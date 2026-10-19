/**
 * universal-bridge — OpenCode plugin for the ZombieCoder Universal Adapter
 * ═══════════════════════════════════════════════════════════════════════
 * What this plugin does
 * ─────────────────────
 *   1. Probes the universal adapter (local TLS first, local HTTP second,
 *      main server last) and mirrors whatever it advertises into OpenCode,
 *      so the model can call those tools natively.
 *   2. Spawns the OCR / screen-recorder / TTS MCP servers as stdio children.
 *   3. Exposes one management tool, `adapter_control`, for status / refresh /
 *      enable / disable.
 *   4. Bootstraps the Mission Barisal layout for the session's working
 *      directory (`.zombiecoder/` — SSOT.md + agents/syllabus.md +
 *      agents/memory.json) and keeps it alive at RUNTIME: the SSOT digest
 *      and syllabus are pushed into the system prompt of every model call,
 *      and every prompt is appended to memory.json. Without this, OpenCode
 *      sessions created no mission files at all — agents had nothing to
 *      follow and memory never accumulated. The main server is then pointed
 *      at the same directory with a DIRECT loopback call that carries the
 *      admin token — never through the adapter (see adoptServerWorkingDir).
 *
 * Why `ctx.tool.transform` and not `ctx.tool.add`
 * ────────────────────────────────────────────────
 *   `Context.tool` is a `ToolDomain`, which exposes `transform / reload /
 *   list / hook` — there is NO `add` on it. Tool registration goes through a
 *   transform that hands you a `ToolEditor`, and *that* object has `add`.
 *   Calling `ctx.tool.add(...)` throws "ctx.tool.add is not a function" and
 *   OpenCode drops the whole plugin, so every call below goes through the
 *   single `register()` helper at the bottom.
 *
 * Safety rules
 * ────────────
 *   • NEVER breaks the editor. If no endpoint answers, setup logs a warning
 *     and returns; OpenCode continues with its built-in tools.
 *   • Never writes to stdout during setup (breaks stdio hosts).
 *   • Every proxied call is bounded by a timeout and returns a readable
 *     error string instead of throwing into the model's context.
 *   • The admin token is read at runtime (env or .env), attached ONLY to a
 *     loopback main-server call, and never hardcoded, logged, or forwarded
 *     to the adapter — which binds with Access-Control-Allow-Origin:*.
 */
import { Plugin } from "@opencode/plugin"
import { createRequire } from "node:module"
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

// ESM has no __dirname; derive it so the error message can point at the file.
const __dirname = fileURLToPath(new URL(".", import.meta.url))

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Order matters: the local adapter is preferred because it sandboxes the file
 * tools and already mirrors the main server's tools (one source, one count).
 * The main server is only a last resort — its file tools are unrestricted.
 */
const ENDPOINTS = [
  process.env.UNIVERSAL_ADAPTER_HTTPS || "https://localhost:5443/mcp",
  process.env.UNIVERSAL_ADAPTER_HTTP || "http://127.0.0.1:5400/mcp",
  process.env.UNIVERSAL_ADAPTER_REMOTE || "https://api.zombiecoder.my.id/mcp",
].filter(Boolean)

const CALL_TIMEOUT_MS = Number(process.env.UNIVERSAL_ADAPTER_TIMEOUT ?? 20000)

const log = (m: string): void => console.log(`[universal-bridge] ${m}`)

/** Names already taken by OpenCode itself; we prefix ours to avoid a clash. */
const PREFIX = process.env.UNIVERSAL_ADAPTER_PREFIX ?? "ua_"

// ─── Mission bootstrap config ────────────────────────────────────────────────
//
// Per-working-directory mission files (.zombiecoder/{SSOT.md,
// agents/syllabus.md, agents/memory.json}) + runtime injection.
//
// The character cap below exists because the server's full SSOT has been
// observed at ~650 KB (~164k tokens) — far beyond any local model's context,
// so injecting it whole gets requests silently truncated or refused. We push
// a bounded digest instead and point at the file for the rest.
const MISSION_CONTEXT_CHARS = Number(process.env.UNIVERSAL_MISSION_CONTEXT_CHARS ?? 4500)
const MEMORY_WINDOW_ENTRIES = 5
const MEMORY_RECENT_SESSIONS = 10

/**
 * Main server for privileged adoption (set_working_dir). Loopback only —
 * the admin token must never leave this machine.
 */
const MAIN_SERVER_URL = process.env.UNIVERSAL_MAIN_SERVER || "http://127.0.0.1:5050/mcp"

/**
 * The test harness (test-plugin.mjs) points the plugin at a throwaway
 * directory; calling set_working_dir there would make the REAL server
 * scan /tmp. Setting UNIVERSAL_MISSION_SERVER_SYNC=0 skips the privileged
 * call while keeping local layout + hooks fully exercised.
 */
const SERVER_SYNC_ENABLED = () => process.env.UNIVERSAL_MISSION_SERVER_SYNC !== "0"

// ─── TLS policy ──────────────────────────────────────────────────────────────
//
// Verification used to be switched off globally (`rejectUnauthorized: false`),
// which meant the remote endpoint was accepted without any identity check at
// all. It is now decided per host:
//
//   loopback (localhost / 127.0.0.1)
//       → trust OUR adapter certificate (~/.zombiecoder/certs/adapter-cert.pem)
//         as a private CA. A different certificate on 5443 is rejected.
//         Only if that file is missing do we fall back to unverified loopback
//         TLS, and we say so out loud.
//   everything else (api.zombiecoder.my.id)
//       → ordinary public-CA verification. That host presents a certificate
//         issued by Google Trust Services, so `rejectUnauthorized: true` works
//         as-is — there is nothing to bypass.
//
// Optional hardening: set UNIVERSAL_ADAPTER_PIN_SHA256 to a certificate
// SHA-256 fingerprint (uppercase hex, colons optional) to pin it. Left unset
// on purpose — the certificate expires Nov 30 2026 and a pin would break the
// bridge on every renewal.

const ADAPTER_CERT_PATH =
  process.env.UNIVERSAL_ADAPTER_CA ?? join(homedir(), ".zombiecoder", "certs", "adapter-cert.pem")

const PIN_SHA256 = (process.env.UNIVERSAL_ADAPTER_PIN_SHA256 ?? "").replace(/:/g, "").toUpperCase()

let warnedMissingCert = false

function tlsPolicy(u: URL): { rejectUnauthorized: boolean; ca?: string[] } {
  if (u.protocol !== "https:") return { rejectUnauthorized: true }

  const host = u.hostname
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1"

  if (loopback) {
    if (existsSync(ADAPTER_CERT_PATH)) {
      return { rejectUnauthorized: true, ca: [readFileSync(ADAPTER_CERT_PATH, "utf8")] }
    }
    if (!warnedMissingCert) {
      warnedMissingCert = true
      log(`⚠ adapter certificate not found at ${ADAPTER_CERT_PATH} — loopback TLS is unverified`)
    }
    return { rejectUnauthorized: false }
  }

  return { rejectUnauthorized: true }
}

// ─── Tiny JSON-RPC client ───────────────────────────────────────────────────

type RpcReply = { result?: unknown; error?: { code: number; message: string } }

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
}

function rpc(
  url: string,
  method: string,
  params: unknown = {},
  id = 1,
  extraHeaders: Record<string, string> = {},
): Promise<RpcReply> {
  const u = new URL(url)
  const isHttps = u.protocol === "https:"
  // ESM has no global `require`; createRequire bridges back to the builtins.
  const nodeRequire = createRequire(import.meta.url)
  const mod = isHttps ? nodeRequire("node:https") : nodeRequire("node:http")

  const policy = isHttps ? tlsPolicy(u) : {}

  return new Promise<RpcReply>((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    const options: any = {
      method: "POST",
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...extraHeaders,
      },
      timeout: CALL_TIMEOUT_MS,
      ...policy,
    }

    // Keep Node's hostname check and layer the optional pin on top of it.
    if (PIN_SHA256) {
      const tlsMod = nodeRequire("node:tls")
      options.checkServerIdentity = (host: string, cert: any) => {
        const err = tlsMod.checkServerIdentity(host, cert)
        if (err) return err
        const got = String(cert?.fingerprint256 ?? "").replace(/:/g, "").toUpperCase()
        if (got && got !== PIN_SHA256) {
          return new Error(`certificate pin mismatch for ${host}: ${got}`)
        }
        return undefined
      }
    }

    const req = mod.request(options, (res: any) => {
      let data = ""
      res.on("data", (c: Buffer) => (data += c))
      res.on("end", () => {
        try {
          resolve(JSON.parse(data))
        } catch {
          reject(new Error(`adapter returned non-JSON (${res.statusCode}): ${data.slice(0, 120)}`))
        }
      })
    })
    req.on("timeout", () => req.destroy(new Error(`timeout after ${CALL_TIMEOUT_MS}ms`)))
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

/** MCP content is an array; join every text part so nothing is silently lost. */
function contentText(result: any): string {
  const content = result?.content
  if (Array.isArray(content)) {
    const text = content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n")
    if (text) return text
  }
  return JSON.stringify(result ?? {}, null, 2)
}

/** Try each endpoint until one answers tools/list. */
async function findEndpoint(): Promise<{ url: string; tools: any[] } | null> {
  for (const url of ENDPOINTS) {
    try {
      const reply = await rpc(url, "tools/list")
      if (reply?.result?.tools?.length) {
        return { url, tools: reply.result.tools }
      }
      log(`${url} answered but advertised no tools`)
    } catch (e: any) {
      log(`${url} unreachable — ${e.message}`)
    }
  }
  return null
}

// ─── Mission bootstrap ───────────────────────────────────────────────────────
//
// Same contract as the VS Code extension's openWorkingDirectory: the LOCAL
// layout is created by us (fs lives right here, no server required), and
// pointing the server at the directory is best-effort. `set_working_dir` is
// a PRIVILEGED tool on the main server (needs MCP_ADMIN_TOKEN or
// ADMIN_API_KEY) and the adapter deliberately does NOT attach that
// credential — the adapter binds loopback with
// Access-Control-Allow-Origin:*, so an attached admin token would turn every
// local process and every hostile web page into RCE. The plugin therefore
// calls the main server DIRECTLY (loopback only, token on that one request).
// A denied call must never lose the files: they already exist.

/** The directory this plugin instance serves (one instance per location). */
function missionRoot(ctx: any): string {
  const d = ctx?.location?.directory
  return typeof d === "string" && d.trim() ? d : process.cwd()
}

/**
 * Server-compatible memory.json shape. The server's readMemory()/archiveSession()
 * expect current_session / recent_context / session_index to exist — writing
 * only `{entries: []}` crashed archiveSession (session_index was undefined).
 * Keep in sync with api.js defaults and the extension's memoryManager.
 */
function defaultMemory(): Record<string, unknown> {
  return {
    current_session: { id: null, started_at: null, message_count: 0, summary: null },
    recent_context: [],
    session_index: { last_accessed: null, total_sessions: 0, total_archived: 0 },
    entries: [],
  }
}

/** Create .zombiecoder/ layout. Never overwrites existing knowledge. */
function ensureMissionLayout(root: string): string[] {
  const created: string[] = []
  const zz = join(root, ".zombiecoder")
  const agents = join(zz, "agents")
  mkdirSync(join(agents, "sessions"), { recursive: true })

  const memPath = join(agents, "memory.json")
  if (!existsSync(memPath)) {
    writeFileSync(memPath, JSON.stringify(defaultMemory(), null, 2), "utf8")
    created.push("agents/memory.json")
  }

  const sylPath = join(agents, "syllabus.md")
  if (!existsSync(sylPath)) {
    writeFileSync(sylPath, syllabusTemplate(basename(root), root), "utf8")
    created.push("agents/syllabus.md")
  }

  // Placeholder only — the server's autoSSOT overwrites it unconditionally
  // when set_working_dir eventually succeeds, so a stub can never block the
  // real scan. Until then the mission layout is complete and injectable.
  const ssotPath = join(zz, "SSOT.md")
  if (!existsSync(ssotPath)) {
    writeFileSync(ssotPath, ssotStub(basename(root), root), "utf8")
    created.push("SSOT.md")
  }

  return created
}

/**
 * Syllabus template mirrors the server's autoSyllabus shape — including the
 * `| তারিখ | সোর্স | টপিক |` marker that _updateSyllabusIndex splices new
 * rows into, so a later server-side append lands cleanly in the table.
 */
function syllabusTemplate(name: string, root: string): string {
  const today = new Date().toISOString().slice(0, 10)
  return [
    `# ${name} — Agent Knowledge Syllabus`,
    `> Bootstrapped by universal-bridge (OpenCode plugin) on ${today}.`,
    "> Append-only: agents never overwrite; durable knowledge is appended below.",
    "",
    "## Latest Learnings",
    "",
    "| তারিখ | সোর্স | টপিক |",
    "|------|-------|-------|",
    "| — | — | Initial syllabus created |",
    "",
    "---",
    "",
    "## 1. Project Knowledge",
    "",
    "### Project Identity",
    `- **Name:** ${name}`,
    `- **Root:** ${root}`,
    "",
    "### How to learn here",
    "1. Read `.zombiecoder/SSOT.md` first — project truth (server-regenerated on set_working_dir).",
    "2. Durable knowledge goes into this file via the `ua_append_syllabus` tool (topic + summary).",
    "3. Session memory lives in `agents/memory.json` (windowed) + `agents/memory.archive.json` (full history).",
    "",
  ].join("\n")
}

/** Honest placeholder — never pretends to be a real server-side scan. */
function ssotStub(name: string, root: string): string {
  const now = new Date().toISOString()
  return [
    `# ${name} — SSOT (plugin placeholder)`,
    "",
    "> Created by the universal-bridge OpenCode plugin on " + now + ".",
    "> The Mission Barisal server regenerates this file with a full project",
    "> scan when `set_working_dir` runs (MCP, privileged). Until then this",
    "> placeholder keeps the mission layout complete; project knowledge is",
    "> in `.zombiecoder/agents/syllabus.md`.",
    "",
    `- **Project:** ${name}`,
    `- **Root:** ${root}`,
    `- **Generated:** ${now}`,
    "",
  ].join("\n")
}

// mtime-keyed cache so a 650 KB SSOT is read once, not once per model call.
const missionFileCache = new Map<string, { mtimeMs: number; text: string }>()

function readMissionFile(absPath: string): string {
  try {
    const st = statSync(absPath)
    const hit = missionFileCache.get(absPath)
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.text
    const text = readFileSync(absPath, "utf8")
    missionFileCache.set(absPath, { mtimeMs: st.mtimeMs, text })
    return text
  } catch {
    return ""
  }
}

/**
 * Bounded digest of SSOT + syllabus for the system prompt. Capped hard:
 * the full SSOT can be ~650 KB (~164k tokens) which no local model accepts,
 * so truncation is honest and points at the file for the rest.
 */
function missionContextText(root: string): string {
  if (MISSION_CONTEXT_CHARS <= 0) return ""
  const ssot = readMissionFile(join(root, ".zombiecoder", "SSOT.md"))
  const syl = readMissionFile(join(root, ".zombiecoder", "agents", "syllabus.md"))
  if (!ssot && !syl) return ""

  const ssotCap = Math.floor(MISSION_CONTEXT_CHARS * 0.6)
  const sylCap = MISSION_CONTEXT_CHARS - ssotCap
  const parts: string[] = [
    `Mission context for ${basename(root)} — bounded digest of .zombiecoder/ ` +
      `(full files on disk; extend via ua_append_syllabus / memory tools).`,
  ]
  if (ssot) {
    parts.push(`# SSOT digest${ssot.length > ssotCap ? " (truncated)" : ""}\n${ssot.slice(0, ssotCap)}`)
  }
  if (syl) {
    parts.push(`# Syllabus digest${syl.length > sylCap ? " (truncated)" : ""}\n${syl.slice(0, sylCap)}`)
  }
  return parts.join("\n\n")
}

/**
 * Append one prompt to memory.json: active window (last 5) + full JSONL
 * archive. Corrupt memory.json is rebuilt from defaults instead of throwing —
 * a broken memory file must never eat a prompt.
 */
function appendMemoryEntry(root: string, sessionId: string, text: string): void {
  const agents = join(root, ".zombiecoder", "agents")
  const memPath = join(agents, "memory.json")
  let memory: Record<string, unknown> = defaultMemory()
  try {
    if (existsSync(memPath)) {
      const parsed = JSON.parse(readFileSync(memPath, "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        memory = { ...memory, ...parsed }
      }
    }
  } catch {
    // corrupt → defaults; the archive still keeps history
  }

  const entry = {
    sessionId,
    timestamp: new Date().toISOString(),
    agent: "opencode",
    summary: text.slice(0, 200),
  }
  const current = Array.isArray(memory.entries) ? (memory.entries as unknown[]) : []
  current.push(entry)
  memory.entries = current.slice(-MEMORY_WINDOW_ENTRIES)

  try {
    writeFileSync(memPath, JSON.stringify(memory, null, 2), "utf8")
  } catch {
    return // disk full / readonly — archive attempt is pointless too
  }
  try {
    appendFileSync(join(agents, "memory.archive.json"), JSON.stringify(entry) + "\n", "utf8")
  } catch {
    // archive is best-effort; the window already holds the entry
  }
}

// ─── Server adoption (set_working_dir with the admin token) ──────────────────
//
// WHY DIRECT: the main server treats set_working_dir as privileged
// (PRIVILEGED_MCP_TOOLS → mcpGate) and requires Authorization: Bearer
// <MCP_ADMIN_TOKEN> or x-api-key. The adapter must never carry that token —
// it binds loopback with Access-Control-Allow-Origin:*, so an attached admin
// token would turn every local process and hostile web page into RCE. The
// plugin therefore calls 127.0.0.1:5050 itself: native client, no Origin
// header → mcpOriginAllowed passes; Bearer token → mcpGate passes.
//
// KNOWN LIMITATION: the server keeps ONE global mcpWorkingDir. Several
// OpenCode locations loaded at once race at setup() time and last-write-wins
// server-side (observed live 2026-10-12: 4 locations adopted in the same
// second). Local layout + context hook per location are unaffected; the
// active session heals the drift via keepServerAdoption() below.

/**
 * Admin token for privileged MCP tools. Resolution order mirrors the server
 * (api.js mcpAdminTokenOk: MCP_ADMIN_TOKEN || ADMIN_API_KEY):
 *   1. process.env (host already exported it)
 *   2. <repo>/.env, parsed exactly like api.js loadEnv (trim, strip quotes)
 * Never logs the value; returns null when nothing is configured.
 */
function loadAdminToken(): string | null {
  const fromEnv = process.env.MCP_ADMIN_TOKEN || process.env.ADMIN_API_KEY
  if (fromEnv) return fromEnv

  const envPath = join(__dirname, "..", "..", ".env")
  try {
    if (!existsSync(envPath)) return null
    for (const raw of readFileSync(envPath, "utf8").split("\n")) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      const eq = line.indexOf("=")
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      if (key !== "MCP_ADMIN_TOKEN" && key !== "ADMIN_API_KEY") continue
      let value = line.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (value) return value // empty value → keep looking (server fallback)
    }
  } catch {
    // unreadable .env → treated as absent; caller reports honestly
  }
  return null
}

/**
 * Point the main server at `root` (direct loopback call, token attached to
 * this one request only). Best-effort by contract: on ANY failure the local
 * files already exist and the context/memory hooks work regardless.
 * Returns true only when the server confirmed adoption.
 */
async function adoptServerWorkingDir(root: string): Promise<boolean> {
  if (!SERVER_SYNC_ENABLED()) {
    log("server set_working_dir skipped (UNIVERSAL_MISSION_SERVER_SYNC=0)")
    return false
  }

  let url: URL
  try {
    url = new URL(MAIN_SERVER_URL)
  } catch {
    log("server set_working_dir skipped (invalid UNIVERSAL_MAIN_SERVER) — local layout kept")
    return false
  }
  // The token may only ever travel to loopback. Refuse loudly otherwise.
  if (!isLoopback(url.hostname)) {
    log(`server set_working_dir refused: ${url.hostname} is not loopback — token stays local`)
    return false
  }

  const token = loadAdminToken()
  if (!token) {
    log(
      "server set_working_dir skipped: no admin token in env or " +
        join(__dirname, "..", "..", ".env") +
        " — local layout kept",
    )
    return false
  }

  try {
    const reply = await rpc(
      MAIN_SERVER_URL,
      "tools/call",
      { name: "set_working_dir", arguments: { directory: root } },
      1,
      { Authorization: `Bearer ${token}` },
    )
    if (reply.error) {
      log(`server set_working_dir denied (${reply.error.code}) — local layout kept: ${root}`)
      return false
    }
    log(`server adopted working dir: ${root}`)
    return true
  } catch (e: any) {
    log(`server set_working_dir skipped (${e.message}) — local layout kept`)
    return false
  }
}

/**
 * Drift-healing: the server has ONE global mcpWorkingDir, and every OpenCode
 * location adopts its own dir at setup() — last write wins. The ACTIVE
 * session therefore re-adopts on a slow timer so its project stays the one
 * the server points at. Throttled (default 10 min) because set_working_dir
 * triggers a full project scan; fire-and-forget so it never delays a model
 * call.
 */
const READOPT_INTERVAL_MS = Number(process.env.UNIVERSAL_MISSION_READOPT_MS ?? 600000)
let lastReadoptAt = 0

async function maybeReadopt(root: string): Promise<void> {
  if (!SERVER_SYNC_ENABLED()) return
  const now = Date.now()
  if (now - lastReadoptAt < READOPT_INTERVAL_MS) return
  lastReadoptAt = now
  try {
    const reply = await rpc(MAIN_SERVER_URL, "tools/call", {
      name: "get_working_dir",
      arguments: {},
    })
    const current = contentText(reply.result || "").trim()
    if (current !== root) {
      log(`server dir drifted (${current || "unknown"}) — re-adopting ${root}`)
      await adoptServerWorkingDir(root)
    }
  } catch {
    // healing is best-effort; the local hooks keep working regardless
  }
}

// Named exports for the test harness (test-plugin.mjs drives these directly
// so a re-setup test doesn't spawn the stdio child MCP servers twice).
export { ensureMissionLayout, missionContextText, appendMemoryEntry, defaultMemory, loadAdminToken, adoptServerWorkingDir }

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default Plugin.define({
  id: "universal-bridge",
  async setup(ctx: any) {
    // ─── Mission bootstrap: local layout + runtime hooks ─────────────────
    // Independent of the adapter: .zombiecoder/ is plain fs, so sessions
    // get mission files even while the adapter is down. One plugin instance
    // serves one location — ctx.location.directory IS the working directory.
    const root = missionRoot(ctx)
    try {
      const created = ensureMissionLayout(root)
      log(
        created.length
          ? `mission layout created in ${root}: ${created.join(", ")}`
          : `mission layout ready in ${root}`,
      )
    } catch (e: any) {
      log(`mission layout failed (continuing without): ${e.message}`)
    }

    // Context hook: every model call gets the bounded SSOT + syllabus digest
    // so agents actually follow the mission at runtime. Unscoped on purpose —
    // the mission applies to every provider, not just one.
    try {
      await ctx.session.hook("context", (event: any) => {
        try {
          const text = missionContextText(root)
          if (text) event.system.push({ type: "text", text })
        } catch {
          // a bad read must never break the model call
        }
        // Fire-and-forget drift healing (throttled inside) — never awaited,
        // so a slow server scan cannot delay this model call.
        maybeReadopt(root).catch(() => {})
      })
      log(`mission context hook active (digest cap ${MISSION_CONTEXT_CHARS} chars)`)
    } catch (e: any) {
      log(`mission context hook skipped: ${e.message}`)
    }

    // Prompt hook: every prompt lands in memory.json (last-5 window) and the
    // append-only archive. Never throws into the prompt pipeline.
    try {
      await ctx.session.hook("prompt", (event: any) => {
        try {
          const text = event?.prompt?.text
          if (typeof text === "string" && text.trim()) {
            appendMemoryEntry(root, String(event.sessionID ?? "unknown"), text)
          }
        } catch {
          // memory failure must never eat a prompt
        }
      })
      log("mission memory hook active (memory.json + memory.archive.json)")
    } catch (e: any) {
      log(`mission memory hook skipped: ${e.message}`)
    }

    // Best-effort server adoption: set_working_dir makes the server scan the
    // project and regenerate the real SSOT (overwriting the placeholder) and
    // keeps server-side tools (ua_read_ssot, append_syllabus without
    // project_dir) resolving against THIS directory. Direct loopback call
    // with the runtime-read admin token — never through the adapter. Runs
    // BEFORE findEndpoint so a down adapter cannot block adoption.
    await adoptServerWorkingDir(root)

    const found = await findEndpoint()

    if (!found) {
      log(
        "adapter not reachable on any endpoint — skipping tool mirroring.\n" +
          "           Start it with:  node " +
          '"' +
          __dirname +
          '/index.js"',
      )
      // Do NOT throw. A missing adapter must never take the editor down.
      return
    }

    log(`connected → ${found.url} (${found.tools.length} tools)`)
    if (found.url.includes("api.zombiecoder.my.id")) {
      log("⚠ local adapter not running — fell back to the main server, whose file tools are NOT sandboxed")
    }

    /** What we mirror: one entry per tool, registered in a single transform. */
    const mirrored: { name: string; tool: any }[] = []

    const mirrorInfo = (url: string, tool: any) => ({
      name: PREFIX + tool.name,
      description: tool.description || "",
      input: tool.inputSchema ?? { type: "object", properties: {}, required: [] },
      output: { type: "string" },
      async execute(args: any) {
        try {
          const reply = await rpc(url, "tools/call", { name: tool.name, arguments: args ?? {} })
          if (reply.error) {
            return {
              output: `❌ ${reply.error.message} (code ${reply.error.code})`,
              metadata: {},
            }
          }
          return { output: contentText(reply.result), metadata: {} }
        } catch (e: any) {
          // Never throw into the model context — a readable string is more
          // useful to it than an unhandled rejection.
          return { output: `❌ ${e.message}`, metadata: {} }
        }
      },
    })

    for (const tool of found.tools) {
      mirrored.push({ name: PREFIX + tool.name, tool })
    }
    await register(ctx, mirrored.map((m) => mirrorInfo(found.url, m.tool)))

    // ─── Child-process (stdio) MCP servers ───────────────────────────────
    // OCR / screen-recorder / TTS run as real child processes of this
    // plugin — no TCP port is allocated, nothing is exposed on any
    // interface, and their lifetime is tied to the parent process.
    const childServers: Array<{ name: string; pid: number; tools: number }> = []
    try {
      const nodeRequire = createRequire(import.meta.url)
      const { createStdioClient } = nodeRequire("/home/sahon/continue/mcp-stdio-client.js")

      const ROOT = "/home/sahon/continue"
      const CHILDREN = [
        { name: "ocr", args: ["external mcp/ocr-mcp.js"] },
        { name: "screen-recorder", args: ["external mcp/screen-recorder-mcp.js"] },
        { name: "tts", args: ["external mcp/tts-mcp.js"] },
      ]

      const childInfos: any[] = []
      for (const def of CHILDREN) {
        try {
          const client = createStdioClient({ name: def.name, args: def.args, cwd: ROOT, timeoutMs: 30000 })
          const tools = await client.tools()
          for (const t of tools) {
            childInfos.push({
              name: `mcp_${def.name}_${t.name}`,
              description: `[stdio child: ${def.name}] ${t.description || ""}`,
              input: t.inputSchema ?? { type: "object", properties: {}, required: [] },
              output: { type: "string" },
              async execute(a: any) {
                try {
                  const r = await client.call("tools/call", { name: t.name, arguments: a ?? {} })
                  return { output: contentText(r), metadata: {} }
                } catch (e: any) {
                  return { output: `❌ ${e.message}`, metadata: {} }
                }
              },
            })
          }
          childServers.push({ name: def.name, pid: client.pid, tools: tools.length })
          log(`child "${def.name}" pid=${client.pid} → ${tools.length} tools (stdio, no port)`)
        } catch (e: any) {
          log(`child "${def.name}" unavailable: ${e.message}`)
        }
      }
      await register(ctx, childInfos)
    } catch (e: any) {
      log(`child MCP setup skipped: ${e.message}`)
    }

    // ─── Management tool: let the client drive the adapter itself ───────────
    await register(ctx, [
      {
        name: "adapter_control",
        description:
          "Manage the universal adapter: check status, re-scan tools, or enable/disable a tool. " +
          "Use this whenever you need to know what the adapter offers right now.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["status", "refresh", "enable", "disable", "tools"],
              description: "What to do.",
            },
            tool: {
              type: "string",
              description:
                "Tool name (required for enable/disable). Use the 'ua_' prefix to list them first.",
            },
          },
          required: ["action"],
        },
        output: { type: "string" },

        async execute(args: any) {
          try {
            switch (args?.action) {
              case "status": {
                const reply = await rpc(found.url, "tools/call", {
                  name: "adapter_status",
                  arguments: {},
                })
                const base = reply.error ? `❌ ${reply.error.message}` : contentText(reply.result)
                const children = childServers.length
                  ? "\n\nchild MCP servers (stdio, no ports):\n" +
                    childServers
                      .map((c) => `  • ${c.name.padEnd(18)} pid=${String(c.pid).padEnd(7)} ${c.tools} tools`)
                      .join("\n")
                  : "\n\nchild MCP servers: none"
                return {
                  output: `endpoint: ${found.url}\n\n${base}${children}`,
                  metadata: {},
                }
              }

              case "tools": {
                const list = mirrored.map((m) => m.name)
                return { output: list.join("\n"), metadata: {} }
              }

              case "refresh": {
                const again = await findEndpoint()
                if (!again) return { output: "Adapter unreachable", metadata: {} }
                found.url = again.url
                found.tools = again.tools
                mirrored.length = 0
                for (const t of again.tools) mirrored.push({ name: PREFIX + t.name, tool: t })
                await register(
                  ctx,
                  again.tools.map((t: any) => mirrorInfo(again.url, t)),
                )
                const ids = again.tools.map((t: any) => PREFIX + t.name)
                return {
                  output: `Re-registered ${ids.length} tool(s) from ${again.url}:\n${ids.join("\n")}`,
                  metadata: {},
                }
              }

              case "enable":
              case "disable": {
                if (!args?.tool) return { output: "`tool` is required", metadata: {} }
                const name = String(args.tool).replace(new RegExp("^" + PREFIX), "")
                const reply = await rpc(found.url, `tools/${args.action}`, { name })
                return {
                  output: reply.error ? `❌ ${reply.error.message}` : contentText(reply.result),
                  metadata: {},
                }
              }

              default:
                return { output: `Unknown action: ${args?.action}`, metadata: {} }
            }
          } catch (e: any) {
            return { output: `❌ ${e.message}`, metadata: {} }
          }
        },
      },
    ])

    log(`mirrored ${mirrored.length} tools: ${mirrored.slice(0, 6).map((m) => m.name).join(", ")}${mirrored.length > 6 ? ", …" : ""}`)
    log("management tool: adapter_control (actions: status, tools, refresh, enable, disable)")
  },
})

/**
 * Register (or re-register) a batch of tools through ONE transform.
 *
 * `Context.tool` has no `add` — registration goes through
 * `tool.transform((editor) => editor.add(info))`, where `ToolEditor` exposes
 * `add / get / update / remove / namespace`. Batching into a single transform
 * also means a refresh replaces the set atomically instead of once per tool.
 */
async function register(ctx: any, infos: any[]): Promise<void> {
  if (!infos.length) return
  await ctx.tool.transform((editor: any) => {
    for (const info of infos) {
      // Re-adding an existing name is undefined behaviour in the host, so
      // drop the previous registration first.
      if (typeof editor.get === "function" && editor.get(info.name)) {
        try {
          editor.remove(info.name)
        } catch {
          /* fall through to add */
        }
      }
      editor.add(info)
    }
  })
}
