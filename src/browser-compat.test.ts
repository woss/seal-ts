/**
 * Browser/Deno compatibility guard: shipped source must not touch Node-only APIs.
 * Stubbing `Buffer` away makes any Node dependency explode loudly, and the
 * round trip proves the whole sign→verify chain runs on web-standard APIs
 * (WebCrypto, TextEncoder, the ES2026 Uint8Array base64/hex methods).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seal } from './seal.js';
import { generateSealKeyPair } from './sign/keygen.js';
import { fromB64, importPrivateKey, toB64 } from './sign/keyutil.js';
import { sealSign } from './sign/signer.js';

const realBuffer = globalThis.Buffer;

beforeAll(() => {
  // @ts-expect-error — simulating a browser: no Node globals.
  delete globalThis.Buffer;
});

afterAll(() => {
  globalThis.Buffer = realBuffer;
});

describe('no-Node-globals runtime', () => {
  it('signs and verifies with Buffer removed from globalThis', async () => {
    const kp = await generateSealKeyPair('ecdsa');
    const key = await importPrivateKey(kp.pkcs8B64, 'ecdsa');
    const sig = await sealSign(new TextEncoder().encode('browser pure'), {
      domain: 'photos.example',
      key,
      alg: 'ecdsa',
      id: 'dan@woss.io',
    });
    const res = await seal.validateBuffer(sig.embedded, 'asset.txt', {
      dnsOverride: 'seal=1 ka=ecdsa p=' + kp.spkiB64,
    });
    expect(res[0]?.valid).toBe(true);

    // ES2026 encoders + tolerance behaviors (PEM wrapping, base64url alphabet).
    const raw = new Uint8Array([0, 1, 2, 250]);
    expect(toB64(fromB64(toB64(raw)))).toBe(toB64(raw));
    expect(fromB64('MFkwEwYHKoZIzj0CAQYIKoZI\nzj0DAQcDQgAE')).toEqual(
      fromB64('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE'),
    );
    expect(toB64(fromB64('-_8'))).toBe('+/8=');
  });
});
