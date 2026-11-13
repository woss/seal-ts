/**
 * SEAL verification — native TypeScript facade.
 *
 * `seal.validateBuffer(buffer, filename, opts)` authenticates records
 * against DNS-published keys (DoH chain: Google → Quad9 → Cloudflare).
 * The `_`-prefixed members are internals retained as a typed compatibility
 * surface — the upstream vector suite depends on them verbatim.
 */
import { parseDNSTXT } from './verify/dns.js';
import { findAllSEALRecords } from './verify/parse.js';
import { computeByteRanges } from './verify/ranges.js';
import { detectFormat, scanByFormat, type SealScanRecord } from './verify/scan.js';
import { decodeSig } from './verify/sig.js';
import { validateBuffer } from './verify/validate.js';

/** A `<seal ... />` record located in a scanned buffer, with offsets for signature blanking. */
export type SealRecord = SealScanRecord;

export type {
  SealValidateOptions,
  SealValidationResult,
} from './verify/validate.js';
import type {
  SealValidateOptions,
  SealValidationResult,
} from './verify/validate.js';

export type { SealParsedRecord } from './verify/parse.js';
import type { SealParsedRecord } from './verify/parse.js';

/**
 * Inline DNS override: pre-parsed TXT fields for one domain, keyed by SEAL field
 * name (`p`, `ka`, `r`, ...) — used when records cannot be fetched from real DNS.
 */
export interface SealDnsOverride {
  [field: string]: string | Uint8Array | undefined;
}

/** Validator API: `seal.validateBuffer(...)` plus typed internals (`_`-prefixed). */
export interface SealValidator {
  validateBuffer(
    buffer: Uint8Array | ArrayBuffer,
    filename?: string,
    opts?: SealValidateOptions,
  ): Promise<SealValidationResult[]>;
  detectFormat(bytes: Uint8Array): string;
  _parseDNSTXT(txt: string): (Record<string, string> & { _pBin?: Uint8Array | null }) | null;
  _findAllSEALRecords(bytes: Uint8Array): SealParsedRecord[];
  _scanByFormat(bytes: Uint8Array): SealScanRecord[];
  _computeByteRanges(
    bSpec: string,
    fileLen: number,
    sigStart: number,
    sigEnd: number,
    prevStart?: number,
    prevEnd?: number,
  ): { ranges: Array<[number, number]> | null; error: string | null };
  _decodeSig(
    sField: string,
    sfField?: string,
  ): {
    sigBytes: Uint8Array | null;
    timestamp: string | null;
    error: string | null;
  };
}

export const seal: SealValidator = {
  validateBuffer,
  detectFormat,
  _parseDNSTXT: parseDNSTXT,
  _findAllSEALRecords: findAllSEALRecords,
  _scanByFormat: scanByFormat,
  _computeByteRanges: computeByteRanges,
  _decodeSig: decodeSig,
};
