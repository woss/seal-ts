/**
 * Signature decoding and crypto verification for SEAL records
 * (mirrors the C `SealValidateDecodeParts` / `SealGetMdfFromString` /
 * `CheckKeyAlgorithm` / `SealDetectECCurve` / `_SealValidateDigest`).
 */
import { b64decode, enc, findSeq,hexdecode } from './bytes.js';

export interface DecodedSig {
  sigBytes: Uint8Array | null;
  timestamp: string | null;
  error: string | null;
}

/**
 * Decode the s= field into raw signature bytes.
 * sf= controls the encoding: base64 (default), hex, bin,
 * or `date<N>:<fmt>` with a leading YYYYMMDDhhmmss[.N] timestamp prefix.
 */
export function decodeSig(sField: string | undefined, sfField: string | undefined): DecodedSig {
  const sf = sfField || 'base64';
  const s = sField || '';

  // Extract optional date prefix
  let timestamp: string | null = null;
  let payload = s;

  if (sf.startsWith('date')) {
    let dateLen = 14; // YYYYMMDDhhmmss
    if (sf.length > 4 && sf[4] >= '0' && sf[4] <= '9') {
      dateLen += 1 + parseInt(sf[4], 10); // "." + N sub-second digits
    }
    if (s.length <= dateLen + 1 || s[dateLen] !== ':') {
      return { sigBytes: null, timestamp: null, error: 'signature date does not match the specified format' };
    }
    if (dateLen > 14 && s[14] !== '.') {
      return { sigBytes: null, timestamp: null, error: 'signature date does not match the specified format' };
    }
    timestamp = s.substring(0, dateLen);
    payload = s.substring(dateLen + 1); // skip ':'
  }

  // Trim trailing whitespace (mirrors C "remove padding" step)
  payload = payload.replace(/\s+$/, '');

  // Determine encoding from sf (after stripping any 'date<N>:' prefix)
  const fmt = sf.replace(/^date\d*:?/, '').toLowerCase() || 'base64';

  let sigBytes: Uint8Array | null;
  if (fmt === 'hex') {
    sigBytes = hexdecode(payload);
    if (!sigBytes) {return { sigBytes: null, timestamp, error: 'hex signature failed to decode' };}
  } else if (fmt === 'bin') {
    // Binary: the value is the raw bytes already stored in the text
    sigBytes = enc.encode(payload);
  } else {
    // base64 (default)
    try {
      sigBytes = b64decode(payload);
    } catch {
      return { sigBytes: null, timestamp, error: 'base64 signature failed to decode' };
    }
    if (!sigBytes || sigBytes.length === 0)
      {return { sigBytes: null, timestamp, error: 'base64 signature failed to decode' };}
  }

  return { sigBytes, timestamp, error: null };
}

/** Digest algorithm mapping (mirrors SealGetMdfFromString). da= field; default sha256. */
export function mapDigestAlg(da: string | undefined): string | null {
  const d = (da || 'sha256').toLowerCase();
  if (d === 'sha1') {return 'SHA-1';}
  if (d === 'sha224') {return 'SHA-224';}
  if (d === 'sha256') {return 'SHA-256';}
  if (d === 'sha384') {return 'SHA-384';}
  if (d === 'sha512') {return 'SHA-512';}
  return null; // unknown
}

export interface KeyAlgInfo {
  type: 'rsa' | 'ec';
  webcryptoName: 'RSASSA-PKCS1-v1_5' | 'ECDSA';
  hash: null;
  namedCurve: 'P-256' | null;
}

/** Key algorithm mapping (mirrors CheckKeyAlgorithm). ka= field; default rsa. */
export function resolveKeyAlg(ka: string | undefined): KeyAlgInfo | null {
  const k = (ka || 'rsa').toLowerCase();
  if (k === 'rsa') {return { type: 'rsa', webcryptoName: 'RSASSA-PKCS1-v1_5', hash: null, namedCurve: null };}
  if (k === 'ec' || k === 'ecdsa') {return { type: 'ec', webcryptoName: 'ECDSA', hash: null, namedCurve: 'P-256' };}
  return null;
}

/**
 * Convert a DER-encoded ECDSA signature to IEEE P1363 (raw r‖s) format.
 * Throws on malformed DER (caller catches and surfaces the message).
 */
export function derToP1363(derSig: Uint8Array, coordLen: number): Uint8Array {
  const d = derSig;
  if (d[0] !== 0x30) {throw new Error('ECDSA sig: expected DER SEQUENCE');}
  let pos = 2; // skip 0x30 + length byte (we trust the outer length)
  // Handle long-form length (rare for ECDSA but possible)
  if (d[1] & 0x80) {pos += d[1] & 0x7f;}

  if (d[pos] !== 0x02) {throw new Error('ECDSA sig: expected INTEGER r');}
  const rLen = d[pos + 1];
  const rBytes = d.subarray(pos + 2, pos + 2 + rLen);
  pos += 2 + rLen;

  if (d[pos] !== 0x02) {throw new Error('ECDSA sig: expected INTEGER s');}
  const sLen = d[pos + 1];
  const sBytes = d.subarray(pos + 2, pos + 2 + sLen);

  // DER integers are signed; a leading 0x00 is added when the high bit is
  // set. Strip it, then left-pad to coordLen.
  function padInt(src: Uint8Array, len: number): Uint8Array {
    let start = 0;
    while (start < src.length - 1 && src[start] === 0x00) {start++;}
    const trimmed = src.subarray(start);
    if (trimmed.length > len) {throw new Error('ECDSA integer too large for curve');}
    const out = new Uint8Array(len);
    out.set(trimmed, len - trimmed.length);
    return out;
  }

  const p1363 = new Uint8Array(coordLen * 2);
  p1363.set(padInt(rBytes, coordLen), 0);
  p1363.set(padInt(sBytes, coordLen), coordLen);
  return p1363;
}

/** Return the coordinate byte length for a named WebCrypto EC curve. */
export function ecCoordLen(curve: string): number {
  if (curve === 'P-256') {return 32;}
  if (curve === 'P-384') {return 48;}
  if (curve === 'P-521') {return 66;}
  throw new Error(`Unknown EC curve: ${curve}`);
}

/**
 * Heuristically detect an EC curve from a DER SPKI structure:
 * look for the OID bytes of P-521/P-384; anything else is P-256.
 */
export function detectECCurve(derBytes: Uint8Array): string {
  // P-384 OID: 2b 81 04 00 22
  // P-521 OID: 2b 81 04 00 23
  const oidP384 = [0x2b, 0x81, 0x04, 0x00, 0x22];
  const oidP521 = [0x2b, 0x81, 0x04, 0x00, 0x23];

  function contains(bytes: Uint8Array, seq: number[]): boolean {
    return findSeq(bytes, new Uint8Array(seq)) !== -1;
  }
  if (contains(derBytes, oidP521)) {return 'P-521';}
  if (contains(derBytes, oidP384)) {return 'P-384';}
  return 'P-256'; // default
}

/**
 * Verify a signature. The public key (from DNS p= or record pk=) is a
 * base64-decoded DER SPKI blob. `rawMessageBytes` is the pre-image —
 * crypto.subtle.verify() hashes it internally with `hashAlg`.
 * ECDSA signatures arrive DER-encoded and are converted to P-1363.
 * Throws on unsupported algorithms and malformed ECDSA DER.
 */
export async function verifySignature(
  pubKeyDerBytes: Uint8Array,
  sigBytes: Uint8Array,
  rawMessageBytes: Uint8Array,
  ka: string | undefined,
  da: string | undefined,
): Promise<boolean> {
  const kaInfo = resolveKeyAlg(ka);
  if (!kaInfo) {throw new Error(`Unsupported key algorithm: ${ka}`);}

  const hashAlg = mapDigestAlg(da);
  if (!hashAlg) {throw new Error(`Unsupported digest algorithm: ${da}`);}

  let importAlg: RsaHashedImportParams | EcKeyImportParams;
  let verifyAlg: string | EcdsaParams;
  let sigForVerify: Uint8Array;
  if (kaInfo.type === 'rsa') {
    importAlg = { name: 'RSASSA-PKCS1-v1_5', hash: hashAlg };
    verifyAlg = 'RSASSA-PKCS1-v1_5';
    sigForVerify = sigBytes; // RSA: use signature as-is
  } else {
    // EC: detect curve, convert DER → P1363 for WebCrypto
    const curve = detectECCurve(pubKeyDerBytes);
    importAlg = { name: 'ECDSA', namedCurve: curve };
    verifyAlg = { name: 'ECDSA', hash: hashAlg };
    sigForVerify = derToP1363(sigBytes, ecCoordLen(curve));
  }

  const pubKey = await crypto.subtle.importKey('spki', pubKeyDerBytes.buffer, importAlg, false, ['verify']);

  // Pass rawMessageBytes — SubtleCrypto hashes it internally using hashAlg.
  return crypto.subtle.verify(verifyAlg, pubKey, sigForVerify, rawMessageBytes);
}
