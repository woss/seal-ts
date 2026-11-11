import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: ['default', 'blob'],
    outputFile: { blob: 'coverage/blob/report.json' },
    coverage: {
      provider: 'v8',
      reportsDirectory: './temp/coverage',
      include: ['src'],
      // Vendored upstream validator is byte-pinned, not unit-covered.
      exclude: ['src/vendor/**'],
      reporter: ['text', 'json'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
