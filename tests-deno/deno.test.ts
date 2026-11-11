/**
 * Deno CI smoke: sign→verify chain on Deno 2.x — web-standard APIs only.
 * Run: deno test --unstable-sloppy-imports tests-deno/
 */
import { deepEqual, equal, ok } from 'node:assert/strict';

// Runner global: typed locally so CI typecheck needs no @types/deno dependency.
declare const Deno: { test: (name: string, fn: () => void | Promise<void>) => void };

import { seal } from '../src/seal.ts';
import { generateSealKeyPair } from '../src/sign/keygen.ts';
import { fromB64, importPrivateKey, toB64 } from '../src/sign/keyutil.ts';
import { sealSign } from '../src/sign/signer.ts';

Deno.test('sign→verify round trip', async () => {
  const kp = await generateSealKeyPair('ecdsa');
  const key = await importPrivateKey(kp.pkcs8B64, 'ecdsa');
  const sig = await sealSign(new TextEncoder().encode('hello deno'), {
    domain: 'photos.example',
    key,
    alg: 'ecdsa',
    id: 'dan@woss.io',
  });
  const res = await seal.validateBuffer(sig.embedded, 'asset.txt', {
    dnsOverride: 'seal=1 ka=ecdsa p=' + kp.spkiB64,
  });
  ok(res[0]?.valid === true);
});

Deno.test('base64/hex encoders + tolerance', () => {
  const raw = new Uint8Array([0, 1, 2, 250]);
  equal(toB64(fromB64(toB64(raw))), toB64(raw));
  deepEqual(
    fromB64('MFkwEwYHKoZIzj0CAQYIKoZI\nzj0DAQcDQgAE'),
    fromB64('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE'),
  );
  equal(toB64(fromB64('-_8')), '+/8=');
  equal(new Uint8Array([0x0f, 0xab]).toHex(), '0fab');
  deepEqual([...Uint8Array.fromHex('0fab')], [15, 171]);
});
