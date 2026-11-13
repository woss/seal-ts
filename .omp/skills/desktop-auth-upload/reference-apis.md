# Reference — API details

All three routes below: `exchange` and `presign` run on the deployed web app; `publish`
runs on the desktop sidecar. `exchange` and `presign` are gated by
`KELP_DESKTOP_GRANTS=1` on the web deployment (unset → 403 via `desktopOnly403()`).

## `POST /api/desktop/exchange` — session → grant

Called by the desktop sidecar right after login (and re-called by the grant cache after its 10-min TTL).

**Auth:** standard session resolution — `kelp.session_token` cookie (signed) **or**
`Authorization: Bearer <raw SSO token>` (better-auth bearer plugin). No session → 401.
**Body:** none.

**Response 200:**

| Field | Value |
|---|---|
| `marketOrigin` | `ORIGIN ?? PUBLIC_MARKET_URL ?? ''` — desktop UI links out here |
| `KELP_MARKET_DB_TOKEN` | freshly minted 15-min SurrealDB JWT for `locals.session.user.id` |
| `tokenExpiresAt` | ISO timestamp of the JWT expiry |
| `KELP_DESKTOP_PRESIGN_URL` | `${origin}/api/desktop/s3/presign` |
| `KELP_MARKET_DB_URL` / `KELP_MARKET_DB_NAMESPACE` / `KELP_MARKET_DB_DATABASE` | copied from web env; `KELP_MARKET_DB_URL` overridable via `KELP_DESKTOP_DB_URL` (prod: the public WS relay) |
| `S3_BUCKET` | copied from web env (non-secret; recorded on `asset.s3Bucket`) |

**Never present:** `KELP_MARKET_DB_USERNAME`, `KELP_MARKET_DB_PASSWORD`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`.

**Failure modes:** grants gate off → 403; no session → 401;
`SURREAL_JWT_PRIVATE_KEY_JWK` missing → unhandled 500 (**fail closed** — the desktop
falls back to its cached/stale grant).

## `POST /api/desktop/s3/presign` — JWT → presigned PUT URLs

**Auth:** `Authorization: Bearer <grant JWT>`. Verified with `importVerifyKey` +
issuer check (`SURREAL_JWT_ISSUER ?? kelp-market-desktop`). The grant-minted JWT
doubles as the presign capability token — one credential, two uses.

**Request body:**

```json
{ "uploads": [ { "key": "assets/<cid>/data.jpg", "contentType": "image/jpeg" } ] }
```

**Validation (400 on violation):** 1–8 items; key matches
`^(assets/[A-Za-z0-9][A-Za-z0-9_-]*/|prnu/)`; content type matches
`^(image/(jpeg|png|webp)|application/json)$`.

**Response 200:** `{ "uploads": [ { "key", "url", "expiresAt" } ] }` — `url` is an S3
`PutObjectCommand` presigned URL (900 s), signed with the server's S3 credentials for
`S3_BUCKET`. Array order matches the request.

**Caller duty:** the `PUT`'s `Content-Type` header must **byte-match** the signed
`contentType` — MinIO/S3 reject mismatches.

**Other codes:** 401 no/bad token; 403 grants off; 500 missing
`SURREAL_JWT_PRIVATE_KEY_JWK` or `S3_BUCKET`.

## `POST /api/desktop/publish` — the desktop upload (runs on the sidecar)

Desktop-only (`KELP_DESKTOP=1`) route on the sidecar's local server. The remote does
**zero** per-asset compute; the laptop does all of it.

**Auth:** session (same resolution as exchange) + grant env mirrored.
**Body:** `{ "imageIds": ["<local index id>", …], "tosVersion": "2026-09-09" }` (`CURRENT_TOS_VERSION`).

**Per image (each step's failure marks that image failed, never the batch):**

1. Read original bytes; `extractAssetMetadata` once from the **originals** (EXIF must survive re-encode).
2. Re-encode decision: RAW containers → libraw decode → JPEG q80; anything > 8192 px
   edge → resize; published edge capped at 8192 (`MAX_PUBLISH_EDGE`); RAW bytes never
   leave the laptop.
3. `stampLicenseMetadata` — license/copyright EXIF + XMP (title/description/keywords)
   baked into the published bytes. Non-fatal on error.
4. `deriveCid(finalBytes)` → **the CID is the asset id**. Existing CID → adopt it
   (idempotent retry) and still attach gear/verification.
5. **Upload:** build `files[]` = main copy (`assets/<cid>/data.<ext>`) + 3 presets
   (`presetKey(cid, suffix)`, `image/jpeg`) → one `requestPresignedPut(...)` for all →
   `fetch(url, { method: 'PUT', headers: { 'content-type': <signed> }, body })` per
   file. No multipart, no S3 client on the laptop.
6. `createAsset(db, { id: cid, desktopProcessed: true, license, s3Key, s3Bucket, … })`
   in the remote DB — `desktopProcessed` makes the DB events skip every server-side
   pipeline job.
7. Gear + verification attach (EXIF probe, PRNU sync). Non-fatal per sub-step.

**Response 200:** `{ results: [ { id, ok, assetId, cid, alreadyPublished?, warn?, error? } ] }`.

**Single-PUT cap:** presigned PUTs are non-multipart → 5 GiB max per object. Published
copies are ≤ 8192 px JPEG — far under.

## PRNU store branch (`putObjectBytes`)

When `KELP_DESKTOP_PRESIGN_URL` is set (desktop only), fingerprint blobs
(`prnu/<cid>`, `application/octet-stream` — raw float32, CID = content address) go
through the presign endpoint; server-side
callers (web reference route, worker) keep direct S3. The env var is read *inside* the
function — the grant lands in `process.env` after import time, so early imports do not
pin it.

## Related (unchanged) flows, for orientation

- **Web browser upload** (`/api/upload/start` → presigned staging PUT →
  `/api/upload/complete` → `asset_finalize` job): still exists in code but is gated off
  in kelp deployments by `webReadOnly` ("Editing is disabled on the web — publish and
  edit from the Kelp desktop app"). It uses server-side S3 creds and was not touched by
  this migration.
