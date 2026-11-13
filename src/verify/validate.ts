/**
 * SEAL validation orchestration
 * (mirrors the C `SealVerify` / `_SealValidateRevoke` / `SealInlineAuthenticate`
 * `SealDoubleDigest` and the upstream top-level `validateBuffer`).
 */
import { b64decode, dec,enc, u8 } from './bytes.js';
import { dnsLookup, parseDNSTXT } from './dns.js';
import { type SealRecordFields } from './parse.js';
import { computeByteRanges } from './ranges.js';
import { scanByFormat,type SealScanRecord } from './scan.js';
import { decodeSig, mapDigestAlg, verifySignature } from './sig.js';

/** Per-record options for {@link validateBuffer}. */
export interface SealValidateOptions {
  /** Raw DNS TXT string, pre-parsed fields object, or array of either. */
  dnsOverride?: string | SealDnsOverride | Array<string | SealDnsOverride>;
  /** Per-domain DNS overrides. Values follow dnsOverride rules. */
  dnsOverrideMap?: Record<string, string | Array<string | SealDnsOverride>>;
  /** Skip signature-crypto failure (used by tests to exercise the DNS path only). */
  verifyOverride?: boolean;
}

/** A DNS fields object (or raw TXT string) standing in for real DNS. */
export interface SealDnsOverride {
  [field: string]: string | Uint8Array | undefined;
}

/** Result of validating one SEAL record. */
export interface SealValidationResult {
  /** Crypto validated against the DNS public key. */
  valid: boolean;
  /** Signature authenticated (inline pk= path may authenticate without crypto). */
  auth: boolean;
  revoked: boolean;
  domain: string;
  keyAlg: string;
  sigFormat: string;
  timestamp: string | null;
  /** Filename passed to validateBuffer (informational). */
  filename?: string;
  /** 1-based index of this record within the file. */
  recordIndex?: number;
  /** Total records found in the file. */
  recordCount?: number;
  error: string | null;
  warnings: string[];
  fields: SealRecordFields;
  /** DNS record that matched (when valid or revoked). */
  matchedDNS?: DnsParsedFields | null;
  /** Computed double digest, hex (debug). */
  debugDigest?: string;
  /** Human-readable b= range description (debug). */
  byteDesc?: string;
}

export type SealValidatorResult = SealValidationResult[];

/** Parsed DNS TXT fields: string values plus decoded binary key slots. */
export type DnsParsedFields = SealRecordFields & {
  _pBin?: Uint8Array | null;
  _pkdBin?: Uint8Array | null;
};

type DnsFields = DnsParsedFields;

/** Concatenate the selected ranges and hash them (mirrors EVP_Digest*). */
async function hashRanges(
  bytes: Uint8Array,
  ranges: Array<[number, number]>,
  hashAlg: string,
): Promise<{ rawBytes: Uint8Array; digest: Uint8Array }> {
  let totalLen = 0;
  for (const [s, e] of ranges) {totalLen += e - s;}

  const rawBytes = new Uint8Array(totalLen);
  let off = 0;
  for (const [s, e] of ranges) {
    rawBytes.set(bytes.subarray(s, e), off);
    off += e - s;
  }
  const digest = new Uint8Array(await crypto.subtle.digest(hashAlg, rawBytes));
  return { rawBytes, digest };
}

/**
 * Compute the double-digest if id= or a timestamp is present.
 * (Mirrors SealDoubleDigest.) Pre-image: `date ":" [id ":"] primaryDigest`.
 * Returns verifyInput = raw pre-image bytes (WebCrypto hashes internally)
 * and digest = the final computed digest (debug/display).
 */
async function doubleDigest(
  primaryRawBytes: Uint8Array,
  primaryDigest: Uint8Array,
  hashAlg: string,
  sigdate: string | null,
  userid: string | null,
): Promise<{ verifyInput: Uint8Array; digest: Uint8Array }> {
  if (!sigdate && !userid) {
    // No double-digest: verify() will hash primaryRawBytes itself.
    return { verifyInput: primaryRawBytes, digest: primaryDigest };
  }

  // Build pre-image: sigdate ":" userid ":" primaryDigest-bytes
  const parts: Uint8Array[] = [];
  if (sigdate) {
    parts.push(enc.encode(sigdate));
    parts.push(enc.encode(':'));
  }
  if (userid) {
    parts.push(enc.encode(userid));
    parts.push(enc.encode(':'));
  }
  parts.push(primaryDigest); // first digest as raw bytes

  let len = 0;
  for (const p of parts) {len += p.length;}
  const preImage = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    preImage.set(p, o);
    o += p.length;
  }

  const d2 = new Uint8Array(await crypto.subtle.digest(hashAlg, preImage));
  return { verifyInput: preImage, digest: d2 };
}

/**
 * DNS record matching (mirrors the loop inside SealVerify()):
 * seal=, ka=, uid=, kv= must agree before trusting the public key.
 */
function dnsRecordMatches(recFields: SealRecordFields, dnsFields: SealRecordFields): boolean {
  // seal version must match
  const recSeal = recFields.seal || '';
  const dnsSeal = dnsFields.seal || '';
  if (!recSeal || !dnsSeal || recSeal !== dnsSeal) {return false;}

  // If DNS specifies ka, record must agree
  if (dnsFields.ka && dnsFields.ka !== recFields.ka) {return false;}

  // If DNS specifies uid, record must agree
  if (dnsFields.uid && dnsFields.uid !== recFields.uid) {return false;}

  // kv must match (both default to "1")
  const recKv = recFields.kv || '1';
  const dnsKv = dnsFields.kv || '1';
  if (recKv !== dnsKv) {return false;}

  return true;
}

/** Revocation check (mirrors _SealValidateRevoke). */
function isRevoked(sigdate: string | null, dnsFields: SealRecordFields): boolean {
  if (dnsFields.p === 'revoke') {return true;}
  const r = dnsFields.r;
  if (r === undefined || r === null) {return false;}
  if (r === '' || r === 'revoke') {return true;} // global revoke
  if (!sigdate) {return true;}
  // r= is a date string; if sigdate >= r, it's revoked
  const minLen = Math.min(sigdate.length, r.length);
  return sigdate.substring(0, minLen) >= r.substring(0, minLen);
}

/**
 * Inline public-key authentication (mirrors SealInlineAuthenticate).
 * When a SEAL record has pk=, validate the signature using pk=, then check
 * against DNS for either p= (exact key match) or pkd=/pka= (key digest).
 */
async function inlineAuthenticate(recFields: SealRecordFields, dnsFields: SealRecordFields): Promise<{ authenticated: boolean; error: string | null }> {
  const pk = recFields.pk;
  const pkd = dnsFields.pkd;
  const pka = dnsFields.pka;

  if (!pk) {return { authenticated: false, error: 'no pk= in record' };}

  // Case A: exact key match in DNS
  if (dnsFields.p && dnsFields.p === pk) {return { authenticated: true, error: null };}

  // Case B: key digest match
  if (pkd && pka) {
    const hashAlg = mapDigestAlg(pka);
    if (!hashAlg) {return { authenticated: false, error: `unknown pka: ${pka}` };}
    const pkBin = b64decode(pk);
    const calc = new Uint8Array(await crypto.subtle.digest(hashAlg, pkBin));
    // encode to base64
    const b64 = btoa(String.fromCharCode(...calc));
    if (b64 !== pkd) {return { authenticated: false, error: 'pkd mismatch' };}
    return { authenticated: true, error: null };
  }

  return { authenticated: false, error: 'cannot authenticate inline key' };
}

/**
 * Core: validate one SEAL record (mirrors SealVerify).
 * `prevSig` carries { start, end } of the previous record's signature value.
 */
async function validateOneRecord(
  fileBytes: Uint8Array,
  rec: SealScanRecord,
  prevSig: { start: number; end: number } | null,
  opts: SealValidateOptions | undefined,
): Promise<SealValidationResult> {
  const f = rec.fields;
  const warnings: string[] = [];
  const result: SealValidationResult = {
    valid: false, // crypto validated
    auth: false, // signature authenticated
    revoked: false,
    domain: f.d || '(unknown)',
    keyAlg: f.ka || 'rsa',
    sigFormat: f.sf || 'base64',
    timestamp: null,
    error: null,
    warnings,
    fields: f,
  };

  const fileLen = fileBytes.length;
  const sigValStart = rec.rawSigStart; // absolute
  const sigValEnd = rec.rawSigEnd; // absolute
  if (sigValStart === -1) {
    result.error = 'SEAL record has no signature (s=) field';
    return result;
  }
  const prevStart = prevSig ? prevSig.start : 0;
  const prevEnd = prevSig ? prevSig.end : 0;

  // 1. ── Prepend/insertion attack warnings ────────────────────
  const bSpec = f.b || '';
  if (!bSpec.includes('F') && !bSpec.includes('P')) {
    warnings.push('SEAL record does not cover start of file — vulnerable to prepend attack');
  }
  if (prevSig && !bSpec.includes('P') && !bSpec.includes('F')) {
    warnings.push('SEAL record does not cover previous signature — vulnerable to insertion attack');
  }

  // 2. ── Decode the signature ─────────────────────────────────
  const { sigBytes, timestamp, error: sigErr } = decodeSig(f.s, f.sf);
  if (sigErr) {
    result.error = sigErr;
    return result;
  }
  if (!sigBytes || sigBytes.length === 0) {
    result.error = 'empty signature';
    return result;
  }
  result.timestamp = timestamp;

  // 3. ── Compute byte ranges ──────────────────────────────────
  const { ranges, error: rangeErr } = computeByteRanges(f.b || '~S,s~', fileLen, sigValStart, sigValEnd, prevStart, prevEnd);
  if (rangeErr) {
    result.error = rangeErr;
    return result;
  }
  if (!ranges || ranges.length === 0) {
    result.error = 'no bytes to hash (empty range)';
    return result;
  }

  // Convert range (f.b) to bytes and text
  f.byteRanges = ranges.map((r) => `${r[0]}-${r[1] - 1}`).join(', ');
  f.sigRange = `${sigValStart}-${sigValEnd - 1}`;
  {
    const ra = (f.b || '').split(',');
    const rs = ra.map((r) => r.split('~')[0]).join(',');
    const re = ra.map((r) => r.split('~')[1]).join(',');
    f.byteDesc = '';
    if (rs.includes('F')) {
      f.byteDesc = 'Start of file';
    } else if (rs.includes('P')) {
      f.byteDesc = 'Start of previous signature';
    } else if (rs.includes('p')) {
      f.byteDesc = 'End of previous signature';
    } else if (rs.includes('S')) {
      f.byteDesc = 'Start of signature';
    } else if (rs.includes('s')) {
      f.byteDesc = 'End of signature';
    } else if (rs.includes('f')) {
      f.byteDesc = 'End of file';
    } else {
      f.byteDesc = 'Absolute offset';
    }
    f.byteDesc += ' to ';
    if (re.includes('f')) {
      f.byteDesc += 'end of file';
    } else if (re.includes('s')) {
      f.byteDesc += 'end of signature';
    } else if (re.includes('S')) {
      f.byteDesc += 'start of signature';
    } else if (re.includes('p')) {
      f.byteDesc += 'end of previous signature';
    } else if (re.includes('P')) {
      f.byteDesc += 'start of previous signature';
    } else if (re.includes('F')) {
      f.byteDesc += 'start of file';
    } else {
      f.byteDesc = 'Absolute offset';
    }

    // Verify the end-of-file coverage
    const lastRange = ranges[ranges.length - 1];
    if (lastRange[1] < fileLen) {
      f.byteDesc += '; SEAL record does not finalize the file, data may be appended';
    }
  }

  // 4. ── Primary digest ───────────────────────────────────────
  const da = f.da || 'sha256';
  const hashAlg = mapDigestAlg(da);
  if (!hashAlg) {
    result.error = `Unknown digest algorithm: ${da}`;
    return result;
  }

  const { rawBytes: primaryRawBytes, digest: primaryDigest } = await hashRanges(fileBytes, ranges, hashAlg);

  // 5. ── Double digest (if date or id present) ────────────────
  // verifyInput = raw bytes to hand to crypto.subtle.verify()
  // digest      = the final computed hash (for debug display only)
  const { verifyInput, digest } = await doubleDigest(primaryRawBytes, primaryDigest, hashAlg, timestamp, f.id || null);

  // Expose the computed digest on the result for debugging (hex, lower-case).
  result.debugDigest = Array.from(digest)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // 6. ── Inline public key path ───────────────────────────────
  let isInline = false;
  let pubKeyBin: Uint8Array | null = null;

  if (f.pk) {
    isInline = true;
    pubKeyBin = b64decode(f.pk);
  }

  // 7. ── DNS lookup and matching ──────────────────────────────
  if (!f.d) {
    result.error = 'No domain (d=) in SEAL record';
    return result;
  }

  const dnsName = `${f.d}`;

  let dnsRecords: DnsFields[] = [];
  if (opts && opts.dnsOverride) {
    // dnsOverride can be: string (raw TXT), object (pre-parsed fields), or array
    const ov = opts.dnsOverride;
    if (Array.isArray(ov)) {
      dnsRecords = ov.map((x) => (typeof x === 'string' ? parseDNSTXT(x) : normalizeDns(x))).filter(Boolean) as DnsFields[];
    } else {
      const parsed = typeof ov === 'string' ? parseDNSTXT(ov) : normalizeDns(ov);
      if (parsed) {dnsRecords = [parsed];}
    }
  } else if (opts && opts.dnsOverrideMap && opts.dnsOverrideMap[f.d]) {
    const ov = opts.dnsOverrideMap[f.d];
    if (Array.isArray(ov)) {
      dnsRecords = ov.map((x) => (typeof x === 'string' ? parseDNSTXT(x) : normalizeDns(x))).filter(Boolean) as DnsFields[];
    } else {
      const parsed = typeof ov === 'string' ? parseDNSTXT(ov) : normalizeDns(ov);
      if (parsed) {dnsRecords = [parsed];}
    }
  } else {
    try {
      dnsRecords = await dnsLookup(dnsName);
    } catch (e) {
      result.error = `DNS lookup failed: ${e instanceof Error ? e.message : String(e)}`;
      return result;
    }
  }

  if (!dnsRecords || dnsRecords.length === 0) {
    result.error = `No SEAL DNS record found for ${dnsName}`;
    return result;
  }

  // Try each DNS record until one validates
  let globalRevoke: string | null = null;
  let globalRevokeDns: DnsFields | null = null;
  let lastError: string | null = null;
  let lastErrorDns: DnsFields | null = null;

  // Check every DNS record
  for (const dns of dnsRecords) {
    // Check field compatibility (seal=, ka=, uid=, kv=)
    if (!dnsRecordMatches(f, dns)) {continue;}

    // Check r= / p=revoke revocation BEFORE attempting crypto
    if (isRevoked(timestamp, dns)) {
      result.revoked = true;
      result.error = dns.p === 'revoke' || dns.r === 'revoke' || dns.r === '' ? 'domain default revoke' : 'public key revoked';
      result.matchedDNS = dns;
      return result;
    }

    // Check for key presence
    const dnsKey = dns.p || dns.pkd;
    if (!dnsKey) {
      // Record has no key and was not revoked by r=.
      // Save as potential global revoke if no other record provides a key.
      globalRevoke = 'domain default revoke';
      globalRevokeDns = dns;
      continue;
    }

    // Figure out which public key to use based on inline status

    // Inline path: authenticate the inline public key against DNS
    if (isInline) {
      result.auth = false;
      if (dns.p === f.pk) {
        // Exact key match in DNS
        result.auth = true;
        result.matchedDNS = dns;
      } else {
        // Try pkd/pka digest authentication
        const { authenticated } = await inlineAuthenticate(f, dns);
        if (authenticated) {
          result.auth = true;
        }
      }
    } else {
      // Not inline
      if (!dns.p && dns.pkd) {continue;} // skip inline-only TXT entries
      if (dns._pBin) {pubKeyBin = dns._pBin;}
      else {pubKeyBin = null;}
    }

    // Verify signature against DNS public key
    if (!pubKeyBin) {
      lastError = 'DNS record has no usable public key';
      lastErrorDns = dns;
      continue;
    }

    let ok = false;
    if (opts && opts.verifyOverride) {
      ok = true;
    } else {
      try {
        ok = await verifySignature(pubKeyBin, sigBytes, verifyInput, f.ka, da);
      } catch (e) {
        lastError = `Verification error: ${e instanceof Error ? e.message : String(e)}`;
        lastErrorDns = dns;
        continue;
      }
    }

    if (!ok) {
      lastError = 'signature mismatch';
      lastErrorDns = dns;
      continue;
    }

    // ✓ Valid!
    result.valid = true;
    if (!isInline) {result.auth = true;}
    result.error = null;
    result.matchedDNS = dns;
    return result;
  }

  // No DNS record matched
  if (globalRevoke) {
    result.revoked = true;
    result.error = globalRevoke;
    result.matchedDNS = globalRevokeDns;
  } else if (!result.valid) {
    result.error = lastError || 'could not validate against any DNS record';
    result.matchedDNS = lastErrorDns;
  }
  return result;
}

/** Coerce an override object's Uint8Array fields into the parsed-fields shape. */
function normalizeDns(ov: SealDnsOverride): DnsFields {
  const out: DnsFields = {};
  for (const [k, v] of Object.entries(ov)) {
    if (v === undefined) {continue;}
    out[k] = typeof v === 'string' ? v : dec.decode(v);
  }
  return out;
}

/** Validate all SEAL records found in a file buffer. */
export async function validateBuffer(buffer: ArrayBuffer | Uint8Array, filename?: string, opts: SealValidateOptions = {}): Promise<SealValidatorResult> {
  const bytes = u8(buffer);
  const recs = scanByFormat(bytes);

  if (recs.length === 0) {
    return [
      {
        valid: false,
        auth: false,
        revoked: false,
        domain: '',
        keyAlg: '',
        sigFormat: '',
        timestamp: null,
        filename: filename || '(unknown)',
        error: 'No SEAL record found in file',
        warnings: [],
        fields: {},
      },
    ];
  }

  const results: SealValidationResult[] = [];
  let prevSig: { start: number; end: number } | null = null; // tracks previous signature value position

  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    // rec.bytes is the coordinate space (whole file, or zip sub-file)
    const r = await validateOneRecord(rec.bytes, rec, prevSig, opts);
    r.filename = filename || '(unknown)';
    r.recordIndex = i + 1;
    r.recordCount = recs.length;
    results.push(r);

    // Update previous-sig pointer for the next iteration
    prevSig = { start: rec.rawSigStart, end: rec.rawSigEnd };
  }

  return results;
}
