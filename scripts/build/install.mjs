#!/usr/bin/env node
/**
 * scripts/build/install.mjs — first run on a new machine.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * One command, both platforms:
 *
 *   node scripts/build/install.mjs
 *
 * It does the things a newcomer would otherwise have to look up:
 *   1. checks the runtime (Node version)
 *   2. creates .env from .env.example and fills the values it can
 *   3. picks a free port (5050 when it is free, otherwise the next one)
 *   4. reports the optional system tools (tesseract, ffmpeg, edge-tts)
 *   5. prints the exact next command
 *
 * It never touches the network and never writes a secret.
 *
 * Options:
 *   --port=5050     force the gateway port
 *   --check         report only, change nothing
 *   --json          machine readable result
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { isPortFree } from "./lib/ports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const ENV_FILE = path.join(ROOT, ".env");
const EXAMPLE = path.join(ROOT, ".env.example");

const JSON_OUT = process.argv.includes("--json");
const CHECK_ONLY = process.argv.includes("--check");
const argOf = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=")[1] : d;
};

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`, bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
  head: (s) => `\x1b[36m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

function has(cmd) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "sh",
      process.platform === "win32" ? [cmd] : ["-c", `command -v ${cmd}`],
      { stdio: "pipe" });
    return true;
  } catch { return false; }
}

/** Ports this run has already handed out (not listening yet, but taken). */
const taken = new Set();

async function firstFreePort(preferred) {
  for (let p = preferred; p < preferred + 200; p++) {
    if (taken.has(p)) continue;
    if (await isPortFree(p)) {
      taken.add(p);
      return p;
    }
  }
  return null;
}

async function main() {
  const report = { at: new Date().toISOString(), root: ROOT, steps: [] };
  const problems = [];

  // 1. runtime
  const major = Number(process.versions.node.split(".")[0]);
  const nodeOk = major >= 18;
  report.steps.push({ step: "runtime", ok: nodeOk, node: process.versions.node });
  if (!nodeOk) problems.push(`Node 18+ is required (found ${process.versions.node})`);

  // 2. .env
  let envCreated = false;
  if (!fs.existsSync(ENV_FILE) && fs.existsSync(EXAMPLE)) {
    if (!CHECK_ONLY) {
      fs.copyFileSync(EXAMPLE, ENV_FILE);
      envCreated = true;
    }
  }
  const envExists = fs.existsSync(ENV_FILE);
  report.steps.push({ step: "env", ok: envExists, created: envCreated });
  if (!envExists) problems.push(".env is missing - copy .env.example to .env");

  // 3. port
  const preferred = parseInt(argOf("port", "5050"), 10);
  const port = await firstFreePort(preferred);
  report.steps.push({ step: "port", ok: !!port, preferred, chosen: port });
  if (!port) problems.push(`no free port near ${preferred}`);
  if (port && port !== preferred && envExists && !CHECK_ONLY) {
    // the .env must name the port the instance will actually use
    const text = fs.readFileSync(ENV_FILE, "utf8");
    fs.writeFileSync(
      ENV_FILE,
      text.replace(/^PORT=.*$/m, `PORT=${port}`),
    );
    report.steps.push({ step: "port-written", ok: true, port });
  }

  // 3b. the MCP registry ports and the other service ports
  //     A second instance on this computer must not reuse the ports of
  //     the first one. A busy port is moved to the next free number and
  //     written back, so the instance owns its whole set.
  if (envExists && !CHECK_ONLY) {
    let text = fs.readFileSync(ENV_FILE, "utf8");
    const moved = [];
    const mcpPorts = [...text.matchAll(/^(MCP_(\d+)_PORT)=(\d+)$/gm)];
    for (const m of mcpPorts) {
      const key = m[1];
      const port = parseInt(m[3], 10);
      if (await isPortFree(port)) continue;
      const next = await firstFreePort(port + 1);
      if (next) {
        text = text.replace(new RegExp(`^${key}=${port}$`, "m"), `${key}=${next}`);
        moved.push({ key, from: port, to: next });
      }
    }
    for (const key of ["BRIDGE_PORT", "UDS_PORT", "ADAPTER_HTTP_PORT"]) {
      const m = text.match(new RegExp(`^${key}=(\d+)$`, "m"));
      if (!m) continue;
      const port = parseInt(m[1], 10);
      if (await isPortFree(port)) continue;
      const next = await firstFreePort(port + 1);
      if (next) {
        text = text.replace(new RegExp(`^${key}=${port}$`, "m"), `${key}=${next}`);
        moved.push({ key, from: port, to: next });
      }
    }
    if (moved.length) {
      fs.writeFileSync(ENV_FILE, text);
      report.steps.push({ step: "service-ports", ok: true, moved });
    }
  }

  // 4. optional system tools
  const optional = [
    { tool: "tesseract", why: "OCR MCP server (image text)" },
    { tool: "ffmpeg", why: "screen recorder + OCR image step" },
    { tool: "nginx", why: "TLS edge on :443" },
    { tool: "openssl", why: "certificate generation" },
  ].map((t) => ({ ...t, present: has(t.tool) }));
  report.optional = optional;

  // 5. the secrets the operator must fill in
  const missingSecrets = [];
  if (envExists) {
    const text = fs.readFileSync(ENV_FILE, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=(.*)$/);
      // only the credentials the gateway itself needs; a provider that is
      // switched off may stay empty
      if (m && !m[2].trim() && /^(ADMIN_TOKEN|ADMIN_API_KEY)$/.test(m[1])) {
        missingSecrets.push(m[1]);
      }
    }
  }
  report.missingSecrets = missingSecrets;

  report.ok = problems.length === 0;
  report.problems = problems;

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log(C.b("INSTALL " + (report.ok ? "OK" : "NEEDS ATTENTION")));
    for (const s of report.steps) log(`   ${s.ok ? C.ok("v") : C.bad("x")} ${s.step}${s.created ? " (created)" : ""}${s.chosen ? " -> " + s.chosen : ""}`);
    log("");
    log("   optional tools:");
    for (const t of optional) {
      log(`     ${t.present ? C.ok("v") : C.warn("-")} ${t.tool.padEnd(10)} ${C.dim(t.why)}`);
    }
    if (missingSecrets.length) {
      log("");
      log(C.warn("   fill these in .env before using the providers:"));
      log(C.warn("     " + missingSecrets.join(", ")));
    }
    if (problems.length) {
      log("");
      for (const p of problems) log(C.bad("   ! " + p));
    }
    log("");
    log(C.b("   NEXT: node start.js"));
    log(C.dim("   then: curl http://127.0.0.1:" + (port || preferred) + "/identity"));
  }
  process.exit(report.ok ? 0 : 1);
}

main();
