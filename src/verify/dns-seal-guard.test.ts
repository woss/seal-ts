/**
 * Covers the defensive `if (!f.seal)` guard in parseDNSTXT: parseSEALRecord
 * itself never returns fields without a truthy seal=, so the guard is only
 * reachable when the parser boundary is mocked.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./parse.js', () => ({
  parseSEALRecord: () => ({ fields: {}, recStart: 0, recEnd: 0, rawSigStart: -1, rawSigEnd: -1 }),
}));

import { parseDNSTXT } from './dns.js';

describe('parseDNSTXT — seal guard', () => {
  it('returns null when the parsed record lacks a seal field', () => {
    expect(parseDNSTXT('ka=rsa p=QUJD')).toBeNull();
  });
});
