---
title: Verifying
sidebar_position: 4
---

# Verification

The verify side is the upstream SEAL-JS validator vendored **verbatim**
(sha256-pinned by test), so verification behaves identically to
`sealtool`/SEAL-JS.

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

## Known quirks (upstream parity, intentional)

- `da=sha224` records can never validate — WebCrypto has no SHA-224.
- TXT parsing, multiple-key domains, and revocation (`p=revoke`,
  `r=<date>`) all follow the vendored upstream behavior exactly.

These are covered by the upstream suite port (`upstream-suite.test.ts`).
