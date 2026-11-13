/**
 * Guard-branch test for the signer: forces computeByteRanges to reject and
 * asserts sealSign surfaces the error instead of signing a bogus pre-image.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../verify/ranges.js', () => ({
  // Signer imports only computeByteRanges; ByteRanges is a type (erased).
  computeByteRanges: () => ({ ranges: null, error: 'mocked range rejection' }),
}));

import { generateSealKeyPair } from './keygen.js';
import { importPrivateKey } from './keyutil.js';
import { sealSign } from './signer.js';

describe('sealSign range guard', () => {
  it('throws when the byte-range computation rejects', async () => {
    const kp = await generateSealKeyPair('rsa');
    const key = await importPrivateKey(kp.pkcs8B64, kp.alg);
    const body = new TextEncoder().encode('guard test body');
    await expect(sealSign(body, { domain: 'example.com', key, alg: 'rsa' })).rejects.toThrow(
      /signer built an invalid b= spec: mocked range rejection/,
    );
  });
});
