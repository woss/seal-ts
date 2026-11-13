/**
 * Signer ↔ native-verifier round trip: what we sign must authenticate.
 * Uses dnsOverride with the exported SPKI key so no network is touched.
 */
import { describe, expect, it } from 'vitest';

import { seal } from './seal.js';
import { generateSealKeyPair } from './sign/keygen.js';
import { importPrivateKey } from './sign/keyutil.js';
import { sealSign } from './sign/signer.js';

async function makeKey(alg: 'rsa' | 'ecdsa') {
  const kp = await generateSealKeyPair(alg);
  return { kp, key: await importPrivateKey(kp.pkcs8B64, alg) };
}

async function roundTrip(alg: 'rsa' | 'ecdsa', body: Uint8Array) {
  const { kp, key } = await makeKey(alg);
  const signed = await sealSign(body, {
    domain: 'photos.example',
    key,
    alg,
    id: 'dan@woss.io',
  });
  const spki = kp.spkiB64;
  const res = await seal.validateBuffer(signed.embedded, 'asset.bin', {
    dnsOverride: `seal=1 ka=${alg} p=${spki}`,
  });
  return { signed, res };
}

describe('signBuffer ↔ validateBuffer round trip', () => {
  it('rsa: text file authenticates', async () => {
    const { signed, res } = await roundTrip('rsa', new TextEncoder().encode('license document body'));
    expect(signed.format).toBe('text');
    expect(res[0].valid).toBe(true);
    expect(res[0].auth).toBe(true);
    expect(res[0].domain).toBe('photos.example');
    expect(res[0].timestamp).toMatch(/^\d{14}$/);
    expect(res[0].fields.id).toBe('dan@woss.io');
  });

  it('ecdsa: text file authenticates', async () => {
    const { res } = await roundTrip('ecdsa', new TextEncoder().encode('license document body'));
    expect(res[0].valid).toBe(true);
    expect(res[0].auth).toBe(true);
  });

  it('ecdsa: hex signature encoding round-trips (worker sidecar shape)', async () => {
    const { kp, key } = await makeKey('ecdsa');
    const signed = await sealSign(new TextEncoder().encode('sidecar body'), {
      domain: 'photos.example',
      key,
      alg: 'ecdsa',
      sigFormat: 'hex',
    });
    expect(signed.record).toMatch(/sf="date:hex" b="F~S,s~f" s="\d{14}:[0-9a-f]+" \/>$/);
    const res = await seal.validateBuffer(signed.embedded, 'manifest.json', {
      dnsOverride: `seal=1 ka=ecdsa p=${kp.spkiB64}`,
    });
    expect(res[0].valid).toBe(true);
    expect(res[0].auth).toBe(true);
  });

  it('rsa: JPEG embeds into an APP8 SEAL segment and authenticates', async () => {
    const jpeg = new Uint8Array(64);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;
    jpeg[2] = 0xff;
    jpeg[3] = 0xe0;
    const { signed, res } = await roundTrip('rsa', jpeg);
    expect(signed.format).toBe('jpeg');
    expect(res[0].valid).toBe(true);
  });

  it('rsa: PNG embeds into seAl chunk and authenticates', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(20).fill(0)]);
    const { signed, res } = await roundTrip('rsa', png);
    expect(signed.format).toBe('png');
    expect(res[0].valid).toBe(true);
  });

  it('tampered body fails authentication with the same key', async () => {
    const { kp, key } = await makeKey('rsa');
    const signed = await sealSign(new TextEncoder().encode('original body'), {
      domain: 'photos.example',
      key,
      alg: 'rsa',
    });
    const text = new TextDecoder().decode(signed.embedded);
    const m = text.match(/<seal [^>]+\/>/);
    expect(m).not.toBe(null);
    const res = await seal.validateBuffer(
      new Uint8Array([...new TextEncoder().encode('tampered body'), ...new TextEncoder().encode(m![0])]),
      't.txt',
      { dnsOverride: `seal=1 ka=rsa p=${kp.spkiB64}` },
    );
    expect(res[0].valid).toBe(false);
    expect(res[0].auth).toBe(false);
  });
});
