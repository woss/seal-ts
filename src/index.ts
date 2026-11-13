/**
 * SEAL (Secure Evidence Attribution Label) v1 — sign and verify.
 *
 * Verify side: native TypeScript port of the upstream SEAL-JS validator,
 * conformance-tested against its public vector suite.
 * Sign side: spec-correct TypeScript signer producing records any
 * spec-conformant validator authenticates byte-exactly.
 */
export type { SealDnsOverride, SealParsedRecord, SealValidateOptions, SealValidationResult, SealValidator } from './seal.js';
export { seal } from './seal.js';
export type { SealKeyPair } from './sign/keygen.js';
export { generateSealKeyPair } from './sign/keygen.js';
export type { SealKeyAlg } from './sign/keyutil.js';
export { exportPkcs8B64, exportSpkiB64, fromB64, importPrivateKey, toB64 } from './sign/keyutil.js';
export type { SealSignature, SealSignOptions } from './sign/signer.js';
export { sealSign } from './sign/signer.js';
