/**
 * Typed facade over the vendored SEAL validator (registered on globalThis).
 */
import './vendor/seal-validator.js';

/** A `<seal ... />` record located in a scanned buffer, with offsets for signature blanking. */
export interface SealParsedRecord {
  /** Parsed TXT-style fields; `_pBin`/`_pkdBin` hold decoded binary p=/pkd= values. */
  fields: Record<string, string> & { _pBin?: Uint8Array; _pkdBin?: Uint8Array };
  /** Offset of the record start within the scanned buffer. */
  recStart: number;
  /** Length of the record (relative, like `` `@RecEnd` `` in the C reference). */
  recEnd: number;
  /** Absolute offsets of the s= value, or -1 when the record has no s= field. */
  rawSigStart: number;
  /** End offset paired with {@link SealParsedRecord.rawSigStart}. */
  rawSigEnd: number;
  /** Coordinate space the record was found in (full file for most scanners). */
  bytes: Uint8Array;
}

/**
 * Inline DNS override: pre-parsed TXT fields for one domain, keyed by SEAL field
 * name (`p`, `ka`, `r`, ...) — used when records cannot be fetched from real DNS.
 */
export interface SealDnsOverride {
  [field: string]: string | Uint8Array | undefined;
}

/** Options for {@link SealValidator.validateBuffer}. */
export interface SealValidateOptions {
  /** Raw DNS TXT string, pre-parsed fields object, or array of either. */
  dnsOverride?: string | SealDnsOverride | Array<string | SealDnsOverride>;
  /** Per-domain DNS overrides. Values follow dnsOverride rules. */
  dnsOverrideMap?: Record<string, string | Array<string | SealDnsOverride>>;
  /** Skip signature-crypto failure (used to test revocation logic). */
  verifyOverride?: boolean;
}

/** Outcome of validating one SEAL record: validity plus the parsed key facts. */
export interface SealValidationResult {
  /** Whether the record authenticated (signature, key, timestamp all check out). */
  valid: boolean;
  /** Authorization flag from the DNS record (a=), when present. */
  auth?: boolean;
  /** Whether the key was revoked via p=revoke or r= date. */
  revoked: boolean;
  /** Domain the record claims (d=). */
  domain: string;
  /** Key algorithm from ka= (e.g. rsa). */
  keyAlg: string;
  /** Signature value encoding from sf= (e.g. base64). */
  sigFormat: string;
  /** Record timestamp, parsed, or null when absent/malformed. */
  timestamp: string | null;
  /** Filename the buffer was scanned under (drives format detection). */
  filename: string;
  /** Fatal validation error, or null when valid. */
  error: string | null;
  /** Non-fatal warnings collected during validation. */
  warnings: string[];
  /** Parsed TXT-style fields of the record. */
  fields: Record<string, string>;
  /** Zero-based index of this record within the buffer. */
  recordIndex?: number;
  /** Total SEAL records found in the buffer. */
  recordCount?: number;
}

/** Validator API exposed by the vendored SEAL-JS script (typed; `_`-prefixed are internals). */
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

/**
 * The vendored SEAL validator: `seal.validateBuffer(buffer, filename, opts)`
 * authenticates records against DNS-published keys (DoH chain: Google →
 * Quad9 → Cloudflare). Side-effect import registers it on globalThis.
 */
export const seal: SealValidator = sealGlobal.SEAL as SealValidator;
