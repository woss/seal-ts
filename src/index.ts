/**
 * SEAL (Secure Evidence Attribution Label) v1 — sign and verify.
 *
 * Verify side: vendored hackerfactor SEAL-JS validator (100% parity).
 * Sign side: spec-correct TypeScript signer producing records the
 * vendored validator authenticates byte-exactly.
 */
export type { SealParsedRecord, SealValidateOptions, SealValidationResult, SealValidator } from './seal.js';
export { seal } from './seal.js';
export type { SealKeyPair } from './sign/keygen.js';
export { generateSealKeyPair } from './sign/keygen.js';
export type { SealKeyAlg } from './sign/keyutil.js';
export { exportPkcs8B64, exportSpkiB64, fromB64, importPrivateKey, toB64 } from './sign/keyutil.js';
export type { SealSignature, SealSignOptions } from './sign/signer.js';
export { sealSign } from './sign/signer.js';
