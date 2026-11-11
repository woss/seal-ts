import { defineConfig } from '@rslib/core';

// Standalone port of the kelp-market rigs library config: ESM-only,
// structure-preserving emit (bundle: false) so the ./sign/* export map
// keeps working, per-file d.ts, tests excluded, vendored validator copied verbatim.
export default defineConfig({
  lib: [
    {
      format: 'esm',
      syntax: 'esnext',
      bundle: false,
      dts: { bundle: false, autoExtension: true },
      source: {
        entry: {
          index: ['src/**/*.ts', '!src/**/*.test.ts'],
        },
      },
      output: {
        target: 'node',
        distPath: { root: 'dist' },
        sourceMap: true,
        cleanDistPath: true,
        polyfill: 'usage',
        copy: [{ from: 'src/vendor', to: 'vendor' }],
      },
    },
  ],
});
