/**
 * scripts/build/lib/edge-services.mjs — the services the TLS edge exposes.
 *
 * ONE definition, used by the renderer (install-nginx-site.mjs) and by the
 * verifier (tls-verify.mjs). Before this, each script built its own
 * list and the two drifted - the verifier checked services the renderer
 * never created, and the renderer created routes the verifier never
 * checked.
 *
 * The rule:
 *   • every MCP server in the registry (tools/mcp-registry.js) becomes a
 *     route, automatically - adding a server to the environment adds its
 *     TLS route, with its own certificate
 *   • the two exceptions are written down here and only here: the gateway
 *     and the local model bridge. They are not MCP servers, so the
 *     registry does not know about them.
 */

const EXCEPTIONS = [
  // Exception 1 of 2: the gateway. It carries two server names - the
  // public ones and the MCP name - because /mcp lives on the same port.
  {
    name: "api",
    desc: "Gateway (api.js) and its /mcp tool endpoint",
    envKey: "PORT",
    fallbackPort: 5050,
    public: true,
    alsoNames: ["mcp"],
  },
  // Exception 2 of 2: the local model bridge. Not an MCP server, so the
  // registry does not know about it.
  {
    name: "bridge",
    desc: "local-llm-bridge (llama / ollama)",
    envKey: "BRIDGE_PORT",
    fallbackPort: 11435,
    public: false,
  },
];

/**
 * @param {object} env        the merged environment
 * @param {Array}  mcpServers the MCP registry entries
 * @returns {Array} the edge services, in a stable order
 */
export function edgeServices(env = {}, mcpServers = []) {
  const out = [];
  const ports = {};

  for (const ex of EXCEPTIONS) {
    const port = parseInt(env[ex.envKey] || "", 10) || ex.fallbackPort;
    ports[ex.name] = port;
    out.push({
      name: ex.name,
      desc: ex.desc,
      port: String(port),
      public: !!ex.public,
      exception: true,
      alsoNames: ex.alsoNames || [],
    });
  }

  for (const s of mcpServers) {
    if (!s || !s.name || !s.port) continue;
    out.push({
      name: s.name,
      desc: s.desc || s.name,
      port: String(s.port),
      public: false,
      exception: false,
    });
  }

  return out;
}

export { EXCEPTIONS };
