"use strict";
// ─── provider/index.js ────────────────────────────────────────────────
// Provider registry + single entry point for the API server.
//
// ARCHITECTURE
//   ┌────────────┐   provider-native    ┌──────────────┐   OpenAI shape   ┌──────────┐
//   │ api.js     │ ───────────────────▶ │ provider/*   │ ───────────────▶ │normalizer│
// │ (agents,   │   chat/chatStream    │ (per-official │                  │ api.js  │
//   │  tools,    │ ◀─────────────────── │  doc dialect) │                  │          │
//   │  routes)   │   normalized result  └──────────────┘                  └──────────┘
//   └────────────┘
//
// Rules enforced here (per project brief):
//   1. NO hardcoded model names anywhere — capabilities come from the DB.
//   2. NO local/cloud distinction — a provider is a response source, full stop.
//   3. Models are looked up DIRECTLY in the DB, never from an in-memory copy.
//   4. Each adapter implements its own official dialect; api.js never branches
//      on provider type.
//
// Capabilities (supports_tools / supports_media / supports_stream) are read
// from the `models` table so adding a model never requires a code change.

const openai = require("./openai");
const groq = require("./groq");
const gemini = require("./gemini");
const ollama = require("./ollama");
const opencode = require("./opencode");
const validator = require("./validator");
const zclog = require("../lib/zc-log");

// Adapter keyed by WIRE dialect — not by vendor marketing name.
// `openai` covers OpenAI, vLLM, and every custom_N endpoint.
const ADAPTERS = {
  openai: openai,
  "openai-compatible": openai,
  groq: groq,
  gemini: gemini,
  ollama: ollama,
  opencode: opencode,
};

// Selection order (evidence: PROVIDER_CONFIG sets type:"openai" for
// OpenCode/Groq/Ollama — selecting on `type` first silently dropped the
// OpenCode headers, the Groq dialect and the Ollama native endpoint):
//   1. explicit cfg.adapter / cfg.dialect  (opt-in, e.g. dialect:"openai")
//   2. dedicated adapter by provider id    (opencode, groq, ollama, gemini)
//   3. wire type                           (gemini, groq, openai, …)
//   4. OpenAI-compatible fallback
function adapterFor(cfg) {
  if (!cfg) return openai;
  const explicit = cfg.adapter || cfg.dialect;
  if (explicit) {
    const e = String(explicit).toLowerCase();
    if (ADAPTERS[e]) return ADAPTERS[e];
  }
  const id = String(cfg.id || "").toLowerCase();
  if (ADAPTERS[id]) return ADAPTERS[id];
  const key = String(cfg.type || "openai").toLowerCase();
  return ADAPTERS[key] || openai;
}

// ─── Capability lookup (DB-direct, no hardcoding) ─────────────────────
// mode: "tools" | "media" | "stream"
// Returns true unless the DB explicitly says 0 — unknown  allow, because
// an over-eager "no" would silently disable working models.
let MODELS_DB = null;
function setDatabase(db) {
  MODELS_DB = db;
  require("./tools").setDatabase(db);   // tool register shares the same DB handle
}

function supports(providerId, modelName, mode) {
  if (!MODELS_DB) return true;
  const col = mode === "tools" ? "supports_tools"
    : mode === "media" ? "supports_media"
    : mode === "stream" ? "supports_stream"
    : null;
  if (!col) return true;
  try {
    const row = MODELS_DB.prepare(
      "SELECT " + col + " FROM models WHERE provider = ? AND (name = ? OR api_model = ?) LIMIT 1",
    ).get(providerId, modelName, modelName);
 if (!row) return true; // not in DB assume yes
    const v = row[col];
    if (v === null || v === undefined) return true;
    return v === 1 || v === true || v === "1";
  } catch (e) {
 return true; // table/column missing allow
  }
}

// ─── Provider config resolution ───────────────────────────────────────
// cfg may be: a config object already resolved by the caller, or a provider
// id string that we expand from environment.
function resolveConfig(cfg) {
  if (cfg && typeof cfg === "object") return cfg;
  return configForId(cfg);
}

function configForId(id) {
  const env = process.env;
  const P = {
    opencode: { baseUrl: env.OPENCODE_BASE, key: env.OPENCODE_API_KEY, type: "opencode" },
    groq:     { baseUrl: env.GROQ_BASE || "https://api.groq.com/openai/v1",
                key: env.GROQ_API_KEY, type: "groq" },
    gemini:   { baseUrl: env.GEMINI_BASE || "https://generativelanguage.googleapis.com/v1beta",
                key: env.GEMINI_API_KEY, type: "gemini" },
    ollama:   { baseUrl: env.OLLAMA_BASE, key: env.OLLAMA_API_KEY || env.OLLAMA_CLOUD_API_KEY,
                type: "openai", dialect: env.OLLAMA_DIALECT || "" },
  };
  if (P[id]) return Object.assign({ id: id }, P[id]);

  // custom_N providers: CUSTOM_PROVIDER_<n>_{URL,KEY,TYPE,...}
  const m = /^custom_(\d+)$/i.exec(id);
  if (m) {
    const n = m[1];
    return {
      id: id,
      baseUrl: env["CUSTOM_PROVIDER_" + n + "_URL"],
      key: env["CUSTOM_PROVIDER_" + n + "_KEY"],
      type: (env["CUSTOM_PROVIDER_" + n + "_TYPE"] || "openai").toLowerCase(),
    };
  }
  return { id: id, baseUrl: "", key: "", type: "openai" };
}

// ─── Message content normalization ─────────────────────────────────────
// OpenAI-compatible clients send multipart content as arrays:
//   content: [{ type: "text", text: "hi" }, { type: "image_url", ... }]
// The boundary contract (provider/schema.json) accepts only string|null
// for message.content, so multipart arrays are flattened to their text
// parts BEFORE request validation and adapter calls. Non-text parts
// (images/files) are dropped — this gateway is text-only. Messages whose
// content is already a string or null pass through untouched.
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(function (m) {
    if (!m || typeof m !== "object") return m;

    // ── Outbound sanitiser ──────────────────────────────────────────────
    // `reasoning_content` / `reasoning` / `thinking` are RESPONSE fields
    // that several upstreams emit. They get stored in the session history
    // and then replayed verbatim on the next turn, at which point strict
    // providers reject the whole request:
    //     'messages.N' : for 'role:assistant' the following must be
    //     satisfied[('messages.N' : property 'reasoning_content' is
    //     unsupported)]
    // Strip them before anything leaves the server. They are never needed
    // upstream, and their absence is harmless everywhere.
    const out = Object.assign({}, m);
    delete out.reasoning_content;
    delete out.reasoning;
    delete out.thinking;

    if (!Array.isArray(out.content)) return out;
    out.content = out.content
      .filter(function (p) {
        return p && (typeof p === "string" || p.type === "text");
      })
      .map(function (p) {
        return typeof p === "string" ? p : p.text || "";
      })
      .join("\n");
    return out;
  });
}


// ─── Error classification (ONE place) ─────────────────────────────────
// Every adapter reports what happened; the classification of "can this be
// retried on another provider" lives here and nowhere else.
function classifyError({ statusCode, error, rate_limited, boundary } = {}) {
  const status = Number(statusCode) || 0;
  const text = String(error || "");
  if (boundary) {
    // A rejected request format is deterministic — another provider will
    // reject it the same way.
    return { retriable: false, rate_limited: false, boundary: true };
  }
  const rateLimited =
    !!rate_limited || status === 429 || /rate.?limit|quota|too many requests/i.test(text);
  const serverSide = status >= 500;
  const network = /timeout|timed out|socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|fetch failed/i.test(text);
  const upstream5xx = /internal server error|bad gateway|service unavailable/i.test(text);
  const retriable = rateLimited || serverSide || network || upstream5xx;
  return { retriable, rate_limited: rateLimited, boundary: false };
}

// ─── Public: non-streaming chat ───────────────────────────────────────
// opts: { providerId|config, model, apiModel, messages, temperature,
//         tools, tool_choice, capabilities:{tools,media,stream} }
// Returns { ok, content, tool_calls, reasoning_content, normalized, raw,
//           provider, model, error, rate_limited }
async function chatImpl(opts) {
  const cfg = resolveConfig(opts.config || opts.providerId);
  const adapter = adapterFor(cfg);
  const providerId = cfg.id || opts.providerId || adapter.id;
  const messages = normalizeMessages(opts.messages);

  let tools = opts.tools;
  const model = opts.apiModel || opts.model;
  if (tools && tools.length) {
    const cap = opts.capabilities || {};
    const allowed = cap.tools != null ? cap.tools
      : supports(providerId, model, "tools");
    if (!allowed) tools = undefined;   // DB says this model can't take tools
  }

  const params = {
    model: opts.model,
    apiModel: opts.apiModel || opts.model,
    messages: messages,
    temperature: opts.temperature,
    tools: tools,
    tool_choice: opts.tool_choice,
    max_tokens: opts.max_tokens,
    top_p: opts.top_p,
    stop: opts.stop,
    user: opts.user,
    response_format: opts.response_format,
    reasoning_effort: opts.reasoning_effort,
    stream: false,
  };

  // LOCAL_MAX_TOKENS (2026-10-19): the env var was set (8192) but read
  //    nowhere, so a client could ask a small local model for a 32k budget
  //    and the model would try — stalling until the request timed out.
  //    A local provider never gets more than the operator allows.
  const localCap = parseInt(process.env.LOCAL_MAX_TOKENS || "0", 10);
  if (cfg.local && localCap > 0 && params.max_tokens > localCap) {
    params.max_tokens = localCap;
  }

  // Boundary validation — reject malformed requests BEFORE they leave the
  // server (schema: provider/schema.json -> #/$defs/chatRequest).
  const vReq = validator.validateRequest(params);
  if (!vReq.valid) {
    return {
      ok: false,
      error: "boundary_reject request: " + vReq.errors.join("; "),
      boundary: vReq.errors,
      retriable: false,
      provider: providerId,
      model: opts.model,
    };
  }

  // 🧟 DEBUG (temporary): capture the exact outbound request so a token
  //    budget can be measured instead of guessed.
  if (process.env.ZC_CAPTURE_OUTBOUND) {
    try {
      require("fs").writeFileSync(
        process.env.ZC_CAPTURE_OUTBOUND,
        JSON.stringify({ provider: providerId, params }, null, 2),
      );
    } catch (_) { /* ignore */ }
  }

  let res;
  try {
    res = await adapter.chat(cfg, params);
  } catch (e) {
    return { ok: false, error: e.message, provider: providerId, model: opts.model };
  }

  // Boundary validation — reject provider output that does not match the
  // normalized contract (schema: provider/schema.json -> #/$defs/chatCompletion).
  if (validator.enabled() && res.ok && res.normalized != null) {
    const vRes = validator.validateResponse(res.normalized);
    if (!vRes.valid) {
      return {
        ok: false,
        statusCode: res.statusCode,
        error: "boundary_reject response: " + vRes.errors.join("; "),
        boundary: vRes.errors,
        raw: res.raw,
        provider: providerId,
        model: opts.model,
      };
    }
  }

  // HTTP 200 + {"error":{…}} body — OpenAI-compatible servers do this for
  // auth/quota failures. Treat it as a failure so the fallback chain runs
  // instead of reporting "empty content".
  if (res.ok && res.raw && res.raw.error && !res.raw.choices) {
    const er = res.raw.error;
    const msg = typeof er === "string" ? er : (er.message || JSON.stringify(er));
    const cls = classifyError({
      statusCode: res.statusCode,
      error: msg,
      rate_limited: res.raw.status === 429 || er.status === 429 ||
        /rate.?limit|quota|too many requests|429/i.test(msg),
    });
    return {
      ok: false,
      statusCode: res.statusCode || 200,
      error: msg,
      rate_limited: cls.rate_limited,
      retriable: cls.retriable,
      raw: res.raw,
      provider: providerId,
      model: opts.model,
    };
  }

  const normalized = res.normalized;
  const message = (normalized && normalized.choices &&
    normalized.choices[0] && normalized.choices[0].message) || {};

  return {
    ok: !!res.ok,
    statusCode: res.statusCode,
    content: message.content || "",
    tool_calls: message.tool_calls || null,
    reasoning_content: message.reasoning_content || null,
    finish_reason: (normalized && normalized.choices &&
      normalized.choices[0] && normalized.choices[0].finish_reason) || null,
    usage: (normalized && normalized.usage) || null,
    normalized: normalized,
    raw: res.raw,
    upstream: res.upstream,
    error: res.error,
    rate_limited: !!res.rate_limited,
    retriable: !!res.retriable || (!res.ok && classifyError({ statusCode: res.statusCode, error: res.error }).retriable),
    provider: providerId,
    dialect: adapter.dialect,
    model: opts.model,
  };
}

// ─── Public: streaming chat ───────────────────────────────────────────
// onDelta receives OpenAI chat.completion.chunk objects (already normalized).
async function chatStreamImpl(opts, onDelta) {
  const cfg = resolveConfig(opts.config || opts.providerId);
  const adapter = adapterFor(cfg);
  const providerId = cfg.id || opts.providerId || adapter.id;
  const messages = normalizeMessages(opts.messages);

  let tools = opts.tools;
  const model = opts.apiModel || opts.model;
  if (tools && tools.length) {
    const cap = opts.capabilities || {};
    const allowed = cap.tools != null ? cap.tools
      : supports(providerId, model, "tools");
    if (!allowed) tools = undefined;
  }

  let res;
  let deltaFrames = 0;
  let invalidFrames = 0;
  try {
    // Boundary validation — reject malformed requests before they leave the
    // server (same request schema as the non-stream path).
    const vReq = validator.validateRequest({
      model: opts.model,
      apiModel: opts.apiModel || opts.model,
      messages: messages,
      temperature: opts.temperature,
      tools: tools,
      tool_choice: opts.tool_choice,
      max_tokens: opts.max_tokens,
      top_p: opts.top_p,
      stop: opts.stop,
      stream: true,
    });
    if (!vReq.valid) {
      return {
        ok: false,
        error: "boundary_reject request: " + vReq.errors.join("; "),
        boundary: vReq.errors,
        provider: providerId,
        model: opts.model,
      };
    }

    // Boundary validation — every normalized frame is checked against
    // #/$defs/chatCompletionChunk before it reaches api.js. Frames that
    // violate the contract are dropped (never forwarded downstream).
    const boundaryDelta = function (chunk) {
      deltaFrames++;
      const v = validator.validateDelta(chunk);
      if (v.valid) onDelta(chunk);
      else invalidFrames++;
    };

    res = await adapter.chatStream(cfg, {
      model: opts.model,
      apiModel: opts.apiModel || opts.model,
      messages: messages,
      temperature: opts.temperature,
      tools: tools,
      tool_choice: opts.tool_choice,
      max_tokens: opts.max_tokens,
      top_p: opts.top_p,
      stop: opts.stop,
      stream: true,
    }, boundaryDelta);
  } catch (e) {
    return { ok: false, error: e.message, provider: providerId, model: opts.model };
  }

  // All frames rejected at the boundary  treat the stream as failed so the
  // fallback chain runs instead of delivering an empty (lies-by-omission)
  // stream to the caller.
  const allFramesRejected =
    deltaFrames > 0 && invalidFrames === deltaFrames;

  // Adapter-level tool_calls are flat {index,id,name,arguments}; the API
  // server consumes the OpenAI streaming shape {id,type,function:{…}}.
  const flat = res.tool_calls;
  const toolCalls = Array.isArray(flat) && flat.length
    ? flat.map(function (t, i) {
        if (t && t.function) return t;               // already nested
        return {
          id: t.id || "call_stream_" + i,
          type: "function",
          function: { name: t.name || "", arguments: t.arguments || "" },
        };
      })
    : null;

  return {
    ok: !!res.ok,
    statusCode: res.statusCode,
    content: res.content || "",
    tool_calls: toolCalls,
    reasoning_content: res.reasoning_content || null,
    finish_reason: res.finish_reason || null,
    error: res.error,
    rate_limited: !!res.rate_limited,
    stream_error: !!res.stream_error || allFramesRejected,
    boundary_dropped: invalidFrames,
    provider: providerId,
    dialect: adapter.dialect,
    model: opts.model,
  };
}

// ─── Public: model discovery ──────────────────────────────────────────
async function listModels(providerIdOrCfg) {
  const cfg = resolveConfig(providerIdOrCfg);
  const adapter = adapterFor(cfg);
  try {
    return await adapter.listModels(cfg);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Public: logging wrappers ─────────────────────────────────────────
// The *Impl bodies above own the actual logic and can return from a dozen
// places. Wrapping here means every exit — success, ok:false, or throw —
// passes through exactly one logging point, and no return path is touched.

/** One record per call: which provider/model, ok flag, latency, error text. */
function logChatResult(label, opts, providerId, t0, res, thrown) {
  const ms = Date.now() - t0;
  const base = {
    label,
    provider: providerId || (res && res.provider) || opts.providerId || null,
    model: opts.model,
    ms,
    status_code: res && res.statusCode,
    rate_limited: res && !!res.rate_limited,
  };
  if (thrown) {
    zclog.fail("provider", label, { ...base, ok: false, error: thrown.message || String(thrown) });
    return;
  }
  if (res && res.ok) {
    zclog.info("provider", label, { ...base, ok: true });
  } else {
    zclog.fail("provider", label, {
      ...base,
      ok: false,
      error: (res && res.error) || "unknown provider failure",
      boundary: res && res.boundary,
      stream_error: res && res.stream_error,
    });
  }
}

async function chat(opts) {
  const providerId = opts.providerId || (opts.config && opts.config.id) || null;
  const t0 = Date.now();
  let res;
  try {
    res = await chatImpl(opts);
  } catch (e) {
    logChatResult("CHAT", opts, providerId, t0, null, e);
    throw e;
  }
  logChatResult("CHAT", opts, providerId, t0, res, null);
  return res;
}

async function chatStream(opts, onDelta) {
  const providerId = opts.providerId || (opts.config && opts.config.id) || null;
  const t0 = Date.now();
  let res;
  try {
    res = await chatStreamImpl(opts, onDelta);
  } catch (e) {
    logChatResult("CHAT_STREAM", opts, providerId, t0, null, e);
    throw e;
  }
  logChatResult("CHAT_STREAM", opts, providerId, t0, res, null);
  return res;
}


// ─── Provider protocol + model discovery ─────────────────────────────
// ONE place that knows how each provider's wire protocol works:
// • openai / groq / opencode / custom_N  {base}/v1/models    (data[].id)
// • ollama (native)                      {base}/api/tags     (models[].name)
// • gemini (native)                      {base}/v1beta/models (models[].name)
// The catalogue is DISCOVERED, never written in an env var. An env var may
// still PIN models, but it is additive and de-duplicated — a wrong value
// must never crash the boot or create a duplicate row.

// ── SECTION: provider-discovery ──
function httpGetJson(url, { headers, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let lib;
    try {
      const u = new URL(url);
      lib = u.protocol === "https:" ? require("https") : require("http");
    } catch (_) {
      return resolve({ ok: false, error: "bad url: " + url });
    }
    try {
      const req = lib.get(
        url,
        { timeout: timeoutMs, headers: headers || {} },
        (res) => {
          let d = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (d += c));
          res.on("end", () => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
              return resolve({
                ok: false,
                error: "HTTP " + res.statusCode,
                status: res.statusCode,
              });
            }
            try { resolve({ ok: true, json: JSON.parse(d) }); }
            catch (e) { resolve({ ok: false, error: "invalid JSON: " + e.message }); }
          });
        },
      );
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
      req.on("error", (e) => resolve({ ok: false, error: e.message }));
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

/** Where a provider publishes its catalogue, per wire dialect. */
function catalogueUrl(cfg) {
  const base = String(cfg.baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return null;
  const dialect = String(cfg.dialect || cfg.type || "openai").toLowerCase();
  if (dialect === "gemini") {
    return /\/v1beta$/i.test(base) ? base + "/models" : base + "/v1beta/models";
  }
  if (dialect === "ollama") {
    // native Ollama: /api/tags · OpenAI-compatible Ollama: /v1/models
    return /\/v1$/i.test(base) ? base + "/models" : base + "/api/tags";
  }
  return /\/v1$/i.test(base) ? base + "/models" : base + "/v1/models";
}

/** Parse a catalogue response into a list of model ids. */
function catalogueIds(json) {
  if (!json) return [];
  const raw = json.data || json.models || json.model || json.modelNames || [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((m) => {
      if (typeof m === "string") return m;
      if (!m || typeof m !== "object") return "";
      // Gemini names arrive as "models/gemini-2.5-flash"
      return String(m.id || m.name || m.model || "").replace(/^models\//, "");
    })
    .filter(Boolean);
}

/**
 * Discover a provider's models. Never throws, never duplicates.
 * @returns {Promise<{ok:boolean, models:string[], source:string, error?:string}>}
 */
async function discoverModels(cfg) {
  if (!cfg || !cfg.baseUrl) {
    return { ok: false, models: [], source: "", error: "no baseUrl" };
  }
  const url = catalogueUrl(cfg);
  if (!url) return { ok: false, models: [], source: "", error: "no catalogue url" };
  const headers = {};
  const isGemini = String(cfg.type || "").toLowerCase() === "gemini";
  // Gemini: the key goes in the query string, NOT as a Bearer header —
  // sending both answers 401 (verified live).
  if (cfg.key && !isGemini) headers.Authorization = "Bearer " + cfg.key;
  let target = url;
  if (isGemini && cfg.key) {
    // Google wants the key as a QUERY parameter; the x-goog-api-key header
    // answers 401 on this endpoint (verified live).
    target += (target.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(cfg.key);
  }
  const r = await httpGetJson(target, { headers });
  if (!r.ok) return { ok: false, models: [], source: target, error: r.error };
  const ids = catalogueIds(r.json);
  if (!ids.length) return { ok: false, models: [], source: url, error: "catalogue empty" };
  return { ok: true, models: [...new Set(ids)], source: url };
}

/**
 * Merge a provider's pinned (env) models with the discovered ones.
 * De-duplicated, order-stable, and a wrong pinned value is simply ignored
 * instead of breaking the boot.
 */
function mergeModels(pinned, discovered) {
  const out = [];
  const seen = new Set();
  const push = (m) => {
    const name = typeof m === "string" ? m : m && m.name;
    if (!name) return;
    const key = String(name).trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };
  for (const m of discovered || []) push(m);
  for (const m of pinned || []) push(m);
  return out;
}

/**
 * Protocol check for one provider: does the endpoint answer the way its
 * dialect says it should? One request, and it is the operator's first line
 * of diagnostics.
 */
async function checkProtocol(cfg) {
// ── END SECTION: provider-discovery ──
  const id = (cfg && cfg.id) || "unknown";
  const dialect = String((cfg && (cfg.dialect || cfg.type)) || "openai").toLowerCase();
  const base = { id, protocol: dialect, baseUrl: (cfg && cfg.baseUrl) || "", models: 0 };
  if (!cfg || !cfg.baseUrl) return { ...base, ok: false, error: "no baseUrl" };
  if (cfg.enabled === false) return { ...base, ok: false, error: "disabled" };
  if (cfg.needsKey && !String(cfg.key || "").trim()) {
    return { ...base, ok: false, error: "no api key" };
  }
  const d = await discoverModels(cfg);
  if (!d.ok) return { ...base, ok: false, error: d.error, source: d.source };
  return { ...base, ok: true, models: d.models.length, source: d.source, ids: d.models };
}


// ─── The tool loop ────────────────────────────────────────────────────
// ONE implementation, used by every provider and every caller. A chat
// that needs tools and a tool call take the same path, so they cannot
// behave differently from each other.
//
// The caller supplies three things:
//   call(round)              performs one model round (the provider layer)
//   execute(name, args)      runs one tool
//   finalAnswer(messages)    the last, tool-free answer
async function runToolLoop({ call, execute, finalAnswer, maxRounds, log: logFn }) {
  const MAX = Math.max(1, maxRounds || 5);
  const note = logFn || (() => {});
  let response = null;

  for (let round = 0; round < MAX; round++) {
    response = await call(round);
    if (!response || !response.success) return response;

    let tcs = response.tool_calls;

    // A model that cannot emit native tool calls sometimes writes the
    // markers as text. Extraction only, and only for the names that were
    // advertised in this request.
    if ((!tcs || !tcs.length) && response.tools && response.tools.length && response.content) {
      try {
        const { extractToolCalls } = require("../tools/tool-sanitizer.js");
        const allow = response.tools
          .map((t) => (t && t.function && t.function.name) || (t && t.name))
          .filter(Boolean);
        const san = extractToolCalls(response.content, allow);
        if (san.tool_calls.length) {
          note("SANITIZED_TOOL_CALLS", {
            model: response.model,
            dialect: san.dialect,
            count: san.tool_calls.length,
          });
          response.content = san.cleaned;
          response.tool_calls = san.tool_calls;
          response.sanitized = true;
          tcs = san.tool_calls;
        }
      } catch (sanErr) {
        note("SANITIZER_ERROR", { error: sanErr.message });
      }
    }

    // The model is NOT a trusted source for tool NAMES. A tool may run
    // only if its name was advertised in THIS request.
    const strictAllowlist =
      String(process.env.TOOL_ALLOWLIST_STRICT || "true").toLowerCase() !== "false";
    if (strictAllowlist) {
      const advertised = new Set(
        (Array.isArray(response.tools) ? response.tools : [])
          .map((t) => (t && t.function && t.function.name) || (t && t.name))
          .filter(Boolean),
      );
      const rejected = [];
      tcs = (tcs || []).filter((tc) => {
        const name = tc && tc.function && tc.function.name;
        if (name && advertised.has(name)) return true;
        rejected.push(name || "(unnamed)");
        return false;
      });
      if (rejected.length) {
        note("TOOL_NOT_ADVERTISED", {
          model: response.model,
          rejected,
          advertised: Array.from(advertised),
        });
      }
    }

    if (!tcs || !tcs.length) {
      note("TOOL_LOOP_NO_TOOL_CALLS", {
        round,
        content_length: (response.content || "").length,
      });
      return response;
    }

    // The assistant message keeps the reasoning: a thinking model rejects
    // the next request when it is missing.
    response.messages.push({
      role: "assistant",
      content: null,
      tool_calls: tcs,
      ...(response.reasoning_content
        ? { reasoning_content: response.reasoning_content }
        : {}),
    });

    for (const tc of tcs) {
      let result;
      try {
        const args =
          typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        result = await execute(tc.function.name, args);
      } catch (err) {
        result = { content: [{ type: "text", text: "Tool error: " + err.message }] };
      }
      const text = result?.content?.[0]?.text || JSON.stringify(result);
      response.messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: String(text).slice(0, 100000),
      });
    }
  }

  // Out of rounds: ask for a tool-free final answer instead of failing.
  note("MAX_TOOL_ROUNDS_EXCEEDED", { max: MAX, model: response?.model });
  if (finalAnswer) return await finalAnswer(response.messages);
  return response;
}

module.exports = {
  chat,
  chatStream,
  listModels,
  supports,
  normalizeMessages,
  setDatabase,
  resolveConfig,
  configForId,
  adapterFor,
  ADAPTERS,
  // Adapters are exported individually for tests / direct use.
  adapters: { openai, groq, gemini, ollama, opencode },
  // provider-layer protocol + catalogue helpers (one implementation)
  discoverModels,
  mergeModels,
  checkProtocol,
  catalogueUrl,
  classifyError,
  runToolLoop,
};
