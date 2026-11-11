/**
 * Typed facade over the vendored SEAL validator (registered on globalThis).
 */
import './vendor/seal-validator.js';

export interface SealParsedRecord {
  fields: Record<string, string> & { _pBin?: Uint8Array; _pkdBin?: Uint8Array };
  /** Offset of the record start within the scanned buffer. */
  recStart: number;
  /** Length of the record (relative, like @RecEnd in the C reference). */
  recEnd: number;
  /** Absolute offsets of the s= value, or -1 when the record has no s= field. */
  rawSigStart: number;
  rawSigEnd: number;
  /** Coordinate space the record was found in (full file for most scanners). */
  bytes: Uint8Array;
}

export interface SealDnsOverride {
  [field: string]: string | Uint8Array | undefined;
}

export interface SealValidateOptions {
  /** Raw DNS TXT string, pre-parsed fields object, or array of either. */
  dnsOverride?: string | SealDnsOverride | Array<string | SealDnsOverride>;
  /** Per-domain DNS overrides. Values follow dnsOverride rules. */
  dnsOverrideMap?: Record<string, string | Array<string | SealDnsOverride>>;
  /** Skip signature-crypto failure (used to test revocation logic). */
  verifyOverride?: boolean;
}

export interface SealValidationResult {
  valid: boolean;
  auth?: boolean;
  revoked: boolean;
  domain: string;
  keyAlg: string;
  sigFormat: string;
  timestamp: string | null;
  filename: string;
  error: string | null;
  warnings: string[];
  fields: Record<string, string>;
  recordIndex?: number;
  recordCount?: number;
}

export interface SealValidator {
  validateBuffer(
    buffer: Uint8Array | ArrayBuffer,
    filename?: string,
    opts?: SealValidateOptions,
  ): Promise<SealValidationResult[]>;
  detectFormat(bytes: Uint8Array): string;
  _parseDNSTXT(txt: string): (Record<string, string> & { _pBin?: Uint8Array }) | null;
  _findAllSEALRecords(bytes: Uint8Array): SealParsedRecord[];
  _scanByFormat(bytes: Uint8Array): SealParsedRecord[];
  _computeByteRanges(
    bSpec: string,
    fileLen: number,
    sigStart: number,
    sigEnd: number,
    prevStart?: number,
    prevEnd?: number,
  ): { ranges: Array<[number, number]>; error: string | null };
  _decodeSig(
    sField: string,
    sfField?: string,
  ): {
    sigBytes: Uint8Array;
    timestamp: string | null;
    error: string | null;
  };
}

// Vendored validator registers itself on globalThis (browser-script heritage).
// The side-effect import above has run by the time this module evaluates.
const sealGlobal = globalThis as unknown as { SEAL?: SealValidator };

export const seal: SealValidator = sealGlobal.SEAL as SealValidator;
