# AGENTS.md — @kelp_digital/seal (future `woss/seal-ts`)

SEAL (Secure Evidence Attribution Label) v1 implementation: TypeScript signer +
vendored JS validator. First full JS signer — upstream JS ([hackerfactor/SEAL-JS](https://github.com/hackerfactor/SEAL-JS))
is validator-only; the only other signer is C ([hackerfactor/SEAL-C](https://github.com/hackerfactor/SEAL-C)).
Spec: [SEAL v1.2.12](https://github.com/hackerfactor/SEAL/blob/main/SPECIFICATION.md).

This package is prepared for standalone publication as `@woss/seal-ts` (GitHub `woss/seal-ts`,
MIT). Until that cutover it stays in the kelp-market workspace as `@kelp_digital/seal`.

## Hard rules

- **`src/vendor/seal-validator.js` is DO-NOT-EDIT.** Vendored verbatim from upstream,
  pinned by sha256 in `src/vendor-pin.test.ts`. Re-vendoring updates the pinned hash in
  that test AND the provenance header in the file, together, deliberately.
- **Signer/validator parity is the invariant.** Every signer output must authenticate
  byte-exactly under the vendored validator. `roundtrip.test.ts` is the gate for any
  record-building or embed change.
- **Never touch validator internals to make a signer change "pass"** — fix the signer;
  the validator mirrors the C reference (`SealVerify`, `SealDoubleDigest`, `_SealValidateRevoke`).

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

## Commands

- `pnpm --filter @kelp_digital/seal test` — vitest (incl. `upstream-suite.test.ts`, a
  1:1 port of upstream's `seal-tests.html`, and `vendor-pin.test.ts`).
- `pnpm --filter @kelp_digital/seal build` — tsc + copies the vendored validator into `dist/vendor/`.
- `pnpm --filter @kelp_digital/seal lint`.

## Verify path (for DNS work)

Validation resolves the signer's public key from DNS TXT at the record's `d=` domain
(DoH chain: Google → Quad9 → Cloudflare, 5 s abort each). Known quirks — `da=sha224`
never validates (no WebCrypto SHA-224); TXT parsing and revocation (`p=revoke`, `r=<date>`)
are all covered by the vendored code and the upstream suite. Ops runbook for our own
records: repo root `docs/infra/seal-dns.md`.
