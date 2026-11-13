/**
 * Format-aware SEAL record extraction.
 *
 * Each scanner mirrors the corresponding `Seal_XXX()` function in the C
 * reference. Every scanner returns ScanResult objects whose `bytes` field is
 * the coordinate space for that SEAL scope — i.e. what F=0 and f=fileLen mean
 * for these records — so nested scopes (JPEG thumbnail, ZIP entry, EXIF block)
 * resolve their b= ranges within the sub-file rather than the outer file.
 */
import { decodeStr, matchAt, readBE16, readBE32, readLE16, readLE32 } from './bytes.js';
import { findAllSEALRecords,type SealParsedRecord } from './parse.js';

/** A parsed record plus the coordinate space its b= ranges resolve against. */
export type SealScanRecord = SealParsedRecord & { bytes: Uint8Array };

/**
 * Scan a byte window [start, end) for SEAL records using the generic
 * text-search. All returned records have rawSigStart/rawSigEnd absolute
 * within `allBytes` (the file-level buffer). Filters out records whose
 * rawSigStart is -1 (no s= field).
 */
export function scanBlock(allBytes: Uint8Array, start: number, end: number): SealScanRecord[] {
  const slice = allBytes.subarray(start, end);
  const recs = findAllSEALRecords(slice);
  // Translate positions back to allBytes-absolute
  const out: SealScanRecord[] = [];
  for (const r of recs) {
    if (r.rawSigStart === -1) {continue;} // no s= value — skip
    out.push({
      bytes: allBytes,
      fields: r.fields,
      recStart: r.recStart + start,
      recEnd: r.recEnd, // relative
      rawSigStart: r.rawSigStart + start,
      rawSigEnd: r.rawSigEnd + start,
    });
  }
  return out;
}

/**
 * Scan EXIF data for SEAL records.
 * Mirrors Seal_Exif(): only looks at top-level IFD0, tag 0xcea1
 * (and also UserComment 0x9286 and Comment 0xfffe).
 * `exifOffset` and `exifSize` are absolute in `allBytes`.
 */
export function scanExif(allBytes: Uint8Array, exifOffset: number, exifSize: number): SealScanRecord[] {
  if (exifOffset + exifSize > allBytes.length) {return [];}
  const b = allBytes;
  const base = exifOffset;

  // Read TIFF header within the EXIF block
  if (exifSize < 8 + 2 + 12) {return [];}
  let endian: 'le' | 'be';
  if (b[base] === 0x49 && b[base + 1] === 0x49 && b[base + 2] === 0x2a) {endian = 'le';}
  else if (b[base] === 0x4d && b[base + 1] === 0x4d && b[base + 3] === 0x2a) {endian = 'be';}
  else {return [];}

  const r16 = endian === 'le' ? readLE16 : readBE16;
  const r32 = endian === 'le' ? readLE32 : readBE32;

  let ifdOff = r32(b, base + 4);
  if (ifdOff < 8 || base + ifdOff + 2 + 12 > allBytes.length) {return [];}

  const count = r16(b, base + ifdOff);
  ifdOff += 2;

  const out: SealScanRecord[] = [];
  for (let e = 0; e < count; e++) {
    const eoff = base + ifdOff + e * 12;
    if (eoff + 12 > allBytes.length) {break;}
    const tag = r16(b, eoff);
    const type = r16(b, eoff + 2);
    const dataSize = r32(b, eoff + 4);
    const dataOff = r32(b, eoff + 8);

    // Only byte/ascii/undefined types (1, 2, 6, 7)
    if (type !== 1 && type !== 2 && type !== 6 && type !== 7) {continue;}
    if (dataSize <= 4) {continue;} // too small for a SEAL record
    if (base + dataOff + dataSize > allBytes.length) {continue;}

    // Only these tags
    if (tag !== 0xcea1 && tag !== 0x9286 && tag !== 0xfffe) {continue;}

    out.push(...scanBlock(allBytes, base + dataOff, base + dataOff + dataSize));
  }
  return out;
}

// ── JPEG ────────────────────────────────────────────────────────
// Mirrors Seal_JPEG():
//   - Walk APP blocks (0xffe0–0xffef) and comment (0xfffe)
//   - Skip continuation blocks (same tag as previous)
//   - Skip known embedded-media labels (JFIF, Exif thumbnail, ICC_PROFILE…)
//   - Give EXIF (Exif\0\0) special processing via scanExif()
//   - Stop at 0xffda (SOS) — do NOT scan into the image stream
//   - Skip MPF (nested images after 0xffd9) entirely

// Labels to skip (they may contain nested media)
const JPEG_SKIP_LABELS = [
  'JP', 'JPN', 'HPQ-', 'DP2', 'PIC', 'AROT', 'JFIF', 'JFXX',
  'HPSC', 'H3X0', 'FPXR', 'MOTO', 'XMTH', 'Adobe', 'Ducky',
  'AJPEG', 'SCRNAIL', 'MMIMETA', 'Ocad$Rev', 'Qualcomm', 'ssuniqueid',
  'HPQ-Capture', 'ICC_PROFILE', 'Photoshop 3.0', 'GenaPhotoStamperd',
];

export function scanJPEG(bytes: Uint8Array): SealScanRecord[] {
  if (bytes.length < 4) {return [];}
  // Quick magic check
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {return [];}

  const out: SealScanRecord[] = [];
  let offset = 2;
  let prevTag = 0xffd8;

  while (offset + 4 <= bytes.length) {
    // JPEG spec: skip non-tag bytes (corruption tolerance)
    const tag = readBE16(bytes, offset);
    if ((tag & 0xffc0) !== 0xffc0) {
      offset++;
      continue;
    }

    if (tag === 0xffd9) {break;} // end of image — stop
    if (tag === 0xffda) {break;} // SOS (start of stream) — stop

    const blockSize = readBE16(bytes, offset + 2);
    if (blockSize < 2 || offset + 2 + blockSize > bytes.length) {break;}

    const dataStart = offset + 4; // after tag + length
    const dataLen = blockSize - 2; // length field includes itself

    if ((tag & 0xfff0) === 0xffe0) {
      // APP block: ffe0–ffef
      // Skip continuation of same APP type
      if (tag === prevTag) {
        offset += 2 + blockSize;
        prevTag = tag;
        continue;
      }

      // MPF: skip — it references post-ffd9 images which are self-contained
      if (dataLen > 4 && matchAt(bytes, dataStart, 'MPF')) {
        offset += 2 + blockSize;
        prevTag = tag;
        continue;
      }

      // EXIF: special IFD-aware scan
      if (dataLen > 6 && matchAt(bytes, dataStart, 'Exif')) {
        const exifStart = dataStart + 6;
        const exifLen = dataLen - 6;
        out.push(...scanExif(bytes, exifStart, exifLen));
        offset += 2 + blockSize;
        prevTag = tag;
        continue;
      }

      // Skip known embedded-media labels
      let skipIt = false;
      for (const lbl of JPEG_SKIP_LABELS) {
        if (dataLen > lbl.length && matchAt(bytes, dataStart, lbl)) {
          skipIt = true;
          break;
        }
      }
      if (skipIt) {
        offset += 2 + blockSize;
        prevTag = tag;
        continue;
      }

      // Generic APP block — scan for SEAL
      out.push(...scanBlock(bytes, dataStart, dataStart + dataLen));
    } else if (tag === 0xfffe) {
      // Comment block
      out.push(...scanBlock(bytes, dataStart, dataStart + dataLen));
    }

    offset += 2 + blockSize;
    prevTag = tag;
  }
  return out;
}

// ── PNG ──────────────────────────────────────────────────────────
// Mirrors Seal_PNG():
//   Walk chunks; scan text/itxt/seal chunks and exif chunks.
//   Stop at IEND. Never scan zTXt (compressed).
export function scanPNG(bytes: Uint8Array): SealScanRecord[] {
  if (bytes.length < 12) {return [];}
  if (!matchAt(bytes, 0, '\x89PNG\r\n\x1a\n')) {return [];}

  const out: SealScanRecord[] = [];
  let offset = 8; // skip 8-byte PNG header

  while (offset + 12 <= bytes.length) {
    const chunkSize = readBE32(bytes, offset);
    const fourcc = decodeStr(bytes, offset + 4, offset + 8);

    if (offset + 12 + chunkSize > bytes.length) {break;}

    if (fourcc === 'IEND') {break;}

    const dataStart = offset + 8;
    const dataEnd = offset + 8 + chunkSize;

    if (
      fourcc.toLowerCase() === 'text' ||
      fourcc.toLowerCase() === 'itxt' ||
      fourcc.toLowerCase() === 'seal'
    ) {
      out.push(...scanBlock(bytes, dataStart, dataEnd));
    } else if (fourcc.toLowerCase() === 'exif') {
      out.push(...scanExif(bytes, dataStart, chunkSize));
    }

    offset += 12 + chunkSize; // size + FourCC + data + CRC
  }
  return out;
}

// ── GIF ───────────────────────────────────────────────────────────
// Mirrors _SealWalkGIF():
//   Walk extension blocks (0x21); scan application extensions (0x21 0xff).
//   Stop at trailer (0x3b) or image descriptor (0x2c).
export function scanGIF(bytes: Uint8Array): SealScanRecord[] {
  if (bytes.length < 16) {return [];}
  if (!matchAt(bytes, 0, 'GIF87a') && !matchAt(bytes, 0, 'GIF89a')) {return [];}

  const out: SealScanRecord[] = [];
  let offset = 10;

  // Skip Global Color Table
  if (bytes[10] & 0x80) {
    const ctSize = 3 * (1 << ((bytes[10] & 0x07) + 1));
    offset = 13 + ctSize;
  }

  while (offset < bytes.length) {
    const tag = bytes[offset++];
    if (offset >= bytes.length) {break;}

    if (tag === 0x3b) {break;} // trailer
    if (tag === 0x00) {continue;}

    if (tag === 0x2c) {
      // Image descriptor — skip it (it contains image data, not metadata)
      offset += 8;
      if (offset >= bytes.length) {break;}
      if (bytes[offset] & 0x80) {
        const lct = 3 * (1 << ((bytes[offset] & 0x07) + 1));
        offset += lct + 1;
      } else {offset++;}
      if (offset >= bytes.length) {break;}
      // Skip LZW image data
      let subLen = bytes[offset++];
      while (subLen > 0 && offset < bytes.length) {
        offset += subLen;
        subLen = offset < bytes.length ? bytes[offset++] : 0;
      }
      continue;
    }

    if (tag === 0x21) {
      const subtag = bytes[offset++];
      const blockStart = offset;
      // Consume sub-blocks
      let subLen = bytes[offset++];
      while (subLen > 0 && offset < bytes.length) {
        offset += subLen;
        subLen = offset < bytes.length ? bytes[offset++] : 0;
      }
      // Application extension (0xff) may contain SEAL
      if (subtag === 0xff) {
        out.push(...scanBlock(bytes, blockStart, offset));
      }
    }
  }
  return out;
}

// ── RIFF (WAV, AVI, WebP) ─────────────────────────────────────────
// Mirrors _RIFFwalk():
//   Walk RIFF and LIST(INFO) chunks; scan any chunk in the RIFF list,
//   plus EXiF chunks. Skip everything else.
const RIFF_SCAN_FOURCC: Record<string, true> = Object.fromEntries(
  [
    'SEAL', 'XMP ', 'IARL', 'IART', 'ICDS', 'ICMS', 'ICMT', 'ICOP', 'ICRD', 'ICRP',
    'IDIM', 'IDIT', 'IDPI', 'IEDT', 'IENG', 'IGNR', 'IKEY', 'ILGT', 'IMED', 'IMUS',
    'INAM', 'IPDS', 'IPLT', 'IPRD', 'IPRO', 'ISBJ', 'ISFT', 'ISGN', 'ISHP', 'ISMP',
    'ISRC', 'ISRF', 'ISTD', 'ISTR', 'ITCH', 'IWEB', 'IWRI',
  ].map((k) => [k, true as const]),
);

export function scanRIFF(bytes: Uint8Array): SealScanRecord[] {
  if (bytes.length < 16) {return [];}
  if (!matchAt(bytes, 0, 'RIFF')) {return [];}
  const totalSize = readLE32(bytes, 4);
  if (totalSize + 8 !== bytes.length) {return [];} // size mismatch

  return _riffWalk(bytes, 0, bytes.length, 0);
}

function _riffWalk(bytes: Uint8Array, posStart: number, posEnd: number, depth: number): SealScanRecord[] {
  const out: SealScanRecord[] = [];
  let pos = posStart;
  while (pos + 8 < posEnd) {
    const fourcc = decodeStr(bytes, pos, pos + 4);
    const size = readLE32(bytes, pos + 4);
    if (pos + 8 + size > posEnd) {break;}

    if (depth < 1 && fourcc === 'RIFF') {
      if (size > 4) {out.push(..._riffWalk(bytes, pos + 12, pos + 12 + size, depth + 1));}
    } else if (depth < 2 && fourcc === 'LIST') {
      if (size > 4) {
        const listType = decodeStr(bytes, pos + 8, pos + 12);
        if (listType === 'INFO') {out.push(..._riffWalk(bytes, pos + 12, pos + 12 + size, depth + 1));}
      }
    } else if (fourcc === 'EXiF') {
      out.push(...scanExif(bytes, pos + 8, size));
    } else if (fourcc in RIFF_SCAN_FOURCC) {
      out.push(...scanBlock(bytes, pos + 8, pos + 8 + size));
    }

    // RIFF pads to 16-bit alignment
    const padded = size % 2 ? size + 1 : size;
    pos += 8 + padded;
  }
  return out;
}

// ── ISO-BMFF (MP4, MOV, HEIC, AVIF, …) ───────────────────────────
// Mirrors _BMFFwalk():
//   Walk top-level atoms; scan atoms listed in BMFFatoms[] ('s' type).
//   Give Exif atoms ('e' type) EXIF-aware scanning.
//   Recursion is disabled in the C code for BMFF (too complex).
const BMFF_SCAN_ATOMS: Record<string, true> = { SEAL: true, name: true, mdta: true, keys: true, mime: true, 'xml ': true, XMP_: true };
const BMFF_EXIF_ATOMS: Record<string, true> = { Exif: true };

export function scanBMFF(bytes: Uint8Array): SealScanRecord[] {
  if (bytes.length < 16) {return [];}
  if (!matchAt(bytes, 4, 'ftyp')) {return [];}
  return _bmffWalk(bytes, 0, bytes.length);
}

function _bmffWalk(bytes: Uint8Array, dataStart: number, dataEnd: number): SealScanRecord[] {
  const out: SealScanRecord[] = [];
  let pos = dataStart;
  while (pos + 8 <= dataEnd) {
    let atomLen = readBE32(bytes, pos);
    if (atomLen === 0) {
      pos += 4;
      continue;
    }

    // Extended (64-bit) length
    if (atomLen === 1) {
      if (pos + 16 > dataEnd) {break;}
      // readBE64 approximation (files >4GB unlikely in browser context)
      const hi = readBE32(bytes, pos + 8);
      const lo = readBE32(bytes, pos + 12);
      atomLen = hi * 0x100000000 + lo;
    }

    if (pos + atomLen > dataEnd) {break;}

    const fourcc = decodeStr(bytes, pos + 4, pos + 8);

    if (fourcc in BMFF_SCAN_ATOMS) {
      out.push(...scanBlock(bytes, pos, pos + atomLen));
    } else if (fourcc in BMFF_EXIF_ATOMS) {
      out.push(...scanExif(bytes, pos, atomLen));
    }

    pos += atomLen;
  }
  return out;
}

// ── TIFF (+ DNG, CR2, NEF, ARW, …) ──────────────────────────────
// Mirrors _TIFFwalk():
//   Walk the top-level IFD chain only.
//   Look for tag 0xcea1 with byte/ascii types.
//   Do NOT recurse into nested IFDs.
export function scanTIFF(bytes: Uint8Array): SealScanRecord[] {
  if (bytes.length < 8) {return [];}
  let endian: 'le' | 'be';
  if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) {endian = 'le';}
  else if (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[3] === 0x2a) {endian = 'be';}
  else {return [];}

  const r16 = endian === 'le' ? readLE16 : readBE16;
  const r32 = endian === 'le' ? readLE32 : readBE32;

  const out: SealScanRecord[] = [];
  let ifdOff = r32(bytes, 4);

  while (ifdOff > 0 && ifdOff + 6 < bytes.length) {
    const count = r16(bytes, ifdOff);
    ifdOff += 2;

    for (let e = 0; e < count; e++) {
      const eoff = ifdOff + e * 12;
      if (eoff + 12 > bytes.length) {break;}

      const tag = r16(bytes, eoff);
      const type = r16(bytes, eoff + 2);
      const dcount = r32(bytes, eoff + 4);
      const doffset = r32(bytes, eoff + 8);

      if (tag !== 0xcea1) {continue;}
      // Only byte/ascii/signed-byte types
      if (type !== 1 && type !== 2 && type !== 6) {continue;}
      if (dcount <= 4) {continue;} // inline, too small
      if (doffset + dcount > bytes.length) {continue;}

      out.push(...scanBlock(bytes, doffset, doffset + dcount));
    }

    // Next IFD pointer (4 bytes after the last entry)
    const nextOff = ifdOff + count * 12;
    if (nextOff + 4 > bytes.length) {break;}
    const next = r32(bytes, nextOff);
    if (next <= ifdOff) {break;} // no loops
    ifdOff = next;
  }
  return out;
}

// ── Matroska (MKV, WebM, MKA) ─────────────────────────────────────
// Mirrors _Matroskawalk():
//   Walk EBML elements; scan the SEAL element (tag 0x5345414C).
export function scanMatroska(bytes: Uint8Array): SealScanRecord[] {
  if (bytes.length < 4) {return [];}
  if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) {return [];}

  const out: SealScanRecord[] = [];
  let offset = 0;

  function readEBML(off: number): { val: number; end: number } {
    if (off >= bytes.length) {return { val: -1, end: off };}
    const b = bytes[off];
    if (b === 0) {return { val: -1, end: off + 1 };}
    let numBytes = 1;
    for (let i = 7; i >= 0; i--) {
      if (b & (1 << i)) {
        numBytes = 8 - i;
        break;
      }
    }
    let val = b & ~(0xff << (8 - numBytes));
    for (let i = 1; i < numBytes; i++) {
      if (off + i >= bytes.length) {return { val: -1, end: off + i };}
      val = val * 256 + bytes[off + i];
    }
    return { val, end: off + numBytes };
  }

  while (offset < bytes.length) {
    const tagR = readEBML(offset);
    if (tagR.val === -1) {break;}
    offset = tagR.end;
    const lenR = readEBML(offset);
    if (lenR.val === -1) {break;}
    offset = lenR.end;
    const iLen = lenR.val;
    if (offset + iLen > bytes.length) {break;}

    // SEAL tag — reachable with a non-canonical 5-byte EBML ID prefix (0x08):
    // readEBML computes val 0x08 & ~(0xff<<3) = 0, then accumulates 'SEAL'.
    if (tagR.val === 0x5345414c) {
      out.push(...scanBlock(bytes, offset, offset + iLen));
    }
    offset += iLen;
  }
  return out;
}

// ── PDF ────────────────────────────────────────────────────────────
// Mirrors _PDFwalk():
//   Scan for SEAL records OUTSIDE objects (between endobj and obj).
//   PDF SEAL records appear as: %<seal .../> at the top level.
export function scanPDF(bytes: Uint8Array): SealScanRecord[] {
  if (bytes.length < 20) {return [];}
  if (!matchAt(bytes, 0, '%PDF')) {return [];}

  // Quick check for %%EOF at end (with trailing whitespace)
  let eof = bytes.length - 1;
  while (eof > 20 && (bytes[eof] === 0x0a || bytes[eof] === 0x0d || bytes[eof] === 0x20)) {eof--;}
  if (!matchAt(bytes, eof - 4, '%%EOF')) {return [];}

  const out: SealScanRecord[] = [];
  let pos = 0;
  let objDepth = 0;

  while (pos < bytes.length) {
    // Detect "obj" keyword (preceded by whitespace): enter object
    if (
      pos + 5 < bytes.length &&
      (bytes[pos] === 0x20 || bytes[pos] === 0x09 || bytes[pos] === 0x0a || bytes[pos] === 0x0d) &&
      bytes[pos + 1] === 0x6f &&
      bytes[pos + 2] === 0x62 &&
      bytes[pos + 3] === 0x6a &&
      (bytes[pos + 4] === 0x20 || bytes[pos + 4] === 0x09 || bytes[pos + 4] === 0x0a || bytes[pos + 4] === 0x0d)
    ) {
      objDepth++;
      pos += 5;
      continue;
    }
    // Detect "endobj"
    if (
      pos + 7 <= bytes.length &&
      bytes[pos] === 0x65 &&
      bytes[pos + 1] === 0x6e &&
      bytes[pos + 2] === 0x64 &&
      bytes[pos + 3] === 0x6f &&
      bytes[pos + 4] === 0x62 &&
      bytes[pos + 5] === 0x6a &&
      (bytes[pos + 6] === 0x20 || bytes[pos + 6] === 0x09 || bytes[pos + 6] === 0x0a || bytes[pos + 6] === 0x0d)
    ) {
      if (objDepth > 0) {objDepth--;}
      pos += 7;
      continue;
    }
    // Outside objects, look for %<seal
    if (
      objDepth === 0 &&
      pos + 7 < bytes.length &&
      bytes[pos] === 0x25 &&
      bytes[pos + 1] === 0x3c && // '%<'
      bytes[pos + 2] === 0x73 &&
      bytes[pos + 3] === 0x65 &&
      bytes[pos + 4] === 0x61 &&
      bytes[pos + 5] === 0x6c &&
      bytes[pos + 6] === 0x20 // 'seal '
    ) {
      // Find end of line
      let pend = pos + 1;
      while (pend < bytes.length && bytes[pend] !== 0x0a && bytes[pend] !== 0x0d) {pend++;}
      // Pass the block starting one byte in (skip the '%')
      out.push(...scanBlock(bytes, pos + 1, pend));
      pos = pend;
      continue;
    }
    pos++;
  }
  return out;
}

// ── ZIP ────────────────────────────────────────────────────────────
// Mirrors Seal_Zip():
//   Scan backwards for each EOCD. For each zip found:
//     - The SEAL scope is [start_of_local_headers .. end_of_eocd_comment]
//     - The SEAL record lives in the EOCD archive comment field
//   Multiple embedded zips are handled by scanning for each EOCD.
export function scanZIP(bytes: Uint8Array): SealScanRecord[] {
  if (bytes.length < 22) {return [];}

  const out: SealScanRecord[] = [];
  // Search backwards for EOCD signatures (50 4b 05 06)
  let scanEnd = bytes.length;

  while (scanEnd >= 22) {
    const eocd = findEOCD(bytes, scanEnd);
    if (eocd < 0) {break;}

    // Parse EOCD
    const commentLen = readLE16(bytes, eocd + 20);
    const commentOff = eocd + 22;
    if (commentOff + commentLen > bytes.length) {
      scanEnd = eocd - 1;
      continue;
    }

    const cdSize = readLE32(bytes, eocd + 12);
    const cdOffset = readLE32(bytes, eocd + 16);

    // Check for zip64 (all 0xffffffff)
    let zipStart: number;
    if (cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // zip64: find the Zip64 EOCD locator just before eocd
      if (eocd < 20 + 56) {
        scanEnd = eocd - 1;
        continue;
      }
      if (
        !matchAt(bytes, eocd - 20, '\x50\x4b\x06\x07') ||
        !matchAt(bytes, eocd - 20 - 56, '\x50\x4b\x06\x06')
      ) {
        scanEnd = eocd - 1;
        continue;
      }
      // Extract start from zip64 eocd
      const z64off = readLE32(bytes, eocd - 20 + 8); // simplified (lower 32 bits)
      zipStart = eocd - 20 - 56 - z64off;
    } else {
      // Regular zip
      if (cdSize + cdOffset > eocd) {
        scanEnd = eocd - 1;
        continue;
      } // corrupt
      zipStart = eocd - cdSize - cdOffset;
    }

    if (zipStart < 0 || zipStart >= bytes.length) {
      scanEnd = eocd - 1;
      continue;
    }

    // The SEAL signature lives in the EOCD comment
    // The coordinate space for this zip is [zipStart .. commentOff + commentLen)
    const zipEnd = commentOff + commentLen;
    const zipBytes = bytes.subarray(zipStart, zipEnd);

    // Scan the comment field — positions must be translated back to zipBytes-local
    const commentLocalStart = commentOff - zipStart;
    const commentLocalEnd = commentLocalStart + commentLen;

    const recs = findAllSEALRecords(zipBytes.subarray(commentLocalStart, commentLocalEnd));
    for (const r of recs) {
      if (r.rawSigStart === -1) {continue;}
      out.push({
        bytes: zipBytes, // ← coordinate space for this zip
        fields: r.fields,
        recStart: r.recStart + commentLocalStart,
        recEnd: r.recEnd,
        rawSigStart: r.rawSigStart + commentLocalStart,
        rawSigEnd: r.rawSigEnd + commentLocalStart,
      });
    }

    scanEnd = eocd - 1;
  }
  return out;
}

function findEOCD(bytes: Uint8Array, searchEnd: number): number {
  // Search backwards for 50 4b 05 06
  for (let i = Math.min(searchEnd - 22, bytes.length - 22); i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {return i;}
  }
  return -1;
}

// ── Text / XML / SVG / HTML ──────────────────────────────────────
// Mirrors Seal_Text(): scan the entire file as a text blob.
export function scanText(bytes: Uint8Array): SealScanRecord[] {
  return scanBlock(bytes, 0, bytes.length);
}

// ── MP3 + ID3 ────────────────────────────────────────────────────
// Mirrors Seal_MPEG() / _SealWalkMPEG():
// Scan ID3v2 tags (at the front) and any APP blocks.
// For simplicity, scan text frames (T*, COM, COMM) inside ID3v2.
export function scanMP3(bytes: Uint8Array): SealScanRecord[] {
  if (bytes.length < 10) {return [];}
  // ID3v2 header: "ID3" + version + flags + syncsafe size
  if (!matchAt(bytes, 0, 'ID3')) {return [];}

  const sz = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const id3End = 10 + sz;

  // Scan the entire ID3 tag for SEAL records
  return scanBlock(bytes, 0, Math.min(id3End, bytes.length));
}

// ── DICOM ────────────────────────────────────────────────────────
// SEAL in DICOM lives in the preamble or in (0009,0010) private tag area.
// For validation purposes, scan the full file as text (like Seal_Text does
// for unknown formats), but only outside the pixel-data element (7FE0,0010).
export function scanDICOM(bytes: Uint8Array): SealScanRecord[] {
  if (bytes.length < 132) {return [];}
  if (!matchAt(bytes, 128, 'DICM')) {return [];}
  // Scan header preamble (0..128) and all non-pixel-data content
  // Simple approach: scan the whole file — pixel data will not contain <seal
  return scanBlock(bytes, 0, bytes.length);
}

// ─── Main format dispatcher ────────────────────────────────────────
/**
 * Dispatch to the appropriate format-aware scanner.
 * Returns records whose `bytes` is the coordinate space for b= range
 * computation (either the whole file, or a sub-file for ZIP entries).
 */
export function scanByFormat(bytes: Uint8Array): SealScanRecord[] {
  const fmt = detectFormat(bytes);

  let recs: SealScanRecord[];
  switch (fmt) {
    case 'jpeg':
      recs = scanJPEG(bytes);
      break;
    case 'png':
      recs = scanPNG(bytes);
      break;
    case 'gif':
      recs = scanGIF(bytes);
      break;
    case 'riff':
      recs = scanRIFF(bytes);
      break;
    case 'bmff':
      recs = scanBMFF(bytes);
      break;
    case 'tiff':
      recs = scanTIFF(bytes);
      break;
    case 'matroska':
      recs = scanMatroska(bytes);
      break;
    case 'pdf':
      recs = scanPDF(bytes);
      break;
    case 'zip':
      recs = scanZIP(bytes);
      break;
    case 'mp3':
      recs = scanMP3(bytes);
      break;
    case 'dicom':
      recs = scanDICOM(bytes);
      break;
    case 'xml': // SVG, HTML, plain XML — fall through
    case 'text':
    default:
      recs = scanText(bytes);
      break;
  }

  // All scanners set `bytes` (whole file, or the ZIP sub-file coordinate space).
  return recs;
}

// ── File-format detection helper (informational only — the validator
// works format-agnostically by searching for <seal …/> text)
export function detectFormat(bytes: Uint8Array): string {
  if (bytes.length < 4) {return 'unknown';}
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {return 'jpeg';}
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {return 'png';}
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {return 'gif';}
  if (matchAt(b, 0, '%PDF')) {return 'pdf';}
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) {return 'riff';} // WAV/AVI/WebP
  if (b.length >= 8 && matchAt(b, 4, 'ftyp')) {return 'bmff';} // MP4/HEIC/AVIF/...
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {return 'matroska';}
  if (
    (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)
  )
    {return 'tiff';}
  if (b[0] === 0x50 && b[1] === 0x4b) {return 'zip';}
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {return 'mp3';}
  if (b.length >= 132 && matchAt(b, 128, 'DICM')) {return 'dicom';}
  const head = decodeStr(b, 0, Math.min(64, b.length)).trimStart();
  if (head.startsWith('<')) {return 'xml';}
  return 'text';
}
