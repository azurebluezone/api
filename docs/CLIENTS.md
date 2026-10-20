# Where this actually works, and who trusts it

The honest version. No marketing, no "we are production ready" claim.

## The question

*Which client will use this? Who vouches for us? Why would they?*

## The answer in one paragraph

**A cloud client does not trust us. It trusts the domain.** The chain is
public and auditable:

```
Let's Encrypt (issuer "C = US, O = Let's Encrypt, CN = YE1")
  └─ infiniteearningzone.com          cert valid until 2027-01-12
       └─ cloudflared tunnel          (Cloudflare's edge terminates TLS)
            └─ nginx :443              our edge, per-service certificates
                 └─ api.js :5050        the gateway
```

Verified on the running system:

```
$ openssl s_client -connect api.infiniteearningzone.com:443
subject=CN = infiniteearningzone.com
issuer=C = US, O = Let's Encrypt, CN = YE1
notAfter=Jan 12 21:28:29 2027 GMT
```

A cloud IDE validates that certificate with the operating system's trust
store. **Nobody has to install anything, and nobody has to trust a
ZombieCoder-specific package.** That is the whole trust story for a hosted
service: a publicly trusted certificate on a domain you control.

## There is no npm signature, and there does not need to be one

The question "where is the dependency package signature, the proprietary
signature" is the right question for a **package**. This is not a package -
it is a **service the client talks to over HTTP**. The equivalent anchors
are:

| For a package | For a service (this) |
| --- | --- |
| npm provenance (SLSA attestation) | TLS certificate on a public domain |
| a signed release tag | a published, versioned repository |
| the registry's trust | the domain's ownership + the audit trail in this repo |

If we ever publish an npm package (the VS Code extension, the desktop
bridge), it should carry npm provenance. Until then the anchor is the
certificate.

## Which clients, exactly

Anything that speaks **MCP over HTTP** or the **OpenAI chat API**. Both
are already live on the public host:

```
POST https://api.infiniteearningzone.com/mcp      → 200   (MCP JSON-RPC)
GET  https://api.infiniteearningzone.com/v1/models → 200   (OpenAI discovery)
```

### VS Code (native MCP support)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "zombiecoder": {
      "type": "http",
      "url": "https://api.infiniteearningzone.com/mcp"
    }
  }
}
```

### Cursor, Zed, JetBrains (MCP over HTTP)

Same shape: a URL, optionally headers. The gateway answers a browser-free
request (no `Origin` header) with `200` - verified.

### Continue, Cline, Roo, Aider, Open WebUI, LM Studio, Jan (OpenAI-compatible)

```
Base URL : https://api.infiniteearningzone.com/v1
API key  : a session token or an admin token (see docs/HEADERS.md)
Model    : any model the registry reports (GET /v1/models)
```

### Our own extension and the ZombieCoder runtime

Already in this repository: the VS Code extension, `zombieBridge`, and the
agent runtime that uses the same `/mcp` endpoint.

## Why a client would point at us

Be honest: **a cloud client can talk to OpenAI directly.** So the reason
must be something OpenAI's endpoint does not do.

1. **A local model with the tool layer attached.** The Ollama bridge serves
   a local model; the gateway adds 153 MCP tools, the agent runtime, the
   persona/memory/syllabus layers. No cloud provider gives you that
   combination, and a BYOK cloud IDE cannot reach a model on your laptop at
   all.
2. **One endpoint instead of twenty.** Every provider (Groq, Gemini, Ollama
   Cloud, the GPU box, the local bridge) behind one OpenAI-shaped URL and
   one tool schema.
3. **Cost.** The local model is free. The pooled free tiers of Groq and
   OpenCode are free. No key from the client is needed for the local path.
4. **The data stays put.** A request for a local model never leaves the
   machine - the only configuration where that is true for a cloud IDE.

## What we do NOT do, and will not

These are the things that would destroy the trust above, so they are
written down:

- **We do not resell or pool someone else's API keys.** If a client uses
  our key, it is a key **this deployment** owns and the client is told
  plainly what it is spending. A shared key sold to strangers is not a
  product, it is a liability.
- **We do not claim a signature we do not have.** No "enterprise
  certified", no "proprietary secure" badge.
- **We do not break the MCP or OpenAI contracts** to make a feature work.
  The headers are documented in `docs/HEADERS.md` and they behave like the
  specification, not like our invention.
- **The self-signed CA stays a local tool.** It is what the LAN path and
  the per-service certificates use. The public path uses the public
  certificate. We never ask a client to disable certificate validation.

## The gaps that are real

Stated plainly, because a client will find them anyway:

1. **Per-client API keys.** Today the credentials are an admin token or a
   session token. A client should get its own key, revocable, scoped to
   the tools it may use.
2. **The agent layer is only as good as the model.** A 1.5B local model
   loops; a cloud model handles the same task. The ladder handles the
   difference - but a client will feel it.
3. **The shared local model has one slot.** It is shared with every other
   tool on the machine, so the local path is first-come, first-served
   with a 60 second timeout before it falls back.
4. **No published release pipeline yet.** The repository is the
   artifact. A signed tag, a changelog and build attestations are the
   next honest step.
5. **The self-consolation risk.** This repository is written by the same
   people who wrote the code it describes. The evidence that is not
   self-referential: the live probes in the syllabus, the test suite, the
   certificate chain from a public CA, and the failure modes written down
   next to the fixes.

## If you want to check us instead of believing us

```bash
# 1. the public certificate is a real one
openssl s_client -connect api.infiniteearningzone.com:443 -servername api.infiniteearningzone.com </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -dates

# 2. the MCP endpoint answers a real handshake
curl -s -X POST https://api.infiniteearningzone.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"you","version":"1"}}}'

# 3. the tool list is real, with schemas
curl -s -X POST https://api.infiniteearningzone.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400

# 4. the tests in this repository pass
node tests/local-tool-cap.test.js
node tests/fallback-hotloop-fix.test.js
node tools/tool-sanitizer.js --selftest
```
