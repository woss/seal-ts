/**
 * Public entry-point smoke test — importing executes every re-export.
 */
import { describe, expect, it } from 'vitest';

import { generateSealKeyPair, seal, sealSign } from './index.js';

describe('index re-exports', () => {
  it('exposes the public API', () => {
    expect(typeof seal.validateBuffer).toBe('function');
    expect(typeof seal.detectFormat).toBe('function');
    expect(typeof seal._findAllSEALRecords).toBe('function');
    expect(typeof sealSign).toBe('function');
    expect(typeof generateSealKeyPair).toBe('function');
  });
});
