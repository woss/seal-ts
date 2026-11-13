---
title: Keys
sidebar_position: 5
---

# Keys

| Function                           | Purpose                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `generateSealKeyPair(alg?)`        | WebCrypto keypair + base64 SPKI (for the DNS `p=` field) + PKCS#8 private key |
| `importPrivateKey(pkcs8B64, alg)`  | Import the stored private key for signing                                     |
| `exportSpkiB64` / `exportPkcs8B64` | Publish / persist keys                                                        |

```ts
import { generateSealKeyPair, exportPkcs8B64, importPrivateKey } from '@woss/seal-ts';

const kp = await generateSealKeyPair('ecdsa');
await persist(kp.pkcs8B64); // already base64 PKCS#8 — store as-is

// Later:
const key = await importPrivateKey(storedPkcs8B64, 'ecdsa');
```

## DNS TXT distribution

Key distribution follows the SEAL DNS model: a TXT record at the signing domain
carrying:

| Field | Meaning                                        |
| ----- | ---------------------------------------------- |
| `seal=` | record marker (`1`)                          |
| `ka=`  | key algorithm (`ecdsa` / `rsa`)               |
| `p=`   | base64 SPKI public key                        |
| `uid=` | optional per-account pinning                  |
| `kv=`  | key version                                   |
| `r=`   | revocation: `r=<YYYYMMDDhhmmss>` or `r=revoke`|
| `p=revoke` | key revocation                            |

Fields are `name=value` pairs separated by **spaces** (the value ends at the next
space or the end of the TXT string); `p=` is bare base64 — the output of
`exportSpkiB64`, no brackets or delimiters inside.

Example record for `example.com`:

```
example.com. IN TXT "seal=1 ka=ecdsa p=MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEw04gTTBr2FPCkFVRQhRQAe2NURZq6c8z1kv6d0iGm0Q kv=1"
```

Ops runbook for our own records: kelp-market repo root
`docs/infra/seal-dns.md`.
