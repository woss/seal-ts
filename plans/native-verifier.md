---
type: Plan
title: Native TypeScript verifier — drop vendored SEAL-JS
description: Implement full SEAL v1.2.12 verification natively in seal-ts and delete src/vendor/seal-validator.js plus its pin test.
status: stable
generated:
  by: omp/01a1d4f0-9f25-70b0-b7eb-d0f0dacfde2d
  at: 2026-11-13T13:15:00Z
---

# Native TypeScript verifier — drop vendored SEAL-JS

## Context

`@woss/seal-ts` implements SEAL v1.2.12 signing in TypeScript (`src/sign/`). Verification,
however, is a 2,006-line verbatim copy of upstream's `hackerfactor/SEAL-JS` browser script
(`src/vendor/seal-validator.js`), sha256-pinned by `src/vendor-pin.test.ts`, registered as a
global (`globalThis.SEAL`) and surfaced through a typed facade in `src/seal.ts`.

Direction from the maintainer (2026-11-13): **seal-ts implements everything from the
specification natively. No vendored code.** Spec: [SEAL v1.2.12 SPECIFICATION.md](https://github.com/hackerfactor/SEAL/blob/main/SPECIFICATION.md).

Facts that shape the work:

- **The signer depends on the vendor file too.** `src/sign/signer.ts` side-effect imports
  `../seal.js` and calls `SEAL.detectFormat(bytes)` and `SEAL._computeByteRanges(...)` off
  `globalThis` for embed placement. Removing the vendor file therefore also removes the
  signer's only global-state dependency.
- **The conformance net is already ours.** `src/upstream-suite.test.ts` (698 lines) is a 1:1
  vitest port of upstream's `seal-tests.html` vectors (upstream commit `ed80e4e9…`), exercised
  through the `seal` facade — `_findAllSEALRecords`, `_computeByteRanges` (+ error strings),
  `_parseDNSTXT`, `_decodeSig`, `_scanByFormat`, `detectFormat`, `validateBuffer`. It tests
  the *API shape*, not the vendor file; it survives the rewrite unmodified.
- **All tests go through the facade.** No test imports the vendor file directly except
  `vendor-pin.test.ts` (which dies with it).
- **The upstream suite has no positive cryptographic vector.** Every `validateBuffer` case in
  `upstream-suite.test.ts` uses `s="FAKESIG"` and asserts error/warning/revocation paths — no
  case asserts `valid: true` from a real RSA/ECDSA verification. Today's only real-crypto check
  is `roundtrip.test.ts` (our signer ↔ our verifier). This shapes the test strategy below.
- **Known vendor conformance gap:** `da=sha224` never validates — WebCrypto has no SHA-224
  digest and no pre-hashed signature mode, so the vendor cannot support it. The spec allows
  `sha224`; this plan keeps the limitation (fails closed) and documents it — see
  "Known limitation" below.

## Goal

1. Native TypeScript implementation of the full verify path: record scanning, parsing,
   `b=` range computation, double digest, DER signature verification, DNS TXT key discovery
   (DoH), revocation.
2. `sign/signer.ts` imports `detectFormat`/`computeByteRanges` from `src/verify/` — no
   `globalThis.SEAL`, no side-effect import.
3. `src/vendor/` deleted; `vendor-pin.test.ts` deleted; build, docs, LICENSE, AGENTS.md
   updated accordingly.

Non-goals: no signer behavior change (records remain byte-identical — `roundtrip.test.ts`
gate stays); no public API redesign (the `seal` facade shape is preserved); no new
dependencies (pure TS + WebCrypto + fetch).

## Lane

Branch: `feat/native-verifier` — create with `but branch new feat/native-verifier`.
No anchor (builds on `main` only). All work lands on this lane; the shared dirty pool
currently holds unrelated `.omp/` config files — commits take only this lane's file IDs.

## Design

### Module layout

New `src/verify/` (mirrors the vendor file's internals, proper TS, per-file d.ts via rslib):

| Module | Contents (vendor counterpart) |
|---|---|
| `bytes.ts` | `readBE16/32`, `readLE16/32`, `findSeq`, `b64decode`, `hexdecode`, `xmlDecode`, `strDecode` |
| `scan.ts` | `detectFormat`, per-format scanners: JPEG APP8 `SEAL\0`, PNG `seAl` chunk, ZIP, EXIF, text/fallback (`scanBlock`, `scanJPEG`, `scanExif`, …) |
| `parse.ts` | `findAllSEALRecords`, `parseSEALRecord`, record grammar (`isAlpha`/`isAlNum`, field tokenizer), binary `p=`/`pkd=` decoding |
| `ranges.ts` | `computeByteRanges` — `b=` window math, value/EOF anchors, error strings (spec-exact; also feeds the signer) |
| `sig.ts` | `decodeSig`, `mapDigestAlg`, `resolveKeyAlg`, `derToP1363` (inverse of `sign/crypto.ts` `p1363ToDer`), `verifySignature`, `detectECCurve` |
| `dns.ts` | `fetchWithTimeout`, DoH chain Google → Quad9 → Cloudflare (5 s abort each), `parseDNSTXT`, `dnsRecordMatches`, `isRevoked` (`p=revoke`, `r=<date>`) |
| `validate.ts` | `hashRanges`, `doubleDigest` (preimage `ts ":" [id ":"] primaryDigest`), `inlineAuthenticate`, `validateOneRecord`, `validateBuffer` |

`src/seal.ts` becomes a real module: constructs the same `seal` object — same method names,
same `_`-prefixed internals (`_findAllSEALRecords`, `_computeByteRanges`, `_parseDNSTXT`,
`_decodeSig`, `_scanByFormat`), same `SealValidationResult`/`SealValidateOptions`/
`SealParsedRecord`/`SealDnsOverride` types (the last with `_pBin`/`_pkdBin` binary fields,
needed by the suite and `index.ts` re-exports) — from the verify modules and exports it. The `_`-methods are a
**deliberate compatibility surface** (the upstream vector suite depends on them verbatim);
they are now properly typed exports, not `globalThis` casts. No global registration:
`globalThis.SEAL` disappears (breaking for consumers who read the global — changelog note).

**Public API intent:** the `seal` facade is the contract. The `src/verify/*` subpaths are
technically importable via the npm `./*` export wildcard but are internal and unsupported;
the rewritten docs say so. `jsr.json` (exports `"."` only) and `package.json` need no change —
verified. `computeByteRanges` carries the facade signature: `prevStart?/prevEnd?` optional,
defaulting to `0` (the signer call sites already pass all six arguments).

## Known limitation: SHA-224 (deferred, fails closed)

`da=sha224` remains **invalid with an explicit error**. Reason: WebCrypto has no SHA-224
digest *and* no pre-hashed ECDSA/RSA mode, so a signature over a SHA-224 digest cannot be
verified through WebCrypto at all; supporting it requires pure-TS ECDSA/RSA verification
(elliptic-curve scalar math, security-sensitive, several hundred lines). Deferred as out of
scope; upgrade path is a dedicated `feat/sha224` lane with pure-TS public-key verification.
The native port raises a dedicated `Unsupported digest algorithm: sha224` error —
deliberately *clearer* than the vendor's incidental WebCrypto throw message; the parity
corpus excludes sha224 so this divergence is out of the vendor-wins rule's scope.
Documented in the rewritten verify doc so the gap is a stated limitation, not silence.

### Behavior kept identical

Provenance note: with the vendor pin gone, these constants' authority is the spec
([SEAL v1.2.12](https://github.com/hackerfactor/SEAL/blob/main/SPECIFICATION.md)), not the
deleted file — each bullet cites its spec anchor.

- DoH resolver chain and 5 s aborts (same order, same fallbacks; validation procedure per spec
  "Verification" section).
- Validation error strings surfaced in `SealValidationResult.error`/`warnings` — the upstream
  suite asserts some of them verbatim.
- `SealValidateOptions` semantics incl. `dnsOverride`/`dnsOverrideMap`/`verifyOverride`.
- 65533-byte JPEG APP8 payload cap (16-bit length field minus its own 2 bytes) and PNG
  (`seAl` chunk)/text (`b=F~S,s~f` F-anchored) embed rules per spec §Embedding — already in
  the signer; verify side must accept exactly what the spec/scanner produce.

## Migration order

No intermediate commit may leave the signer or the test suite broken. The signer decouples
from the global **before** the facade flips; the vendor file stays on disk, untouched, until
the final step.

1. **Verify modules, direct tests.** Create `src/verify/` (`bytes.ts`, `ranges.ts`,
   `parse.ts`, `scan.ts`, then `sig.ts`, `dns.ts`, `validate.ts`). Gate: a new
   `src/verify/verify.test.ts` runs the upstream-suite vectors' logic against the native
   modules **directly** (not through the facade — the facade still surfaces the vendor at
   this point). Facade and signer untouched.
2. **Signer decoupled.** `sign/signer.ts` imports `detectFormat`/`computeByteRanges` from
   `src/verify/*`; drop the side-effect import and the `globalThis` cast, and update the
   signer's doc comments that reference the vendored validator (header note + the
   side-effect-import comment above the `SealApi` interface). Gate:
   `signer.test.ts` + `roundtrip.test.ts` green, vendor untouched.
3. **Facade cutover.** `src/seal.ts` rebuilt from the verify modules (no global registration,
   `_`-methods preserved as typed compat surface). Gate: `upstream-suite.test.ts` **unmodified
   and green** (it tests the facade API, which is preserved), plus `roundtrip.test.ts`,
   `browser-compat.test.ts`, `signer.test.ts`.
4. **Parity checkpoint + permanent crypto fixtures (one-time, pre-deletion).** Throwaway
   script in `temp/` (deleted after): side-effect-imports the vendor file directly, reads
   `globalThis.SEAL`, and runs both verifiers over the upstream fixtures plus a generated
   corpus (rsa/ecdsa × jpeg/png/text, `dnsOverride` fixtures incl. revocation), diffing
   `SealValidationResult`. Resolution rule: **the vendored validator wins** — any divergence
   is a bug in the native port. While the vendor is still here, capture **permanent positive
   crypto fixtures** (fixed key + fixed signature over a fixed body, one RSA + one ECDSA,
   vendor-validated) into `verify.test.ts` — the upstream suite has no positive crypto vector,
   and after deletion these fixtures are the only independent cryptographic anchor.
5. **Delete + docs.** Delete `src/vendor/seal-validator.js`, `src/vendor-pin.test.ts`, the
   `temp/` script; remove the rslib `copy` entry. Update: LICENSE (attribution paragraph
   **retained and reworded** — the verify modules are a structural TypeScript port of upstream
   SEAL-JS, MIT, commit `ed80e4e9…`, so MIT's notice-preservation applies; only the "verbatim
   copy / hash-pin" provenance wording goes), `docs/docs/vendor.md` (→ native verify doc,
   internal-subpath note, sha224 limitation), `docs/docs/verifying.md` (currently describes
   the vendored validator), `src/index.ts` module doc comment (same), AGENTS.md (vendor hard
   rules removed; parity invariant restated as spec-conformance via the upstream vector suite
   + pinned crypto fixtures; upstream-vector re-sync procedure: re-port changed vectors from
   upstream `seal-tests.html` in a dedicated commit).

## Test strategy

- `upstream-suite.test.ts`: **unmodified**, green against the native verifier. This is the
  conformance gate — vectors come from upstream, not from our reading of the spec.
- `roundtrip.test.ts`: unchanged; now gates our-sign ↔ our-verify byte-exactness.
- `signer.test.ts`, `browser-compat.test.ts`: unchanged, must stay green (signer decoupling).
- New: `verify.test.ts` — negative paths the upstream suite under-covers: tampered record
  bytes, wrong key, revoked key (`p=revoke`, past/future `r=`), bad `b=` window, oversized
  APP8 payload. Plus the **permanent positive crypto fixtures** captured in migration step 4:
  fixed key + fixed signature over a fixed body (one RSA, one ECDSA), vendor-validated before
  deletion — the only independent cryptographic anchor once the vendor is gone.
- Deleted: `vendor-pin.test.ts`.
- `pnpm lint`, `pnpm typecheck` clean; no `globalThis.SEAL` references left (grep gate).

## Alternatives considered

1. **Keep the vendored validator as the verify oracle** (status quo). Rejected: maintainer
   direction is a single-language package owning the full spec; the vendor file is an untyped
   global-registering browser script whose provenance chain rests on a hash pin, and it can
   never validate `sha224`.
2. **SEAL-C compiled to WASM as the verification witness** ([hackerfactor/SEAL-C](https://github.com/hackerfactor/SEAL-C),
   upstream's C reference implementation). Rejected: drags a C toolchain and wasm glue into a
   browser-shipped TS library — heavier than the entire validator — and CI cost forever, to
   gain one link of trust that the upstream vector suite already anchors.
3. **Depend on upstream via npm.** Rejected: upstream ships no package; the validator is a
   single global-registering script (the reason it was vendored in the first place).
4. **Keep the vendor file permanently as a dev-only cross-check.** Rejected as a shipped state
   by the same direction; adopted in miniature as the one-time parity checkpoint (step 4)
   before deletion.
5. **Full SHA-224 support via pure-TS ECDSA/RSA verification.** Rejected for this lane:
   WebCrypto cannot verify SHA-224 signatures (no SHA-224 digest, no pre-hashed mode), so
   support means hand-rolled public-key math — security-sensitive, hundreds of lines, its own
   review cycle. Kept as a documented fails-closed limitation (see "Known limitation").

## Risks

- **Shared misread of the spec** (signer and verifier are both ours): a canonicalization or
  preimage bug can roundtrip green. Mitigations: the upstream vectors (external anchor), the
  step-4 parity checkpoint against the battle-tested validator, and the **permanent positive
  crypto fixtures** — the upstream suite alone has no positive crypto vector, so without the
  captured fixtures the repo would keep no independent cryptographic oracle after deletion.
- **DNS/TXT edge cases** (multi-string TXT, quoted values, `p=revoke` semantics): covered by
  the ported suite plus new `verify.test.ts` cases; DoH behavior kept byte-for-byte identical
  in ordering and timeouts.
- **Signer regression during decoupling**: guarded by `signer.test.ts` + `roundtrip.test.ts`
  byte-exactness gates; `detectFormat`/`computeByteRanges` move verbatim, no logic edits.
- **Upstream vector drift**: with no vendor file to re-pin, future upstream vector fixes are
  absorbed by re-porting the changed `check()` cases from upstream `seal-tests.html`
  (procedure recorded in the AGENTS.md rewrite, step 5).

## Acceptance

- `pnpm test` green; `upstream-suite.test.ts` untouched and passing against native code.
- `src/vendor/` and `vendor-pin.test.ts` gone; `grep -r "globalThis.SEAL" src/` empty.
- `pnpm build` ships no vendor directory; LICENSE (upstream attribution retained, reworded for
  the port), `docs/docs/vendor.md`, `docs/docs/verifying.md`, `src/index.ts` header, and
  AGENTS.md updated.
- Positive crypto fixtures in `verify.test.ts` pass — independent cryptographic anchor exists
  without the vendor.
- `da=sha224` fails closed with an explicit error, documented as a known limitation.
