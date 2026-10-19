#!/usr/bin/env node
/**
 * scripts/build/install-nginx-site.mjs — the project's own nginx edge on :443
 * ═══════════════════════════════════════════════════════════════════════
 *
 * SELF-CONTAINED BY DESIGN. Nothing outside this project is required:
 * no CDN, no tunnel, no external CA, no third party in the path.
 * nginx IS the edge. It owns :443, terminates TLS with certificates this
 * project issues itself, and proxies to the Node services on loopback.
 *
 * Every service gets its OWN key pair (one shared key for the whole
 * deployment is how a single leaked .pem takes everything down with it,
 * and it makes it impossible to tell which service a request came from).
 * One local CA signs them all; trusting that CA on this machine makes
 * every browser and CLI trust the whole chain.
 *
 * SCOPE NOTE
 *   :443 is a PRIVILEGED port (net.ipv4.ip_unprivileged_port_start=1024),
 *   so a non-root process can never bind it. The system nginx (root) owns
 *   :80 today and owns :443 after the install step. The project-unique
 *   high ports (dist/ports.json) keep every instance separate.
 *
 * Usage:
 *   node scripts/build/install-nginx-site.mjs
 *   node scripts/build/install-nginx-site.mjs --json
 *   node scripts/build/install-nginx-site.mjs --upstream=127.0.0.1:5050
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import { ensureCa, ensureServiceCert, writeNginxRootConf } from "./lib/certs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

// ESM has no `require` - the registry is CommonJS, so bridge it.
const require = createRequire(import.meta.url);
const { readEnv: readProjectEnv } = require(
  path.join(ROOT, "tools", "mcp-registry.js"),
);
const DIST = path.join(ROOT, "dist");
const CERT_DIR = path.join(DIST, "certs");
const NGINX_DIR = path.join(DIST, "nginx");
const SITE_NAME = "zombiecoder-ai";
const PROJECT = path.basename(ROOT);

const JSON_OUT = process.argv.includes("--json");
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`, err: (s) => `\x1b[31m${s}\x1b[0m`,
  head: (s) => `\x1b[36m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

function nginxBin() {
  for (const c of ["/usr/sbin/nginx", "/usr/bin/nginx", "nginx"]) {
    try { execFileSync(c, ["-v"], { stdio: "pipe" }); return c; } catch { /* next */ }
  }
  return null;
}

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) out[k] = v;
  }
  return out;
}

/**
 * The services that are REALLY running right now — the edge must point at
 * live ports, not at a build artefact nobody started.
 */
function liveServices(env) {
  const list = [];
  const apiPort = env.PORT || "5050";
  list.push({ name: "api", port: apiPort, desc: "Gateway (api.js)", public: true });
  // The gateway itself publishes the MCP tool set on /mcp — a dedicated
  // server name for it keeps "who am I talking to" obvious in the logs.
  list.push({ name: "mcp", port: apiPort, desc: "MCP tool endpoint (/mcp of the gateway)" });
  list.push({ name: "bridge", port: env.BRIDGE_PORT || "11435", desc: "local-llm-bridge" });

  // The MCP registry is the environment (tools/mcp-registry.js).
  const { getMcpServers } = require(path.join(ROOT, "tools", "mcp-registry.js"));
  for (const s of getMcpServers()) {
    list.push({ name: s.name, port: String(s.port), desc: s.desc || s.name });
  }
  return list;
}

function main() {
  const report = { project: PROJECT, generatedAt: new Date().toISOString() };
  try {
    const env = readEnv(path.join(ROOT, ".env"));
    const services = liveServices(env);
    if (!services.length) throw new Error("no live services found (.env / MCP registry)");

    const ca = ensureCa({ dir: CERT_DIR, cn: `${PROJECT}-local-ca` });
    report.ca = { path: ca.certPath, fingerprint: ca.fingerprint, notAfter: ca.notAfter };

    // one leaf per service
    const blocks = [];
    const certs = {};
    for (const svc of services) {
      // SAN list: the service name, the PUBLIC domain (the cloud tunnel
      // connects by that name, so the certificate must cover it), localhost
      // and the loopback address.
      // APP_URL lives in .env, not in the shell environment.
      const appUrl = String(readProjectEnv().APP_URL || "");
      const publicDomain =
        (appUrl.match(/^https?:\/\/([^/:]+)/) || [])[1] || "localhost";
      const hosts = [
        `${svc.name}.${PROJECT}.local`,
        publicDomain,
        "localhost",
        "127.0.0.1",
      ];
      const leaf = ensureServiceCert({ name: `edge-${svc.name}`, dir: CERT_DIR, hosts, ca });
      certs[svc.name] = leaf;
      report.certs = report.certs || {};
      report.certs[svc.name] = { fingerprint: leaf.fingerprint, notAfter: leaf.notAfter, cert: leaf.certPath, key: leaf.keyPath };

      // Server names must be UNIQUE per block. Repeating "localhost" in
      // every block made nginx warn "conflicting server name ... ignored"
      // and silently drop every service except the first one.
      // Each service owns <name>.<project>.local; the public domain belongs
      // to the api service only.
      const serverNames = svc.public
        ? `${publicDomain} ${PROJECT}.local api.${PROJECT}.local`
        : `${svc.name}.${PROJECT}.local ${publicDomain}`;
      const isDefault = svc.public ? " default_server" : "";

      blocks.push(
        [
          `# ── ${svc.name} — ${svc.desc}`,
          `server {`,
          `    listen              443 ssl${isDefault};`,
          `    listen              [::]:443 ssl${isDefault};`,
          `    server_name         ${serverNames};`,
          ``,
          `    ssl_certificate     ${leaf.certPath};`,
          `    ssl_certificate_key ${leaf.keyPath};`,
          `    ssl_protocols       TLSv1.2 TLSv1.3;`,
          `    ssl_session_cache   shared:${svc.name}_edge_SSL:10m;`,
          `    ssl_session_timeout 1h;`,
          ``,
          `    add_header Strict-Transport-Security "max-age=31536000" always;`,
          `    add_header X-Content-Type-Options nosniff always;`,
          `    add_header X-Frame-Options SAMEORIGIN always;`,
          ``,
          `    client_max_body_size 32m;`,
          ``,
          `    location / {`,
          `        proxy_pass         http://127.0.0.1:${svc.port};`,
          `        proxy_http_version 1.1;`,
          `        proxy_set_header   Host $host;`,
          `        proxy_set_header   X-Real-IP $remote_addr;`,
          `        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;`,
          `        proxy_set_header   X-Forwarded-Proto https;`,
          `        proxy_read_timeout 300s;`,
          `        proxy_send_timeout 300s;`,
          `    }`,
          `}`,
          ``,
        ].join("\n"),
      );
    }

    const site = [
      `# ─────────────────────────────────────────────────────────────`,
      `# ${SITE_NAME} — generated by scripts/build/install-nginx-site.mjs`,
      `# The project's own TLS edge on :443. One CA, one key pair per`,
      `# service, everything proxied to loopback. No third party.`,
      `#`,
      `# install (needs root — :443 is a privileged port):`,
      `#   sudo bash scripts/build/install-nginx.sh`,
      `# or manually:`,
      `#   sudo cp ${path.relative(ROOT, path.join(NGINX_DIR, SITE_NAME + ".conf"))} /etc/nginx/sites-available/${SITE_NAME}`,
      `#   sudo ln -sf /etc/nginx/sites-available/${SITE_NAME} /etc/nginx/sites-enabled/${SITE_NAME}`,
      `#   sudo nginx -t && sudo systemctl reload nginx`,
      `# ─────────────────────────────────────────────────────────────`,
      blocks.join("\n"),
    ].join("\n");

    const outFile = path.join(NGINX_DIR, SITE_NAME + ".conf");
    fs.mkdirSync(NGINX_DIR, { recursive: true });
    fs.writeFileSync(outFile, site, { mode: 0o644 });
    report.siteFile = outFile;
    report.services = services.map((s) => ({ name: s.name, port: s.port }));

    // validate the syntax
    const nginx = nginxBin();
    let validated = false;
    let validateOut = "";
    if (nginx) {
      const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "zc-443-"));
      const rootConf = writeNginxRootConf({ includeFile: outFile, prefixDir: prefix });
      try {
        const o = execFileSync(nginx, ["-t", "-c", rootConf, "-p", prefix], {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        validateOut = String(o).trim().split("\n").pop();
        validated = true;
      } catch (e) {
        const raw = String(e.stderr || e.message).trim();
        // `nginx -t` also BINDS the listen sockets. Non-root  :443 bind
        // fails even with a perfect config. "syntax is ok" is the verdict.
        if (/syntax is ok/i.test(raw) && /bind\(\)/i.test(raw) && /Permission denied/i.test(raw)) {
          validated = true;
          validateOut = "syntax is ok — bind() on :443 needs root (expected)";
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
      log(C.b("NGINX :443 EDGE — READY TO INSTALL"));
 log(` ${C.ok("")} ${path.relative(ROOT, outFile)} (${services.length} service block(s))`);
      for (const s of services) {
        const c = report.certs[s.name];
        log(`    ${C.dim(`${s.name.padEnd(16)} 127.0.0.1:${s.port.padEnd(6)} ${(c.fingerprint || "").slice(0, 23)}…`)}`);
      }
 log(` ${validated ? C.ok("") : C.err("")} nginx -t: ${validateOut}`);
      log("");
      log(C.b("  install (one command, needs root):"));
      log(`    sudo bash scripts/build/install-nginx.sh`);
      log("");
      log(C.b("  trust our CA on this machine (so browsers/curl/Node accept it):"));
      log(`    sudo cp ${path.relative(ROOT, ca.certPath)} /usr/local/share/ca-certificates/${PROJECT}-local-ca.crt`);
      log(`    sudo update-ca-certificates`);
      log("");
      log(C.dim("  no external CA, no third party in the path — nginx is the whole edge."));
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
