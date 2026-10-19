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
 * The values are READ AT USE TIME (getters), not at import time. A module
 * that is imported before the .env is loaded would otherwise freeze the
 * fallback value into the process - which is exactly how a fresh clone
 * tried to bind 5050 while another instance already owned it.
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
  get api() { return int(process.env.PORT, 5050); },
  // Unix domain socket fallback (Windows TCP fallback uses api + 1).
  get uds() { return int(process.env.UDS_PORT, 5150); },
  // The local model bridge (llama.cpp / ollama).
  get bridge() { return int(process.env.BRIDGE_PORT, 11435); },
  // Universal adapter: plain HTTP and TLS.
  get adapterHttp() { return int(process.env.ADAPTER_HTTP_PORT, 5400); },
  get adapterHttps() { return int(process.env.ADAPTER_HTTPS_PORT, 5443); },
};

module.exports = { PORTS, int };
