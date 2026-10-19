// =============================================================================
// Mission Barisal v3 — External MCP Loader
// Loads external MCP servers from TWO sources:
//   1) the MCP REGISTRY — environment-driven (tools/mcp-registry.js)
//   2) direct URLs from EXTERNAL_MCP_URLS env         (comma-separated)
// Uses MCPClientManager (mcp-client.js) for the actual JSON-RPC connection.
// =============================================================================

const path = require("path");
const fs = require("fs");
const { MCPClientManager } = require("./mcp-client.js");

const { getMcpServers } = require("./tools/mcp-registry.js");

let manager = null;

// ─── Load server definitions from the MCP registry (environment) ──
function loadFromFolder() {
  const servers = [];
  try {
    const list = getMcpServers();
    for (const s of list) {
      if (!s || !s.url) continue;
      servers.push({
        name: s.name,
        url: s.url,
        transport: s.transport || "http",
        token: s.token || "",
        autoConnect: s.autoConnect !== false,
        source: "registry",
      });
    }
    console.log("[EXTERNAL_MCP] registry: " + servers.length + " server(s)");
  } catch (e) {
    console.warn("[EXTERNAL_MCP] registry read failed: " + e.message);
  }
  return servers;
}

// ─── Load server definitions from EXTERNAL_MCP_URLS env ──────
function loadFromUrls() {
  const servers = [];
  const raw = (process.env.EXTERNAL_MCP_URLS || "").trim();
  if (!raw) return servers;
  const urls = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  for (const url of urls) {
    servers.push({
      name: hostFromUrl(url),
      url,
      transport: "http",
      token: "",
      autoConnect: true,
      source: "url",
    });
  }
  console.log("[EXTERNAL_MCP] env URLs: " + servers.length + " server(s)");
  return servers;
}

function hostFromUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host.replace(/[^a-z0-9]/gi, "-");
  } catch (e) {
    return "external-" + Math.random().toString(36).slice(2, 8);
  }
}

// ─── Connect all servers via MCPClientManager ────────────────
async function loadAll() {
  if (!manager) manager = new MCPClientManager(console.log);
  const defs = [...loadFromFolder(), ...loadFromUrls()];
  const results = [];
  for (const def of defs) {
    try {
      const res = await manager.connectServer(def.name, def.url, {
        transport: def.transport,
        token: def.token,
        autoConnect: def.autoConnect,
      });
      results.push({ name: def.name, ...res, source: def.source });
    } catch (e) {
      results.push({ name: def.name, error: e.message, source: def.source });
    }
  }
  return results;
}

// ─── Tools from all connected external servers ───────────────
function getAllTools() {
  return manager ? manager.getAllExternalTools() : [];
}

// ─── Call an external tool: <server>__<tool> ─────────────────
async function call(name, tool, args) {
  return manager ? manager.callExternalTool(name, tool, args || {}) : null;
}

// ─── Parse a full tool name like  server__tool  ──────────────
function parseToolName(fullName) {
  const idx = fullName.indexOf("__");
  if (idx === -1) return null;
  return { server: fullName.slice(0, idx), tool: fullName.slice(idx + 2) };
}

// ─── Server status list (for /api/mcp-external) ──────────────
function getStatus() {
  return manager
    ? manager.listServers().map((s) => ({
        name: s.name,
        url: s.url,
        status: s.status,
        tools: (s.tools || []).length,
        lastSeen: s.lastSeen,
        error: s.error || null,
      }))
    : [];
}

function getManager() {
  return manager;
}

module.exports = {
  loadAll,
  getAllTools,
  call,
  parseToolName,
  getStatus,
  getManager,
  // The registry is the environment now (tools/mcp-registry.js) — there is
  // no config file to point at.
  getServers: () => require("./tools/mcp-registry.js").getMcpServers(),
};