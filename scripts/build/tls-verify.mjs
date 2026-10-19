#!/usr/bin/env node
/**
 * scripts/build/tls-verify.mjs — TLS/SSL verification for the built instance
 * ═══════════════════════════════════════════════════════════════════════
 * Uses nginx as the TLS terminator (engine X) and gives EVERY service its
 * own key pair — one shared key for the whole deployment is how a single
 * leaked .pem takes everything down with it.
 *
 * Steps
 *   1. read the port plan produced by build.mjs (dist/ports.json)
 *   2. generate one self-signed cert+key per service (SAN: localhost,
 *      127.0.0.1, ::1, project host)
 *   3. render the nginx server blocks (one per service, its own cert)
 * 4. `nginx -t`  configuration validation
 *   5. start nginx on the project's TLS ports
 *   6. real TLS handshake per service (node:tls, ca = that service's cert):
 *      chain verification, hostname verification, protocol, cipher
 * 7. end-to-end proxy check: TLS client  nginx  node upstream
 *   8. stop nginx, prove every port is free again
 *
 * Usage:
 *   node scripts/build/tls-verify.mjs            # full run
 *   node scripts/build/tls-verify.mjs --json     # machine-readable
 *   node scripts/build/tls-verify.mjs --no-run   # config check only
 *
 * Zero dependencies. Node >= 18. Needs the nginx CLI on PATH.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import {
  ensureCa, ensureServiceCert, generateNginxConf, writeNginxRootConf,
  certCheck, certFingerprint, certNotAfter, opensslAvailable,
} from "./lib/certs.mjs";
import { isPortFree } from "./lib/ports.mjs";
import { serviceHostName, serviceHostNames, publicDomainsOf } from "./lib/hosts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DIST = path.join(ROOT, "dist");
const CERT_DIR = path.join(DIST, "certs");
const NGINX_DIR = path.join(DIST, "nginx");
const PREFIX_DIR = path.join(NGINX_DIR, "prefix");

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const NO_RUN = argv.includes("--no-run");

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`, err: (s) => `\x1b[31m${s}\x1b[0m`,
  head: (s) => `\x1b[36m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = (...a) => { if (!JSON_OUT) console.log(...a); };
const step = (n, t) => log(`${C.b(`[${n}]`)} ${C.head(t)}`);

function nginxBin() {
  for (const c of ["/usr/sbin/nginx", "/usr/bin/nginx", "nginx"]) {
    try {
      execFileSync(c, ["-v"], { stdio: "pipe" });
      return c;
    } catch { /* next */ }
  }
  return null;
}

// ── 1. plan ────────────────────────────────────────────────────────────
function readPlan() {
  const p = path.join(DIST, "ports.json");
  if (!fs.existsSync(p)) {
    throw new Error("dist/ports.json missing — run `node scripts/build/build.mjs` first");
  }
  const plan = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!plan.services || !plan.services.length) throw new Error("dist/ports.json has no services");
  return plan;
}

// ── 6. TLS handshake against one service ──────────────────────────────
// NOTE: the CA is passed as PEM CONTENT, not as a file path.
// Node 24 + OpenSSL 3 silently fails to load a self-signed CA given as a
// path in `ca` (the chain builder then treats the leaf as self-signed and
// reports UNABLE_TO_VERIFY_LEAF_SIGNATURE), while the very same file
// passed as a buffer verifies correctly. Verified empirically:
//   ca:[path]   -> ERR UNABLE_TO_VERIFY_LEAF_SIGNATURE
//   ca:[buffer] -> authorized: true
function tlsProbe({ host, port, caPem, servername, path: urlPath = "/" }) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername,
        ca: [caPem],
        rejectUnauthorized: true, // full chain + hostname verification
        minVersion: "TLSv1.2",
      },
      () => {
        const cert = socket.getPeerCertificate();
        const cipher = socket.getCipher();
        const proto = socket.getProtocol();
        const authorized = socket.authorized;
        const authorizationError = socket.authorizationError || null;
        socket.destroy();
        resolve({
          authorized,
          authorizationError,
          protocol: proto,
          cipher: cipher ? cipher.name : null,
          subject: cert && cert.subject ? cert.subject.CN : null,
          san: cert && cert.subjectaltname ? cert.subjectaltname : null,
          validTo: cert && cert.valid_to ? cert.valid_to : null,
          issuer: cert && cert.issuer ? cert.issuer.CN : null,
        });
      },
    );
    socket.setTimeout(6000, () => {
      socket.destroy();
      resolve({ error: "timeout" });
    });
    socket.on("error", (e) => resolve({ error: e.message, code: e.code || null }));
  });
}

// ── 7. end-to-end: TLS client  nginx  node upstream ─────────────────
function httpsGet({ host, port, path: urlPath, caPem, servername }) {
  return new Promise((resolve) => {
    const req = https.request(
      { host, port, path: urlPath, method: "GET", ca: [caPem], servername, rejectUnauthorized: true },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body: body.slice(0, 200) }));
      },
    );
    req.setTimeout(6000, () => { req.destroy(); resolve({ error: "timeout" }); });
    req.on("error", (e) => resolve({ error: e.message }));
    req.end();
  });
}

/** One plain HTTP POST, used to compare a service with its own port. */
function httpProbe({ host, port, path: urlPath = "/mcp", body = "" }) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host, port, path: urlPath, method: "POST", timeout: 8000,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(d); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.write(body);
    req.end();
  });
}

/** One HTTPS POST, used for the mapping check. */
function httpsProbe({ host, port, servername, caPem, body, path: urlPath = "/mcp", method = "POST" }) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host, port, servername,
        path: urlPath, method,
        ca: [caPem], rejectUnauthorized: true,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 8000,
      },
      (res) => {
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(d); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.write(body);
    req.end();
  });
}

// ── main ───────────────────────────────────────────────────────────────
async function main() {
  const report = { startedAt: new Date().toISOString(), project: path.basename(ROOT) };
  let nginx = null;
  let stub = null;

  try {
    step(1, "PLAN");
    const plan = readPlan();
    // The TLS ports come from the instance block, the upstreams from the
    // LIVE services. Verifying a block that nothing runs proves nothing;
    // the mapping check must exercise the real backends.
    const { getMcpServers, readEnv } = await import(
      path.join(ROOT, "tools", "mcp-registry.js")
    );
    const env = readEnv();
    const livePorts = {
      api: env.PORT || "5050",
      mcp: env.PORT || "5050",
      bridge: env.BRIDGE_PORT || "11435",
    };
    for (const m of getMcpServers()) livePorts[m.name] = String(m.port);
    const services = plan.services
      .filter((s) => s.tls)
      .map((s) => ({
        ...s,
        livePort: livePorts[s.name] || String(s.http),
        tlsPort: s.tls,
      }));
    report.plan = { base: plan.base, services: services.length };
    for (const s of services) {
      log(`    ${C.dim(`${s.name.padEnd(8)} http=${s.http}  tls=${s.tls ?? "-"}`)}`);
    }

    if (!opensslAvailable()) throw new Error("openssl CLI not found");

    step(2, "PROJECT CA + PER-SERVICE CERTIFICATES");
    const hosts = ["localhost", "127.0.0.1", "::1"];
    const ca = ensureCa({ dir: CERT_DIR, cn: `${report.project}-local-ca`, force: argv.includes("--rotate") });
    const caPem = fs.readFileSync(ca.certPath);
 log(` ${C.ok("")} CA ${C.dim((ca.fingerprint || "").slice(0, 29) + "…")} ${C.dim("exp " + (ca.notAfter || "?"))}`);

    const certs = {};
    for (const s of services) {
      const c = ensureServiceCert({
        name: s.name,
        dir: CERT_DIR,
        // the same name the edge config uses (scripts/build/lib/hosts.mjs)
        hosts: [...hosts, ...serviceHostNames(s.name, path.basename(ROOT))],
        ca,
        force: argv.includes("--rotate"),
      });
      certs[s.name] = c;
      const check = certCheck(c.certPath, ca.certPath);
      log(
 ` ${check.ok ? C.ok("") : C.err("")} ${s.name.padEnd(8)} ${C.dim((c.fingerprint || "").slice(0, 29) + "…")}` +
        ` ${C.dim("exp " + (c.notAfter || "?"))}`,
      );
      if (!check.ok) throw new Error(`certificate chain verify failed for ${s.name}: ${check.out}`);
    }
    report.ca = { fingerprint: ca.fingerprint, notAfter: ca.notAfter, cert: path.relative(DIST, ca.certPath) };
    report.certs = Object.fromEntries(
      Object.entries(certs).map(([k, c]) => [k, {
        fingerprint: c.fingerprint, notAfter: c.notAfter, reused: c.reused,
        key: path.relative(DIST, c.keyPath), cert: path.relative(DIST, c.certPath),
      }]),
    );

    step(3, "NGINX CONFIGURATION");
    // The TLS port comes from the instance block, the upstream from the
    // live service. The mapping check below is only meaningful when the
    // real backends are behind the TLS ports.
    const servicesWithTls = services
      .filter((s) => s.tls)
      .map((s) => ({
        ...s,
        httpPort: s.http,
        tlsPort: s.tls,
        livePort: s.livePort,
        hosts: [...hosts, ...serviceHostNames(s.name, path.basename(ROOT))],
        serverNames: serviceHostName(s.name, path.basename(ROOT)),
      }));
    const siteConf = path.join(NGINX_DIR, `${report.project}.conf`);
    generateNginxConf({
      services: servicesWithTls,
      certs,
      outFile: siteConf,
      projectName: report.project,
    });
    const rootConf = writeNginxRootConf({ includeFile: siteConf, prefixDir: PREFIX_DIR });
 log(` ${C.ok("")} ${path.relative(ROOT, siteConf)} (${servicesWithTls.length} server block(s))`);

    nginx = nginxBin();
    if (!nginx) throw new Error("nginx CLI not found (apt install nginx)");
    report.nginx = nginx;

    step(4, "NGINX CONFIG TEST");
    try {
      const out = execFileSync(nginx, ["-t", "-c", rootConf, "-p", PREFIX_DIR], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
 log(` ${C.ok("")} ${String(out).trim().split("\n").pop()}`);
    } catch (e) {
      const err = String(e.stderr || e.message);
 log(` ${C.err("")} ${err.trim()}`);
      throw new Error("nginx -t failed: " + err.trim().split("\n").slice(-3).join(" | "));
    }
    report.nginxTest = "pass";

    if (NO_RUN) {
      report.note = "config only (--no-run)";
      report.ok = true;
    } else {
      step(5, "START NGINX");
      // A stub upstream on the api HTTP port proves the whole chain:
      // TLS client -> nginx -> node. The real api.js is not started here.
      const apiSvc = plan.services.find((s) => s.name === "api");
      stub = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, stub: "tls-verify", path: req.url }));
      });
      await new Promise((res, rej) => {
        stub.once("error", rej);
        stub.listen(apiSvc.http, "127.0.0.1", res);
      });
      log(`    ${C.dim(`stub upstream on 127.0.0.1:${apiSvc.http}`)}`);

      const out = execFileSync(nginx, ["-c", rootConf, "-p", PREFIX_DIR], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
 log(` ${C.ok("")} nginx started ${String(out).trim()}`);

      // wait for the TLS ports to accept
      const deadline = Date.now() + 8000;
      const tlsPorts = servicesWithTls.map((s) => s.tlsPort);
      for (;;) {
        const free = await Promise.all(tlsPorts.map((p) => isPortFree(p)));
        // isPortFree() === true   nothing is accepting on that port.
        // So "every port is listening" == every entry is NOT free.
        if (free.every((f) => !f)) break;
        if (Date.now() > deadline) throw new Error("nginx did not open every TLS port in time");
        await new Promise((r) => setTimeout(r, 200));
      }
 log(` ${C.ok("")} ${tlsPorts.length} TLS port(s) listening`);

 step(6, "TLS HANDSHAKE VERIFICATION (chain: leaf project CA)");
      const results = [];
      let tlsFailures = 0;
      for (const s of servicesWithTls) {
        const r = await tlsProbe({
          host: "127.0.0.1", port: s.tlsPort, caPem, servername: "localhost",
        });
        const good = r.authorized === true;
        if (!good) tlsFailures++;
        results.push({ service: s.name, port: s.tlsPort, ...r, ok: good });
        log(
 ` ${good ? C.ok("") : C.err("")} ${s.name.padEnd(8)} ` +
          C.dim(`${r.protocol || "?"} ${r.cipher || "?"} cn=${r.subject || "?"} issuer=${r.issuer || "?"}`),
        );
        if (!good) {
          log(`      ${C.err(String(r.error || r.authorizationError))}`);
        }
      }
      report.tls = results;
      if (tlsFailures) throw new Error(`${tlsFailures} TLS handshake(s) failed verification`);

 step(7, "END-TO-END PROXY CHECK (TLS nginx node)");
      const apiSvc2 = plan.services.find((s) => s.name === "api");
      const e2e = await httpsGet({
        host: "127.0.0.1", port: apiSvc2.tls, path: "/health",
        caPem, servername: "localhost",
      });
      const e2eOk = e2e.status === 200;
 log(` ${e2eOk ? C.ok("") : C.err("")} GET https://127.0.0.1:${apiSvc2.tls}/health ${e2e.status || e2e.error}`);
      if (!e2eOk && e2e.body) log(`      ${C.dim(e2e.body)}`);
      report.e2e = { ok: e2eOk, ...e2e };
      if (!e2eOk) throw new Error("end-to-end TLS proxy check failed");

      step(8, "TOOL -> PORT MAPPING");
      // A TLS port that answers with the WRONG tool is the worst kind of
      // clash: it works, and it returns somebody else's data. Every
      // service must answer on its own name with its own tools.
      const mapping = [];
      for (const svc of services) {
        if (!svc.tls) continue;
        // A slot with no live service in this instance is not part of it.
        if (!livePorts[svc.name]) {
          mapping.push({ service: svc.name, skipped: true, ok: true });
          log(`    - ${svc.name.padEnd(17)} (no live service in this instance)`);
          continue;
        }
        const name = serviceHostName(svc.name, path.basename(ROOT));
        // The bridge is an OpenAI compatible server, not an MCP server.
        const isMcp = svc.name !== "bridge";
        const probe = await httpsProbe({
          host: "127.0.0.1",
          port: svc.tls,
          servername: name,
          caPem: fs.readFileSync(ca.certPath),
          path: isMcp ? "/mcp" : "/health",
          method: isMcp ? "POST" : "GET",
          body: isMcp
            ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
            : "",
        });
        const tools = probe.json?.result?.tools || [];
        // A tool that belongs to ANOTHER service means the wrong backend is
        // behind this name. The tool names do not have to start with the
        // service name ("screen_screenshot" belongs to "screen-recorder").
        const otherNames = services
          .map((o) => o.name)
          .filter((n) => n !== svc.name && n !== "api" && n !== "mcp");
        // an MCP server must not answer with somebody else's tools
        // The decisive check: the tools behind this NAME must be the same
        // tools the service answers on its OWN port. A gateway aggregates
        // the tools of every server, so "a tool of another service" is
        // normal there - but a different SET means the wrong backend is
        // behind the name.
        let direct = null;
        if (isMcp) {
          const d = await httpProbe({
            host: "127.0.0.1",
            port: svc.livePort,
            path: "/mcp",
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
          });
          direct = (d.json?.result?.tools || []).map((t) => String(t.name || "")).sort();
        }
        const viaName = tools.map((t) => String(t.name || "")).sort();
        const sameSet =
          !direct || (viaName.length === direct.length && viaName.join("|") === direct.join("|"));
        const foreign = !sameSet;
        const ok = probe.status === 200 && !foreign;
        mapping.push({ service: svc.name, name, status: probe.status, tools: tools.length, ok });
        log(
          `    ${ok ? "✓" : "✗"} ${svc.name.padEnd(17)} ${name.padEnd(24)} ` +
            `tools=${String(tools.length).padStart(3)}`,
        );
        if (!ok && probe.error) log(`      ${probe.error}`);
      }
      report.mapping = mapping;
      const badMapping = mapping.filter((m) => !m.ok);
      if (badMapping.length) {
        throw new Error(
          "tool/port mapping is wrong: " +
            badMapping.map((m) => `${m.service}(${m.status || m.error})`).join(", "),
        );
      }

      step(9, "SHUTDOWN + PORT RELEASE");
    }

    // stop stub
    if (stub) { await new Promise((r) => stub.close(r)); stub = null; }
    // stop nginx
    const pidFile = path.join(PREFIX_DIR, "nginx.pid");
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      try { process.kill(pid, "SIGQUIT"); } catch { /* already gone */ }
      const until = Date.now() + 5000;
      while (Date.now() < until && fs.existsSync(pidFile)) {
        await new Promise((r) => setTimeout(r, 100));
      }
 log(` ${C.ok("")} nginx stopped (pid ${pid})`);
    }

    step(9, "PORT RELEASE VERIFICATION");
    const allPorts = [];
    for (const s of plan.services) {
      allPorts.push(s.http, s.tls);
    }
    const busy = [];
    for (const p of allPorts) {
      if (!p) continue;
      if (!(await isPortFree(p))) busy.push(p);
    }
    if (busy.length) throw new Error("port(s) still occupied after shutdown: " + busy.join(", "));
 log(` ${C.ok("")} all ${allPorts.length} port(s) free again — no clash with any other project`);
    report.portsReleased = true;
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.error = String(e.message || e);
  } finally {
    if (stub) { try { stub.close(); } catch { /* ignore */ } }
    const pidFile = path.join(PREFIX_DIR, "nginx.pid");
    if (fs.existsSync(pidFile)) {
      try {
        const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
        process.kill(pid, "SIGQUIT");
      } catch { /* ignore */ }
    }
  }

  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, "tls-report.json"), JSON.stringify(report, null, 2) + "\n");

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log("");
    if (report.ok) log(C.b(C.ok("  TLS VERIFICATION OK")) + C.dim("   report: dist/tls-report.json"));
    else log(C.b(C.err("  TLS VERIFICATION FAILED")) + ": " + report.error);
    log("");
  }
  process.exit(report.ok ? 0 : 1);
}

main();
