"use strict";
/**
 * tools/mcp-registry.js — THE ONE registry of external MCP servers.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The registry used to live in "external mcp/servers.json". A JSON file is
 * a second source of truth: it drifts from the environment, it can carry a
 * credential (a 249-character Facebook token once lived there), and it is
 * not covered by the .env rules the rest of the project follows.
 *
 * Now the ENVIRONMENT is the registry. One numbered block per server:
 *
 *   MCP_<N>_NAME       unique id (also the tool-name prefix)
 *   MCP_<N>_SCRIPT     server script, relative to the project root
 *   MCP_<N>_PORT       loopback port it listens on
 *   MCP_<N>_PORT_ENV   the env var the SCRIPT itself reads for its port
 *   MCP_<N>_PATH       URL path on that port (default /mcp)
 *   MCP_<N>_ENABLED    true | false
 *   MCP_<N>_TOKEN      optional bearer token for the MCP client
 *   MCP_<N>_DESC       one-line description
 *
 * MCP_<N>_PORT_ENV matters: the orchestrator and the script must agree on
 * the port, and the script's own variable name is a property of the
 * script — not something a registry may guess.
 *
 * Zero dependencies. Node >= 18.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/** Minimal .env parser — the same shape api.js uses. */
// ── SECTION: mcp-registry ──
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
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    if (k) out[k] = v;
  }
  return out;
}

/** process.env wins over .env (a real environment always wins). */
function readEnv() {
  const file = loadEnvFile(path.join(ROOT, ".env"));
  const out = Object.assign({}, file);
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

/** Derive the env var a script is expected to read for its port. */
function defaultPortEnv(name) {
  return (
    String(name || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") + "_MCP_PORT"
  );
}

/**
 * The registry, in declaration order.
 * @returns {Array<{name,script,port,portEnv,url,path,desc,token,enabled,local}>}
 */
function getMcpServers(opts = {}) {
  const env = readEnv();
  const byIndex = new Map();

  for (const [key, value] of Object.entries(env)) {
    const m = /^MCP_(\d+)_(.+)$/.exec(key);
    if (!m) continue;
    const idx = Number(m[1]);
    if (!Number.isFinite(idx)) continue;
    if (!byIndex.has(idx)) byIndex.set(idx, {});
    byIndex.get(idx)[m[2].toUpperCase()] = value;
  }

  const out = [];
  for (const idx of [...byIndex.keys()].sort((a, b) => a - b)) {
    const e = byIndex.get(idx);
    const name = String(e.NAME || "").trim();
    const script = String(e.SCRIPT || "").trim();
    const port = parseInt(e.PORT || "0", 10);
    if (!name || !script || !port) continue;
    if (String(e.ENABLED || "true").trim().toLowerCase() === "false") continue;

    const urlPath = String(e.PATH || "/mcp").trim() || "/mcp";
    const urlPathClean = urlPath === "/" ? "" : "/" + urlPath.replace(/^\/+|\/+$/g, "");
    out.push({
      name,
      script: path.resolve(ROOT, script),
      scriptRel: script,
      port,
      portEnv: String(e.PORT_ENV || "").trim() || defaultPortEnv(name),
      path: urlPathClean || "/",
      mcpPath: urlPathClean || "/",
      url: `http://127.0.0.1:${port}${urlPathClean}`,
      desc: String(e.DESC || "").trim(),
      token: String(e.TOKEN || "").trim(),
      enabled: true,
      local: true,
      transport: "http",
      autoConnect: String(e.AUTO_CONNECT || "true").trim().toLowerCase() !== "false",
      index: idx,
    });
  }

  if (opts.includeDisabled) {
    // the disabled ones are useful for the admin view
    for (const idx of [...byIndex.keys()].sort((a, b) => a - b)) {
      const e = byIndex.get(idx);
      const name = String(e.NAME || "").trim();
      const script = String(e.SCRIPT || "").trim();
      const port = parseInt(e.PORT || "0", 10);
      if (!name || !script || !port) continue;
      if (String(e.ENABLED || "true").trim().toLowerCase() !== "false") continue;
      const urlPath = String(e.PATH || "/mcp").trim() || "/mcp";
      const urlPathClean = urlPath === "/" ? "" : "/" + urlPath.replace(/^\/+|\/+$/g, "");
      out.push({
        name,
        script: path.resolve(ROOT, script),
        scriptRel: script,
        port,
        portEnv: String(e.PORT_ENV || "").trim() || defaultPortEnv(name),
        path: urlPathClean || "/",
        mcpPath: urlPathClean || "/",
      mcpPath: urlPathClean || "/",
        url: `http://127.0.0.1:${port}${urlPathClean}`,
        desc: String(e.DESC || "").trim(),
        token: String(e.TOKEN || "").trim(),
        enabled: false,
        local: true,
        transport: "http",
        autoConnect: false,
        index: idx,
      });
    }
    out.sort((a, b) => a.index - b.index);
  }

  return out;
}

/** name  entry */
function getMcpServerByName(name, opts) {
  return getMcpServers(opts).find((s) => s.name === name) || null;
}

module.exports = { getMcpServers, getMcpServerByName, readEnv, loadEnvFile, defaultPortEnv, ROOT };
// ── END SECTION: mcp-registry ──
