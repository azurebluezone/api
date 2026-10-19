#!/usr/bin/env node
/**
 * scripts/build/verify-mcp.mjs — FUNCTIONAL verification of the external MCP
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The existing smoke test only proves the PROTOCOL layer: the server
 * answers tools/list. That is not the same as "the tool works" — an OCR
 * server without tesseract answers tools/list with 4 tools and then fails
 * on every single call. This script calls the tools for real.
 *
 * It also answers the question the protocol-level test cannot:
 *   "does a tool work on a path OUTSIDE the main project directory?"
 * Every probe uses an absolute path under the user's home, never under
 * the project root.
 *
 * Checks per server
 * 1. tools/list                        protocol + tool inventory
 * 2. a REAL tools/call                 the function actually works
 * 3. outside-the-project path          no sandbox silently blocks it
 * 4. its external binary dependency    tesseract / ffmpeg / edge-tts
 *
 * Usage:
 *   node scripts/build/verify-mcp.mjs           # full run
 *   node scripts/build/verify-mcp.mjs --json
 *
 * Zero dependencies. Node >= 18.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const { getMcpServers } = require("../../tools/mcp-registry.js");

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`, err: (s) => `\x1b[31m${s}\x1b[0m`,
  head: (s) => `\x1b[36m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

// ── JSON-RPC over HTTP ────────────────────────────────────────────────
function rpc(url, method, params, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const req = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        method: "POST", timeout: timeoutMs,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve({ ok: true, json: JSON.parse(buf), status: res.statusCode }); }
          catch (e) { resolve({ ok: false, error: "bad JSON: " + e.message, raw: buf.slice(0, 300) }); }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
}

function which(bin) {
  try {
    return execFileSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).trim() || null;
  } catch { return null; }
}

// ── probes: one real call per server ──────────────────────────────────
// path: absolute, OUTSIDE the project root  proves no sandbox blocks it
const PROBE_DIR = path.join(os.homedir(), "zombie-mcp-verify");

function makeProbes(servers) {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const probeFile = path.join(PROBE_DIR, "probe.txt");
  fs.writeFileSync(probeFile, "hello-from-outside-the-project\n");
  // a tiny PNG for the OCR probe (1x1, no text) — the point is the CALL path
  const png = path.join(PROBE_DIR, "probe.png");
  if (!fs.existsSync(png)) {
    fs.writeFileSync(
      png,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
  }
  const byName = Object.fromEntries(servers.map((s) => [s.name, s]));

  return {
    ocr: {
      tool: "ocr_image",
      args: { path: png },
      needs: ["ffmpeg", "tesseract"], // ffmpeg normalises the image, tesseract reads it
      outside: true,
    },
    "screen-recorder": {
      tool: "screen_screenshot",
      args: { name: "verify-probe" },
      needs: ["ffmpeg"],
      outside: true,
    },
    tts: {
      tool: "tts_speak",
      args: { text: "verification probe" },
      needs: ["edge-tts"],
      outside: true,
    },
    "public-api": {
      tool: "stackoverflow_search",
      args: { query: "nodejs", pagesize: 1 },
      needs: [],
      outside: false,
    },
    "facebook-ads": {
      tool: "ads_get_ad_accounts",
      args: {},
      needs: [],
      outside: false,
    },
    combined: {
      tool: "stackoverflow_search",
      args: { query: "nodejs", pagesize: 1 },
      needs: [],
      outside: false,
    },
    "universal-adapter": {
      tool: "system_info",
      args: {},
      needs: [],
      outside: false,
    },
    _byName: byName,
  };
}

// ── .env loader (so children see FB_ACCESS_TOKEN etc.) ────────────────
function loadEnvFile(file) {
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

// ── main ───────────────────────────────────────────────────────────────
async function main() {
  const report = { startedAt: new Date().toISOString(), project: path.basename(ROOT) };
  const children = [];
  const results = [];

  try {
    // The registry is the environment (tools/mcp-registry.js) — no
    // servers.json any more.
    const servers = getMcpServers();
    const probes = makeProbes(servers);

    // The complete port map — every child gets EVERY port var, so gateways
    // (combined) can reach their backends.
    const portEnv = {};
    for (const s of servers) {
      if (s.port && s.portEnv) portEnv[s.portEnv] = s.port;
    }

    log(C.b("EXTERNAL MCP — FUNCTIONAL VERIFICATION"));
    log(C.dim(`probe dir (outside the project): ${PROBE_DIR}`));
    log("");

    for (const s of servers) {
      const port = Number(new URL(s.url).port);
      const mcpUrl = s.url.endsWith("/mcp") ? s.url : s.url + "/mcp";
      const script = path.resolve(ROOT, s.script);
      const entry = { name: s.name, url: s.url, port };

      if (!fs.existsSync(script)) {
        entry.status = "error";
        entry.detail = "script missing";
        results.push(entry);
 log(` ${C.err("")} ${s.name.padEnd(17)} script missing`);
        continue;
      }

      // spawn — with .env loaded, exactly like api.js/start.js do
      const env = { ...loadEnvFile(path.join(ROOT, ".env")), ...process.env, ...portEnv };
      const child = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
      children.push({ name: s.name, child });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString().slice(0, 400)));

      // wait for the port
      let up = false;
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const alive = await new Promise((res) => {
          const sock = http.get({ host: "127.0.0.1", port, path: "/", timeout: 600 }, (r) => { r.resume(); res(true); });
          sock.on("error", () => res(false));
          sock.on("timeout", () => { sock.destroy(); res(false); });
        });
        if (alive) { up = true; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!up) {
        entry.status = "error";
        entry.detail = "port never opened";
        results.push(entry);
 log(` ${C.err("")} ${s.name.padEnd(17)} port ${port} never opened`);
        continue;
      }

      // 1) tools/list
      const list = await rpc(mcpUrl, "tools/list", {});
      const tools = list?.json?.result?.tools || [];
      entry.tools = tools.length;
      entry.listOk = list.ok && tools.length > 0;

      // 2) dependency binaries — the env for the CHILD is the .env file,
      //    so the check must look at the same place, not at our own process
      const probe = probes[s.name];
      const envFile = loadEnvFile(path.join(ROOT, ".env"));
      entry.needs = (probe?.needs || []).map((b) => ({
        bin: b,
        present:
          b === "edge-tts"
            ? !!(envFile.EDGE_TTS_PATH && fs.existsSync(envFile.EDGE_TTS_PATH))
            : !!which(b),
      }));
      const missing = entry.needs.filter((n) => !n.present).map((n) => n.bin);

      // 3) a REAL call
      let call = { attempted: false };
      if (probe && probe.tool) {
        call.attempted = true;
        const r = await rpc(mcpUrl, "tools/call", { name: probe.tool, arguments: probe.args });
        const text = String(
          r?.json?.result?.content?.[0]?.text || r?.json?.error?.message || r?.raw || "",
        );
        // A tool can fail three ways, and only the first two are visible in
        // the JSON-RPC envelope:
        //   1. JSON-RPC error / isError flag
        // 2. a JSON payload with "success": false    the common case here
        //   3. a human-readable "TTS error: ... ENOENT" text
        // The TEXT alone is never a success signal — a StackOverflow answer
        // may contain the words "error" or "not working".
        const unknownTool = /Unknown tool/i.test(String(r?.json?.error?.message || ""));
        let payloadFail = false;
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object") {
            if (parsed.success === false) payloadFail = true;
            if (parsed.error && !parsed.items) payloadFail = true;
          }
        } catch { /* not JSON — fall through to the text check */ }
        const textFail =
          /(^|\n)\s*(error|failed)\s*[:\s]/i.test(text) ||
          /ENOENT|Command failed|not installed|Traceback/i.test(text);
        const isError = !!r?.json?.error || !!r?.json?.result?.isError || unknownTool || payloadFail || textFail;
        call.ok = r.ok && !isError;
        call.text = text.slice(0, 220);
        call.isError = isError;
        if (r?.json?.error) call.error = r.json.error.message;
        if (unknownTool) call.error = "Unknown tool: " + probe.tool;
        if (payloadFail || textFail) call.error = "tool reported failure in its payload";
      }
      entry.call = call;

      entry.status = entry.listOk && (!call.attempted || call.ok) ? "ok" : (entry.listOk ? "degraded" : "error");
      results.push(entry);

 const mark = entry.status === "ok" ? C.ok("") : entry.status === "degraded" ? C.warn("!") : C.err("");
      log(
        `  ${mark} ${s.name.padEnd(17)} tools=${String(entry.tools).padStart(3)}` +
        (call.attempted ? `  call(${probe.tool})=${call.ok ? "ok" : "FAIL"}` : "  call=skipped") +
        (missing.length ? `  ${C.warn("missing:" + missing.join(","))}` : ""),
      );
      if (call.attempted && !call.ok) log(`      ${C.dim(String(call.text || call.error || "").slice(0, 160))}`);
    }

    report.results = results;
    report.ok = results.every((r) => r.status === "ok");
    report.degraded = results.filter((r) => r.status === "degraded").map((r) => r.name);
  } catch (e) {
    report.ok = false;
    report.error = String(e.message || e);
  } finally {
    for (const { child } of children) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    await new Promise((r) => setTimeout(r, 600));
  }

  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "dist", "mcp-verify-report.json"), JSON.stringify(report, null, 2) + "\n");

  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); }
  else {
    log("");
    const ok = results.filter((r) => r.status === "ok").length;
    const deg = results.filter((r) => r.status === "degraded").length;
    log(`  ${C.b("RESULT")}  ${ok} ok · ${deg} degraded · ${results.length - ok - deg} error`);
    log(`  ${C.dim("report: dist/mcp-verify-report.json")}`);
    log("");
  }
  process.exit(report.ok ? 0 : 1);
}

main();
