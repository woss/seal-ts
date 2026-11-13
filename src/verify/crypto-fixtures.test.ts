/**
 * Permanent positive-crypto anchor: frozen key pairs, bodies, and embedded
 * records captured once (signer output proven against the upstream vendored
 * validator at capture time, plus the native verifier). After the vendor
 * deletion, this file is the only independent check that the signer and the
 * native verifier agree with the reference behavior on real RSA/ECDSA crypto.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { fromB64 } from '../sign/keyutil.js';
import { validateBuffer } from './validate.js';

interface AlgFixture {
  pkcs8B64: string;
  spkiB64: string;
  body: string;
  dns: string;
  /** base64 of the full file with the SEAL record embedded */
  embeddedB64: string;
}

const FIXTURES = JSON.parse(
  readFileSync(new URL('./crypto-fixtures.json', import.meta.url), 'utf8'),
) as Record<'rsa' | 'ecdsa', AlgFixture>;

describe('frozen crypto fixtures (positive anchor)', () => {
  for (const alg of ['rsa', 'ecdsa'] as const) {
    it(`${alg}: frozen record validates with the native verifier`, async () => {
      const f = FIXTURES[alg];
      const embedded = fromB64(f.embeddedB64);
      const results = await validateBuffer(embedded, 'fixture.txt', { dnsOverride: f.dns });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].valid, `valid: ${results[0].error}`).toBe(true);
      expect(results[0].auth).toBe(true);
      expect(results[0].revoked).toBe(false);
      expect(results[0].keyAlg).toBe(alg);
    });
  }

  it('fixture bodies differ per algorithm (guards against a copy-paste anchor)', () => {
    expect(FIXTURES.rsa.embeddedB64).not.toBe(FIXTURES.ecdsa.embeddedB64);
  });
});
