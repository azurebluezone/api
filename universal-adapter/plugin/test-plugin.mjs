/**
 * test-plugin.mjs — Load the real plugin and run its real setup() against a
 * mock OpenCode context, so we can see exactly which tools it registers.
 *
 * The mock deliberately mirrors the REAL `Context.tool` from
 * `@opencode/plugin@2.x`, which is a `ToolDomain`:
 *
 * transform(cb)   the ONLY way to register a tool; cb gets a ToolEditor
 *     list() / reload() / hook()
 *
 * `ToolEditor` (what the callback receives) has add/get/update/remove.
 *
 * There is intentionally NO `ctx.tool.add`. An earlier version of this test
 * invented one, which made it pass while the plugin failed to load in the
 * real editor ("ctx.tool.add is not a function", 34 times in opencode.log).
 * If the plugin regresses to calling ctx.tool.add, this test throws the same
 * way OpenCode does.
 *
 * Nothing is mocked except the ctx object itself.
 */

import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the plugin at the LOCAL adapter before index.ts is imported — its
// endpoints are read at module load. The main server is excluded so this test
// can never silently pass against the wrong backend.
process.env.UNIVERSAL_ADAPTER_HTTPS ??= "https://localhost:5443/mcp";
process.env.UNIVERSAL_ADAPTER_HTTP ??= "http://127.0.0.1:5400/mcp";
process.env.UNIVERSAL_ADAPTER_REMOTE = "";

// A throwaway working directory: the mission bootstrap must create
// .zombiecoder/ inside whatever location the plugin is given, and this keeps
// the repo clean while proving exactly that.
const WORKDIR = mkdtempSync(join(tmpdir(), "zc-plugin-mission-"));

const registered = [];
const hooks = [];

const ctx = {
  // Location.Info — the plugin reads location.directory as the mission root.
  location: { directory: WORKDIR },
  // SessionDomain.hook — the ONLY way to register session hooks in the real
  // host. Recorded so the test can fire them like OpenCode would.
  session: {
    hook: async (name, cb) => {
      hooks.push({ name, cb });
      return { dispose: async () => {} };
    },
  },
  tool: {
    // ToolDomain — no `add` lives here, exactly like the real host.
    transform: async (cb) => {
      cb({
        add: (tool) => {
          const i = registered.findIndex((t) => t.name === tool.name);
          if (i !== -1) registered.splice(i, 1);
          registered.push(tool);
        },
        get: (id) => registered.find((t) => t.name === id),
        update: (id, mutate) => {
          const t = registered.find((x) => x.name === id);
          if (t) mutate(t);
        },
        remove: (id) => {
          const i = registered.findIndex((t) => t.name === id);
          if (i !== -1) registered.splice(i, 1);
        },
        namespace: () => {},
        list: () => registered,
      });
      return { dispose: async () => {} };
    },
    list: async () => registered,
    reload: async () => {},
    hook: async () => ({ dispose: async () => {} }),
  },
};

console.log("─".repeat(68));
console.log("  Loading universal-bridge plugin (real index.ts)");
console.log("─".repeat(68));

// The mock location is a throwaway temp dir — never let setup() point the
// REAL server at it. Local layout + hooks stay fully exercised; only the
// privileged set_working_dir call is skipped.
process.env.UNIVERSAL_MISSION_SERVER_SYNC = "0";

const mod = await import("./index.ts");
const plugin = mod.default;

await plugin.setup(ctx);

console.log(`\n  Registered tools: ${registered.length}\n`);

// ── Prove the tools actually execute against the live adapter ────────────────
let pass = 0,
  fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
 console.log(` ${name}`);
  } else {
    fail++;
 console.log(` ${name}${detail ? " " + detail : ""}`);
  }
};

console.log("  Mirrored adapter tools:");
for (const t of registered.slice(0, 8)) console.log(`     ${t.name.padEnd(26)} ${(t.description || "").slice(0, 44)}`);
console.log(`     … and ${Math.max(0, registered.length - 8)} more`);

console.log("\n  Mock matches the real host API:\n");
ok("ctx.tool.transform is the registration path", typeof ctx.tool.transform === "function");
ok("no ctx.tool.add (the bug that broke the plugin)", typeof ctx.tool.add === "undefined");

// ── Mission bootstrap: per-working-directory layout + runtime hooks ──────────
console.log("\n  Mission bootstrap (per working directory):\n");

{
  const zz = join(WORKDIR, ".zombiecoder");
  ok("SSOT.md created", existsSync(join(zz, "SSOT.md")));
  ok("syllabus.md created", existsSync(join(zz, "agents", "syllabus.md")));
  ok("memory.json created", existsSync(join(zz, "agents", "memory.json")));
  ok("sessions/ dir created", existsSync(join(zz, "agents", "sessions")));

  // memory.json must carry the server-compatible keys — a bare {entries:[]}
  // crashed the server's archiveSession (session_index undefined).
  if (existsSync(join(zz, "agents", "memory.json"))) {
    const mem = JSON.parse(readFileSync(join(zz, "agents", "memory.json"), "utf8"));
    ok(
      "memory.json has server-compatible keys",
      ["current_session", "recent_context", "session_index", "entries"].every((k) => k in mem),
      JSON.stringify(Object.keys(mem)),
    );
  }

  // The syllabus must contain the table marker _updateSyllabusIndex splices
  // into — without it, later server-side appends land nowhere visible.
  if (existsSync(join(zz, "agents", "syllabus.md"))) {
    const syl = readFileSync(join(zz, "agents", "syllabus.md"), "utf8");
    ok(
      "syllabus has the Latest-Learnings table marker",
      syl.includes("| তারিখ | সোর্স | টপিক |"),
    );
  }

  // Idempotency: re-running the bootstrap must NOT clobber existing
  // knowledge. Called directly (not via a second setup()) so the stdio
  // child MCP servers aren't spawned twice inside one test process.
  const sylPath = join(zz, "agents", "syllabus.md");
  const ssotPath = join(zz, "SSOT.md");
  const beforeSyl = readFileSync(sylPath, "utf8");
  const beforeSsot = readFileSync(ssotPath, "utf8");
  const { ensureMissionLayout } = await import("./index.ts");
  const secondRun = ensureMissionLayout(WORKDIR);
  ok(
    "re-bootstrap reports nothing new",
    Array.isArray(secondRun) && secondRun.length === 0,
    JSON.stringify(secondRun),
  );
  ok("re-bootstrap does not overwrite syllabus", readFileSync(sylPath, "utf8") === beforeSyl);
  ok("re-bootstrap does not overwrite SSOT", readFileSync(ssotPath, "utf8") === beforeSsot);

  // ── Server adoption (privileged set_working_dir) ───────────────────────────
  // loadAdminToken must resolve a credential when one exists (env or .env)
  // without ever throwing; adoptServerWorkingDir must honour the harness
  // kill-switch above and refuse to touch the real server.
  const { loadAdminToken, adoptServerWorkingDir } = mod;
  const token = loadAdminToken();
  ok(
    "loadAdminToken returns string|null",
    token === null || typeof token === "string",
    typeof token,
  );
  ok(
    "adopt respects UNIVERSAL_MISSION_SERVER_SYNC=0",
    (await adoptServerWorkingDir(WORKDIR)) === false,
  );
}

// ── Runtime hooks: context injection + memory append ────────────────────────
console.log("\n  Runtime hooks:\n");

{
  ok("context hook registered", hooks.some((h) => h.name === "context"));
  ok("prompt hook registered", hooks.some((h) => h.name === "prompt"));

  // Fire the context hook the way OpenCode does: event.system is pushed into.
  const ctxHook = hooks.find((h) => h.name === "context");
  if (ctxHook) {
    const event = { system: [] };
    await ctxHook.cb(event);
    ok(
      "context hook injects mission text",
      Array.isArray(event.system) && event.system.some((p) => p.type === "text" && p.text.length > 0),
      JSON.stringify(event.system).slice(0, 80),
    );
    const joined = (event.system || []).map((p) => p.text || "").join("\n");
    ok("injected text mentions SSOT", joined.includes("SSOT"), joined.slice(0, 60));
    // Bounded: never exceed the configured cap (local models choke on more).
    ok(
      "injection stays under the cap",
      joined.length <= 4500,
      `${joined.length} chars > 4500`,
    );
  } else {
    ok("context hook injects mission text", false, "no context hook");
  }

  // Fire the prompt hook: the prompt must land in memory.json.
  const promptHook = hooks.find((h) => h.name === "prompt");
  const memPath = join(WORKDIR, ".zombiecoder", "agents", "memory.json");
  if (promptHook) {
    await promptHook.cb({ sessionID: "ses_test_1", prompt: { text: "mission memory proof" } });
    const mem = existsSync(memPath) ? JSON.parse(readFileSync(memPath, "utf8")) : {};
    ok(
      "prompt hook appends to memory.json",
      Array.isArray(mem.entries) && mem.entries.length === 1 && mem.entries[0].summary === "mission memory proof",
      JSON.stringify(mem.entries).slice(0, 80),
    );
    // Window: more than 5 prompts  only the last 5 stay in the active file.
    for (let i = 2; i <= 8; i++) {
      await promptHook.cb({ sessionID: "ses_test_1", prompt: { text: `prompt ${i}` } });
    }
    const mem2 = JSON.parse(readFileSync(memPath, "utf8"));
    ok(
      "memory window caps at 5 entries",
      mem2.entries.length === 5 && mem2.entries[4].summary === "prompt 8",
      `got ${mem2.entries.length}`,
    );
    // Empty prompts must NOT pollute memory.
    await promptHook.cb({ sessionID: "ses_test_1", prompt: { text: "   " } });
    const mem3 = JSON.parse(readFileSync(memPath, "utf8"));
    ok("empty prompt not recorded", mem3.entries.length === 5);

    // Archive keeps everything the window pruned (append-only JSONL).
    const arcPath = join(WORKDIR, ".zombiecoder", "agents", "memory.archive.json");
    ok("memory.archive.json written", existsSync(arcPath));
    if (existsSync(arcPath)) {
      const lines = readFileSync(arcPath, "utf8").trim().split("\n").filter(Boolean);
      ok("archive holds all 8 prompts", lines.length === 8, `got ${lines.length}`);
      ok("archive lines are valid JSON", lines.every((l) => { JSON.parse(l); return true; }));
    }
  } else {
    ok("prompt hook appends to memory.json", false, "no prompt hook");
  }
}

console.log("\n  Live execution through the plugin:\n");

// Local adapter's own tools.
for (const name of ["ua_system_info", "ua_hash_text"]) {
  const t = registered.find((x) => x.name === name);
  if (!t) {
    ok(name, false, "not registered");
    continue;
  }
  const args = name === "ua_hash_text" ? { text: "plugin bridge proof" } : {};
  const res = await t.execute(args, {});
  ok(name, typeof res.output === "string" && res.output.length > 0, String(res.output).slice(0, 80));
}

// The main server's tools must arrive THROUGH the adapter — this is the whole
// point of the pull-sync. agent_mission is a main-server-only tool name.
{
  const t = registered.find((x) => x.name === "ua_agent_mission");
  ok("ua_agent_mission (main server, pulled via adapter)", !!t);
}

// Main-server tool actually executing end to end: adapter  main server.
{
  const t = registered.find((x) => x.name === "ua_get_working_dir");
  if (t) {
    const res = await t.execute({}, {});
    ok(
      "ua_get_working_dir forwards to the main server",
      typeof res.output === "string" && res.output.includes("/"),
      String(res.output).slice(0, 80),
    );
  } else {
    ok("ua_get_working_dir forwards to the main server", false, "not registered");
  }
}

// Count proof: mirror count must equal what the ADAPTER currently advertises.
// A hardcoded number drifts every time a tool is added (it already went
// 154  155 with agent_personas); fetching tools/list from the same endpoint
// the plugin used is the drift-free invariant.
{
  const ua = registered.filter((t) => t.name.startsWith("ua_")).length;
  const res = await fetch(process.env.UNIVERSAL_ADAPTER_HTTP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }).catch(() => null);
  const advertised = res && res.ok ? (await res.json())?.result?.tools?.length ?? 0 : 0;
  ok(
    `adapter mirrors every advertised tool (${ua} === ${advertised})`,
    advertised > 0 && ua === advertised,
    `advertised ${advertised}, mirrored ${ua}`,
  );
  ok("tool count is in the expected band (>=150)", ua >= 150, `got ${ua}`);
}

// management tool
const ctl = registered.find((x) => x.name === "adapter_control");
ok("adapter_control registered", !!ctl);
if (ctl) {
  const st = await ctl.execute({ action: "status" }, {});
  // adapter_status reports name "universal-adapter".
  ok(
    "adapter_control status",
    String(st.output).includes('"name": "universal-adapter"'),
    String(st.output).slice(0, 90),
  );
  ok("status shows the main server link", String(st.output).includes("main_server"), String(st.output).slice(0, 90));

  const tl = await ctl.execute({ action: "tools" }, {});
  ok("adapter_control tools", String(tl.output).includes("ua_"), String(tl.output).slice(0, 90));

  const rf = await ctl.execute({ action: "refresh" }, {});
  ok("adapter_control refresh", String(rf.output).includes("Re-registered"), String(rf.output).slice(0, 90));

  const en = await ctl.execute({ action: "enable", tool: "ua_hash_text" }, {});
  ok("adapter_control enable", String(en.output).includes("enabled"), String(en.output).slice(0, 90));
}

// error path must not throw, and the ADAPTER's sandbox must win over the main
// server's unrestricted read_file (collision policy: local implementation wins).
{
  const t = registered.find((x) => x.name === "ua_read_file");
  if (t) {
    const r = await t.execute({ path: "../../../etc/passwd" }, {});
    ok(
      "sandbox blocks paths outside roots",
      String(r.output).includes("outside allowed roots"),
      String(r.output).slice(0, 90),
    );
  } else {
    ok("sandbox blocks paths outside roots", false, "ua_read_file not registered");
  }
}

// Clean the temp mission root only on success; on failure keep it
// so the failing files can be inspected manually.
if (fail === 0) {
  rmSync(WORKDIR, { recursive: true, force: true });
}

console.log("\n" + "─".repeat(68));
console.log(`  PLUGIN TEST: ${pass} passed, ${fail} failed`);
console.log(fail === 0 ? `  temp mission root removed: ${WORKDIR}` : `  temp mission root kept for inspection: ${WORKDIR}`);
console.log("─".repeat(68));
process.exit(fail === 0 ? 0 : 1);
