# Headers and sessions

What a client sends, and what it gets back. One contract for every route.

## Request headers

| Header | Meaning | Required |
| --- | --- | --- |
| `Authorization: Bearer <token>` | session token (from `POST /api/auth/verify`) or admin token | for private routes |
| `X-API-Key: <key>` | alternative to the bearer token | alternative |
| `X-Session-Id: <id>` | the session the client already holds | no |
| `X-Request-Id: <id>` | the client's own id, echoed back in the log | no |
| `X-Client-Name` / `X-MCP-Client-Name` | who is calling | no |
| `X-Client-Version` / `X-MCP-Client-Version` | which version of the client | no |
| `X-MCP-Client-Dir` | the project folder of the client, used to generate its SSOT | no |
| `MCP-Protocol-Version` | the MCP protocol the client speaks | no (default `2025-06-18`) |
| `Mcp-Session-Id` | the MCP session the client opened | no |
| `Origin` | browser origin; cross-origin calls are rejected except the allowed list | for browsers |

## Response headers

| Header | Meaning |
| --- | --- |
| `X-Request-Id` | the request id: the client's, or a generated one. Quote it in a bug report. |
| `MCP-Protocol-Version` | the version the client asked for |
| `Mcp-Session-Id` | the session id (issued on `initialize`, echoed afterwards) |
| `X-Server` | `ZombieCoder/MissionBarisal` |
| `X-Client-Name` | the client name that was seen |
| `Access-Control-Allow-Origin` | only for the allowed origins |

## Sessions

A session is a row in the `sessions` table and a signed token.

```
POST /api/auth/verify   { "api_key": "<ADMIN_API_KEY>" }
  -> { "session_id": "s_…", "session_token": "<random>.<hmac>", … }
```

The token is `<random>.<hmac>`: the HMAC is computed with the server
secret (`SESSION_HMAC_SECRET`, or `ADMIN_TOKEN` / `ADMIN_API_KEY`). A
session token is therefore **not** a bare secret in a database, and a
forged token is rejected before the database is even consulted.

`SESSION_HMAC_REQUIRED=false` turns the signature off (a bare random
token). The default is on.

Send the token on every later call:

```
Authorization: Bearer <session_token>
```

## Sessions in the MCP handshake

```
POST /mcp
  -> Mcp-Session-Id: <uuid>          (issued on initialize)
  -> keep sending it on later calls
```

The server is stateless, so a lost session id costs nothing: the client
can initialize again.

## Identity in one place

| Where | What it carries |
| --- | --- |
| `GET /identity` | name, version, domain, branding, server facts |
| `GET /api/config/origin` | the public URLs a client should use (including every hostname in `PUBLIC_DOMAINS`) |
| `GET /api/agents` | the agents of THIS project, with their model |
| `GET /v1/models` | the agents as OpenAI models |
| `GET /api/v0/models` | every provider model, with the provider that serves it |
| `POST /mcp` → `initialize` | `serverInfo`: name, version, domain, working dir, SSOT pointer |
| `GET /api/mcp-clients` | the clients connected right now, with their version and working dir |

All of them read the same source: `domain-config.js` (which reads the
environment) and the models database. A client therefore never receives
an identity that contradicts another endpoint.
