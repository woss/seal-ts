import { describe, expect, it } from 'vitest';

import { seal } from './seal.js';
import { p1363ToDer } from './sign/crypto.js';
import { generateSealKeyPair } from './sign/keygen.js';
import { importPrivateKey } from './sign/keyutil.js';
import { sealSign } from './sign/signer.js';

function z32(first: number): Uint8Array {
  const b = new Uint8Array(32);
  b[0] = first;
  return b;
}

describe('p1363ToDer', () => {
  it('prepends 0x00 to INTEGERs with the high bit set (both r and s)', () => {
    const r = new Uint8Array(32).fill(0xff);
    const s = new Uint8Array(32).fill(0xff);
    const der = p1363ToDer(new Uint8Array([...r, ...s]));
    expect(der[0]).toBe(0x30);
    expect(der[2]).toBe(0x02);
    expect(der[3]).toBe(33); // 0x00 prefix + 32 bytes
    expect(der[4]).toBe(0x00);
    expect(der[37]).toBe(0x02); // s INTEGER header
    expect(der[38]).toBe(33);
    expect(der[39]).toBe(0x00); // high bit set → padded
  });

  it('trims leading zeros without a 0x00 prefix', () => {
    const r = z32(0x00);
    r[1] = 0x01; // 0x00 0x01 0x00… — trim drops the leading zero
    const s = z32(0x01); // no leading zero — untouched
    const der = p1363ToDer(new Uint8Array([...r, ...s]));
    expect(der[3]).toBe(31); // r trimmed to 31 bytes, no prefix
    expect(der[4]).toBe(0x01);
    expect(der[35]).toBe(0x02); // s INTEGER header
    expect(der[36]).toBe(32); // untrimmed length
    expect(der[37]).toBe(0x01); // no 0x00 prefix
  });

  it('rejects non-64-byte input', () => {
    expect(() => p1363ToDer(new Uint8Array(63))).toThrow('unexpected ECDSA P1363 signature length: 63');
  });
});

describe('sealSign input validation and container guards', () => {
  it('rejects non-14-digit timestamps', async () => {
    const { key } = await makeKey('rsa');
    await expect(
      sealSign(new TextEncoder().encode('x'), {
        domain: 'photos.example',
        key,
        timestamp: '2026010112000',
      }),
    ).rejects.toThrow('timestamp must be 14 digits (YYYYMMDDhhmmss), got: 2026010112000');
  });

  it('rejects PNGs too small to contain IHDR', async () => {
    const { key } = await makeKey('rsa');
    const tiny = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await expect(sealSign(tiny, { domain: 'd', key })).rejects.toThrow('PNG too small: no IHDR chunk');
  });

  it('rejects records exceeding the JPEG APP8 segment limit', async () => {
    const { key } = await makeKey('rsa');
    // 70000-char domain pushes the record past the 65533-byte APP8 limit.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // SOI + EOI
    await expect(sealSign(jpeg, { domain: 'd'.repeat(70000), key })).rejects.toThrowError(
      /SEAL record too large for JPEG APP8 segment/,
    );
  });

  it('rejects PNGs truncated before the IHDR chunk ends', async () => {
    const { key } = await makeKey('rsa');
    const truncated = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 100, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4, 5,
    ]);
    await expect(sealSign(truncated, { domain: 'd', key })).rejects.toThrow(
      'PNG truncated before IHDR chunk end',
    );
  });
});

describe('sealSign option defaults', () => {
  it('defaults to rsa when alg omitted', async () => {
    const { kp, key } = await makeKey('rsa');
    const signed = await sealSign(new TextEncoder().encode('default alg body'), {
      domain: 'photos.example',
      key,
    });
    expect(signed.format).toBe('text');
    const res = await seal.validateBuffer(signed.embedded, 't.txt', {
      dnsOverride: `seal=1 ka=rsa p=${kp.spkiB64}`,
    });
    expect(res[0].valid).toBe(true);
    expect(res[0].keyAlg).toBe('rsa');
  });

  it('includes id= in the double digest when provided', async () => {
    const { kp, key } = await makeKey('ecdsa');
    const signed = await sealSign(new TextEncoder().encode('id body'), {
      domain: 'photos.example',
      key,
      alg: 'ecdsa',
      id: 'user@ex.com',
    });
    expect(signed.record).toContain('id="user@ex.com"');
    const res = await seal.validateBuffer(signed.embedded, 't.txt', {
      dnsOverride: `seal=1 ka=ecdsa p=${kp.spkiB64}`,
    });
    expect(res[0].valid).toBe(true);
  });
});

describe('uid= DNS pinning — records carry matching id= and uid=', () => {
  it('emits uid= alongside id=', async () => {
    const { key } = await makeKey('ecdsa');
    const signed = await sealSign(new TextEncoder().encode('uid body'), {
      domain: 'photos.example',
      key,
      alg: 'ecdsa',
      id: 'acct-42',
    });
    expect(signed.record).toContain('id="acct-42"');
    expect(signed.record).toContain('uid="acct-42"');
    expect(signed.record).not.toMatch(/uid="[^"]*"[^>]*uid="/); // exactly one uid=
  });

  it('authenticates against a DNS record pinning the same uid=', async () => {
    const { kp, key } = await makeKey('ecdsa');
    const signed = await sealSign(new TextEncoder().encode('uid body'), {
      domain: 'photos.example',
      key,
      alg: 'ecdsa',
      id: 'acct-42',
    });
    const res = await seal.validateBuffer(signed.embedded, 't.txt', {
      dnsOverride: `seal=1 ka=ecdsa p=${kp.spkiB64} uid=acct-42`,
    });
    expect(res[0].valid).toBe(true);
    expect(res[0].auth).toBe(true);
  });

  it('fails authentication when the DNS record pins a different uid=', async () => {
    const { kp, key } = await makeKey('ecdsa');
    const signed = await sealSign(new TextEncoder().encode('uid body'), {
      domain: 'photos.example',
      key,
      alg: 'ecdsa',
      id: 'acct-42',
    });
    const res = await seal.validateBuffer(signed.embedded, 't.txt', {
      dnsOverride: `seal=1 ka=ecdsa p=${kp.spkiB64} uid=other-acct`,
    });
    expect(res[0].valid).toBe(false);
    expect(res[0].auth).toBe(false);
  });

  it('rejects empty and whitespace/quote ids', async () => {
    const { key } = await makeKey('rsa');
    for (const bad of ['', 'a b', 'a"b', "a'b", 'a\tb']) {
      await expect(
        sealSign(new TextEncoder().encode('x'), { domain: 'photos.example', key, id: bad }),
      ).rejects.toThrow(/id must be non-empty with no whitespace or quotes/);
    }
  });
});

describe('embedText separator handling', () => {
  it('does not add a separator when the body already ends with a newline', async () => {
    const { kp, key } = await makeKey('rsa');
    const signed = await sealSign(new TextEncoder().encode('ends with newline\n'), {
      domain: 'photos.example',
      key,
    });
    const text = new TextDecoder().decode(signed.embedded);
    expect(text).not.toContain('\n\n');
    const res = await seal.validateBuffer(signed.embedded, 't.txt', {
      dnsOverride: `seal=1 ka=rsa p=${kp.spkiB64}`,
    });
    expect(res[0].valid).toBe(true);
  });

  it('signs an empty text body', async () => {
    const { kp, key } = await makeKey('rsa');
    const signed = await sealSign(new Uint8Array(0), { domain: 'photos.example', key });
    expect(signed.format).toBe('text');
    const res = await seal.validateBuffer(signed.embedded, 't.txt', {
      dnsOverride: `seal=1 ka=rsa p=${kp.spkiB64}`,
    });
    expect(res[0].valid).toBe(true);
  });
});

async function makeKey(alg: 'rsa' | 'ecdsa') {
  const kp = await generateSealKeyPair(alg);
  const key = await importPrivateKey(kp.pkcs8B64, alg);
  return { kp, key };
}
