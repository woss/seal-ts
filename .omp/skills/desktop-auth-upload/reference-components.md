# Reference — components, trust model, TTLs, env vars, keys

## Components and files

| Component | File(s) | Role |
|---|---|---|
| Key generator (one-time) | `market/packages/db-ops/scripts/generate-surreal-access-key.mjs` | Generates the Ed25519 keypair; prints private JWK + public SPKI PEM |
| Token minter | `market/packages/db/src/surreal-jwt.ts` | `mintSurrealToken()` signs 15-min EdDSA JWTs; `importVerifyKey()` derives the public verify key (jose's WebCrypto rejects private keys for verify) |
| DB client auth branch | `market/packages/db/src/client.ts` (`getDb`) | When `KELP_MARKET_DB_TOKEN` is set, authenticates with the JWT instead of user/pass |
| Schema access method | `market/packages/db/schemas/init.surql` (bottom) | `DEFINE ACCESS OVERWRITE desktop ... TYPE RECORD WITH JWT` — SurrealDB verifies the JWT server-side. Applied verbatim by `market/packages/db-ops/scripts/apply-schema.ts` (whole file as one query; literal newlines inside the PEM are fine) |
| Exchange endpoint | `market/apps/web/src/routes/(private)/api/desktop/exchange/+server.ts` | Session → grant (minted JWT + presign URL + non-secret config) |
| Presign endpoint | `market/apps/web/src/routes/(private)/api/desktop/s3/presign/+server.ts` | JWT → short-lived presigned S3 PUT URLs |
| DB relay entry | `market/apps/web/server/relay-server.mjs` (+ `market/apps/web/scripts/copy-relay.mjs`) | Custom adapter-node entry: session-checked WS relay `/api/desktop/db/rpc` → cluster-internal SurrealDB |
| Local-API guard | `market/apps/desktop/src/lib/server/desktop/guard.ts` | `requireLocalSession()` — sidecar routes 401 without a session; deployed web refuses desktop-only paths via `desktopOnly403()` |
| Publish route | `market/apps/desktop/src/routes/api/desktop/publish/+server.ts` | The desktop's own server route: encode → stamp → CID → presigned uploads → asset record |
| Grant cache | `market/apps/desktop/src/lib/server/desktop/grant.ts` | Caches the grant per SSO session, mirrors it into `process.env` |
| Presign client | `market/packages/db/src/s3-presign-client.ts` | `requestPresignedPut()` — shared HTTP client for the presign endpoint |
| PRNU store branch | `market/packages/db/src/prnu-store.ts` (`putObjectBytes`) | Presign path when `KELP_DESKTOP_PRESIGN_URL` is set; direct S3 otherwise |
| Exports hub | `market/packages/db/src/index.ts` | Public surface: `mintSurrealToken`, `importVerifyKey`, `requestPresignedPut`, `PresignedUpload` |

## Trust model

**Roots of trust (secrets, server-side only):**

1. **Ed25519 private JWK** (`SURREAL_JWT_PRIVATE_KEY_JWK`) — lives in the web process env / `kelp-market-env` secret. Signs SurrealDB JWTs; its public half also verifies presign requests.
2. **S3 access keys** (`S3_ACCESS_KEY`/`S3_SECRET_KEY`) — web/worker env only. Sign presigned PUT URLs and all server-side S3 operations. Never sent to the desktop.
3. **SSO session tokens** — held by the browser (signed cookie) or desktop (raw token via bearer). The web app forwards them to the SSO to resolve sessions; it never sees SSO secrets.

**What the desktop holds after login (all non-secret or short-lived):**

- `KELP_MARKET_DB_TOKEN` — the 15-min JWT (capability, verified by SurrealDB).
- `KELP_DESKTOP_PRESIGN_URL` — a URL (capability gated by the same JWT).
- `KELP_MARKET_DB_URL/NAMESPACE/DATABASE`, `S3_BUCKET` — connection config, non-secret.

**Verification points:** SurrealDB verifies the JWT signature/issuer/expiry against the public key in its schema. The presign endpoint verifies the same JWT with the derived public key. Nothing else is trusted: presign keys are allowlisted, content types are allowlisted, batch size is capped. The WS DB relay is a dumb pipe after a session check — the JWT is still verified by SurrealDB itself, so the relay adds transport reachability, not new trust.

The public key sitting in the schema is safe: it only lets the *server* verify tokens — it cannot mint them.

## TTLs (the timing contract)

| Credential | Lifetime | Why |
|---|---|---|
| Grant cache entry (desktop) | 10 min | One remote round-trip max per TTL; re-exchanged on fresh login |
| SurrealDB JWT | 15 min | Must outlive the grant cache (`10 < 15`) so a reused cached grant never carries a dead token |
| SurrealDB session (from JWT auth) | 1 h | `DURATION FOR SESSION 1h` in the access method |
| Presigned PUT URL | 15 min (900 s) | Upload window; new URL minted per publish |
| Stale-grant fallback | until next successful exchange | A degraded remote keeps serving the cached grant instead of breaking requests |

## Env vars

**Web (server) — `market/.env` / `kelp-market-env` secret / dev `market/apps/web/.env`:**

| Var | Required | Notes |
|---|---|---|
| `SURREAL_JWT_PRIVATE_KEY_JWK` | yes (desktop grants) | One-line JSON JWK. **Single-quote it in files that get `source`d** — bash strips double quotes from unquoted values. |
| `SURREAL_JWT_ISSUER` | no | Defaults to `kelp-market-desktop`. Must match what the presign endpoint verifies (same env). |
| `KELP_MARKET_DB_URL/NAMESPACE/DATABASE` | yes | Where the web app itself connects; also copied into the grant. |
| `KELP_MARKET_DB_USERNAME/PASSWORD` | yes | Web/worker/mcp signin (scoped user). Never granted to the desktop. |
| `S3_ENDPOINT/REGION/ACCESS_KEY/SECRET_KEY/BUCKET` | yes | Server-side S3. Only `S3_BUCKET` is copied into the grant. |
| `KELP_DESKTOP_GRANTS` | yes (=1) | Kill switch. Unset → both desktop endpoints return 403. |
| `KELP_DESKTOP_DB_URL` | no | Overrides `KELP_MARKET_DB_URL` inside the desktop grant — prod sets the public WS relay (`wss://kelp.market/api/desktop/db/rpc`). Unset → grant copies `KELP_MARKET_DB_URL` verbatim. |
| `ORIGIN` / `PUBLIC_MARKET_URL` | yes | Basis for `KELP_DESKTOP_PRESIGN_URL` and `marketOrigin` in the grant. |

**Desktop sidecar — set by the Tauri shell (or test rig):**

| Var | Notes |
|---|---|
| `KELP_DESKTOP=1` | Enables desktop-only routes (`isDesktopServer()`). |
| `KELP_APP_DATA` | Local app-data dir (`kelp-desktop/kelp-market.db` SQLite lives here). |
| `KELP_MARKET_REMOTE_URL` | Deployed web app base URL — the grant exchange target. |

The sidecar must start with **no** `KELP_MARKET_DB_*` / `S3_*` values: credentials arrive only via the grant (fail-fast in `getMarketDb` otherwise).

## Key material and the SurrealDB access method

Keypair generated once per deployment by `generate-surreal-access-key.mjs`:
**private JWK** → web env (secret, signs + verifies); **public SPKI PEM** →
`init.surql` `ALGORITHM EDDSA KEY` literal (not secret).

```surql
DEFINE ACCESS OVERWRITE desktop ON DATABASE TYPE RECORD WITH JWT
  ALGORITHM EDDSA KEY "-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----"
  DURATION FOR TOKEN 15m, FOR SESSION 1h
;
```

- `OVERWRITE` makes rotation a schema re-apply (idempotent).
- **No `AUTHENTICATE` clause:** the token's `id` claim IS the record user. SurrealDB
  v3.2.4 accepts a signature-valid token even when no `user:<id>` row exists — with
  table permissions at `PERMISSIONS WHERE true`, the session gets full table access.
  No user-row upsert is needed.
- **No `AUDIENCE` clause:** only in SurrealDB 3.3.0 (beta). The dedicated keypair +
  `ac`/`iss` claims already bind tokens to this app. Add `AUDIENCE "kelp-surreal"`
  as hardening once 3.3.0 is stable.
- `DURATION FOR SESSION 1h`: after auth the session survives 1 h;
  `invalidateOnExpiry: true` in `getDb()` plus the health probe rebuilds the
  connection with a fresh token when it dies.

## Token claims (minted by `mintSurrealToken(userId, env)`)

| Claim | Value | Purpose |
|---|---|---|
| `alg`/`typ` (header) | `EdDSA` / `JWT` | Ed25519 |
| `iss` | `SURREAL_JWT_ISSUER` ?? `kelp-market-desktop` | Binds token to this app |
| `sub` | raw userId | Conventional subject |
| `id` | `` `user:⟨${userId}⟩` `` | **The record user.** Angle-quoted because SurrealDB parses this claim as SurrealQL — an unquoted id containing `-` is parsed as arithmetic and truncated. Always quote. |
| `ac` | `desktop` | App-binding claim (readable in `$auth` context) |
| `ns` / `db` | namespace / database | Scope echo |
| `iat` / `exp` | now / now+15 min | Lifetime |

Minter throws (fail-loud) `'SURREAL_JWT_PRIVATE_KEY_JWK not set'` when the key is
missing; namespace/database required. `importVerifyKey` is used by the presign
endpoint; unit-tested in `market/packages/db/src/__tests__/surreal-jwt.test.ts`.

## Failure modes and fallbacks

| Failure | Behavior | Why it's safe |
|---|---|---|
| `SURREAL_JWT_PRIVATE_KEY_JWK` missing on web | Exchange 500 (fail closed); presign 500 | Desktop falls back to its cached/stale grant — existing behavior, no new code path |
| Remote web app degraded | Desktop keeps serving the cached grant until a later exchange succeeds | One bad response never breaks in-flight work |
| SSO unreachable at relay WS upgrade | 503, fail closed | No anonymous frames reach SurrealDB; desktop retries / uses cached grant |
| JWT expired mid-session | `invalidateOnExpiry: true` + health probe → `getDb()` reconnects, re-authenticates with mirrored token | Grant TTL (10 min) < token TTL (15 min), reused token still valid |
| Tampered / wrong-key / wrong-issuer JWT | SurrealDB and presign both reject | Signature + issuer + expiry all checked |
| Presign key/content-type/size violation | 400 with an explanatory error | Allowlists at the boundary; nothing stored |
| Presigned PUT rejected by OVH S3 (HTTP 403) | SDK ≥3.7 default bakes placeholder `x-amz-checksum-crc32=AAAAAA==` + `x-amz-sdk-checksum-algorithm=CRC32` into the URL — MinIO ignores it, OVH rejects it | `S3Client`s that presign on web carry `requestChecksumCalculation: 'WHEN_REQUIRED'` (web `asset-storage.ts`, `upload/start`, `verify/raw/sample-start`) — probe-proven |
| Grants flag unset (`KELP_DESKTOP_GRANTS≠1`) | Both desktop endpoints 403 | Deployment-level kill switch |
| Desktop starts with DB/S3 env already present | `getMarketDb` fail-fast ("desktop database credentials not granted yet") | Keeps the grant as the only credential path |
| SurrealDB record user row doesn't exist | Auth still succeeds (no `AUTHENTICATE` clause); table perms `WHERE true` | Identity binds via the signed `id` claim; least-privilege `$auth` scoping is a future schema pass |

## Deployment

**Local (orbstack, kelp-dev):** `market/k8s/overlays/local/data.yaml` pins
`docker.io/surrealdb/surrealdb:v3.2.4` + `strategy: Recreate` (single-node surrealkv
LOCK file vs rolling surge pod; prod uses TiKV, no issue). Apply:
`kubectl --context orbstack -n kelp-dev apply -f market/k8s/overlays/local/data.yaml`,
then schema via `market/packages/db-ops/scripts/apply-schema.ts` through the
`pf-surreal-dev` port-forward (svc/surrealdb 9997). Web dev env: `market/apps/web/.env`
(JWK single-quoted, `KELP_MARKET_DB_*` → 9997, `KELP_DESKTOP_GRANTS=1`).

**Prod (kelp cluster):** kelp-infra `envs/prod/3-data` (module `kv-stack`) pins
`v3.2.4`, TiKV backend. Market schema (with `DEFINE ACCESS desktop`) applies via the
market init containers when the market app deploys. Prod secret needs
`SURREAL_JWT_PRIVATE_KEY_JWK` (+ optional `SURREAL_JWT_ISSUER`) and
`KELP_DESKTOP_GRANTS=1` before desktop grants go live. Since 0.4.0 the web pod runs
the WS relay entry (`build/relay-server.mjs`) and sets
`KELP_DESKTOP_DB_URL=wss://kelp.market/api/desktop/db/rpc`.
