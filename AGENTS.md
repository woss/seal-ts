# AGENTS.md — @woss/seal-ts

SEAL (Secure Evidence Attribution Label) v1 implementation: pure TypeScript
signer + native TypeScript verifier (a port of the upstream SEAL-JS validator,
itself mirroring the C reference). Spec:
[SEAL v1.2.12 SPECIFICATION.md](https://github.com/hackerfactor/SEAL/blob/main/SPECIFICATION.md).

The package is standalone (`@woss/seal-ts`, GitHub `woss/seal-ts`, MIT): no
vendored or generated third-party code ships in it.

## Signer invariants (break these = bug)

- Timestamps: 14 digits `YYYYMMDDhhmmss`, `sf=date:<fmt>` prefix (see `sign/signer.ts`).
- `id=` always paired with `uid=` (same value); ids must be non-empty, no whitespace/quotes
  (spec §uid). DNS `uid=` pinning matches against the record's `uid=`.
- Double digest preimage: `ts ":" [id ":"] primaryDigest` — mirrors `SealDoubleDigest`.
- Embeds per spec v1.2.12: JPEG = APP8 segment with `SEAL\0` label; PNG = `seAl` chunk;
  text = appended sidecar, `b=F~S,s~f` (F-anchored). Both segment types cap at 65533 bytes
  of payload (JPEG 16-bit length field minus its own 2 bytes).
- ECDSA signatures are DER-encoded (variable 70–72 B); `p1363ToDer` in `sign/crypto.ts`
  converts raw P-1363 output. Embed `b=` windows are value/EOF-anchored precisely so
  variable-length signatures re-verify.

## Verification

- Native TS verifier lives in `src/verify/` (`bytes`, `ranges`, `parse`, `scan`,
  `sig`, `dns`, `validate`); `src/seal.ts` is the typed facade. No `globalThis.SEAL`.
- Conformance: `upstream-suite.test.ts` is a 1:1 port of upstream's `seal-tests.html`
  vectors and must stay unmodified; `crypto-fixtures.test.ts` pins frozen
  signer→verifier records (RSA + ECDSA) as the permanent positive-crypto anchor;
  `roundtrip.test.ts` gates any record-building or embed change.
- The upstream suite asserts error strings verbatim — changing a validation message is a
  conformance break, not a wording tweak.
- Known limitation: `da=sha224` fails closed with an explicit error (WebCrypto has no
  SHA-224 digest or pre-hashed signature mode). Documented in `docs/docs/verifying.md`.

## Commands

- `pnpm test` — vitest (includes `upstream-suite.test.ts`, `crypto-fixtures.test.ts`,
  `roundtrip.test.ts`). Requires Node ≥ 26 (`Uint8Array.toBase64`/`fromBase64`).
- `pnpm build` — rslib, structure-preserving ESM (`dist/`).
- `pnpm lint`.
