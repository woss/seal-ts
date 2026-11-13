---
name: metadata-write
description: >
  Desktop metadata write-back: pushing effective keywords/title/description
  into image files, XMP sidecars, and Lightroom .lrcat catalogs. Use when
  working on metadata-write.ts, writeSidecar, exiftool tag args, XMP write
  behavior, lrcat sync queues, keyword ownership, or debugging
  exiftool-write-not-persisted / stale-tag / mtime-churn issues in
  kelp-market's desktop app.
---

# Desktop metadata write

Entry point: `market/apps/desktop/src/lib/server/desktop/metadata-write.ts`.
All writes funnel through `writeFileMetadata(appData, assetId)` — the five
auto-sync hook sites and manual writes alike. Serialized per-path by
`withFileWriteLock` (in-process). exiftool runs by name from PATH;
`desktop-server.mjs` prepends the provisioned copy's directory, so no
per-process pool is needed.

## Effective payload

`effectivePayload(db, row)` computes what the file should carry:

- `keywords`: `effectiveKeywords` — override (or Lightroom fallback) plus
  accepted-not-dismissed `tag_feedback` tags. A user dismissal collapses
  the list.
- `title`: `titleOverride ?? describeTitle ?? exifTitle ?? ''`
- `description`: `descriptionOverride ?? describeDescription ?? exifDescription ?? ''`

Empty string means "this field should not be set" — including "unset what
an earlier era wrote".

## Clear-write invariant (NEVER skip empty fields)

`tagsFor(payload)` emits **all three tag homes unconditionally**:

| Payload field | exiftool args | Empty value |
| --- | --- | --- |
| keywords | `-XMP-dc:Subject=` + `-IPTC:Keywords=` | single `-TAG=` deletes the tag |
| title | `-XMP-dc:Title=` | deletes |
| description | `-XMP-dc:Description=` | deletes |

exiftool deletes a tag when assigned an empty value. Skipping empty fields
leaves stale values in the file forever while `fileHasPayload` demands
exact file==payload match — every write then ends
`exiftool-write-not-persisted` while exiftool still rewrites bytes (mtime
churn per attempt). Regression fixed 2026-10-18: keywords collapsed from
three tags to one (`macro`), old Title/Description from an earlier write
era survived, every subsequent write failed.

Consequences:

- A write converges the file to the payload exactly, including clearing.
- A second call with the same payload hits the `fileHasPayload` fast path
  and returns `unchanged` — no mtime churn, no byte rewrite. Verify is
  idempotent by construction.
- `normalizeKeywords` sorts both sides before compare; exiftool `-json -n`
  read-back (comma-joined for lists) is the single source of truth.

Sidecar mode (`writeSidecar`) mirrors the same payload. Both modes report
`status: 'written' | 'unchanged' | 'skipped' | 'error'` with a `reason`
for errors (`exiftool-write-not-persisted` survives for genuine
post-write mismatches, e.g. concurrent writers on one path).

Skip guard: a fully-empty payload (no keywords, no title, no description)
still skips — clear-to-nothing is not requested by any current flow.

## Catalog write-back (.lrcat sources) — keyword ownership

For Lightroom-catalog sources the file write is half the job;
`lrcat-sync.ts` drains a queue that applies the same payload inside the
`.lrcat` SQLite database itself, only while Lightroom is closed (a held
catalog is a strict gate, never advisory). Keyword-link semantics are set
by the **Kelp Desktop primary for tags** setting (`SETTING_KELP_PRIMARY_TAGS`,
default off):

| | off (default) | on |
| --- | --- | --- |
| Add payload keywords to photo | yes | yes |
| Unlink catalog keywords the payload lacks | never | yes (link rows only) |
| Title/description | add/update only, never removed | same |

- Removal is scoped to the synced photo's links and compares
  case-insensitively against the payload (`Nature` is owned by `nature`).
  The `AgLibraryKeyword` row itself is NEVER deleted — other photos and
  LR's keyword tree keep it.
- Turning the toggle on backfills the sync queue with every lrcat-sourced
  asset (`enqueueAllLrcatAssets`) so already-overridden photos reconcile
  on the next drain; the drain applies whatever the payload is at that time.
- Toggle off: the catalog owns its removals — Kelp only adds, so tags
  deleted in Kelp keep living on the photo inside Lightroom.

### Drain gate and coalescing

- The gate is **Lightroom process presence**, not only a SQLite lock:
  `isCatalogOpen` → `isLrProcessRunning()` on darwin/linux; Windows probes
  the catalog file lock first, then process presence; a missing catalog
  file counts as closed (`KELP_LR_GATE=closed` pins tests).
- One drain in flight per appData — a concurrent call coalesces onto the
  in-flight promise; newly enqueued rows wait for the next 60 s tick.
- `kickLrcatSync` fires after ingest, after bulk remove/exclude, and after
  the settings deep-clean, so an open Lightroom cannot strand the queue;
  kick failures are swallowed because the queue is durable.
- `enqueueLrcatSync` is idempotent and kind-aware — non-catalog sources
  no-op, so bulk paths can enqueue blindly.

## Tests

`metadata-write.test.ts` reproduces the storm: seed an asset, write the
old-era payload, empty the effective fields, assert the file converges
(read-back equals payload) and a repeat write returns `unchanged`.
`metadata-heal.test.ts` covers the feedback-ledger semantics feeding
`effectiveKeywords`.
