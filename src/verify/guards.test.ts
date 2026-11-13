/**
 * validateOneRecord guard branches that only fire under a mocked crypto seam:
 * a DNS record with no seal= (match falls through) and a non-Error rejection
 * from verifySignature (String(e) alternative).
 */
import { describe, expect, it, vi } from 'vitest';

import type * as SigModule from './sig.js';
import { verifySignature } from './sig.js';
import { validateBuffer } from './validate.js';

vi.mock('./sig.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SigModule>();
  return { ...actual, verifySignature: vi.fn() };
});

const verifyMock = vi.mocked(verifySignature);
const te = new TextEncoder();
const body = te.encode('<seal seal="1" d="example.com" ka="rsa" s="QUJD" b="F~f" />');

describe('validateBuffer — mocked crypto guards', () => {
  it('skips DNS records without a seal= field', async () => {
    // dnsFields with no seal: recSeal falls back to '' in the comparison chain
    const [r] = await validateBuffer(body, 'x.txt', { dnsOverride: { ka: 'rsa' } });
    expect(r.valid).toBe(false);
    expect(r.error).toBe('could not validate against any DNS record');
  });

  it('reports a non-Error crypto rejection via String(e)', async () => {
    verifyMock.mockRejectedValueOnce('kaboom');
    const [r] = await validateBuffer(body, 'x.txt', { dnsOverride: 'seal=1 ka=rsa p=QUJD' });
    expect(r.error).toBe('Verification error: kaboom');
  });
});
