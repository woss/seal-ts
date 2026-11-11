# seal-ts

SEAL (Secure Evidence Attribution Label) v1 for TypeScript/JavaScript — **sign and verify**.

SEAL is an open standard for binding attribution and authentication to media: a compact
DKIM-model record (`<seal … />`) embedded in the file or shipped as a sidecar, authenticated
by a public key published in DNS TXT. Spec: [SEAL v1.2.12](https://github.com/hackerfactor/SEAL/blob/main/SPECIFICATION.md)
by [Hacker Factor](https://www.hackerfactor.com/).

The upstream JavaScript implementation ([hackerfactor/SEAL-JS](https://github.com/hackerfactor/SEAL-JS))
is **validator-only**; until now a full signer existed only in C ([hackerfactor/SEAL-C](https://github.com/hackerfactor/SEAL-C)).
This package adds the missing signer in TypeScript and pairs it with the vendored upstream
validator so what we sign is proven to authenticate, byte for byte.

## Status

Pre-publication. The package will ship on npm as `@woss/seal-ts` (repo `woss/seal-ts`)
after external review; inside the kelp-market workspace it is `@kelp_digital/seal`.

## Install

```sh
pnpm add @woss/seal-ts   # once published; until then: workspace package
```

## Sign

```ts
import { generateSealKeyPair, sealSign } from '@woss/seal-ts';

const kp = await generateSealKeyPair('ecdsa'); // or 'rsa'
// publish kp.spkiB64 in DNS TXT for your domain (see "Key distribution")

const signed = await sealSign(manifestBytes, {
  domain: 'example.com',
  key: kp.key,
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

The verify side is the upstream validator vendored **verbatim** (sha256-pinned by test),
so verification behaves identically to `sealtool`/SEAL-JS, including quirks
(`da=sha224` records can never validate — no WebCrypto SHA-224).

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

- `upstream-suite.test.ts` — 1:1 port of upstream `seal-tests.html` against the vendored validator.
- `roundtrip.test.ts` — what we sign must authenticate, across text/JPEG/PNG, rsa/ecdsa.
- `vendor-pin.test.ts` — the vendored validator stays byte-identical to the pinned upstream commit.

## License

MIT — see [LICENSE](LICENSE). The vendored validator is
[hackerfactor/SEAL-JS](https://github.com/hackerfactor/SEAL-JS) (MIT), reproduced verbatim
with provenance header. SEAL is designed by Hacker Factor; this is an independent implementation
of the [open specification](https://github.com/hackerfactor/SEAL).
