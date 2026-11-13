---
slug: /
title: seal-ts
sidebar_position: 1
---

# seal-ts

SEAL (Secure Evidence Attribution Label) v1 for TypeScript/JavaScript — **sign and verify**.

SEAL is an open standard for binding attribution and authentication to media: a compact
DKIM-model record (`<seal … />`) embedded in the file or shipped as a sidecar, authenticated
by a public key published in DNS TXT. The spec is maintained by
[Hacker Factor](https://www.hackerfactor.com/) — [SEAL v1.2.12](https://github.com/hackerfactor/SEAL/blob/main/SPECIFICATION.md).

The upstream JavaScript implementation ([hackerfactor/SEAL-JS](https://github.com/hackerfactor/SEAL-JS))
is **validator-only**; until now a full signer existed only in C ([hackerfactor/SEAL-C](https://github.com/hackerfactor/SEAL-C)).
This package implements the **whole spec natively in TypeScript** — signer and verifier —
with the verifier ported from upstream and conformance-tested against its public vector suite.

## Quick start

```ts
import { generateSealKeyPair, importPrivateKey, sealSign, seal } from '@woss/seal-ts';

// One-time: generate a keypair, publish the SPKI in DNS TXT (see Keys)
const kp = await generateSealKeyPair('ecdsa');

// Sign a manifest (JPEG/PNG embeds natively; anything else is a sidecar record)
const signed = await sealSign(manifestBytes, {
  domain: 'example.com',
  key: await importPrivateKey(kp.pkcs8B64, kp.alg),
  alg: 'ecdsa',
});

// Later, anywhere: verify against DNS-published keys
const results = await seal.validateBuffer(signed.embedded, 'photo.jpg');
console.log(results[0].valid); // true
```

## Where to go next

- [Installation](./installation.md)
- [Signing](./signing.md) — embed formats, record structure, algorithms
- [Verification](./verifying.md) — DNS resolution, validation results, quirks
- [Keys](./keys.md) — generation, persistence, DNS TXT distribution, revocation
