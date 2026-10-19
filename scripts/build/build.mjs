#!/usr/bin/env node
/**
 * scripts/build/build.mjs — project build for ZombieCoder / Mission Barisal
 * ═══════════════════════════════════════════════════════════════════════
 * Produces a self-contained `dist/` for THIS project instance:
 *
 *   1. PREFLIGHT  — required files present, Node version, openssl present
 *   2. SYNTAX     — every runtime .js/.mjs passes `node --check`
 *   3. PORTS      — a project-unique, conflict-free port block
 *   4. ASSEMBLE   — runtime files copied into dist/
 *   5. GENERATE   — dist/.env.dist, dist/ports.json, dist/manifest.json,
 *                   dist/start.sh, dist/nginx/*.conf
 *   6. VERIFY     — re-hash every copied file, and PROVE no secret from
 *                   the live .env leaked into dist/
 *
 * The port block is derived from a hash of the project root, so:
 *   • the same project always gets the same block (reproducible),
 *   • a DIFFERENT project on this machine gets a different block,
 *   • and every candidate port is checked against the live listener table
 *     (/proc/net/tcp) before it is handed out.
 *
 * Usage:
 *   node scripts/build/build.mjs              # build
 *   node scripts/build/build.mjs --check      # verify an existing dist/
 *   node scripts/build/build.mjs --json       # machine-readable report
 *
 * Zero dependencies. Node >= 18.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { allocatePorts, assertPortsFree, readLiveListenPorts } from "./lib/ports.mjs";
import { ensureServiceCert, generateNginxConf, opensslAvailable, certFingerprint } from "./lib/certs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DIST = path.join(ROOT, "dist");

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const CHECK_ONLY = argv.includes("--check");

// ── tiny logger ────────────────────────────────────────────────────────
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  head: (s) => `\x1b[36m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = (...a) => { if (!JSON_OUT) console.log(...a); };
const step = (n, t) => log(`${C.b(`[${n}]`)} ${C.head(t)}`);

// ── file selection ─────────────────────────────────────────────────────
const SKIP_DIRS = new Set([
  "node_modules", ".git", "logs", "dist", ".zombiecoder", "coverage", ".cache",
]);
const SKIP_FILES = new Set([".env", ".env.local", ".DS_Store", "registry.db"]);
const RUNTIME_DIRS = [
  "agent", "lib", "normalizer", "provider", "public", "scripts", "skills",
  "tools", "universal-adapter", "external mcp", "external tools", "tests",
];
const RUNTIME_ROOT_FILES = [
  "api.js", "start.js", "start.sh", "start-local-mcp.js", "cdp-pipe.js",
  "domain-config.js", "external-mcp.js", "integrations.js", "local-llm-bridge.js",
  "mcp-client.js", "mcp-stdio-client.js", "note-store.js", "README.md",
  ".env.example",
];

function collectFiles() {
  const out = [];
  for (const f of RUNTIME_ROOT_FILES) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) out.push(p);
  }
  for (const d of RUNTIME_DIRS) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue;
        const p = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(p);
        else {
          if (SKIP_FILES.has(e.name)) continue;
          if (e.name.endsWith(".bak") || e.name.endsWith(".dl")) continue;
          out.push(p);
        }
      }
    }
  }
  return out.sort();
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// ── secret scanner ─────────────────────────────────────────────────────
const SECRET_KEY_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|AUTH|CREDENTIAL)/i;

function loadDotEnv(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) v = v.slice(1, -1);
    map.set(k, v);
  }
  return map;
}

function collectSecretValues(env) {
  const out = [];
  for (const [k, v] of env) {
    if (!SECRET_KEY_RE.test(k)) continue;
    if (!v || v.length < 8) continue;
    if (v.includes(" ") && v.length > 40) continue; // prose, not a credential
    out.push({ key: k, value: v });
  }
  return out;
}

// ── hardcoded-secret scanner (config files) ────────────────────────────
/**
 * A credential written into a config file is worse than one in .env:
 * .env is gitignored, config files usually are not, and the credential
 * ends up in every build output. The Facebook Ads token in
 * external mcp/servers.json was exactly this — 249 characters, in a file
 * that the build copies into dist/.
 */
const HARDCODED_SECRET_RE =
  /"(token|api_?key|secret|password|access_?token|client_?secret)"\s*:\s*"([^"]{16,})"/gi;
const PLACEHOLDER_RE = /^(your_|<.*>|\{\{.*\}\}|changeme|xxx+|placeholder|example|test|dummy)/i;

function scanHardcodedSecrets(root) {
  const hits = [];
  const skipDirs = new Set(["node_modules", ".git", "dist", "logs", ".zombiecoder"]);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(json|env|conf|yml|yaml|ini|toml|config)$/i.test(e.name)) continue;
      if (path.basename(p) === ".env.example") continue; // template
      let text;
      try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
      let m;
      HARDCODED_SECRET_RE.lastIndex = 0;
      while ((m = HARDCODED_SECRET_RE.exec(text)) !== null) {
        const key = m[1];
        const value = m[2];
        if (PLACEHOLDER_RE.test(value)) continue;
        if (value.length < 20) continue;
        // A credential has no spaces; a description does. "optional auth
        // header" is documentation, "EAANyonke..." is a token.
        if (/\s/.test(value)) continue;
        // Must look like a credential, not a path/URL/word.
        if (!/^[A-Za-z0-9._\-+/=]{20,}$/.test(value)) continue;
        hits.push({ file: path.relative(root, p), key, length: value.length });
      }
    }
  };
  walk(root);
  return hits;
}

// ── steps ──────────────────────────────────────────────────────────────
function preflight() {
  step(1, "PREFLIGHT");
  const required = ["api.js", "start.js", "provider/index.js", "local-llm-bridge.js"];
  const missing = required.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) throw new Error("missing required file(s): " + missing.join(", "));
 log(` ${C.ok("")} required files present (${required.length})`);

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) throw new Error("Node >= 18 required, found " + process.versions.node);
 log(` ${C.ok("")} node ${process.versions.node}`);

  const ssl = opensslAvailable();
 log(` ${ssl ? C.ok("") : C.warn("!")} openssl ${ssl ? "available" : "MISSING (TLS steps will be skipped)"}`);
  return { node: process.versions.node, openssl: ssl };
}

function syntaxCheck(files) {
  step(2, "SYNTAX CHECK");
  const jsFiles = files.filter((f) => /\.(js|mjs|cjs)$/.test(f));
  const failures = [];
  for (const f of jsFiles) {
    try {
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    } catch (e) {
      failures.push({ file: path.relative(ROOT, f), error: String(e.stderr || e.message).slice(0, 400) });
    }
  }
  if (failures.length) {
 for (const f of failures) log(` ${C.err("")} ${f.file}\n ${f.error}`);
    throw new Error(`syntax check failed for ${failures.length} file(s)`);
  }
 log(` ${C.ok("")} ${jsFiles.length} file(s) parse cleanly`);
  return { checked: jsFiles.length };
}

async function allocate() {
  step(3, "PORT ALLOCATION (project-unique block)");
  const live = readLiveListenPorts();
  const res = await allocatePorts(ROOT);
  await assertPortsFree(res.ports);
 log(` ${C.ok("")} block base ${res.base} (block #${res.blockIndex}, ${res.attempts} attempt(s))`);
  log(`    ${C.dim(`live listeners on this host: ${live.size}`)}`);
  for (const s of res.services) {
    log(`    ${C.dim(`    ${s.name.padEnd(8)} http=${s.httpPort}  tls=${s.tlsPort ?? "-"}`)}`);
  }
  return res;
}

function assemble(files) {
  step(4, "ASSEMBLE dist/");
  // TLS material survives a rebuild: the CA + per-service leaf keys are
  // expensive to rotate and are not build output. tls-verify.mjs refreshes
  // them on demand (--rotate).
  let keptCerts = null;
  const certsDir = path.join(DIST, "certs");
  if (fs.existsSync(certsDir)) {
    keptCerts = fs.mkdtempSync(path.join(os.tmpdir(), "zc-certs-"));
    fs.cpSync(certsDir, keptCerts, { recursive: true });
  }
  if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  if (keptCerts) {
    fs.cpSync(keptCerts, certsDir, { recursive: true });
    fs.rmSync(keptCerts, { recursive: true, force: true });
    log(`    ${C.dim("kept existing dist/certs (TLS material survives a rebuild)")}`);
  }

  const manifest = [];
  let bytes = 0;
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const dest = path.join(DIST, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f, dest);
    const st = fs.statSync(dest);
    bytes += st.size;
    manifest.push({ file: rel, bytes: st.size, sha256: sha256(dest) });
  }
 log(` ${C.ok("")} ${manifest.length} file(s), ${(bytes / 1024).toFixed(0)} KiB`);
  return manifest;
}

function generate(ports, services, manifest) {
  step(5, "GENERATE runtime metadata");

  // ports.json
  fs.writeFileSync(
    path.join(DIST, "ports.json"),
    JSON.stringify(
      {
        project: path.basename(ROOT),
        projectRoot: ROOT,
        generatedAt: new Date().toISOString(),
        base: ports.base,
        services: services.map((s) => ({
          name: s.name, desc: s.desc, http: s.httpPort, tls: s.tlsPort,
        })),
      },
      null,
      2,
    ) + "\n",
  );
 log(` ${C.ok("")} dist/ports.json`);

  // .env.dist — the SAFE template: .env.example + this instance's ports.
  const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const p = ports.ports;
  const overrides = [
    "",
    "# ─────────────────────────────────────────────────────────────",
    `# PROJECT-UNIQUE PORTS (generated ${new Date().toISOString()})`,
    "# Every instance of this project owns its own block — no clash",
    "# with any other project or with the dev instance.",
    "# ─────────────────────────────────────────────────────────────",
    `PORT=${p.api.http}`,
    `APP_URL=https://localhost:${p.api.tls}`,
    `MCP_PORT=${p.mcp.http}`,
    `BRIDGE_PORT=${p.bridge.http}`,
    `OCR_MCP_PORT=${p.ocr.http}`,
    `SCREEN_MCP_PORT=${p.screen.http}`,
    `TTS_MCP_PORT=${p.tts.http}`,
    `UNIVERSAL_ADAPTER_MCP_PORT=${p.adapter.http}`,
    `ADMIN_PORT=${p.admin.http}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(DIST, ".env.dist"), example + overrides);
 log(` ${C.ok("")} dist/.env.dist (from .env.example + project ports)`);

  // run.sh — runs the built instance on its own project-specific ports.
  // (named run.sh, not start.sh: the repo's own start.sh is copied as-is
  //  and overwriting it would break the manifest hash)
  const startSh = `#!/usr/bin/env bash
# Generated by scripts/build/build.mjs — runs the BUILT instance of
# ${path.basename(ROOT)} on its own project-specific ports.
set -euo pipefail
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HERE/.env" ]; then
  set -a; . "$HERE/.env"; set +a
else
  echo "warn: $HERE/.env missing — copy .env.dist to .env and fill the secrets." >&2
  set -a; . "$HERE/.env.dist"; set +a
fi
export PORT="\${PORT:-$(${p.api.http})}"
exec node "$HERE/start.js"
`;
  fs.writeFileSync(path.join(DIST, "run.sh"), startSh, { mode: 0o755 });
 log(` ${C.ok("")} dist/run.sh`);

  // manifest.json
  const man = {
    project: path.basename(ROOT),
    generatedAt: new Date().toISOString(),
    node: process.versions.node,
    ports: Object.fromEntries(
      Object.entries(ports.ports).map(([k, v]) => [k, v]),
    ),
    files: manifest.sort((a, b) => a.file.localeCompare(b.file)),
  };
  fs.writeFileSync(path.join(DIST, "manifest.json"), JSON.stringify(man, null, 2) + "\n");
 log(` ${C.ok("")} dist/manifest.json`);

  return man;
}

async function verify(manifest, ports) {
  step(6, "VERIFY");

  // 6a. every copied file still hashes the same
  let bad = 0;
  for (const m of manifest) {
    const p = path.join(DIST, m.file);
    if (!fs.existsSync(p)) { bad++; continue; }
    if (sha256(p) !== m.sha256) bad++;
  }
  if (bad) throw new Error(`${bad} file(s) in dist/ do not match the manifest`);
 log(` ${C.ok("")} ${manifest.length} file(s) match the manifest hash`);

  // 6b. no secret from the live .env may exist in dist/
  const env = loadDotEnv(path.join(ROOT, ".env"));
  const secrets = collectSecretValues(env);
  const leaks = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scan(p); continue; }
      let text;
      try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
      for (const s of secrets) {
        if (text.includes(s.value)) leaks.push({ file: path.relative(DIST, p), key: s.key });
      }
    }
  };
  scan(DIST);
  if (leaks.length) {
 for (const l of leaks) log(` ${C.err("")} secret "${l.key}" found in ${l.file}`);
    throw new Error("secret leak detected in dist/");
  }
 log(` ${C.ok("")} no secret from .env (${secrets.length} value(s) scanned) leaked into dist/`);

  // 6c. no credential may be hardcoded in a config file (they end up in
  //     every build output, and config files are usually NOT gitignored)
  const hardcoded = scanHardcodedSecrets(ROOT);
  if (hardcoded.length) {
    for (const h of hardcoded) {
 log(` ${C.err("")} hardcoded credential "${h.key}" (${h.length} chars) in ${h.file}`);
    }
    throw new Error(
      "hardcoded credential(s) in config file(s): " +
        hardcoded.map((h) => h.file + ":" + h.key).join(", "),
    );
  }
 log(` ${C.ok("")} no hardcoded credential in any config file`);

  // 6d. the built ports must still be free
  await assertPortsFree(ports);
 log(` ${C.ok("")} all ${Object.keys(ports).length} service port(s) still free`);

  return { files: manifest.length, secretsScanned: secrets.length, hardcoded: hardcoded.length };
}

function checkExisting() {
  step(1, "CHECK existing dist/");
  const manPath = path.join(DIST, "manifest.json");
  if (!fs.existsSync(manPath)) throw new Error("dist/manifest.json missing — run the build first");
  const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
  let bad = 0;
  for (const m of man.files) {
    const p = path.join(DIST, m.file);
 if (!fs.existsSync(p) || sha256(p) !== m.sha256) { bad++; log(` ${C.err("")} ${m.file}`); }
  }
  if (bad) throw new Error(`${bad} file(s) do not match the manifest`);
 log(` ${C.ok("")} ${man.files.length} file(s) match the manifest hash`);
  return man;
}

// ── main ───────────────────────────────────────────────────────────────
async function main() {
  const report = { project: path.basename(ROOT), root: ROOT, startedAt: new Date().toISOString() };
  try {
    if (CHECK_ONLY) {
      const man = checkExisting();
      report.check = { ok: true, files: man.files.length };
    } else {
      report.preflight = preflight();
      const files = collectFiles();
      report.syntax = syntaxCheck(files);
      const ports = await allocate();
      report.ports = ports;
      const manifest = assemble(files);
      const man = generate(ports, ports.services, manifest);
      report.verify = await verify(manifest, ports.ports);
      report.manifest = { files: man.files.length };
    }
    report.ok = true;
    report.finishedAt = new Date().toISOString();
  } catch (e) {
    report.ok = false;
    report.error = String(e.message || e);
    report.finishedAt = new Date().toISOString();
    if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
    else {
      log("");
      log(`${C.err("BUILD FAILED")}: ${e.message}`);
    }
    process.exit(1);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log("");
    log(C.b(C.ok("  BUILD OK")));
    if (report.ports) {
      log(`  ${C.dim("ports:")}  ${Object.entries(report.ports.ports)
        .map(([k, v]) => `${k}=${v.http}${v.tls ? "/" + v.tls : ""}`)
        .join("  ")}`);
    }
    log(`  ${C.dim("dist:")}   ${DIST}`);
    log(`  ${C.dim("next:")}  node scripts/build/tls-verify.mjs`);
    log("");
  }
}

main();
