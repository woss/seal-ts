/**
 * WebCrypto primitives for SEAL signing — exact inverses of the vendored
 * validator's verify path (RSASSA-PKCS1-v1_5 / ECDSA P-256, SHA-256 only).
 */

import type { SealKeyAlg } from './keyutil.js';

export type { SealKeyAlg };

/** SHA-256 digest (da=sha256 — the only digest the signer supports). */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

export async function signPreImage(
  key: CryptoKey,
  alg: SealKeyAlg,
  preImage: Uint8Array,
): Promise<Uint8Array> {
  if (alg === 'rsa') {
    return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, preImage as BufferSource));
  }
  const p1363 = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, preImage as BufferSource),
  );
  // The validator applies derToP1363() before verifying — it expects DER,
  // while WebCrypto hands back P1363 (r||s). Convert.
  return p1363ToDer(p1363);
}

/** Convert a 64-byte P1363 signature (r||s) to DER SEQUENCE. */
export function p1363ToDer(sig: Uint8Array): Uint8Array {
  if (sig.length !== 64) {
    throw new Error(`unexpected ECDSA P1363 signature length: ${sig.length}`);
  }
  const r = sig.subarray(0, 32);
  const s = sig.subarray(32);
  const rTrim = trimLeadingZero(r);
  const sTrim = trimLeadingZero(s);
  // INTEGER needs 0x00 prefix when the high bit is set
  const rInt = rTrim[0] & 0x80 ? new Uint8Array([0x00, ...rTrim]) : rTrim;
  const sInt = sTrim[0] & 0x80 ? new Uint8Array([0x00, ...sTrim]) : sTrim;
  const len = 2 + rInt.length + 2 + sInt.length;
  return new Uint8Array([0x30, len, 0x02, rInt.length, ...rInt, 0x02, sInt.length, ...sInt]);
}

function trimLeadingZero(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0x00) {
    i++;
  }
  return b.subarray(i);
}
