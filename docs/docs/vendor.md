---
title: Vendored validator
sidebar_position: 6
---

# Vendored validator

`src/vendor/seal-validator.js` is reproduced **verbatim** from
[hackerfactor/SEAL-JS](https://github.com/hackerfactor/SEAL-JS) (MIT), with a
provenance header recording the upstream commit and sha256 pin.

## Why vendor instead of depend

- Upstream ships no npm package; the file is a single global-registering script.
- The vendor-pin test (`vendor-pin.test.ts`) asserts byte-identity with the
  pinned upstream commit — any drift fails CI.
- Sign/verify parity is the core guarantee: the upstream test suite is ported
  1:1 (`upstream-suite.test.ts`) and every roundtrip test signs with our signer
  and verifies with upstream code.

## Upgrading the pin

Bump the vendored file to a new upstream commit and update the pinned hash in
`vendor-pin.test.ts` in the same commit, noting the upstream changelog in the
PR description.
