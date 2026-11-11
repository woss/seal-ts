---
type: Plan
title: Prepare SEAL package for @woss/seal-ts publication
description: In-place publication prep of market/packages/seal (agent context, README, MIT license, publish manifest) — no extraction, no submodule.
status: draft
generated:
  by: omp/01a1cb1e-f7b7-75ac-b389-5180ab427b71
  at: 2026-11-11T16:45:00Z
---

# Prepare SEAL package for @woss/seal-ts publication

Prepares `market/packages/seal` to become the standalone repo [`woss/seal-ts`](https://github.com/woss/seal-ts)
(npm `@woss/seal-ts`) for external review by Neal Krawetz (Hacker Factor) — **in place**, without
extracting or submoduling now. Extraction is a later, mechanical step once review lands.

**Lane:** `chore/seal-ts-prep` (`but branch new chore/seal-ts-prep`) — independent of the open
`chore/seal-conformance` PR #405; files disjoint.

## Scope

1. `market/packages/seal/AGENTS.md` — package contract for agents: vendored-file discipline
   (`src/vendor/seal-validator.js` is DO-NOT-EDIT, sha256-pinned by `vendor-pin.test.ts`),
   signer invariants (14-digit timestamps, uid=/id= pairing, APP8 `SEAL\0` / PNG `seAl`
   embeds, text sidecars F-anchored), test commands, upstream links.
2. `market/packages/seal/README.md` — publication-grade: what SEAL is, install/usage,
   API surface (`sealSign`, `generateSealKeyPair`, `seal` facade, key import/export),
   vendored-validator provenance + Hacker Factor credit, spec v1.2.12 link.
3. `market/packages/seal/LICENSE` — MIT. Package was `AGPL3`; flip per approved plan
   (vendor file is MIT; MIT maximizes reviewer reuse). Upstream attribution stays in the
   vendored header.
4. `market/packages/seal/package.json` — publish fields only: `files`, `repository`,
   `publishConfig`/`engines` as missing. Name stays `@kelp_digital/seal` until extraction
   (rename to `@woss/seal-ts` happens with the submodule cutover, not now).

## Non-goals

- No extraction, no submodule, no import renames (worker/web keep `@kelp_digital/seal`).
- No code changes; signer/tests untouched (PR #405 owns those).

## Alternatives considered

- **Extract now + submodule** — rejected: user ruled "without extracting"; extraction before
  review feedback would churn both repos.
- **Keep AGPL3** — viable, but the presented plan (approved in chat) chose MIT for the
  standalone repo; flipping now avoids a license change riding the extraction commit.
