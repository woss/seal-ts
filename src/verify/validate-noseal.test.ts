/**
 * Covers the `recFields.seal || ''` fallback in dnsRecordMatches: scanner
 * records always carry a truthy seal=, so the fallback is only reachable when
 * the scanner boundary is mocked with a record lacking seal=.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./scan.js', () => ({
  scanByFormat: () => [
    {
      bytes: new Uint8Array(10),
      fields: { d: 'example.com', s: 'QUJD', b: 'F~f' },
      recStart: 0,
      recEnd: 10,
      rawSigStart: 0,
      rawSigEnd: 0,
    },
  ],
}));

import { validateBuffer } from './validate.js';

describe('validateBuffer — record without seal field', () => {
  it('fails DNS matching for a record with no seal=', async () => {
    const [r] = await validateBuffer(new Uint8Array(10), 'x.bin', {
      dnsOverride: 'seal=1 ka=rsa p=QUJD',
    });
    expect(r.valid).toBe(false);
    expect(r.error).toBe('could not validate against any DNS record');
  });
});
