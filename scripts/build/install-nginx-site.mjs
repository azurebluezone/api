#!/usr/bin/env node
/**
 * scripts/build/install-nginx-site.mjs — render the nginx edge for an instance
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The SHAPE of the configuration lives in deploy/nginx.conf.template.
 * This script only supplies values: the service list of this instance, its
 * own ports, and a certificate per service. Nothing is written twice.
 *
 * Port model
 *   5050 — the gateway. The canonical number of the application.
 *   :443 — the host's single TLS port. One listener per machine, several
 *           server names on it. The primary instance owns it.
 *   the instance block — a second copy of the app and its MCP servers uses
 *           ports from scripts/build/lib/ports.mjs, so two instances never
 *           fight over a port.
 *
 * Usage:
 *   node scripts/build/install-nginx-site.mjs
 *   node scripts/build/install-nginx-site.mjs --tls-port=443
 *   node scripts/build/install-nginx-site.mjs --json
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { ensureCa, ensureServiceCert, writeNginxRootConf } from "./lib/certs.mjs";
import { renderTemplate, loadTemplate } from "./lib/nginx-template.mjs";
import { allocatePorts } from "./lib/ports.mjs";
import { serviceHostName, serviceHostNames, publicDomainsOf } from "./lib/hosts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DIST = path.join(ROOT, "dist");
const CERT_DIR = path.join(DIST, "certs");
const NGINX_DIR = path.join(DIST, "nginx");
const TEMPLATE = path.join(ROOT, "deploy", "nginx.conf.template");

const require = createRequire(import.meta.url);
const { readEnv } = require(path.join(ROOT, "tools", "mcp-registry.js"));

const JSON_OUT = process.argv.includes("--json");
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`, err: (s) => `\x1b[31m${s}\x1b[0m`,
  head: (s) => `\x1b[36m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

function nginxBin() {
  for (const c of ["/usr/sbin/nginx", "/usr/bin/nginx", "nginx", "nginx.exe"]) {
    try {
      execFileSync(c, ["-v"], { stdio: "pipe" });
      return c;
    } catch { /* next */ }
  }
  return null;
}

/** The services of THIS instance and where each one is reachable. */
function instanceServices(env) {
  const plan = require(path.join(ROOT, "scripts", "build", "lib", "ports.mjs"));
  const out = [];
  const apiPort = env.PORT || "5050";
  const primary = apiPort === "5050";

  // the public hostnames this instance answers to
  const publicDomains = publicDomainsOf(env);
  const primaryDomain = publicDomains[0] || "localhost";

  // the instance block: the primary instance keeps the host ports, a second
  // instance gets its own block so the two never collide
  const block = primary
    ? null
    : plan.getBlockPorts
      ? plan.getBlockPorts(ROOT)
      : null;

  const tlsPortFor = (name, index) => {
    if (primary) return 443;
    if (block && block[name]) return block[name].tls;
    return null;
  };

  out.push({
    name: "api",
    desc: "Gateway (api.js)",
    httpPort: apiPort,
    tlsPort: tlsPortFor("api", 0),
    serverNames: [...publicDomains, serviceHostName("api", path.basename(ROOT))].join(" "),
    hosts: [...publicDomains, "localhost", "127.0.0.1"],
  });
  out.push({
    name: "mcp",
    desc: "MCP tool endpoint (/mcp of the gateway)",
    httpPort: apiPort,
    tlsPort: tlsPortFor("mcp", 1),
    serverNames: serviceHostName("mcp", path.basename(ROOT)),
    hosts: [...publicDomains, "localhost", "127.0.0.1"],
  });
  out.push({
    name: "bridge",
    desc: "local-llm-bridge (llama / ollama)",
    httpPort: env.BRIDGE_PORT || "11435",
    tlsPort: tlsPortFor("bridge", 2),
    serverNames: serviceHostName("bridge", path.basename(ROOT)),
    hosts: [...publicDomains, "localhost", "127.0.0.1"],
  });

  // the external MCP servers, straight from the registry
  const { getMcpServers } = require(path.join(ROOT, "tools", "mcp-registry.js"));
  for (const s of getMcpServers()) {
    out.push({
      name: s.name,
      desc: s.desc || s.name,
      httpPort: String(s.port),
      tlsPort: tlsPortFor(s.name, out.length),
      serverNames: serviceHostName(s.name, path.basename(ROOT)),
      hosts: [...publicDomains, "localhost", "127.0.0.1"],
    });
  }
  return out;
}

function main() {
  const report = { project: path.basename(ROOT), generatedAt: new Date().toISOString() };
  try {
    const env = readEnv();
    const services = instanceServices(env).filter((s) => s.tlsPort);
    if (!services.length) throw new Error("no service to expose");

    const ca = ensureCa({ dir: CERT_DIR, cn: `${path.basename(ROOT)}-local-ca` });
    const certs = {};
    for (const svc of services) {
      // The certificate must cover every name that reaches this service,
      // including its own server name.
      const hosts = new Set([
        ...svc.hosts,
        ...String(svc.serverNames || "").split(/\s+/).filter(Boolean),
      ]);
      certs[svc.name] = ensureServiceCert({
        name: `edge-${svc.name}`,
        dir: CERT_DIR,
        hosts: [...hosts],
        ca,
      });
    }
    report.ca = { path: ca.certPath, fingerprint: ca.fingerprint };

    const mimeTypes =
      process.platform === "win32"
        ? "conf/mime.types"
        : fs.existsSync("/etc/nginx/mime.types")
          ? "/etc/nginx/mime.types"
          : "conf/mime.types";
    const logDir = path.join(DIST, "nginx", "run");
    fs.mkdirSync(logDir, { recursive: true });

    const conf = renderTemplate(
      loadTemplate(TEMPLATE),
      {
        INSTANCE: path.basename(ROOT),
        PUBLIC_DOMAINS: services[0].serverNames,
        CA_CERT: ca.certPath,
        LOG_DIR: logDir,
        MIME_TYPES: mimeTypes,
      },
      {
        SERVICES: services.map((s) => ({
          NAME: s.name,
          DESC: s.desc,
          HTTP_PORT: s.httpPort,
          TLS_PORT: s.tlsPort,
          CERT: certs[s.name].certPath,
          KEY: certs[s.name].keyPath,
          SERVER_NAMES: s.serverNames,
        })),
      },
    );

    const outFile = path.join(NGINX_DIR, `${path.basename(ROOT)}.conf`);
    fs.mkdirSync(NGINX_DIR, { recursive: true });
    fs.writeFileSync(outFile, conf, { mode: 0o644 });
    report.siteFile = outFile;
    report.services = services.map((s) => ({
      name: s.name, http: s.httpPort, tls: s.tlsPort,
    }));

    const nginx = nginxBin();
    let validated = false;
    let validateOut = "";
    if (nginx) {
      const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "zc-nginx-"));
      const rootConf = writeNginxRootConf({ includeFile: outFile, prefixDir: prefix });
      try {
        const o = execFileSync(nginx, ["-t", "-c", rootConf, "-p", prefix], {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        validateOut = String(o).trim().split("\n").pop();
        validated = true;
      } catch (e) {
        const raw = String(e.stderr || e.message).trim();
        if (/syntax is ok/i.test(raw) && /bind\(\)/i.test(raw)) {
          validated = true;
          validateOut = "syntax is ok - bind() on :443 needs root (expected)";
        } else {
          validateOut = raw;
        }
      }
      fs.rmSync(prefix, { recursive: true, force: true });
    }
    report.nginxTest = { ok: validated, out: validateOut };

    if (JSON_OUT) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      log(C.b("NGINX EDGE - READY TO INSTALL"));
      log(`  ${C.ok("v")} template  ${path.relative(ROOT, TEMPLATE)}`);
      log(`  ${C.ok("v")} rendered   ${path.relative(ROOT, outFile)}`);
      for (const s of services) {
        log(C.dim(`      ${s.name.padEnd(17)} http=${s.httpPort}  tls=${s.tlsPort}`));
      }
      log(`  ${validated ? C.ok("v") : C.err("x")} nginx -t: ${validateOut}`);
      log("");
      log(C.b("  install (needs root for :443):"));
      log(`    sudo bash scripts/build/install-nginx.sh`);
      log("");
      log(C.dim("  trust the project CA on this machine:"));
      log(C.dim(`    sudo cp ${path.relative(ROOT, ca.certPath)} /usr/local/share/ca-certificates/${path.basename(ROOT)}-local-ca.crt`));
      log(C.dim("    sudo update-ca-certificates"));
      log("");
    }
    process.exit(validated ? 0 : 1);
  } catch (e) {
    if (JSON_OUT) console.log(JSON.stringify({ ...report, error: String(e.message || e) }, null, 2));
    else log(C.err("ERROR: " + e.message));
    process.exit(1);
  }
}

main();
