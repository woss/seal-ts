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
await persist(exportPkcs8B64(kp.key)); // store the private key

// Later:
const key = await importPrivateKey(storedPkcs8B64, 'ecdsa');
```

## DNS TXT distribution

Key distribution follows the SEAL DNS model: a TXT record at the signing domain
carrying:

| Field | Meaning                                        |
| ----- | ---------------------------------------------- |
| `seal=` | record marker                                |
| `ka=`  | key algorithm (`ecdsa` / `rsa`)               |
| `p=`   | base64 SPKI public key                        |
| `uid=` | optional per-account pinning                  |
| `kv=`  | key version                                   |
| `r=`   | revocation: `r=<YYYYMMDDhhmmss>` or `r=revoke`|
| `p=revoke` | key revocation                            |

Example record for `example.com`:

```
example.com. IN TXT "seal=v1; ka=ecdsa; p=<base64 SPKI>; kv=1"
```

Ops runbook for our own records: kelp-market repo root
`docs/infra/seal-dns.md`.
