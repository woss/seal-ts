/**
 * Unit tests for signature decoding and crypto verification.
 */
import { describe, expect, it } from 'vitest';

import { generateSealKeyPair } from '../sign/keygen.js';
import { importPrivateKey } from '../sign/keyutil.js';
import { b64decode, enc } from './bytes.js';
import {
  decodeSig,
  derToP1363,
  detectECCurve,
  ecCoordLen,
  mapDigestAlg,
  resolveKeyAlg,
  verifySignature,
} from './sig.js';

describe('decodeSig', () => {
  it('decodes base64 (default)', () => {
    const s = decodeSig('aGVsbG8=', undefined);
    expect(s.error).toBeNull();
    expect(Array.from(s.sigBytes!)).toEqual([104, 101, 108, 108, 111]);
    expect(s.timestamp).toBeNull();
  });

  it('falls back to base64 for a bare date format', () => {
    const s = decodeSig('20260101000000:QUJD', 'date');
    expect(s.error).toBeNull();
    expect(s.timestamp).toBe('20260101000000');
    expect(Array.from(s.sigBytes!)).toEqual([65, 66, 67]);
  });

  it('trims trailing whitespace', () => {
    expect(decodeSig('aGVsbG8=  ', 'base64').error).toBeNull();
  });

  it('rejects an empty base64 payload', () => {
    expect(decodeSig(undefined, undefined).error).toMatch(/base64 signature failed to decode/);
  });

  it('rejects malformed base64', () => {
    expect(decodeSig('a$b!', 'base64').error).toMatch(/base64 signature failed to decode/);
  });

  it('decodes hex', () => {
    expect(Array.from(decodeSig('48656c6c6f', 'hex').sigBytes!)).toEqual([72, 101, 108, 108, 111]);
  });

  it('rejects malformed hex', () => {
    expect(decodeSig('zz', 'hex').error).toMatch(/hex signature failed to decode/);
  });

  it('decodes bin as raw bytes', () => {
    expect(Array.from(decodeSig('abc', 'bin').sigBytes!)).toEqual([97, 98, 99]);
  });

  it('returns an empty payload for empty bin (vendor-exact: no error)', () => {
    const s = decodeSig('', 'bin');
    expect(s.error).toBeNull();
    expect(s.sigBytes!.length).toBe(0);
  });

  it('extracts a date:base64 timestamp', () => {
    const s = decodeSig('20260101000000:aGVsbG8=', 'date:base64');
    expect(s.error).toBeNull();
    expect(s.timestamp).toBe('20260101000000');
    expect(Array.from(s.sigBytes!)).toEqual([104, 101, 108, 108, 111]);
  });

  it('supports sub-second date formats', () => {
    const s = decodeSig('20260101000000.5:48656c6c6f', 'date1:hex');
    expect(s.error).toBeNull();
    expect(s.timestamp).toBe('20260101000000.5');
  });

  it('rejects sub-second payloads without the dot separator', () => {
    const s = decodeSig('20260101000000X:48656c6c6f', 'date2:hex');
    expect(s.error).toMatch(/does not match the specified format/);
  });

  it('rejects a date payload without a colon', () => {
    expect(decodeSig('20260101000000QUJD', 'date:base64').error).toMatch(/does not match the specified format/);
  });

  it('rejects a truncated date payload', () => {
    expect(decodeSig('2026:aGVsbG8=', 'date:base64').error).toMatch(/does not match the specified format/);
  });

  it('rejects sub-second payload without the dot', () => {
    expect(decodeSig('202601010000005:QUJD', 'date2:base64').error).toMatch(/does not match the specified format/);
  });

  it('rejects when the colon sits where the dot should be', () => {
    // dateLen=17 for date2: s[17] is ':' (passes the colon check) but s[14] is not '.'
    expect(decodeSig('20260101000000XYZ:QUJD', 'date2:base64').error).toMatch(/does not match the specified format/);
  });
});

describe('mapDigestAlg', () => {
  it('maps all supported digests', () => {
    expect(mapDigestAlg(undefined)).toBe('SHA-256');
    expect(mapDigestAlg('sha1')).toBe('SHA-1');
    expect(mapDigestAlg('sha224')).toBe('SHA-224');
    expect(mapDigestAlg('sha256')).toBe('SHA-256');
    expect(mapDigestAlg('sha384')).toBe('SHA-384');
    expect(mapDigestAlg('sha512')).toBe('SHA-512');
    expect(mapDigestAlg('SHA256')).toBe('SHA-256');
    expect(mapDigestAlg('md5')).toBeNull();
  });
});

describe('resolveKeyAlg', () => {
  it('maps rsa (default), ec and ecdsa', () => {
    expect(resolveKeyAlg(undefined)?.type).toBe('rsa');
    expect(resolveKeyAlg('rsa')?.webcryptoName).toBe('RSASSA-PKCS1-v1_5');
    expect(resolveKeyAlg('ec')?.webcryptoName).toBe('ECDSA');
    expect(resolveKeyAlg('ECDSA')?.namedCurve).toBe('P-256');
    expect(resolveKeyAlg('dsa')).toBeNull();
  });
});

describe('ecCoordLen', () => {
  it('returns coordinate lengths', () => {
    expect(ecCoordLen('P-256')).toBe(32);
    expect(ecCoordLen('P-384')).toBe(48);
    expect(ecCoordLen('P-521')).toBe(66);
    expect(() => ecCoordLen('P-999')).toThrow(/Unknown EC curve/);
  });
});

describe('detectECCurve', () => {
  it('defaults to P-256', () => {
    expect(detectECCurve(new Uint8Array([1, 2, 3]))).toBe('P-256');
  });
  it('detects P-384 and P-521 OIDs', () => {
    expect(detectECCurve(new Uint8Array([0x2b, 0x81, 0x04, 0x00, 0x22]))).toBe('P-384');
    expect(detectECCurve(new Uint8Array([0x2b, 0x81, 0x04, 0x00, 0x23]))).toBe('P-521');
  });
  it('does not confuse a partial OID prefix', () => {
    // findSeq must resume past a failed needle match.
    expect(detectECCurve(new Uint8Array([0x2b, 0x00, 0x2b, 0x81, 0x04, 0x00, 0x22]))).toBe('P-384');
  });
});

describe('derToP1363', () => {
  const coordLen = 32;

  it('converts a well-formed DER signature', () => {
    const r = new Uint8Array(32).fill(0xaa);
    const s = new Uint8Array(32).fill(0xbb);
    const der = new Uint8Array([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s]);
    const out = derToP1363(der, coordLen);
    expect(Array.from(out.subarray(0, 32))).toEqual(Array.from(r));
    expect(Array.from(out.subarray(32))).toEqual(Array.from(s));
  });

  it('strips a sign-padding zero and left-pads', () => {
    const r = new Uint8Array([0x00, 0x01, 0x02]);
    const s = new Uint8Array(31).fill(0x03);
    const der = new Uint8Array([0x30, 0x08, 0x02, 0x03, ...r, 0x02, 0x1f, ...s]);
    const out = derToP1363(der, coordLen);
    expect(out[31]).toBe(0x02);
    expect(out[0]).toBe(0x00);
    expect(out[32 + 30]).toBe(0x03);
  });

  it('handles long-form DER length', () => {
    const der = new Uint8Array([0x30, 0x81, 0x08, 0x02, 0x02, 0x01, 0x02, 0x02, 0x02, 0x03, 0x04]);
    const out = derToP1363(der, coordLen);
    expect(out[31]).toBe(0x02);
    expect(out[63]).toBe(0x04);
  });

  it('throws on a non-SEQUENCE', () => {
    expect(() => derToP1363(new Uint8Array([0x31, 0x00]), coordLen)).toThrow(/expected DER SEQUENCE/);
  });

  it('throws on a missing INTEGER r', () => {
    expect(() => derToP1363(new Uint8Array([0x30, 0x02, 0x01, 0x00]), coordLen)).toThrow(/expected INTEGER r/);
  });

  it('throws on a missing INTEGER s', () => {
    const der = new Uint8Array([0x30, 0x04, 0x02, 0x02, 0x01, 0x02]);
    expect(() => derToP1363(der, coordLen)).toThrow(/expected INTEGER s/);
  });

  it('throws when an integer is too large for the curve', () => {
    const r = new Uint8Array(33).fill(0x01);
    const s = new Uint8Array(32).fill(0x02);
    const der = new Uint8Array([0x30, 0x45, 0x02, 0x21, ...r, 0x02, 0x20, ...s]);
    expect(() => derToP1363(der, coordLen)).toThrow(/too large/);
  });
});

describe('verifySignature', () => {
  it('verifies a real RSA signature end to end', async () => {
    const kp = await generateSealKeyPair('rsa');
    const key = await importPrivateKey(kp.pkcs8B64, 'rsa');
    const msg = enc.encode('seal verify test message');
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, msg));
    const spki = b64decode(kp.spkiB64);
    await expect(verifySignature(spki, sig, msg, 'rsa', 'sha256')).resolves.toBe(true);
    await expect(verifySignature(spki, sig, enc.encode('other'), 'rsa', 'sha256')).resolves.toBe(false);
  });

  it('rejects unsupported key and digest algorithms', async () => {
    const kp = await generateSealKeyPair('rsa');
    const key = await importPrivateKey(kp.pkcs8B64, 'rsa');
    const spki = b64decode(kp.spkiB64);
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode('x')));
    await expect(verifySignature(spki, sig, enc.encode('x'), 'dsa', 'sha256')).rejects.toThrow(/Unsupported key algorithm/);
    await expect(verifySignature(spki, sig, enc.encode('x'), 'rsa', 'md5')).rejects.toThrow(/Unsupported digest algorithm/);
  });
});
