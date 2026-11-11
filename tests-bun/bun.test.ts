/**
 * Bun CI smoke: sign→verify chain on Bun — web-standard APIs only.
 * Run: bun test tests-bun/
 */
import { expect, test } from 'bun:test';

import { seal } from '../src/seal.ts';
import { generateSealKeyPair } from '../src/sign/keygen.ts';
import { fromB64, importPrivateKey, toB64 } from '../src/sign/keyutil.ts';
import { sealSign } from '../src/sign/signer.ts';

test('sign→verify round trip', async () => {
  const kp = await generateSealKeyPair('ecdsa');
  const key = await importPrivateKey(kp.pkcs8B64, 'ecdsa');
  const sig = await sealSign(new TextEncoder().encode('hello bun'), {
    domain: 'photos.example',
    key,
    alg: 'ecdsa',
    id: 'dan@woss.io',
  });
  const res = await seal.validateBuffer(sig.embedded, 'asset.txt', {
    dnsOverride: 'seal=1 ka=ecdsa p=' + kp.spkiB64,
  });
  expect(res[0]?.valid).toBe(true);
});

test('base64/hex encoders + tolerance', () => {
  const raw = new Uint8Array([0, 1, 2, 250]);
  expect(toB64(fromB64(toB64(raw)))).toBe(toB64(raw));
  expect([...fromB64('MFkwEwYHKoZIzj0CAQYIKoZI\nzj0DAQcDQgAE')]).toEqual([
    ...fromB64('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE'),
  ]);
  expect(toB64(fromB64('-_8'))).toBe('+/8=');
  expect(new Uint8Array([0x0f, 0xab]).toHex()).toBe('0fab');
});
