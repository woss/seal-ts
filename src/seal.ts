/**
 * SEAL verification — native TypeScript facade.
 *
 * `seal.validateBuffer(buffer, filename, opts)` authenticates records
 * against DNS-published keys (DoH chain: Google → Quad9 → Cloudflare).
 * The `_`-prefixed members are internals retained as a typed compatibility
 * surface — the upstream vector suite depends on them verbatim. Their types
 * are `typeof` the real implementations so they can never drift.
 */
import { parseDNSTXT } from './verify/dns.js';
import { findAllSEALRecords } from './verify/parse.js';
import { computeByteRanges } from './verify/ranges.js';
import { detectFormat, scanByFormat, type SealScanRecord } from './verify/scan.js';
import { decodeSig } from './verify/sig.js';
import { validateBuffer } from './verify/validate.js';

/** A `<seal ... />` record located in a scanned buffer, with offsets for signature blanking. */
export type SealRecord = SealScanRecord;

export type { SealParsedRecord } from './verify/parse.js';
export type { SealDnsOverride, SealValidateOptions, SealValidationResult } from './verify/validate.js';

/** Validator API: `seal.validateBuffer(...)` plus typed internals (`_`-prefixed). */
export interface SealValidator {
  validateBuffer: typeof validateBuffer;
  detectFormat: typeof detectFormat;
  _parseDNSTXT: typeof parseDNSTXT;
  _findAllSEALRecords: typeof findAllSEALRecords;
  _scanByFormat: typeof scanByFormat;
  _computeByteRanges: typeof computeByteRanges;
  _decodeSig: typeof decodeSig;
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
