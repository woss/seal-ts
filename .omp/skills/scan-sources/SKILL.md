---
name: scan-sources
description: >
  How the Kelp desktop indexer scans folder sources and Lightroom catalogs:
  source kinds, change detection, XMP sidecar ingestion for RAWs, deepest-source
  attribution, raw-sibling preference, and blocklist gating. Use when working
  on desktop scan behavior (scan.ts, lrcat ingestion, xmp-sidecar.ts),
  debugging missing/duplicated scanned assets, attribution of files to the
  wrong source, sidecar keyword reads, lrcat keyword sync, or building any new
  source kind / scan fast-path. Triggers: scan sources, rescan, attribution,
  sidecars, XMP sidecar, Lightroom catalog scanning, lrcat scanning,
  raw-sibling, scan keywords.
---

# Desktop scan sources

Logic lives in `market/apps/desktop/src/lib/server/desktop/scan.ts`.

## Source kinds

| Kind | Discovery | Keyword source of truth |
|---|---|---|
| `directory` | filesystem walk (allowlisted image extensions) | EXIF/XMP in file; `<basename>.xmp` sidecar for RAWs |
| `lrcat` | Lightroom catalog SQL — replaces the walk entirely | the catalog (file XMP may lag; NEVER consulted) |

The lrcat query returns rows, `lrKeywords`, and LR-rendered preview locations
in one pass. Originals moved out from under the catalog surface as error rows
and are skipped — the catalog snapshot is not the asset.

## Change detection (fast-path rules)

- Directory rows: asset id = hash of `path:mtime`. mtime bump = new asset.
  Unchanged rows take an upsert no-op fast-path that skips hashing, EXIF
  parsing, and blocklist work.
- lrcat rows: anchor is the **file's** mtime, NOT the catalog `modDate` —
  a catalog-only keyword edit must not move the asset id. A rescan
  reconciles `lrKeywords` from the catalog snapshot for known rows the
  fast-path skipped.
- RAW sidecars: row's `xmpMtime` stores the sidecar's mtime; unchanged
  sidecar on a known row skips the sidecar parse entirely.
- Kelp's own metadata writes wrap in `suppressRescan` quiet windows
  (consumed by the file watcher and the poll tick — suppression means
  "drop this fire", never "defer"), so own writes never re-trigger a scan.
  Content-identical rewrites keep AI/user columns via carry-forward in
  `upsertImage`; a content change never carries them.
- lrcat rows are blocklist-gated **before any file read**. The unchanged
  fast-path skips re-hashing when `sha256` is stored; legacy NULL-sha rows
  get exactly one backfill hash on the unchanged path.

## XMP sidecars (directory sources only; `xmp-sidecar.ts`)

- RAW bytes can't carry metadata: Lightroom lands keywords in a
  `<basename>.xmp` sidecar next to the RAW.
- Keywords = `Subject` ∪ `Keywords`, read via `exiftool -json -n -Subject -Keywords`.
- Sidecar keywords are merged with EXIF keywords into the row's list;
  the blocklist gate runs on the MERGED list and fails closed — a matched
  sidecar keyword excludes the asset (no row, no preview).
- Sidecar edits don't touch the RAW's mtime, so the known fast-path does a
  fresh sidecar read and persists the merged list when changed.
- lrcat sources NEVER read sidecars — the catalog is authoritative.

## Deepest-source attribution (directory scans)

A file belongs to the source whose path is the longest prefix of its path
(`owningSourceId`). A scan rooted at `~/Pictures/woss-photo` hands
`windsurf/` files to an existing `woss-photo/windsurf` source so per-source
counts match user expectation. On the unchanged fast-path, rows attributed
to the scan root by an earlier scan are re-owned with a cheap UPDATE when a
nested source was added later. lrcat rows stay catalog-authoritative and
are never re-owned.

## Ignored files

Non-image files the walk passes (videos, `.jpg_original`, PSDs, dotfiles)
are counted in `progress.ignored` and surfaced as `· N ignored` on the
Sources page status card. Render them visibly, never drop silently.

## Raw-sibling preference

A JPEG with a same-basename RAW sibling is redundant:

- New pairs are skipped at scan time.
- Already-indexed JPEGs are removed and recorded as excluded with reason
  `raw-sibling`; NO tombstone — if the RAW disappears later, the JPEG is the
  best remaining capture and re-imports on the next scan.

## Tests

Adjacent in `market/apps/desktop/src/lib/server/desktop/`:
`lrcat.test.ts`, `scan-lrcat.test.ts`, `lrcat-sync.test.ts`,
`xmp-sidecar.test.ts`, `xmp-sidecar-index.test.ts`,
`scan-blocklist.test.ts`. When changing scan behavior, extend the matching
test file.

## Related skills

Keyword overrides and the tag blocklist live in their own skills
(`cleared-keywords-override`, `import-tag-blocklist`) — do not restate their
rules here.
