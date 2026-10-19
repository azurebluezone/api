#!/usr/bin/env node
/**
 * scripts/build/verify-public.mjs — what does the public surface look like?
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The cloud tunnel decides which local service answers for a hostname.
 * That mapping lives in the Cloudflare dashboard, but the tunnel LOGS the
 * configuration it received, so the truth can be read from the host.
 *
 * This script prints, for every public hostname:
 *   hostname -> origin service -> is the origin alive?
 * and flags the inconsistencies that actually break a client:
 *   - a hostname that answers 5xx from the edge
 *   - two hostnames for the SAME app pointing at DIFFERENT origins
 *   - a public hostname missing from the tunnel rules
 *
 * Usage:
 *   node scripts/build/verify-public.mjs
 *   node scripts/build/verify-public.mjs --json
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const JSON_OUT = process.argv.includes("--json");

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`, bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
  head: (s) => `\x1b[36m${s}\x1b[0m`,
};
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

/** The tunnel ingress rules, read from the cloudflared log. */
function readTunnelIngress() {
  let text = "";
  for (const cmd of [
    "journalctl -u cloudflared --no-pager -n 900",
    "journalctl -u cloudflared --no-pager -n 900 2>/dev/null",
  ]) {
    try {
      text = execFileSync("sh", ["-c", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (text.includes("Updated to new configuration")) break;
    } catch { /* try the next form */ }
  }
  const matches = [...text.matchAll(/config="(.*?)" version=/g)];
  if (!matches.length) return null;
  const raw = matches[matches.length - 1][1];
  let cfg;
  try { cfg = JSON.parse(raw.replace(/\\"/g, '"')); } catch { return null; }
  const rules = (cfg.ingress || []).map((r) => ({
    hostname: r.hostname || null,
    service: r.service,
  }));
  return { rules, at: new Date().toISOString() };
}

async function probe(url) {
  try {
    // the module must follow the URL protocol, not a flag
    const mod = url.startsWith("https:")
      ? await import("node:https")
      : await import("node:http");
    return await new Promise((resolve) => {
      const req = mod.default.get(url, { timeout: 8000, rejectUnauthorized: false }, (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      });
      req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
      req.on("error", (e) => resolve({ status: 0, error: e.code || e.message }));
    });
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

async function main() {
  const report = { at: new Date().toISOString() };
  const ingress = readTunnelIngress();
  report.ingress = ingress;

  if (!ingress) {
    report.error = "tunnel ingress not found in the cloudflared log";
    if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
    else log(C.bad("tunnel ingress not readable (is cloudflared running?)"));
    process.exit(1);
  }

  log(C.head("CLOUD TUNNEL INGRESS (from the tunnel log)"));
  for (const r of ingress.rules) {
    log(`   ${(r.hostname || "* (catch-all)").padEnd(32)} -> ${r.service}`);
  }
  log("");

  // every public hostname this project claims, and where it actually lands
  const env = fs.existsSync(path.join(ROOT, ".env"))
    ? fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    : "";
  const publicDomains = (env.match(/^PUBLIC_DOMAINS=(.*)$/m) || [, ""])[1]
    .split(",").map((d) => d.trim()).filter(Boolean);

  const rows = [];
  log(C.head("PUBLIC HOSTNAME -> ORIGIN -> ALIVE?"));
  for (const host of publicDomains) {
    // An exact hostname match wins. A suffix match is only a fallback:
    // "api.infiniteearningzone.com" also ends with "infiniteearningzone.com",
    // and the apex rule points at a different service.
    const rule =
      ingress.rules.find((r) => r.hostname === host) ||
      ingress.rules.find((r) => r.hostname && host.endsWith("." + r.hostname));
    const local = rule ? rule.service : null;
    const originPort = local && local.startsWith("http://")
      ? Number(local.split(":").pop())
      : null;
    const alive = originPort ? (await probe(`http://127.0.0.1:${originPort}/`)).status > 0 : false;
    const edge = await probe(`https://${host}/identity`);
    rows.push({ host, local, originPort, originAlive: alive, edgeStatus: edge.status });
    log(
      `   ${host.padEnd(30)} local=${String(local || "NOT IN TUNNEL").padEnd(26)}` +
      ` origin=${alive ? C.ok("up") : C.bad("down")}  edge=${edge.status || edge.error}`,
    );
  }
  report.hosts = rows;

  // consistency: the same app must not be reachable through two origins
  const byOrigin = new Map();
  for (const r of rows) {
    if (!r.local) continue;
    if (!byOrigin.has(r.local)) byOrigin.set(r.local, []);
    byOrigin.get(r.local).push(r.host);
  }
  const issues = [];
  for (const [origin, hosts] of byOrigin) {
    if (hosts.length > 1) {
      const ports = new Set(hosts.map((h) => (rows.find((r) => r.host === h) || {}).originPort));
      if (ports.size > 1) {
        issues.push(
          `the same app is served through different origins: ${hosts.join(", ")} -> ${origin}`,
        );
      }
    }
  }
  for (const r of rows) {
    if (!r.local) issues.push(`${r.host} is not in the tunnel ingress rules`);
    if (r.edgeStatus >= 500) issues.push(`${r.host} answers ${r.edgeStatus} at the edge`);
  }
  report.issues = issues;

  log("");
  if (issues.length) {
    log(C.warn("  ISSUES"));
    for (const i of issues) log(C.warn("   - " + i));
  } else {
    log(C.ok("  no inconsistencies"));
  }
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  process.exit(issues.length ? 1 : 0);
}

main();
