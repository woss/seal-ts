---
name: license-pipeline
description: >
  Reference for the Kelp license pipeline: snapshot/drift-guard discipline,
  quote freezing, training-job bundle packaging, license delivery surfaces
  (bundle tar.gz, manifests, MCP downloads), SEAL verification trust model,
  and licensing decision. Use when the user mentions the license pipeline,
  license snapshot or frozen hash, quote/confirm/mint hash mismatch,
  training-job LICENSE.md bundle, seal.json, /manifests/:id, DNS TXT seal
  verification, SEAL_PRIVATE_KEY, editing CLAUSE_LIBRARY license text, or
  "license terms changed since purchase" delivery failures.
---

# License Pipeline

One contract: **a buyer receives exactly the license text they were quoted against,
byte-identical, or the pipeline refuses to deliver** — regardless of time elapsed or
edits in between.

Full clause content + composition: `market/packages/schema/src/licenses.ts`.

## Chain (flow)

1. Upload → `stampLicenseMetadata` embeds Creator License tags (EXIF Copyright, XMP
   Rights/WebStatement → `/licenses/kelp-creator-v1`) into published JPEG bytes; CID
   covers stamped bytes. Asset row records `licenseVersion`/`licenseStampedAt`.
2. `estimate_training_set` → quote row freezes `licenseFullText` + `licenseTextHash`
   (+ `composedLicenseId`, `clauseIds`). Freezing point.
3. `confirm_training_set` → revalidates composition server-side against the live
   registry; persisted `clauseIds` written back on the quote. Mismatch → throw before
   settlement (`market/packages/db/src/quote-confirm.ts`).
4. Payment webhook → training job bundles `LICENSE.md` in tar.gz.
5. Delivery: bundle manifest (sealed, public), MCP `get_training_set` download.
6. Single-asset: `request_license` freezes text on `license_request` row →
   `mintLicenseGrantForRequest` stamps `buyerLicenseId` + `buyerLicenseText` into a
   LicenseGrant in `proof_ledger`.

## Snapshot discipline — drift guard

Drift guard = `hashText(fullText)` (sha256, `market/packages/db/src/prnu.ts`). At every
out-boundary compare frozen hash vs freshly recomposed text from the live clause registry.

| Boundary | Frozen | Guard |
|---|---|---|
| Estimate (composed + floor-only) | Quote: `licenseFullText`, `licenseTextHash`, `composedLicenseId`, `clauseIds` | freezing point |
| Quote confirm | confirmed `clauseIds` on quote | mismatch → throw pre-settlement |
| Prebuilt dataset purchase (`purchaseDataset`, `market/packages/db/src/datasets.ts`) | full `kelp-training-v1` text + hash on quote | bundle guard |
| Training-job bundle (`market/apps/worker/src/jobs/training-job.ts`) | `LICENSE.md` bytes + `licenseDocumentSha256` in sealed manifest | `hashText(licenseText) !== quote.licenseTextHash` → job FAILS, nothing delivered |
| License request (`market/apps/mcp/src/tools/request_license.ts`) | `license_request` row text + hash | freezing point |
| Grant mint (`mintLicenseGrantForRequest`, `market/packages/db/src/quotes.ts`) | manifest stamps `buyerLicenseId`/`buyerLicenseText` + hash | frozen vs live mismatch → throw, NEVER mint |

- Absent hash (legacy rows) = guard skipped; settlement path unchanged — never a hard
  failure on old data.
- `seed-licenses.mjs` derives rows from the compiled `LICENSE_REGISTRY` — never
  hand-maintain mirrored rows.

## Invariants (test-enforced)

- Every composition includes `MANDATORY_BUYER_CLAUSES` (6 clauses incl. `termination`),
  even when the caller omits it.
- `LICENSE.md` sha256 in the tar equals the sealed manifest's
  `license.licenseDocumentSha256`, and shipped text matches frozen `licenseFullText`
  byte-for-byte (`node --test market/packages/db` bundle round-trip in `training-job-bundle` coverage — the worker bundle path is `market/apps/worker/src/jobs/training-job.ts`).
- Creator agency (`sublicense-agency`): buyer terms can never grant beyond the
  creator's grant; each buyer license is fixed at time of sale.

## Creator stamping — critical rule

Desktop publish records `licenseVersion`/`licenseStampedAt` **only when stamping
succeeded**; the DB row must never claim a stamp the bytes don't carry.

## Delivery surfaces

- Bundle tar.gz: `manifest.json` (pretty-printed; SEAL attests the COMPACT canonical
  bytes), `seal.json` (SEAL envelope over the manifest, shipped in-bundle for offline
  verification), `LICENSE.md`, assets at `assets/<assetId>/data.jpg`.
- `GET /manifests/<jobId>.json` (web, public): sealed bundle manifest from `bundleManifest`/`bundleSeal` persisted on the quote at settlement.
- `GET /api/v1/manifests/:id` (MCP, public): single-asset LicenseGrant manifests from `proof_ledger`. Public by design — verifiers fetch without a key.
- `/licenses/[id]` page: registry + platform licenses from `LICENSE_REGISTRY`;
  `kelp-composed-*` ids resolve server-side from the quote that froze them (via
  `proof_ledger`), 404 when the id no longer composes to itself.

## Verification trust model

Client-side: `market/apps/web/src/lib/seal-verifier.ts`. Per-check results (manifest
hash, signature, seal hash/algorithm/signature).

1. **DNS TXT** `_seal.<domain>` (Cloudflare DoH) — any domain, tag-parsed (`seal=1`,
   `ka=ed25519`, `p=<hex key>`); candidate keys must actually verify the signature.
2. **Fallback** `/.well-known/kelp-seal-pubkey.json` — ONLY for allowlisted Kelp
   domains (`kelp.market`, `kelp.digital`). A non-Kelp domain with no/inapplicable TXT
   resolves `not-found`, NEVER the platform key — the fallback must not anchor
   third-party domains.
3. **Key rotation**: endpoint publishes `keys` (SEAL_PUBLIC_KEYS) and `revoked`
   (SEAL_REVOKED_KEYS); verifier picks whichever candidate verifies; `revoked` is
   checked even for the primary key.
4. Production hard-errors without `SEAL_PRIVATE_KEY`; the all-zero dev key is
   unreachable outside dev/test.

## Editing clause text

Allowed: `title:`/`body:` strings in `CLAUSE_LIBRARY`.

- Future sales render new text immediately.
- **Already-frozen purchases are untouchable.** If a paid set is still undelivered and
  you edit a clause it contains, delivery fails loudly ("license terms changed since
  purchase") instead of shipping different terms — intended trade: correctness for the
  buyer beats delivery convenience. **Coordinate with the team before editing bodies
  while quotes are live.**
- Delivered signed grants never change.
- If the change stales `/legal-teams` or OG image titles, fix/flag those too.
- Advisory: legal-text changes are engineering-reviewed, NOT counsel-approved —
  external counsel sign-off required before first sale.
