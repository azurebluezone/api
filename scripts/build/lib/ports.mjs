/**
 * lib/ports.mjs — per-project port allocation.
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
 *   3. Every candidate port is probed against the LIVE listener table
 *      (/proc/net/tcp + /proc/net/tcp6). If anything in the block is busy
 *      the allocator walks to the next block until it finds a free one.
 *
 * Zero dependencies. Node >= 18.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";

export const PORT_WINDOW_START = 15000;
export const PORT_WINDOW_END = 17999;
export const PORT_STRIDE = 20;
export const MAX_BLOCK_ATTEMPTS = 64;

/** Parse LISTEN sockets out of /proc/net/tcp{,6}  Set<number>. */
export function readLiveListenPorts() {
  const ports = new Set();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const local = cols[1];
      const state = cols[3];
      if (state !== "0A") continue; // 0A = TCP_LISTEN
      const hex = local.split(":")[1];
      if (!hex) continue;
      const port = parseInt(hex, 16);
      if (Number.isFinite(port)) ports.add(port);
    }
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

/**
 * The service names this project ships, in a stable order.
 * Every service owns TWO ports inside the block: a plain HTTP port (the
 * Node process) and a TLS port (the nginx terminator in front of it).
 * Offsets are 1-based inside the block; the block itself is stride-aligned.
 */
export const SERVICE_PLAN = [
  { name: "api",     http: 1,  tls: 2,  desc: "Gateway HTTP (api.js)" },
  { name: "mcp",     http: 3,  tls: 4,  desc: "MCP gateway" },
  { name: "bridge",  http: 5,  tls: 6,  desc: "local-llm-bridge (llama/ollama)" },
  { name: "ocr",     http: 7,  tls: 8,  desc: "OCR MCP server" },
  { name: "screen",  http: 9,  tls: 10, desc: "screen-recorder MCP server" },
  { name: "tts",     http: 11, tls: 12, desc: "TTS MCP server" },
  { name: "adapter", http: 13, tls: 14, desc: "universal-adapter" },
  { name: "admin",   http: 15, tls: 16, desc: "admin/metrics endpoint" },
  // The PHP broker (external tools/php-broker-server.js) binds a plain HTTP
  // port. It MUST be inside the project block: its old default 9999 is
  // already taken by another ZombieCoder instance on this machine, and the
  // collision killed our start script with a raw EADDRINUSE.
  { name: "broker",  http: 17, tls: null, desc: "PHP broker (appsp-internal-connection)" },
];

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

  const h = projectHash(projectRoot);
  const firstBlock = h % blocks;

  for (let attempt = 0; attempt < Math.min(MAX_BLOCK_ATTEMPTS, blocks); attempt++) {
    const blockIdx = (firstBlock + attempt) % blocks;
    const base = start + blockIdx * stride;
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
      return { base, ports, services, attempts: attempt + 1, live: live.size, blockIndex: blockIdx };
    }
  }
  throw new Error(
    "no free port block in " + start + "-" + end + " after " + MAX_BLOCK_ATTEMPTS + " attempts",
  );
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
