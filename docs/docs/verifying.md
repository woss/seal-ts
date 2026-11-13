---
title: Verifying
sidebar_position: 4
---

# Verification

Verification is implemented natively in TypeScript (`src/verify/`) — no
external validator is shipped. Its structure mirrors the SEAL C reference
(`SealVerify`, `SealDoubleDigest`, `SealParse`) and is exercised against the
upstream SEAL-JS vector suite, ported 1:1 in `upstream-suite.test.ts`.

```ts
import { seal } from '@woss/seal-ts';

const results = await seal.validateBuffer(bytes, filename, {
  // Omit `dnsOverride` to resolve DNS TXT over DoH (Google → Quad9 → Cloudflare).
});
// results[i].valid, .auth, .revoked, .error
```

## Key resolution

Validation resolves the signer's public key from DNS TXT at the record's
`d=` domain. The DoH chain (Google → Quad9 → Cloudflare, 5 s abort each) keeps
verification dependency-free and browser-compatible. Pass `dnsOverride` to
inject records directly (tests, offline verification).

## Known limitation: `da=sha224`

`sha224` records fail closed with an explicit error: WebCrypto has no SHA-224
digest and no pre-hashed ECDSA/RSA signature mode, so a signature over a
SHA-224 digest cannot be verified without a pure-TypeScript hash
implementation. The spec permits `sha224`; everything else (`sha1`, `sha256`,
`sha384`, `sha512`) validates.

## Conformance

The upstream suite (`upstream-suite.test.ts`), the frozen crypto fixtures
(`crypto-fixtures.test.ts`), and the sign→verify roundtrip are all green.
TXT parsing quirks, multiple-key domains, and revocation (`p=revoke`,
`r=<date>`) follow upstream behavior.
