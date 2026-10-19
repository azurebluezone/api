# Code conventions

Short rules that keep this repository readable. They are conventions, not
laws — but a change that breaks one should say why.

## 1. Sections are marked

Every non-trivial block of new code is wrapped in a marker pair, with the
section name written at both ends:

```js
// ── SECTION: tool-allowlist-choke-point ──
const allowed = new Set(tools.map((t) => t.function.name));
// ── END SECTION: tool-allowlist-choke-point ──
```

Find them with a regex:

```bash
grep -n "SECTION: " api.js
```

## 2. Comments explain why, not what

One short line per comment. No dates, no emoji, no Bengali. If a comment
needs more than a line, the code is doing too much.

## 3. No emoji and no Bengali in code

Strings that are product content (personas, UI text) may be Bengali.
Comments and identifiers may not. No emoji anywhere.

## 4. One implementation per behaviour

A rule lives in exactly one module. If a second place needs it, it calls
the first. Duplicated logic is how the tool-call allowlist was bypassed and
how the provider port contract broke.

| Concern | Owner |
| --- | --- |
| Provider wire protocol, catalogue discovery | `provider/index.js` |
| Provider model list in memory + DB | `api.js` (bootstrap) |
| External MCP server registry | `tools/mcp-registry.js` |
| Tool-call parsing | `tools/tool-sanitizer.js` |
| Tool execution | `api.js` (`executeMcpTool`) |

## 5. No model names in code or environment

A model is discovered from the provider, or pinned in the database. Never
in a source file, never in `.env`. The only exception is a comment that
explains a past incident.

## 6. Secrets stay in `.env`

`.env` is gitignored. `dist/` is gitignored. A credential in a config
file, a log line or a build output is a leak — the build fails on it.

## 7. Ports belong to the project

Every instance owns a block of ports derived from `sha256(projectRoot)`
(`scripts/build/lib/ports.mjs`). A port that is hardcoded in code is a
collision waiting to happen.
