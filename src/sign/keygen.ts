import { exportPkcs8B64, exportSpkiB64, type SealKeyAlg } from './keyutil.js';

/** A generated SEAL signing key pair: private key for signing, public key for DNS publication. */
export interface SealKeyPair {
  alg: SealKeyAlg;
  /** base64 PKCS#8 private key — store as SEAL_SIGNING_KEY */
  pkcs8B64: string;
  /** base64 SPKI public key — publish in the domain's DNS TXT p= field */
  spkiB64: string;
}

/**
 * Generate a new SEAL signing key pair.
 * rsa (default, 2048-bit) or ecdsa (P-256) — the two algorithms the
 * SEAL validator resolves.
 */
export async function generateSealKeyPair(alg: SealKeyAlg = 'rsa'): Promise<SealKeyPair> {
  let keyPair: CryptoKeyPair;
  if (alg === 'rsa') {
    keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
      },
      true,
      ['sign', 'verify'],
    );
  } else {
    keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
  }
  return {
    alg,
    pkcs8B64: await exportPkcs8B64(keyPair.privateKey),
    spkiB64: await exportSpkiB64(keyPair.publicKey),
  };
}
