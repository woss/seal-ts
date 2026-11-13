/**
 * SEAL record parser (mirrors the C `SealParse()`).
 *
 * Handles:
 *   <seal field="value" ... />          – standard
 *   &lt;seal field="value" ... /&gt;    – XML entity encoded (XMP)
 *   <?seal field="value" ... ?>         – XML processing instruction
 */
import { dec, enc, matchAt, strDecode, xmlDecode } from './bytes.js';

/** Parsed TXT-style fields; `_pBin`/`_pkdBin` hold decoded binary p=/pkd= DNS key values. */
export type SealRecordFields = Record<string, string> & {
  _pBin?: Uint8Array | null;
  _pkdBin?: Uint8Array | null;
  byteRanges?: string;
  sigRange?: string;
  byteDesc?: string;
};

/** A `<seal ... />` record located in a scanned buffer, with offsets for signature blanking. */
export interface SealParsedRecord {
  fields: SealRecordFields;
  /** Offset of the record start within the scanned buffer. */
  recStart: number;
  /** Length of the record (relative, like `@RecEnd` in the C reference). */
  recEnd: number;
  /** Absolute offsets of the s= value, or -1 when the record has no s= field. */
  rawSigStart: number;
  rawSigEnd: number;
}

function isAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}
function isAlNum(c: number): boolean {
  return isAlpha(c) || (c >= 0x30 && c <= 0x39);
}

/**
 * Scan all bytes for every SEAL record.
 * Returns an array of parsed records with their byte positions.
 */
export function findAllSEALRecords(bytes: Uint8Array): SealParsedRecord[] {
  const results: SealParsedRecord[] = [];

  // Opener patterns: "<seal " (standard), "&lt;seal " (entity-encoded XMP),
  // "<?seal " (XML PI, case-insensitive).
  let pos = 0;
  while (pos < bytes.length) {
    // Quick scan: look for '<' or '&'
    let found = -1,
      xmlMode = 0;
    for (let i = pos; i < bytes.length; i++) {
      const c = bytes[i];
      if (c !== 0x3c && c !== 0x26) {continue;}

      // Check standard opener: <seal or <?seal
      if (c === 0x3c) {
        if (matchAt(bytes, i, '<seal ')) {
          found = i;
          xmlMode = 0;
          break;
        }
        // case-insensitive match for <?seal
        const look = dec.decode(bytes.subarray(i, Math.min(i + 8, bytes.length))).toLowerCase();
        if (look.startsWith('<?seal ')) {
          found = i;
          xmlMode = 2;
          break;
        }
      }
      // Check entity-encoded opener: &lt;seal
      if (c === 0x26 && matchAt(bytes, i, '&lt;seal ')) {
        found = i;
        xmlMode = 1;
        break;
      }
    }
    if (found === -1) {break;}

    // Now parse the record starting at `found`
    const rec = parseSEALRecord(bytes, found, xmlMode);
    if (rec) {
      results.push(rec);
      pos = found + rec.recEnd;
    } else {
      pos = found + 1;
    }
  }
  return results;
}

/**
 * Parse one SEAL record starting at byteOffset.
 * Returns null if parsing fails.
 * `recEnd` is relative offset from byteOffset (like @RecEnd in C).
 * `rawSigStart`/`rawSigEnd` are absolute byte offsets of the signature value.
 */
export function parseSEALRecord(bytes: Uint8Array, byteOffset: number, xmlMode: number): SealParsedRecord | null {
  // xmlMode: 0 = plain (<seal), 1 = entity (&lt;seal), 2 = XML PI (<?seal)

  // Advance past the opener
  let i: number;
  if (xmlMode === 0) {i = byteOffset + '<seal '.length;}
  else if (xmlMode === 1) {i = byteOffset + '&lt;seal '.length;}
  else {i = byteOffset + '<?seal '.length;}

  const fields: SealRecordFields = {};
  let rawSigStart = -1,
    rawSigEnd = -1;
  const lim = bytes.length;

  // State machine: look for attribute=value pairs
  while (i < lim) {
    // Skip whitespace
    while (i < lim && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) {i++;}
    if (i >= lim) {return null;}

    // Check for end-of-record markers
    if (xmlMode === 0) {
      if (bytes[i] === 0x3e) {
        i++;
        break;
      } // >
      if (matchAt(bytes, i, '/>')) {
        i += 2;
        break;
      }
      if (matchAt(bytes, i, '</')) {break;} // </...>
      if (bytes[i] === 0x3c) {return null;} // another < without closing
    } else if (xmlMode === 2) {
      // PI
      if (matchAt(bytes, i, '?>')) {
        i += 2;
        break;
      }
      if (bytes[i] === 0x3e) {return null;}
    } else {
      // entity-encoded XML — accept both &gt; and /> as closers
      if (matchAt(bytes, i, '&gt;')) {
        i += 4;
        break;
      }
      if (matchAt(bytes, i, '/&gt;')) {
        i += 5;
        break;
      }
      if (matchAt(bytes, i, '&lt;/')) {break;}
      if (matchAt(bytes, i, '&lt;')) {return null;}
      // Also accept plain /> or > (mixed real/entity encoding happens in the wild)
      if (bytes[i] === 0x3e) {
        i++;
        break;
      }
      if (matchAt(bytes, i, '/>')) {
        i += 2;
        break;
      }
    }

    // Read field name  (must be alphanumeric)
    if (!isAlpha(bytes[i])) {return null;}
    const fieldStart = i;
    while (i < lim && isAlNum(bytes[i])) {i++;}
    const fieldName = dec.decode(bytes.subarray(fieldStart, i));

    if (i >= lim || bytes[i] !== 0x3d) {return null;} // must be followed by =
    i++; // skip '='

    // Read value (quoted or unquoted)
    let quote = 0;
    let isXmlQuote = false;
    if (i < lim && (bytes[i] === 0x22 || bytes[i] === 0x27)) {
      quote = bytes[i];
      i++;
    } else if (xmlMode === 1 && matchAt(bytes, i, '&quot;')) {
      isXmlQuote = true;
      i += 6;
    }

    const valStart = i;
    let valEnd = i;

    while (i < lim) {
      if (bytes[i] === 0x5c) {
        i += 2;
        continue;
      } // backslash escape
      if (!quote && !isXmlQuote) {
        // Stop at whitespace, < >, and also & (for entity-encoded XML mode)
        if (
          bytes[i] === 0x20 ||
          bytes[i] === 0x09 ||
          bytes[i] === 0x0a ||
          bytes[i] === 0x0d ||
          bytes[i] === 0x3c ||
          bytes[i] === 0x3e ||
          (xmlMode === 1 && bytes[i] === 0x26)
        ) {
          valEnd = i;
          break;
        }
      } else if (isXmlQuote) {
        if (matchAt(bytes, i, '&quot;')) {
          valEnd = i;
          i += 6;
          break;
        }
      } else {
        if (bytes[i] === quote) {
          valEnd = i;
          i++;
          break;
        }
      }
      i++;
    }
    if (i >= lim && valEnd === valStart) {valEnd = i;} // ran to end

    // Decode value
    const rawVal = dec.decode(bytes.subarray(valStart, valEnd));
    const decodedVal = isXmlQuote ? xmlDecode(rawVal) : strDecode(rawVal);

    // Track the signature position (absolute in the file)
    if (fieldName === 's') {
      rawSigStart = valStart;
      rawSigEnd = valEnd;
    }

    // Warn on duplicate but allow the last one to win (matches C behavior)
    fields[fieldName] = decodedVal;

    // After value, check for termination
    if (i >= lim) {break;}
    const nc = bytes[i];
    if (nc === 0x20 || nc === 0x09 || nc === 0x0a || nc === 0x0d) {continue;}
    // Hit a closing token — finalize
    if (xmlMode === 0 && (nc === 0x3e || (nc === 0x2f && i + 1 < lim && bytes[i + 1] === 0x3e))) {
      if (nc === 0x3e) {i++;}
      else {i += 2;}
      break;
    }
    if (xmlMode === 2 && matchAt(bytes, i, '?>')) {
      i += 2;
      break;
    }
    if (xmlMode === 1 && (matchAt(bytes, i, '&gt;') || matchAt(bytes, i, '/&gt;') || matchAt(bytes, i, '&lt;'))) {
      while (i < lim && !matchAt(bytes, i, '&gt;')) {i++;}
      if (i < lim) {i += 4;}
      break;
    }
  }

  if (!fields.seal) {return null;}
  // rawSigStart === -1 is allowed for DNS records (no s= field);
  // callers that need the sig position check it themselves.

  return {
    fields,
    recStart: byteOffset,
    recEnd: i - byteOffset, // relative, matches @RecEnd
    rawSigStart,
    rawSigEnd,
  };
}

export { enc };
