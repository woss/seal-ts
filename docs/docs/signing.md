---
title: Signing
sidebar_position: 3
---

# Signing

`sealSign` produces a SEAL v1 record and embeds it in the payload when the
format supports it.

```ts
import { generateSealKeyPair, importPrivateKey, sealSign } from '@woss/seal-ts';

const kp = await generateSealKeyPair('ecdsa'); // or 'rsa'

const signed = await sealSign(manifestBytes, {
  domain: 'example.com',
  key: await importPrivateKey(kp.pkcs8B64, kp.alg),
  alg: 'ecdsa',
  id: 'account-42', // optional; emitted as id= and uid= (spec §uid)
  sigFormat: 'hex', // or 'base64' (default)
});

signed.embedded; // bytes with the SEAL record embedded
signed.record;   // the <seal … /> record string
signed.format;   // 'jpeg' | 'png' | 'text'
```

## Embed formats

| Format  | Embedding                                                             |
| ------- | --------------------------------------------------------------------- |
| `jpeg`  | Spec's APP8 segment with a `SEAL\0` label                             |
| `png`   | `seAl` chunk                                                          |
| `text`  | Record appended to the bytes (sidecar model, `b=F~S,s~f`)            |

The text sidecar is anchored to start-of-file and the signature value
(`b=F~S,s~f`), so it re-verifies after embedding.

## Record structure

Records carry `sf=date:<fmt>` and use the spec's double digest —
`ts ":" [id ":"] sha256(bytes)` — signed with the private key
(ECDSA P-256 or RSA; signature emitted hex or base64).
