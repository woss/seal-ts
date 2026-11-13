# seal-ts

SEAL (Secure Evidence Attribution Label) v1 for TypeScript/JavaScript — **sign and verify**.

SEAL is an open standard for binding attribution and authentication to media: a compact
DKIM-model record (`<seal … />`) embedded in the file or shipped as a sidecar, authenticated
by a public key published in DNS TXT. Spec: [SEAL v1.2.12](https://github.com/hackerfactor/SEAL/blob/main/SPECIFICATION.md)
by [Hacker Factor](https://www.hackerfactor.com/).

The upstream JavaScript implementation ([hackerfactor/SEAL-JS](https://github.com/hackerfactor/SEAL-JS))
is **validator-only**; until now a full signer existed only in C ([hackerfactor/SEAL-C](https://github.com/hackerfactor/SEAL-C)).
This package implements the **whole spec natively in TypeScript** — signer and verifier —
with the verifier ported from upstream SEAL-JS and conformance-tested against its public
vector suite.

## Status

Pre-publication. The package will ship on npm as `@woss/seal-ts` (repo `woss/seal-ts`)
after external review; inside the kelp-market workspace it is `@kelp_digital/seal`.

Docs: <https://woss.github.io/seal-ts/> (API reference: <https://woss.github.io/seal-ts/typedoc/>).

## Install

```sh
pnpm add @woss/seal-ts   # once published; until then: workspace package
```

## Sign

```ts
import { generateSealKeyPair, importPrivateKey, sealSign } from '@woss/seal-ts';

const kp = await generateSealKeyPair('ecdsa'); // or 'rsa'
// publish kp.spkiB64 in DNS TXT for your domain (see "Key distribution")

const signed = await sealSign(manifestBytes, {
  domain: 'example.com',
  key: await importPrivateKey(kp.pkcs8B64, kp.alg),
  alg: 'ecdsa',
  id: 'account-42', // optional; emitted as id= and uid= (spec §uid)
  sigFormat: 'hex', // or 'base64' (default)
});

signed.embedded; // bytes with the SEAL record embedded (JPEG APP8, PNG seAl, or appended text)
signed.record; // the <seal … /> record string
signed.format; // 'jpeg' | 'png' | 'text'
```

Records carry `sf=date:<fmt>` and use the spec's double digest
(`ts ":" [id ":"] sha256(bytes)`). JPEG embeds use the spec's APP8 segment with a
`SEAL\0` label; PNG embeds use a `seAl` chunk; anything else is treated as text and the
record is appended (sidecar model, `b=F~S,s~f` — anchored to start-of-file and the
signature value, so it re-verifies after embedding).

## Verify

```ts
import { seal } from '@woss/seal-ts';

const results = await seal.validateBuffer(bytes, filename, {
  // Omit `dnsOverride` to resolve DNS TXT over DoH (Google → Quad9 → Cloudflare).
});
// results[i].valid, .auth, .revoked, .error
```

The verify side is a native TypeScript port of the upstream validator, conformance-tested
against its public vector suite. It behaves identically to `sealtool`/SEAL-JS, including
quirks (`da=sha224` records fail closed — WebCrypto has no SHA-224).

### Trust: `valid` vs `auth`

`valid: true` means the signature verified against the key that was used. For records
carrying an inline `pk=`, that key is the record's own — a self-signed record can be
`valid: true` with `auth: false`. Treat a record as bound to its domain only when
`valid && auth` (`auth: true` = the DNS-published key covered the signature).

## Keys

| Function                           | Purpose                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `generateSealKeyPair(alg?)`        | WebCrypto keypair + base64 SPKI (for the DNS `p=` field) + PKCS#8 private key |
| `importPrivateKey(pkcs8B64, alg)`  | Import the stored private key for signing                                     |
| `exportSpkiB64` / `exportPkcs8B64` | Publish / persist keys                                                        |

Key distribution follows the SEAL DNS model: TXT record at the signing domain carrying
`seal=`, `ka=`, `p=` (base64 SPKI), optional `uid=` (per-account pinning), `kv=`, and
revocation fields (`r=<YYYYMMDDhhmmss>` or `r=revoke`, `p=revoke`).

## Test

```sh
pnpm test
```

- `upstream-suite.test.ts` — 1:1 port of upstream `seal-tests.html` against the native verifier.
- `roundtrip.test.ts` — what we sign must authenticate, across text/JPEG/PNG, rsa/ecdsa.
- `crypto-fixtures.test.ts` — frozen signer records (RSA + ECDSA, proven against upstream
  at capture time) validating with the native verifier.

## License

MIT — see [LICENSE](LICENSE). The verifier is a TypeScript port of
[hackerfactor/SEAL-JS](https://github.com/hackerfactor/SEAL-JS) (MIT); upstream attribution
retained in [LICENSE](LICENSE). SEAL is designed by Hacker Factor; this is an independent
implementation of the [open specification](https://github.com/hackerfactor/SEAL).
