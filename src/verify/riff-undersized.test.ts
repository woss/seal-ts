/**
 * Covers the `size > 4` false arm of the nested-RIFF recursion in _riffWalk:
 * scanRIFF's own length invariant (totalSize === length - 8, length >= 16)
 * means the depth-0 RIFF header always has size > 4, so the false arm is only
 * reachable when readLE32 answers differently per call.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./bytes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bytes.js')>();
  let calls = 0;
  return {
    ...actual,
    readLE32: (b: Uint8Array, off: number) => {
      calls++;
      if (calls === 1) {return b.length - 8;} // scanRIFF's totalSize check passes
      if (calls === 2) {return 2;} // walk header size <= 4
      return actual.readLE32(b, off);
    },
  };
});

import { scanRIFF } from './scan.js';

describe('scanRIFF — undersized header', () => {
  it('ignores a RIFF header whose size is not greater than 4', () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
    expect(scanRIFF(bytes)).toEqual([]);
  });
});
