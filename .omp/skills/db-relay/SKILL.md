---
name: db-relay
description: >
  Desktop ↔ market transport: HTTP routes desktops use to talk to the market web app
  (exchange, presign, bulk finalize, gear, decisions, tag-head, SSE), and the legacy WS DB
  relay (`wss://kelp.market/api/desktop/db/rpc`, relay-server.mjs) that is still deployed but
  unused by shipped desktops. Trigger when the user mentions "db relay", "websocket relay",
  "desktop relay connection", "relay protocol", "desktop DB sync", or asks why the desktop
  has no SurrealDB driver, or how desktop grant URLs (`KELP_DESKTOP_DB_URL`) work.
---

# Desktop ↔ market transport

Desktops ship **no SurrealDB client/driver at all**. Every market interaction rides HTTP
routes on the web app:

| Route | Role |
|---|---|
| `POST /api/desktop/exchange` | Mints the grant (SurrealDB JWT + S3/presign env) |
| `POST /api/desktop/s3/presign` | Owner-bound presigned PUT/GET URLs |
| `POST /api/desktop/assets/bulk` | 7-asset batch finalize |
| `POST /api/desktop/gear`, `…/gear/challenge` | Gear find-or-register, verification challenges |
| `POST /api/desktop/decisions`, `…/tag-head` | Tag decision + fleet tag-head sync |
| `GET /api/desktop/assets/[cid]` | Asset fetch |
| `GET /api/desktop/events` | SSE push |

## Legacy WS DB relay — retained, unused by shipped desktops

0.4.x–0.6.x desktops synced by proxying SurrealDB RPC over
`wss://kelp.market/api/desktop/db/rpc`. A custom web entry
(`market/apps/web/server/relay-server.mjs`, copied into the web build by
`market/apps/web/scripts/copy-relay.mjs`):

1. Accepted the WS upgrade.
2. Resolved the session from raw headers against the SSO — no cookie/bearer → 401,
   SSO down → 503 (fail-closed).
3. Dialed the cluster-internal `ws://surrealdb:8000/rpc` (unreachable from user machines;
   netpol allows web/mcp/worker only).
4. Relayed frames 1:1, binary flag preserved.

Shipped desktops no longer dial it. Remnants stay deployed — do NOT rip them out casually:

- `market/apps/web/server/relay-server.mjs` + `market/apps/web/scripts/copy-relay.mjs` (still copied
  into the web build / Docker image)
- k8s web `command: ['node', 'build/relay-server.mjs']` (`market/k8s/overlays/prod/desktop-grants-patch.yaml`)
- `KELP_DESKTOP_DB_URL` grant override — prod sets it to `wss://kelp.market/api/desktop/db/rpc`
  in `desktop-grants-patch.yaml`; unset → grant copies `KELP_MARKET_DB_URL` verbatim
- `DEFINE ACCESS desktop` in `market/packages/db/schemas/init.surql`

## Rules

- NEVER add a SurrealDB driver to the desktop bundle; new desktop data flows go through
  `/api/desktop/*` HTTP routes.
- The grant still mirrors `KELP_MARKET_DB_URL` (overridable via `KELP_DESKTOP_DB_URL`), but
  shipped desktops never use it for data — publish/sync is HTTP-only.
- Removing the relay requires touching the web build copy step, the k8s command patch, and the
  grant env override together; old desktops (0.4.x–0.6.x) may still expect the grant keys.
