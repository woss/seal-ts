---
name: asset-publish-flow
description: >
  Kelp Market desktop asset publish pipeline: local scan, classify, gear
  verification, publish (bytes+record+gear edges), dataset eligibility, buyer
  integrity. Use when asked to publish assets, debug the publish flow, work on
  scan/classify/publish stages, gear sync, PRNU probes, license stamping,
  re-encode rules, CIDs, or dataset eligibility gates. Trigger phrases:
  "publish pipeline", "asset upload flow", "publish eligibility", "why is my
  asset not dataset-eligible", "stage 3 publish", "re-encode", "write-once rule".
---
# Asset Publish Flow (desktop → buyer)

Desktop is the ONLY authoring surface; web is read-only. One publish action
carries bytes, metadata, gear links and verification evidence to the market.

Pipeline: scan → classify → verify → publish → dataset-eligible → buyer.

## Stage 0 — Scan (local, no network)
`market/apps/desktop/src/lib/server/desktop/scan.ts` → local SQLite index
(`kelp-desktop/index.db`).

- Recursive walk, dot-dirs skipped, extension allowlist:
  `jpg jpeg png tiff webp dng arw cr2 cr3 nef orf raf rw2`.
- Index rows: path, mtime, size, dims, pick/colorLabel, captureTime,
  camera/lens strings, LR keywords, sha256. Unchanged files (mtime+size
  match) skipped.
- One `readFile` per file is shared by hashing, preview, EXIF and PRNU.
  RAW decodes through libraw (`decodeRawImage`) so dims are sensor-native;
  previews → `kelp-desktop/previews/<sha256>.jpg`.
- EXIF (`extractAssetMetadata`): title, description, keywords, copyright,
  DateTimeOriginal, camera/lens make+model, body/lens serials.
- Gear rows: each body/lens serial → serial-keyed row (`getOrCreateGear`,
  kind `camera_body`|`lens`); `image.bodyGearId`/`lensGearId` anchor
  PRNU caps, challenge linking and publish-time `taken_with`.
- SigLIP 768-float embedding per preview (rampp worker bridge).
- PRNU reference fingerprints per camera body (`extractSensorFingerprint`),
  capped at `PRNU_CAP` (saturate in the low tens); skipped with
  `skipped:NO_BODY_SERIAL` when no EXIF body serial. Stored in local
  `prnu_fingerprint` table + JSON on disk.
- Backfills ride the same scan (schema-version gated): keywords for old
  rows, embeddings for pre-embedding rows.

## Stage 1 — Classify (local AI pass)
`classify-job.ts` — background job, CHUNK=4, cooperative cancel.

- RAM++ tags (max 20) per preview; describe+title for rows missing them.
- Tag learning: accept/dismiss/typed-keyword decisions logged per camera
  body, reshaping future suggestions.
- Similarity propagation: strong tags (≥0.7, max 3) SUGGESTED to visually
  similar unclassified photos — suggest-only, discounted, NEVER auto-applied.
- Stored on row: `tagsModel` (JSON [tag, confidence]), `describeTitle`,
  `describeDescription`, `classifiedAt`. These feed the published record's
  title/description unless the user overrides them.

## Stage 2 — Verification evidence
QR challenge responded with a real camera photo; EXIF serials cross-checked;
pass lands in the hash-chained ledger.

Confidence tiers (`market/packages/db/src/confidence.ts`):
| Tier | Score | Meaning | Price |
| tier1 | 0.0–0.3 | EXIF serial (forgeable) | $0.50 |
| tier2 | 0.3–0.7 | challenge passed (strong 0.65 / weak 0.5) | $1 |
| tier3 | 0.7–1.0 | PRNU sensor match | $2 |

- Proof sync (Gear page "Sync gear and verifications", also run at publish):
  `ensureRemoteGear` (find-by-serial or `registerGearIdentity`) + upload
  verified-but-unsynced response photos via `POST /api/verify/proof` →
  `verifications/<responseId>.jpg`, confidence via `accumulateConfidenceScore`
  (monotonic max, never lowers). Synced challenges marked `syncedAt` locally
  — NEVER re-uploaded.
- PRNU probes sync at publish.
- Local verification evidence (challenge table, JPEGs) is worthless until a
  sync or publish carries it over.

## Stage 3 — Publish
`market/apps/desktop/src/routes/api/desktop/publish/+server.ts`. Guards:
desktop-only server, SSO session (`kelp_desktop_token` cookie), local
app-data, current ToS version.

Credentials: market access rides the login-time credential grant
(`grant.ts`) — short-lived SurrealDB record JWT (`KELP_MARKET_DB_TOKEN`,
minted by web `/api/desktop/exchange`, verified by the `desktop` access
method in `market/packages/db/schemas/init.surql`), presign endpoint URL
(`KELP_DESKTOP_PRESIGN_URL`, same JWT as Bearer), non-secret `S3_BUCKET`.
NO DB user/pass or S3 keys ever reach the laptop — uploads go direct-to-S3
via presigned PUTs (`requestPresignedPut`: 15-min JWT, 15-min URLs).

### Sequence
Once per publish, BEFORE the image loop: `syncGearAndVerifications(index,
token, owner)`. Non-fatal — degraded remote = warn, publish proceeds, next
run catches up.

Per image (each step's failure marks the IMAGE failed, never the batch;
gear/verification sub-steps individually non-fatal):
1. Read original bytes (`readFile(image.filePath)`).
2. `extractAssetMetadata` on ORIGINAL bytes once, up front — the re-encode
   decision AND every EXIF text field must survive re-encoding (RAW drops
   EXIF by nature).
3. Re-encode decision — published edge capped at 8192 px (`MAX_PUBLISH_EDGE`),
   never AVIF (encoder dimension limits):
   - RAW container (RAW_EXTS + TIFF magic): libraw decode →
     `.rotate().resize(8192 inside, no enlarge).jpeg(q80)` — published
     original IS the full decode; RAW bytes never leave the laptop.
   - RAW extension but JPEG magic (misnamed): publish as JPEG.
   - Non-RAW with max edge > 8192: `.rotate().resize(8192 inside, no
     enlarge).keepExif().jpeg(q80)` — orientation baked into pixels, EXIF
     preserved through resize.
   - Otherwise: no re-encode; pixels byte-identical (license stamp still
     rewrites the container).
   - `orientationOverride` (review-grid rotate, per asset) rides the same
     `.rotate()`: override > 0 always re-encodes and bakes it in; 0/absent
     keeps plain EXIF-orient. Source bytes on disk stay immutable.
4. Metadata precedence (record values):
   - title: user override → EXIF title → describe title → filename
   - description: user override → EXIF description → describe description
   - keywords: user override (comma list) → EXIF keywords
   - plus `indexTags`: classifier's accepted tags with confidences.
5. License stamp + embedding: `stampLicenseMetadata(bytes, copyright,
   { title, description, keywords })` — XMP rights pair + EXIF copyright +
   orientation pin (strict: incomplete stamp THROWS and publish continues
   unstamped, never half-stamped), plus EXIF ImageDescription and XMP merge
   of dc:title/dc:description/dc:subject. Embedded ONCE, here, before the
   CID. Later edits update record/manifests, NEVER the bytes.
6. CID: `deriveCid(finalBytes)` of the exact published bytes. The CID IS
   the asset id.
7. Adopt path — `findAssetById` hit (retry after partial publish): mark
   published locally, run idempotent gear/verification attach, `continue`.
   NEVER re-upload or re-stamp published bytes.
8. S3 upload: main object `assets/<cid>/data.<ext>` (multipart), then three
   locally generated presets `generateThumbnail` →
   `assets/<cid>/presets/{sm,md,lg}.jpg` (500/900/1200, q80). md preset
   becomes the thumbnail URL.
9. Asset record (`createAsset`): id = CID, `desktopProcessed: true` (server
   pipeline jobs skipped), license = deployment default
   (`kelp-training-v1` unless configured), PUBLISHED dimensions (sharp on
   final bytes), `fileSize` of final bytes.
10. `attachGearAndVerification`:
    - EXIF re-probe of original bytes (`probeAndLinkGear`): AI generator
      signatures → `ai_detection` step; serial-based `taken_with` links.
    - Local-index linking: `bodyGearId`/`lensGearId` → `getGearById` →
      `ensureRemoteGear` → `relateAssetTakenWith` (idempotent, confidence
      1.0 with serial). Survives stripped EXIF — scan already knew the gear.
    - Verification edges: refetch `getGearIdentity`; when `confidenceScore
      ≥ minScoreForTier(DATASET_MIN_TIER)` (tier1 → floor 0.0) →
      `createGearVerificationEdge(identity, asset, method, confidence)`.
      Method = `challenge_response` if a local verified challenge references
      that gear, else `sensor_fingerprint`. Deduped per (gear, asset).
      Unverified-gear assets stay linked and price at their EXIF tier —
      gear does NOT gate dataset eligibility (owner decision 2026-09-28).
    - PRNU probe: local fingerprint for this image syncs via
      `saveFingerprint` (kind `probe`) against the linked body identity,
      making the sensor challengeable server-side.
11. Bookkeeping: license-stamped marker, thumbnail URL, pipeline steps
    (`presets/tags/rampp_tags/describe/ai_detection`) all `done`.
12. Tag edges: every keyword → `getOrCreateTag` +
    `relateAssetTag(confidence 0.8, source model)`; classifier tags with
    stored confidences likewise.
13. `markImagePublished` — library shows asset published with its CID.

## Post-publish state
| Object | Key |
| Main image | `assets/<cid>/data.jpg` |
| Presets | `assets/<cid>/presets/{sm,md,lg}.jpg` |
| Challenge responses | `verifications/<responseId>.jpg` |
| Asset record | `asset:⟨cid⟩` |
| Gear graph | `asset ->taken_with-> gear_identity` |
| Verification edges | `gear_identity ->gear_verifies-> asset` (method + confidenceAtTimeOfUpload) |
| Sensor references | PRNU fingerprints via `saveFingerprint` |

**Write-once rule**: bytes are written exactly once at first publish. The
CID is the hash of the STAMPED published bytes, not of the untouched camera
file, and stays stable forever. Later edits update the record (and dataset
manifests through it), never the bytes.

## Stage 4 — Dataset eligibility
Datasets are assembled from asset RECORDS, not bytes; `manifest.json` carries
assetId, title, license, price, thumbnail per entry.

Eligibility enforced twice with identical criteria — estimate gate
(`quotes.ts`) + confirm re-check per frozen asset (`datasets.ts`); both read
live records, so a desktop publish makes an asset eligible immediately:
- record: title AND description present, ≥ 1 tag edge.

Gear verification does NOT gate eligibility (owner decision 2026-09-28).
`minConfidence` explicitly passed to an estimate filters the candidate pool
by tier; absent, no gear leg applies.

## Stage 5 — Buyer integrity
Web (`/dashboard/asset/[id]`, gear registry, datasets) and MCP tools are
read views over the same records. Web metadata editing disabled — records
change only via desktop republish/adopt and record edits. Bytes are
content-addressed (`deriveCid`, same CAR derivation as the finalize worker
and IPFS stack): a buyer re-derives the CID from the download and compares
against the manifest's assetId.

## Web upload path (disabled)
`upload/start` → presigned PUT (`tmp/<uuid7>/data.<ext>`) → `upload/complete`
enqueues `asset_finalize` (derive CID, dedup, promote to
`assets/<cid>/data.<ext>`, create record, `asset_created` event chains
`asset_meta` → stamp/probe/presets/PRNU → tagging, link gear from EXIF
serials). Disabled at API level by the read-only flag until web uploads
return.
