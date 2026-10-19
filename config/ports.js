"use strict";
/**
 * config/ports.js — the ONE place a port number is decided.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Every port comes from the environment. The value below is the fallback
 * for a machine with no .env, and it is the same number everywhere:
 *
 *   5050 — the gateway (api.js / start.js)
 *
 * A second instance on the same computer changes .env, not the code. That
 * is the whole point: fifty instances, fifty port blocks, zero clashes and
 * zero edits.
 *
 * The instance-unique block (a second copy of the app, its MCP servers, its
 * bridge) is allocated by scripts/build/lib/ports.mjs from the project
 * path, so it never collides with the primary instance.
 */

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
}

const PORTS = {
  // The gateway. This is the canonical number of the application.
  api: int(process.env.PORT, 5050),
  // Unix domain socket fallback (Windows TCP fallback uses api + 1).
  uds: int(process.env.UDS_PORT, 5150),
  // The local model bridge (llama.cpp / ollama).
  bridge: int(process.env.BRIDGE_PORT, 11435),
  // Universal adapter: plain HTTP and TLS.
  adapterHttp: int(process.env.ADAPTER_HTTP_PORT, 5400),
  adapterHttps: int(process.env.ADAPTER_HTTPS_PORT, 5443),
};

module.exports = { PORTS, int };
