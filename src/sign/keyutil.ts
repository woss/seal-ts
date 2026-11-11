/**
 * Key serialization helpers: base64 (RFC 4648) and WebCrypto import/export
 * for SEAL signing keys — inverses of the vendored validator's key handling.
 */

/** Encode bytes as standard base64 (RFC 4648) — ES2026 Uint8Array method, universal in browsers/Deno/Node 24+. */
export function toB64(data: Uint8Array): string {
  return data.toBase64();
}

/** Decode base64 back to bytes — tolerates PEM line-wrapping and the base64url alphabet (`-`/`_`). */
export function fromB64(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  return clean.includes('-') || clean.includes('_')
    ? Uint8Array.fromBase64(clean, { alphabet: 'base64url', lastChunkHandling: 'loose' })
    : Uint8Array.fromBase64(clean, { lastChunkHandling: 'loose' });
}

/** Signing key algorithm: `rsa` (RSASSA-PKCS1-v1_5/SHA-256, 2048-bit) or `ecdsa` (P-256/SHA-256). */
export type SealKeyAlg = 'rsa' | 'ecdsa';

/**
 * Import a PKCS#8 private key (base64) for SEAL signing.
 * rsa   → RSASSA-PKCS1-v1_5 with SHA-256
 * ecdsa → ECDSA P-256 with SHA-256
 */
export async function importPrivateKey(pkcs8B64: string, alg: SealKeyAlg): Promise<CryptoKey> {
  const pkcs8 = fromB64(pkcs8B64);
  if (alg === 'rsa') {
    return crypto.subtle.importKey(
      'pkcs8',
      pkcs8 as BufferSource,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8 as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/** Export a private key as base64 PKCS#8 (storage format for SEAL_SIGNING_KEY). */
export async function exportPkcs8B64(key: CryptoKey): Promise<string> {
  return toB64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', key)));
}

/** Export a public key as base64 SPKI (the value published in the DNS TXT p= field). */
export async function exportSpkiB64(key: CryptoKey): Promise<string> {
  return toB64(new Uint8Array(await crypto.subtle.exportKey('spki', key)));
}
