---
title: Installation
sidebar_position: 2
---

# Installation

```sh
pnpm add @woss/seal-ts
# or
npm install @woss/seal-ts
```

Requires Node.js ≥ 24 (WebCrypto, `node:` streams not needed — the API is
buffer/string in, buffer/string out). Works in any runtime exposing
[WebCrypto](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto)
and [globalThis.crypto](https://developer.mozilla.org/en-US/docs/Web/API/crypto).

The package is ESM-only (`type: module`). TypeScript declarations ship alongside
the JavaScript (`dist/*.d.ts`).

:::note Pre-publication
The package ships on npm as `@woss/seal-ts` after external review. Inside the
kelp-market workspace it lives as `@kelp_digital/seal` with identical source.
:::
