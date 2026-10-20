"use strict";
/**
 * config/providers.js — the ONE provider registry and the ONE resolution
 * ladder.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Every model this system can reach is an entry in the same list, with the
 * same fields. There is no separate path for "the local model", "a free
 * model" or "a local agent": they are providers with a different `kind`
 * and `tier`, and they are reached by exactly the same code.
 *
 *   kind   cloud  a remote API (Groq, Gemini, OpenCode, a custom gateway)
 *          local  runs on this machine (the Ollama bridge, the adapter)
 *          agent  a local agent that answers with the MCP tool set
 *   tier   free   costs nothing
 *          paid   costs money
 *          local  costs nothing, runs here
 *
 * The ladder (config/providers.js resolveLadder) is the same for every
 * caller - a chat, a tool call, an agent, a fallback:
 *
 *   1. the model that was asked for
 *   2. a free model
 *   3. the local model
 *   4. the local agent
 *   5. nothing - the caller reports it honestly
 *
 * A provider whose key is missing is switched OFF here, so it can never be
 * half-configured in one place and alive in another.
 */

const DEFAULT_PORT = 5050;

/** A placeholder is not a credential. */
function cleanKey(value) {
  const v = String(value || "").trim();
  if (/^(<.*>|\{\{.*\}\}|YOUR_|CHANGEME|xxx+)$/i.test(v)) return "";
  return v;
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
}

/** "gemini-flash=>gemini-3.6-flash" → public name + api model. */
function parseModelEntry(entry) {
  const arrow = String(entry).indexOf("=>");
  if (arrow > 0) {
    return {
      name: entry.slice(0, arrow).trim(),
      apiModel: entry.slice(arrow + 2).trim(),
    };
  }
  return entry;
}

function parseModels(list) {
  return String(list || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseModelEntry);
}

/** A model id that costs nothing. */
function isFreeModel(id) {
  return /(^|[-_/])free([-_]|$)/i.test(String(id || ""));
}

function isLocalModel(id) {
  return /ollama|local|llama|qwen|gemma|mistral|phi|deepseek-r1/i.test(String(id || ""));
}

/**
 * Build the registry from the environment.
 * @param {object} env  the environment (already merged with .env)
 * @param {object} [extra] { agentModels: {agentId: model} }
 */
function buildProviders(env, extra = {}) {
  const out = [];
  const e = env || {};
  const apiPort = int(e.PORT, DEFAULT_PORT);

  const add = (p) => {
    if (!p) return;
    out.push({
      id: p.id,
      name: p.name,
      kind: p.kind || "cloud",
      tier: p.tier || "paid",
      baseUrl: p.baseUrl || "",
      key: cleanKey(p.key),
      type: p.type || "openai",
      dialect: p.dialect || "",
      models: p.models || [],
      priority: int(p.priority, 999),
      local: !!p.local,
      needsKey: !!p.needsKey,
      enabled: p.enabled !== false,
      agentId: p.agentId || null,
    });
  };

  // ── cloud providers ────────────────────────────────────────────────
  add({
    id: "opencode",
    name: "OpenCode",
    kind: "cloud",
    tier: e.OPENCODE_TIER || "paid",
    baseUrl: e.OPENCODE_BASE || "https://opencode.ai/zen/v1",
    key: e.OPENCODE_API_KEY || "",
    type: "opencode",
    models: parseModels(e.OPENCODE_MODELS),
    priority: int(e.OPENCODE_PRIORITY, 999),
    needsKey: true,
  });
  add({
    id: "groq",
    name: "Groq",
    kind: "cloud",
    tier: e.GROQ_TIER || "paid",
    baseUrl: e.GROQ_BASE || "https://api.groq.com/openai/v1",
    key: e.GROQ_API_KEY || "",
    type: "groq",
    models: parseModels(e.GROQ_MODELS),
    priority: int(e.GROQ_PRIORITY, 999),
    needsKey: true,
  });
  add({
    id: "gemini",
    name: "Gemini",
    kind: "cloud",
    tier: e.GEMINI_TIER || "paid",
    baseUrl: e.GEMINI_BASE || "https://generativelanguage.googleapis.com/v1beta",
    key: e.GEMINI_API_KEY || "",
    type: "gemini",
    models: parseModels(e.GEMINI_MODELS),
    priority: int(e.GEMINI_PRIORITY, 999),
    needsKey: true,
  });

  // ── the local model: Ollama, through the bridge ────────────────────
  // The same provider shape as the cloud ones. The difference is the
  // `kind` and that it needs no key.
  add({
    id: "ollama",
    name: "Ollama (local)",
    kind: "local",
    tier: "local",
    baseUrl: e.OLLAMA_BASE || "http://127.0.0.1:" + int(e.BRIDGE_PORT, 11435) + "/v1",
    key: "",
    type: "ollama",
    dialect: e.OLLAMA_DIALECT || "openai",
    models: parseModels(e.OLLAMA_MODELS),
    priority: int(e.OLLAMA_PRIORITY, 999),
    local: true,
  });

  // ── the hosted Ollama ──────────────────────────────────────────────
  add({
    id: "ollama-cloud",
    name: "Ollama Cloud",
    kind: "cloud",
    tier: e.OLLAMA_CLOUD_TIER || "paid",
    baseUrl: e.OLLAMA_CLOUD_BASE || "https://ollama.com",
    key: e.OLLAMA_CLOUD_API_KEY || "",
    type: "ollama",
    models: parseModels(e.OLLAMA_CLOUD_MODELS),
    priority: int(e.OLLAMA_CLOUD_PRIORITY, 999),
    needsKey: true,
  });

  // ── custom gateways: CUSTOM_PROVIDER_N_* ───────────────────────────
  const seen = new Set();
  for (const key of Object.keys(e)) {
    const m = /^CUSTOM_PROVIDER_(\d+)_(.+)$/.exec(key);
    if (!m) continue;
    const num = m[1];
    if (seen.has(num)) continue;
    seen.add(num);
    const name = e[`CUSTOM_PROVIDER_${num}_NAME`] || `Custom-${num}`;
    const url = e[`CUSTOM_PROVIDER_${num}_URL`];
    if (!url) continue;
    const enabled =
      String(e[`CUSTOM_PROVIDER_${num}_ENABLED`] || "true").toLowerCase() !== "false";
    add({
      id: `custom_${num}`,
      name,
      kind: "cloud",
      tier: e[`CUSTOM_PROVIDER_${num}_TIER`] || "paid",
      baseUrl: url,
      key: e[`CUSTOM_PROVIDER_${num}_KEY`] || "",
      type: e[`CUSTOM_PROVIDER_${num}_TYPE`] || "openai",
      models: parseModels(e[`CUSTOM_PROVIDER_${num}_MODELS`]),
      priority: int(e[`CUSTOM_PROVIDER_${num}_PRIORITY`], 10),
      needsKey: true,
      enabled,
    });
  }

  // ── the local agents ───────────────────────────────────────────────
  // An agent is NOT an API endpoint: it runs ON a model and answers with
  // the MCP tool set. The ladder therefore yields the agent's MODEL, and
  // the chat goes to the provider that serves that model. (Registering an
  // agent as a provider pointed the request at a path that does not
  // exist - every call answered 404.)
  const agentModels = { ...(extra.agentModels || {}) };

  // A provider without a key cannot serve anything: switch it off here,
  // so no caller can ever pick it up.
  for (const p of out) {
    if (p.needsKey && !String(p.key || "").trim()) p.enabled = false;
  }
  out.agentModels = agentModels;
  return out;
}

/**
 * The resolution ladder. One order for every caller.
 * @returns {Array<{providerId, model, tier, kind, reason}>}
 */
function resolveLadder(providers, { model, agentId, tried = [], agentModels = {} } = {}) {
  const triedSet = new Set(tried);
  const live = providers.filter((p) => p.enabled !== false);
  const out = [];
  const push = (p, m, reason) => {
    if (!m) return;
    if (triedSet.has(m)) return;
    if (out.some((c) => c.model === m)) return;
    out.push({ providerId: p.id, model: m, tier: p.tier, kind: p.kind, reason });
  };

  const modelOf = (p) => (p.models || []).map((m) => (typeof m === "string" ? m : m.name));

  // 1. the model that was asked for
  if (model) {
    for (const p of live) {
      if (modelOf(p).includes(model)) push(p, model, "requested");
    }
  }

  // 2. a free model
  for (const p of live) {
    for (const m of modelOf(p)) {
      if (isFreeModel(m)) push(p, m, "free");
    }
  }

  // 3. the local model
  // A provider that runs on this machine serves local models - whatever
  // they are called. The name is not the test, the provider is.
  for (const p of live) {
    if (!p.local) continue;
    for (const m of modelOf(p)) push(p, m, "local");
  }

  // 4. the local agent: its MODEL, served by whoever serves that model.
  for (const [agentId, agentModel] of Object.entries(agentModels || {})) {
    if (!agentModel) continue;
    for (const p of live) {
      if (modelOf(p).includes(agentModel)) {
        push(p, agentModel, "local-agent:" + agentId);
        break;
      }
    }
  }

  // 5. an agent that was asked for by name
  if (agentId && agentModels[agentId]) {
    const m = agentModels[agentId];
    for (const p of live) {
      if (modelOf(p).includes(m)) {
        push(p, m, "requested-agent");
        break;
      }
    }
  }

  return out;
}

module.exports = {
  buildProviders,
  resolveLadder,
  parseModels,
  parseModelEntry,
  isFreeModel,
  isLocalModel,
};
