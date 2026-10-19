/**
 * scripts/build/lib/ports.mjs — per-project port allocation.
 *
 * Goal: every project instance on this machine gets its OWN port block, so
 * two instances of the same app (or two different projects) can never mix
 * traffic, and a build never lands on a port that is already taken.
 *
 * Method
 *   1. hash(projectRootPath) -> deterministic offset. The same project
 *      always gets the same block (reproducible builds); a different
 *      project on the same machine gets a different one.
 *   2. The block is a stride-aligned range inside a reserved window, so
 *      each project owns a contiguous set of ports.
 *   3. Every candidate port is checked against the LIVE listener table
 *      before it is handed out. The table is read in the way the platform
 *      provides it: /proc/net/tcp on Linux, netstat on Windows and macOS.
 *
 * Zero dependencies. Node >= 18.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const PORT_WINDOW_START = 15000;
export const PORT_WINDOW_END = 17999;
export const PORT_STRIDE = 20;
export const MAX_BLOCK_ATTEMPTS = 64;

/**
 * The services this project ships, in a stable order.
 * Every service owns TWO ports inside the block: a plain HTTP port (the
 * Node process) and a TLS port (the nginx terminator in front of it).
 * Offsets are 1-based inside the block; the block itself is stride-aligned.
 */
export const SERVICE_PLAN = [
  { name: "api",     http: 1,  tls: 2,  desc: "Gateway (api.js)" },
  { name: "mcp",     http: 3,  tls: 4,  desc: "MCP gateway" },
  { name: "bridge",  http: 5,  tls: 6,  desc: "local-llm-bridge (llama / ollama)" },
  { name: "ocr",     http: 7,  tls: 8,  desc: "OCR MCP server" },
  { name: "screen",  http: 9,  tls: 10, desc: "screen-recorder MCP server" },
  { name: "tts",     http: 11, tls: 12, desc: "TTS MCP server" },
  { name: "adapter", http: 13, tls: 14, desc: "universal-adapter" },
  { name: "admin",   http: 15, tls: 16, desc: "admin/metrics endpoint" },
  { name: "broker",  http: 17, tls: null, desc: "PHP broker (appsp-internal-connection)" },
];

/** The listeners of this machine, in the way the platform reports them. */
export function readLiveListenPorts() {
  const ports = new Set();
  if (process.platform === "linux") {
    for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let text;
      try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
      for (const line of text.split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) continue;
        if (cols[3] !== "0A") continue; // 0A = TCP_LISTEN
        const hex = cols[1].split(":")[1];
        if (!hex) continue;
        const port = parseInt(hex, 16);
        if (Number.isFinite(port)) ports.add(port);
      }
    }
    return ports;
  }

  // Windows and macOS: netstat reports the listening ports.
  for (const cmd of ["netstat -ano", "netstat -an"]) {
    try {
      const out = execFileSync("sh", ["-c", cmd], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of out.split("\n")) {
        if (!/LISTEN|LISTENING/i.test(line)) continue;
        const m = line.match(/:(\d{2,5})\s/);
        if (!m) continue;
        const port = parseInt(m[1], 10);
        if (Number.isFinite(port)) ports.add(port);
      }
      if (ports.size) return ports;
    } catch { /* try the next form */ }
  }
  return ports;
}

/** TCP connect probe — true when nothing is accepting on that port. */
export function isPortFree(port, host = "127.0.0.1", timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (free) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* already closed */ }
      resolve(free);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(false));
    sock.once("timeout", () => done(true));
    sock.once("error", () => done(true));
    sock.connect(port, host);
  });
}

function readEnvForPorts() {
  try {
    const file = path.join(ROOT_DIR, ".env");
    if (!fs.existsSync(file)) return process.env;
    const out = { ...process.env };
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      if (k && !out[k]) out[k] = t.slice(eq + 1).trim();
    }
    return out;
  } catch {
    return process.env;
  }
}


/**
 * The port registry: which block belongs to which project on this machine.
 *
 * The live-listener check is not enough: two instances that allocate at the
 * same moment would pick the same block, because neither is listening yet.
 * With 50 instances and 149 blocks the birthday paradox alone produced 119
 * overlaps. The registry closes that hole: a block is reserved for a
 * project the moment it is allocated, and a stale entry (a project folder
 * that no longer exists) is released.
 */
const REGISTRY_FILE = path.join(
  os.homedir(),
  ".zombiecoder",
  "ports.json",
);

function readRegistry() {
  try {
    const j = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function writeRegistry(reg) {
  try {
    fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
  } catch { /* the registry is a convenience, not a requirement */ }
}

/**
 * Drop entries that are stale: a project folder that is gone AND an entry
 * that has not been touched for a day. A folder that does not exist yet
 * (an instance that is about to be created) must keep its reservation.
 */
const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
function pruneRegistry(reg) {
  const out = {};
  const now = Date.now();
  for (const [base, entry] of Object.entries(reg)) {
    if (!entry || !entry.project) continue;
    const age = now - Date.parse(entry.at || 0);
    if (fs.existsSync(entry.project) || (Number.isFinite(age) && age < REGISTRY_TTL_MS)) {
      out[base] = entry;
    }
  }
  return out;
}

function projectHash(projectRoot) {
  return crypto
    .createHash("sha256")
    .update(path.resolve(projectRoot))
    .digest()
    .readUInt32BE(0);
}

/**
 * Allocate a conflict-free port block for this project.
 * @returns {Promise<{base:number, ports:Object, services:Array, attempts:number, live:number}>}
 */
export async function allocatePorts(projectRoot, opts = {}) {
  const start = opts.start ?? PORT_WINDOW_START;
  const end = opts.end ?? PORT_WINDOW_END;
  const stride = opts.stride ?? PORT_STRIDE;
  const plan = opts.plan ?? SERVICE_PLAN;

  const live = readLiveListenPorts();
  const blocks = Math.floor((end - start) / stride);
  if (blocks < 1) throw new Error("port window too small");

  const registry = pruneRegistry(readRegistry());
  const resolvedRoot = path.resolve(projectRoot);
  const h = projectHash(projectRoot);
  const firstBlock = h % blocks;

  for (let attempt = 0; attempt < Math.min(MAX_BLOCK_ATTEMPTS, blocks); attempt++) {
    const blockIdx = (firstBlock + attempt) % blocks;
    const base = start + blockIdx * stride;

    // a block already reserved for another project is not ours
    const reserved = registry[String(base)];
    if (reserved && reserved.project && path.resolve(reserved.project) !== resolvedRoot) {
      continue;
    }

    const wanted = [];
    for (const s of plan) {
      wanted.push(base + s.http);
      if (s.tls) wanted.push(base + s.tls);
    }
    const conflict = wanted.find((p) => live.has(p));
    if (conflict === undefined) {
      const ports = {};
      const services = plan.map((s) => {
        const entry = {
          name: s.name,
          desc: s.desc,
          httpPort: base + s.http,
          tlsPort: s.tls ? base + s.tls : null,
        };
        ports[s.name] = { http: entry.httpPort, tls: entry.tlsPort };
        return entry;
      });
      registry[String(base)] = {
        project: resolvedRoot,
        at: new Date().toISOString(),
        ports: services.length,
      };
      writeRegistry(registry);
      return { base, ports, services, attempts: attempt + 1, live: live.size, blockIndex: blockIdx };
    }
  }
  throw new Error(
    "no free port block in " + start + "-" + end + " after " + MAX_BLOCK_ATTEMPTS + " attempts",
  );
}

/**
 * The port block of a project, by service name.
 * Used by a SECONDARY instance: it asks for its own block so it never
 * touches the primary instance's ports.
 */
export function getBlockPorts(projectRoot, opts = {}) {
  const plan = opts.plan ?? SERVICE_PLAN;
  const env = readEnvForPorts();
  const primary = (env.PORT || "5050") === "5050";
  if (primary) return null;
  const start = opts.start ?? PORT_WINDOW_START;
  const end = opts.end ?? PORT_WINDOW_END;
  const stride = opts.stride ?? PORT_STRIDE;
  const blocks = Math.floor((end - start) / stride);
  const h = projectHash(projectRoot);
  const base = start + (h % blocks) * stride;
  const out = {};
  for (const s of plan) {
    out[s.name] = { http: base + s.http, tls: s.tls ? base + s.tls : null };
  }
  return out;
}

/** Verify every allocated port is still free (double-check right before use). */
export async function assertPortsFree(ports) {
  const busy = [];
  for (const [name, pair] of Object.entries(ports)) {
    for (const port of [pair.http, pair.tls]) {
      if (!port) continue;
      const free = await isPortFree(port);
      if (!free) busy.push(`${name}:${port}`);
    }
  }
  if (busy.length) {
    throw new Error("port(s) already in use: " + busy.join(", "));
  }
  return true;
}
