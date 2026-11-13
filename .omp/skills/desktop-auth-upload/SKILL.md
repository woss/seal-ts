---
name: desktop-auth-upload
description: >
  Desktop ↔ market auth + upload system: how the Kelp desktop sidecar trades an SSO
  session for a 15-minute SurrealDB JWT and presigned S3 upload URLs, with no DB password
  or S3 keys ever on the laptop. Covers the grant exchange endpoint, presign endpoint,
  the desktop publish flow (CID idempotency), Ed25519 key material, the SurrealDB
  `DEFINE ACCESS desktop` JWT access method, and `getDb()` token auth. Trigger when the
  user mentions "desktop grant", "grant exchange", "KELP_MARKET_DB_TOKEN", "presign",
  "desktop JWT", "SurrealDB JWT auth", "desktop publish", "CID idempotency", "why does
  the desktop have no DB credentials", "key rotation", or "desktop auth".
---

# Desktop ↔ Market: JWT auth + presigned uploads (shipped 2026-09-19)

The desktop sidecar never holds a database password or S3 keys — it trades an SSO
session for a 15-minute signed JWT (which IS the SurrealDB credential) plus permission
to ask a web endpoint for short-lived presigned S3 PUT URLs. Applies to the desktop
sidecar (`market/apps/desktop`, Tauri app) talking to a deployed market web app.
Web/worker/mcp services keep classic scoped user/pass signin; the browser upload flow is
gated off in kelp deployments (`webReadOnly`).

## The five load-bearing facts

1. **One identity source.** The SSO session is the only root of trust;
   `POST /api/desktop/exchange` converts it into everything else.
2. **Two secrets, neither leaves the server.** The Ed25519 private JWK
   (`SURREAL_JWT_PRIVATE_KEY_JWK`, web env) signs SurrealDB JWTs; S3 access keys
   (web/worker env) sign presigned URLs. The desktop gets neither.
3. **Everything on the laptop is short-lived.** Grant cache 10 min, JWT 15 min,
   presigned URLs 15 min. Grant TTL < token TTL, so a cached grant's token is always
   still valid when reused.
4. **The JWT is the database credential.** SurrealDB itself verifies it
   (`DEFINE ACCESS OVERWRITE desktop ... TYPE RECORD WITH JWT` in
   `market/packages/db/schemas/init.surql`); no app code checks passwords for the
   desktop path.
5. **The CID is the idempotency key.** Published bytes are content-addressed; a retried
   publish adopts the existing asset instead of failing or duplicating.

## Core flow 1 — login → grant exchange

```
SSO login (email → OTP; companies add TOTP)
→ sidecar: POST /api/desktop/exchange (cookie or Bearer <SSO token>) on deployed web
→ web resolves session via SSO, mintSurrealToken(locals.session.user.id) — Ed25519, 15 min
→ grant returned: KELP_MARKET_DB_TOKEN, KELP_DESKTOP_PRESIGN_URL,
  KELP_MARKET_DB_URL/NAMESPACE/DATABASE (URL overridable via KELP_DESKTOP_DB_URL; prod
  sets the WS relay wss://kelp.market/api/desktop/db/rpc), S3_BUCKET, tokenExpiresAt
→ sidecar caches grant (10 min TTL) and mirrors it into process.env
→ next getDb(): KELP_MARKET_DB_TOKEN set → db.authenticate(JWT) — SurrealDB verifies the
  Ed25519 signature vs the schema public key; session lasts 1 h
```

Never in the grant: `KELP_MARKET_DB_USERNAME/PASSWORD`, `S3_ENDPOINT/REGION/ACCESS_KEY/SECRET_KEY`.

## Core flow 2 — publish (all compute on the laptop)

Per image in `POST /api/desktop/publish` (sidecar-local, desktop-only route; each step's
failure marks that image failed, never the batch):

1. Read original bytes; `extractAssetMetadata` from the **originals** (EXIF must
   survive re-encode).
2. Re-encode: RAW containers → libraw decode → JPEG q80; > 8192 px edge → resize;
   published edge capped at 8192 (`MAX_PUBLISH_EDGE`); RAW bytes never leave the laptop.
3. `stampLicenseMetadata` — license/copyright EXIF + XMP baked into published bytes
   (non-fatal on error).
4. `deriveCid(finalBytes)` → **CID is the asset id**; existing CID → adopt
   (idempotent retry), still attach gear/verification.
5. Upload via `requestPresignedPut()`: main copy (`assets/<cid>/data.<ext>`) +
   3 JPEG presets → presigned PUT fetches. No multipart, no S3 client on the laptop;
   5 GiB non-multipart PUT cap.
6. `createAsset(db, { id: cid, desktopProcessed: true, license, s3Key, s3Bucket … })` —
   `desktopProcessed` makes DB events skip every server-side pipeline job.
7. Gear + verification attach (EXIF probe, PRNU sync) — non-fatal per sub-step.

## Core flow 3 — `getDb()` auth branch (`market/packages/db/src/client.ts`)

```
KELP_MARKET_DB_TOKEN set?  → db.authenticate(token)     ← desktop sidecar
otherwise                  → db.signin(scoped)          ← web/worker/mcp
                             (fallbacks: unscoped root on 2.x, bootstrap root for mem://)
→ db.use({ namespace, database })  — token path logs user=desktop-jwt
```

Precedence: token wins when present. Server containers never set
`KELP_MARKET_DB_TOKEN`. Reconnects run the same branch (grant cache mirrors env).

## Sharp edges (NEVER violate)

- **JWT `id` claim is parsed as SurrealQL.** Always angle-quote:
  `user:⟨${userId}⟩`. An unquoted id with `-` becomes arithmetic
  (`user:abc-123` → `user:abc`). Done in the minter; keep it.
- **jose's WebCrypto rejects private keys for verify** → use
  `importVerifyKey(privateJwkJson)` (`@kelp_digital/market-db`), which derives the
  public half via `node:crypto.createPublicKey`. Memoized per process.
- **Single-quote `SURREAL_JWT_PRIVATE_KEY_JWK` in files that get `source`d** —
  bash strips double quotes from unquoted values.
- **Presign caller duty:** the PUT's `Content-Type` header must byte-match the signed
  `contentType` — MinIO/S3 reject mismatches.
- **No `KELP_MARKET_DB_*` / `S3_*` in the sidecar's start env** — credentials arrive
  only via the grant (`getMarketDb` fails fast otherwise).
- **Kill switch:** unset `KELP_DESKTOP_GRANTS` → both desktop web endpoints 403.

## Key rotation

1. `node market/packages/db-ops/scripts/generate-surreal-access-key.mjs` → new private JWK + public PEM.
2. Replace `SURREAL_JWT_PRIVATE_KEY_JWK` in web env/secret (single-quoted), restart web.
3. Replace the `ALGORITHM EDDSA KEY` PEM in `market/packages/db/schemas/init.surql`
   (`OVERWRITE` makes re-apply idempotent — `pnpm schema:apply` / init containers).
4. Desktops pick up new tokens on their next grant exchange (≤10 min); old tokens die
   naturally (≤15 min). No user action.

Deploy web + desktop in the same release train — the grant payload shape changed; an
old desktop can't use the new grant, and removing legacy env keys from the grant cuts
off old desktops' DB access.

## References (load on demand — relative to this skill)

- `reference-components.md` — every component/file, trust model, TTLs, env vars, key
  material, SurrealDB access method details, token claims, failure-mode table, deployment.
- `reference-apis.md` — full API reference for `/api/desktop/exchange`,
  `/api/desktop/s3/presign`, `/api/desktop/publish` (auth, bodies, validation, failure codes).
- `reference-operations.md` — verification checklist, deployment details, PRNU store
  branch, related unchanged flows.
