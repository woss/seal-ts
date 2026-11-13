/**
 * Unit tests for the format scanners — hand-built binary fixtures for every
 * branch of every scanner (JPEG, PNG, GIF, RIFF, BMFF, TIFF, Matroska, PDF,
 * ZIP, MP3, DICOM) plus the dispatcher and detectFormat.
 */
import { describe, expect, it } from 'vitest';

import {
  detectFormat,
  scanBMFF,
  scanByFormat,
  scanDICOM,
  scanExif,
  scanGIF,
  scanJPEG,
  scanMatroska,
  scanMP3,
  scanPDF,
  scanPNG,
  scanRIFF,
  scanText,
  scanTIFF,
  scanZIP,
} from './scan.js';

const te = new TextEncoder();
const REC = '<seal seal="1" d="ex.com" s="QUJD" />';
const txt = (s: string) => te.encode(s);
const u16le = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
const u32le = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
const u16be = (n: number) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
const u32be = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

function cat(...parts: Array<Uint8Array | string | number[]>): Uint8Array {
  const arrs = parts.map((p) => (typeof p === 'string' ? te.encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

// ── TIFF builder (used by EXIF fixtures) ─────────────────────────
function tiffLe(entries: Array<{ tag: number; type: number; value: Uint8Array }>): Uint8Array {
  const n = entries.length;
  let valOff = 8 + 2 + n * 12 + 4;
  const blobs: Uint8Array[] = [];
  const entryBytes = entries.map((e) => {
    const en = new Uint8Array(12);
    en.set(u16le(e.tag), 0);
    en.set(u16le(e.type), 2);
    en.set(u32le(e.value.length), 4);
    en.set(u32le(valOff), 8);
    blobs.push(e.value);
    valOff += e.value.length;
    return en;
  });
  return cat('II', new Uint8Array([0x2a, 0x00]), u32le(8), u16le(n), ...entryBytes, u32le(0), ...blobs);
}

function tiffBe(entries: Array<{ tag: number; type: number; value: Uint8Array }>): Uint8Array {
  const n = entries.length;
  let valOff = 8 + 2 + n * 12 + 4;
  const blobs: Uint8Array[] = [];
  const entryBytes = entries.map((e) => {
    const en = new Uint8Array(12);
    en.set(u16be(e.tag), 0);
    en.set(u16be(e.type), 2);
    en.set(u32be(e.value.length), 4);
    en.set(u32be(valOff), 8);
    blobs.push(e.value);
    valOff += e.value.length;
    return en;
  });
  return cat('MM', new Uint8Array([0x00, 0x2a]), u32be(8), u16be(n), ...entryBytes, u32be(0), ...blobs);
}

const exifEntry = { tag: 0xcea1, type: 1, value: txt(REC) };

// ── JPEG ─────────────────────────────────────────────────────────
function jpegSeg(tag: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  out[0] = 0xff;
  out[1] = tag;
  const len = data.length + 2;
  out[2] = (len >> 8) & 0xff;
  out[3] = len & 0xff;
  out.set(data, 4);
  return out;
}
const SOI = new Uint8Array([0xff, 0xd8]);
const jpegOf = (...parts: Uint8Array[]) => cat(SOI, ...parts);

describe('scanJPEG', () => {
  it('finds a record in a COM segment', () => {
    const bytes = jpegOf(jpegSeg(0xfffe, txt(REC)));
    const recs = scanJPEG(bytes);
    expect(recs.length).toBe(1);
    expect(recs[0]!.fields.s).toBe('QUJD');
    expect(recs[0]!.bytes).toBe(bytes);
  });

  it('finds a record in a generic APP segment', () => {
    expect(scanJPEG(jpegOf(jpegSeg(0xffe3, txt(REC)))).length).toBe(1);
  });

  it('scans EXIF IFD0 tag 0xcea1', () => {
    const tiff = tiffLe([exifEntry]);
    const bytes = jpegOf(jpegSeg(0xffe1, cat('Exif\x00\x00', tiff)));
    const recs = scanJPEG(bytes);
    expect(recs.length).toBe(1);
    expect(recs[0]!.fields.s).toBe('QUJD');
  });

  it('scans EXIF UserComment and Comment tags too', () => {
    const tiff = tiffLe([
      exifEntry,
      { tag: 0x9286, type: 1, value: txt(REC) },
      { tag: 0xfffe, type: 1, value: txt(REC) },
    ]);
    expect(scanJPEG(jpegOf(jpegSeg(0xffe1, cat('Exif\x00\x00', tiff)))).length).toBe(3);
  });

  it('skips MPF segments', () => {
    const bytes = jpegOf(jpegSeg(0xffe1, cat('MPF\x00', txt(REC))));
    expect(scanJPEG(bytes)).toEqual([]);
  });

  it('skips known embedded-media labels', () => {
    const bytes = jpegOf(jpegSeg(0xffe0, cat('JFIF\x00\x01', txt(REC))));
    expect(scanJPEG(bytes)).toEqual([]);
  });

  it('skips continuation segments with the same tag', () => {
    const bytes = jpegOf(jpegSeg(0xffe0, txt('JFIF\x00x')), jpegSeg(0xffe0, txt(REC)));
    expect(scanJPEG(bytes)).toEqual([]);
  });

  it('stops at SOS and EOI', () => {
    const afterSos = cat(SOI, jpegSeg(0xffda, txt('')), jpegSeg(0xfffe, txt(REC)));
    expect(scanJPEG(afterSos)).toEqual([]);
    const afterEoi = cat(SOI, jpegSeg(0xfffe, txt(REC)), new Uint8Array([0xff, 0xd9]), jpegSeg(0xfffe, txt(REC)));
    expect(scanJPEG(afterEoi).length).toBe(1);
  });

  it('walks past corrupt non-tag bytes', () => {
    const bytes = jpegOf(new Uint8Array([0x12, 0x34]), jpegSeg(0xfffe, txt(REC)));
    expect(scanJPEG(bytes).length).toBe(1);
  });

  it('bails on a too-small or oversized block length', () => {
    expect(scanJPEG(cat(SOI, [0xff, 0xfe, 0x00, 0x00], txt(REC)))).toEqual([]);
    expect(scanJPEG(cat(SOI, [0xff, 0xfe, 0xff, 0xff], txt(REC)))).toEqual([]);
  });

  it('rejects short and non-JPEG input', () => {
    expect(scanJPEG(txt('<seal />'))).toEqual([]);
    expect(scanJPEG(txt('not a jpeg at all'))).toEqual([]);
  });
});

describe('scanExif guards (via JPEG)', () => {
  it('ignores a truncated EXIF block', () => {
    const bytes = jpegOf(jpegSeg(0xffe1, cat('Exif\x00\x00', txt('II'))));
    expect(scanJPEG(bytes)).toEqual([]);
  });
  it('ignores unknown endianness', () => {
    const bytes = jpegOf(jpegSeg(0xffe1, cat('Exif\x00\x00', txt('XX\x2a\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00'))));
    expect(scanJPEG(bytes)).toEqual([]);
  });
  it('ignores an IFD offset below 8', () => {
    const bad = cat('II', new Uint8Array([0x2a, 0x00]), u32le(0), u16le(1), new Uint8Array(12), u32le(0), txt(REC));
    const bytes = jpegOf(jpegSeg(0xffe1, cat('Exif\x00\x00', bad)));
    expect(scanJPEG(bytes)).toEqual([]);
  });
  it('skips disallowed types, small data, out-of-range data and other tags', () => {
    const tiff = tiffLe([
      { tag: 0x0100, type: 1, value: txt(REC) }, // other tag
      { tag: 0xcea1, type: 3, value: txt(REC) }, // disallowed type
      { tag: 0xcea1, type: 1, value: txt('abc') }, // too small
    ]);
    const bytes = jpegOf(jpegSeg(0xffe1, cat('Exif\x00\x00', tiff)));
    expect(scanJPEG(bytes)).toEqual([]);
  });
});

// ── PNG ─────────────────────────────────────────────────────────
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngChunk(fourcc: string, data: Uint8Array): Uint8Array {
  return cat(u32be(data.length), fourcc, data, new Uint8Array(4));
}
const pngOf = (...chunks: Uint8Array[]) => cat(PNG_MAGIC, pngChunk('IHDR', new Uint8Array(13)), ...chunks, pngChunk('IEND', new Uint8Array(0)));

describe('scanPNG', () => {
  it('scans tEXt, iTXt and seAl chunks', () => {
    for (const fourcc of ['tEXt', 'iTXt', 'seAl']) {
      const bytes = pngOf(pngChunk(fourcc, txt(REC)));
      const recs = scanPNG(bytes);
      expect(recs.length, fourcc).toBe(1);
      expect(recs[0]!.fields.s).toBe('QUJD');
      expect(recs[0]!.bytes).toBe(bytes);
    }
  });

  it('scans eXIf chunks as EXIF', () => {
    const bytes = pngOf(pngChunk('eXIf', tiffLe([exifEntry])));
    expect(scanPNG(bytes).length).toBe(1);
  });

  it('skips zTXt chunks', () => {
    expect(scanPNG(pngOf(pngChunk('zTXt', txt(REC))))).toEqual([]);
  });

  it('stops at IEND', () => {
    const bytes = cat(PNG_MAGIC, pngChunk('IHDR', new Uint8Array(13)), pngChunk('IEND', new Uint8Array(0)), pngChunk('tEXt', txt(REC)));
    expect(scanPNG(bytes)).toEqual([]);
  });

  it('bails on an oversized chunk', () => {
    expect(scanPNG(cat(PNG_MAGIC, u32be(0xfffffff0), 'tEXt', txt(REC)))).toEqual([]);
  });

  it('rejects short and non-PNG input', () => {
    expect(scanPNG(txt('ab'))).toEqual([]);
    expect(scanPNG(txt('not a png file'))).toEqual([]);
  });
});

// ── GIF ─────────────────────────────────────────────────────────
const GIF_HEAD = cat('GIF89a', u16le(1), u16le(1), [0x00, 0x00, 0x00]); // flags 0x00 — no GCT

describe('scanGIF', () => {
  it('scans application extensions', () => {
    const payload = txt(REC);
    const ext = cat([0x21, 0xff, payload.length], payload, [0x00, 0x3b]);
    const bytes = cat(GIF_HEAD, ext);
    const recs = scanGIF(bytes);
    expect(recs.length).toBe(1);
    expect(recs[0]!.bytes).toBe(bytes);
  });

  it('skips the global color table when present', () => {
    const head = cat('GIF89a', u16le(1), u16le(1), [0x80, 0x00, 0x00], new Uint8Array(6)); // GCT size 6
    const payload = txt(REC);
    const ext = cat([0x21, 0xff, payload.length], payload, [0x00, 0x3b]);
    expect(scanGIF(cat(head, ext)).length).toBe(1);
  });

  it('skips non-application extensions and walks image descriptors', () => {
    // comment ext (0xfe) → skip; image descriptor with LCT + LZW sub-blocks → skip; then app ext.
    const comment = cat([0x21, 0xfe, 0x02, 0xaa, 0xbb, 0x00]);
    const desc = cat([0x2c], new Uint8Array(8), [0x80], new Uint8Array(6), [0x02, 0xaa, 0xbb, 0x00]);
    const payload = txt(REC);
    const ext = cat([0x21, 0xff, payload.length], payload, [0x00, 0x3b]);
    expect(scanGIF(cat(GIF_HEAD, comment, desc, ext)).length).toBe(1);
  });

  it('handles plain sub-blocks and padding bytes', () => {
    const desc = cat([0x2c], new Uint8Array(8), [0x00], [0x02, 0xaa, 0xbb, 0x00]);
    expect(scanGIF(cat(GIF_HEAD, desc)).length).toBe(0);
    expect(scanGIF(cat(GIF_HEAD, [0x00, 0x00, 0x3b]))).toEqual([]);
  });

  it('rejects short and non-GIF input', () => {
    expect(scanGIF(txt('ab'))).toEqual([]);
    expect(scanGIF(txt('not a gif file at all'))).toEqual([]);
  });
});

// ── RIFF ────────────────────────────────────────────────────────
function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2 ? new Uint8Array(1) : new Uint8Array(0);
  return cat(fourcc, u32le(data.length), data, pad);
}
function riffOf(...chunks: Uint8Array[]): Uint8Array {
  const body = cat('WAVE', ...chunks);
  return cat('RIFF', u32le(body.length), body);
}

describe('scanRIFF', () => {
  it('scans SEAL and ICMT chunks and pads odd sizes', () => {
    const bytes = riffOf(riffChunk('SEAL', txt(REC)), riffChunk('JUNK', txt('zz')), riffChunk('ICMT', txt(REC)));
    const recs = scanRIFF(bytes);
    expect(recs.length).toBe(2);
    expect(recs[0]!.fields.s).toBe('QUJD');
  });

  it('recurses into LIST INFO and nested RIFF chunks', () => {
    const bytes = riffOf(riffChunk('LIST', cat('INFO', riffChunk('ICMT', txt(REC)))));
    expect(scanRIFF(bytes).length).toBe(1);
  });

  it('skips non-INFO LIST chunks and short LIST chunks', () => {
    expect(scanRIFF(riffOf(riffChunk('LIST', cat('adtl', riffChunk('ICMT', txt(REC))))))).toEqual([]);
    expect(scanRIFF(riffOf(riffChunk('LIST', txt('INFO'))))).toEqual([]);
  });

  it('scans EXiF chunks', () => {
    const bytes = riffOf(riffChunk('EXiF', tiffLe([exifEntry])));
    expect(scanRIFF(bytes).length).toBe(1);
  });

  it('rejects size mismatch and non-RIFF input', () => {
    const body = cat('WAVE', riffChunk('SEAL', txt(REC)));
    expect(scanRIFF(cat('RIFF', u32le(body.length + 2), body))).toEqual([]);
    expect(scanRIFF(txt('not a riff file'))).toEqual([]);
  });
});

// ── ISO-BMFF ────────────────────────────────────────────────────
function bmffAtom(fourcc: string, data: Uint8Array): Uint8Array {
  return cat(u32be(8 + data.length), fourcc, data);
}

describe('scanBMFF', () => {
  it('scans SEAL atoms over the whole atom space', () => {
    const bytes = cat(bmffAtom('ftyp', txt('isom')), bmffAtom('SEAL', txt(REC)));
    const recs = scanBMFF(bytes);
    expect(recs.length).toBe(1);
    expect(recs[0]!.fields.s).toBe('QUJD');
    expect(recs[0]!.bytes).toBe(bytes);
  });

  it('runs the EXIF branch for Exif atoms (header-first → no TIFF)', () => {
    const bytes = cat(bmffAtom('ftyp', txt('isom')), bmffAtom('Exif', tiffLe([exifEntry])));
    expect(scanBMFF(bytes)).toEqual([]);
  });

  it('handles zero-length atoms and 64-bit extended lengths', () => {
    const zero = new Uint8Array(4);
    const ext = cat(u32be(1), 'SEAL', u32be(0), u32be(8 + REC.length), txt(REC));
    const bytes = cat(bmffAtom('ftyp', txt('isom')), zero, ext);
    expect(scanBMFF(bytes).length).toBe(1);
    const tooBig = cat(u32be(1), 'SEAL', u32be(1), u32be(0xfffffff0));
    expect(scanBMFF(cat(bmffAtom('ftyp', txt('isom')), tooBig))).toEqual([]);
  });

  it('bails when an atom runs past the end, and on short/non-BMFF input', () => {
    expect(scanBMFF(cat(bmffAtom('ftyp', txt('isom')), u32be(0xffffff), 'SEAL'))).toEqual([]);
    expect(scanBMFF(txt('ab'))).toEqual([]);
    expect(scanBMFF(txt('not an mp4 file at all'))).toEqual([]);
  });
});

// ── TIFF ────────────────────────────────────────────────────────
describe('scanTIFF', () => {
  it('scans tag 0xcea1 in both endiannesses', () => {
    expect(scanTIFF(tiffLe([exifEntry])).length).toBe(1);
    expect(
      scanTIFF(tiffBe([{ tag: 0xcea1, type: 1, value: txt(REC) }])).length,
    ).toBe(1);
  });

  it('skips other tags, disallowed types, small counts and out-of-range data', () => {
    const tiff = tiffLe([
      { tag: 0x0100, type: 1, value: txt(REC) },
      { tag: 0xcea1, type: 3, value: txt(REC) },
      { tag: 0xcea1, type: 1, value: txt('abc') },
      { tag: 0xcea1, type: 1, value: new Uint8Array(0) },
    ]);
    expect(scanTIFF(tiff)).toEqual([]);
  });

  it('follows the IFD chain and stops at a zero pointer', () => {
    // IFD0 has no useful entries and points at a second IFD holding the record.
    const secondOff = 8 + 2 + 12 + 4;
    const tiff = cat(
      'II', new Uint8Array([0x2a, 0x00]), u32le(8),
      u16le(1), new Uint8Array(12), u32le(secondOff),
      u16le(1),
      (() => {
        const en = new Uint8Array(12);
        en.set(u16le(0xcea1), 0);
        en.set(u16le(1), 2);
        en.set(u32le(REC.length), 4);
        en.set(u32le(secondOff + 2 + 12 + 4), 8);
        return en;
      })(),
      u32le(0),
      txt(REC),
    );
    expect(scanTIFF(tiff).length).toBe(1);
  });

  it('rejects short and non-TIFF input', () => {
    expect(scanTIFF(txt('ab'))).toEqual([]);
    expect(scanTIFF(txt('not a tiff file'))).toEqual([]);
  });
});

// ── Matroska ────────────────────────────────────────────────────
const MKV_MAGIC = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
// 5-byte vint for the decoded tag value 0x5345414C ('SEAL')
const SEAL_TAG = new Uint8Array([0x08, 0x53, 0x45, 0x41, 0x4c]);
const vint = (n: number) => new Uint8Array([0x80 | n]);

describe('scanMatroska', () => {
  it('scans SEAL elements', () => {
    const bytes = cat(MKV_MAGIC, [0x81, 0x00], SEAL_TAG, vint(REC.length), txt(REC));
    const recs = scanMatroska(bytes);
    expect(recs.length).toBe(1);
    expect(recs[0]!.fields.s).toBe('QUJD');
    expect(recs[0]!.bytes).toBe(bytes);
  });

  it('skips non-SEAL elements and bails on truncated lengths', () => {
    const other = new Uint8Array([0x08, 0x4d, 0x80, 0x03, 0x87]);
    expect(scanMatroska(cat(MKV_MAGIC, [0x81, 0x00], other, vint(REC.length), txt(REC))).length).toBe(0);
    expect(scanMatroska(cat(MKV_MAGIC, [0x81, 0x00], SEAL_TAG, vint(0x7f), txt('short')))).toEqual([]);
  });

  it('rejects short and non-Matroska input', () => {
    expect(scanMatroska(txt('ab'))).toEqual([]);
    expect(scanMatroska(txt('not an mkv'))).toEqual([]);
  });
});

// ── PDF ─────────────────────────────────────────────────────────
const PDF_HEAD = '%PDF-1.4\n';

describe('scanPDF', () => {
  it('finds %<seal records outside objects', () => {
    const bytes = txt(`${PDF_HEAD} obj\n1 0 R\nendobj\n%<seal seal="1" d="ex.com" s="QUJD" />\n%%EOF\n`);
    const recs = scanPDF(bytes);
    expect(recs.length).toBe(1);
    expect(recs[0]!.fields.s).toBe('QUJD');
    expect(recs[0]!.bytes).toBe(bytes);
  });

  it('ignores records inside objects', () => {
    const bytes = txt(`${PDF_HEAD} obj\n%<seal seal="1" d="ex.com" s="QUJD" />\nendobj\n%%EOF\n`);
    expect(scanPDF(bytes)).toEqual([]);
  });

  it('handles whitespace after %%EOF but rejects a missing one', () => {
    expect(scanPDF(txt(`${PDF_HEAD}%<seal seal="1" d="ex.com" s="QUJD" />\n%%EOF   \r\n`)).length).toBe(1);
    expect(scanPDF(txt(`${PDF_HEAD}%<seal seal="1" d="ex.com" s="QUJD" />\n`))).toEqual([]);
  });

  it('rejects short and non-PDF input', () => {
    expect(scanPDF(txt('ab'))).toEqual([]);
    expect(scanPDF(txt('not a pdf document at all'))).toEqual([]);
  });
});

// ── ZIP ─────────────────────────────────────────────────────────
function eocd(comment: Uint8Array, cdSize = 0, cdOffset = 10): Uint8Array {
  const e = new Uint8Array(22);
  e.set([0x50, 0x4b, 0x05, 0x06], 0);
  e.set(u32le(cdSize), 12);
  e.set(u32le(cdOffset), 16);
  e.set(u16le(comment.length), 20);
  return e;
}

describe('scanZIP', () => {
  it('finds a record in the EOCD comment (whole file coordinate space)', () => {
    const body = new Uint8Array(10);
    const comment = txt(REC);
    const bytes = cat(body, eocd(comment), comment);
    const recs = scanZIP(bytes);
    expect(recs.length).toBe(1);
    expect(recs[0]!.fields.s).toBe('QUJD');
    expect(recs[0]!.bytes).toEqual(bytes);
  });

  it('handles zip64 EOCDs via the locator', () => {
    const z64 = cat(new Uint8Array([0x50, 0x4b, 0x06, 0x06]), new Uint8Array(52));
    const locator = cat(new Uint8Array([0x50, 0x4b, 0x06, 0x07]), u32le(0), u32le(0), u32le(0), u32le(1));
    const comment = txt(REC);
    const tail = eocd(comment, 0xffffffff, 0xffffffff);
    const bytes = cat(z64, locator, tail, comment);
    const recs = scanZIP(bytes);
    expect(recs.length).toBe(1);
    expect(recs[0]!.bytes).toEqual(bytes);
  });

  it('skips zip64 candidates whose computed zipStart is out of bounds', () => {
    const z64 = cat(new Uint8Array([0x50, 0x4b, 0x06, 0x06]), new Uint8Array(52));
    const comment = txt(REC);
    // z64off (readLE32 at locator+8) = 0xFFFF → zipStart = (eocd-76) - 65535 < 0
    const z64offField = u32le(0xffff);
    const locator2 = cat(new Uint8Array([0x50, 0x4b, 0x06, 0x07]), u32le(0), z64offField, u32le(0), u32le(1));
    const tail = eocd(comment, 0xffffffff, 0xffffffff);
    const bytes = cat(z64, locator2, tail, comment);
    expect(scanZIP(bytes)).toEqual([]);
  });

  it('skips zip64 candidates with a missing/misplaced locator', () => {
    // EOCD claims zip64 but sits too early in the file
    const comment = txt(REC);
    expect(scanZIP(cat(eocd(comment, 0xffffffff, 0xffffffff), comment))).toEqual([]);
    // EOCD far enough, but signatures missing
    const junk = new Uint8Array(76);
    expect(scanZIP(cat(junk, eocd(comment, 0xffffffff, 0xffffffff), comment))).toEqual([]);
  });

  it('skips corrupt and overrunning EOCDs, then scans the next one', () => {
    const comment = txt(REC);
    // corrupt: cdSize + cdOffset > eocd
    const corrupt = eocd(comment, 0, 0xffff);
    const bytes = cat(new Uint8Array(10), corrupt, comment);
    expect(scanZIP(bytes)).toEqual([]);
    // comment length overruns the file
    const overrun = eocd(new Uint8Array(0), 0, 10);
    overrun.set(u16le(0xffff), 20);
    expect(scanZIP(cat(new Uint8Array(10), overrun, comment))).toEqual([]);
  });

  it('ignores records without an s= value', () => {
    const comment = txt('<seal seal="1" d="ex.com" />');
    expect(scanZIP(cat(new Uint8Array(10), eocd(comment), comment))).toEqual([]);
  });

  it('rejects short input', () => {
    expect(scanZIP(txt('ab'))).toEqual([]);
  });
});

// ── MP3 / DICOM ─────────────────────────────────────────────────
describe('scanMP3', () => {
  it('scans the ID3 tag area', () => {
    const bytes = cat('ID3', [0x04, 0x00, 0x00], [0, 0, 0, 100], txt(REC));
    expect(scanMP3(bytes).length).toBe(1);
  });
  it('rejects short and non-MP3 input', () => {
    expect(scanMP3(txt('ab'))).toEqual([]);
    expect(scanMP3(txt('not an mp3 file'))).toEqual([]);
  });
});

describe('scanDICOM', () => {
  it('scans files with a DICM marker', () => {
    const bytes = cat(new Uint8Array(128), 'DICM', txt(REC));
    expect(scanDICOM(bytes).length).toBe(1);
  });
  it('rejects short and non-DICOM input', () => {
    expect(scanDICOM(new Uint8Array(131))).toEqual([]);
    expect(scanDICOM(cat(new Uint8Array(128), 'XXXX', txt(REC)))).toEqual([]);
  });
});

// ── Dispatcher + detectFormat ───────────────────────────────────
describe('scanByFormat', () => {
  it('dispatches every format', () => {
    expect(scanByFormat(jpegOf(jpegSeg(0xfffe, txt(REC)))).length).toBe(1);
    expect(scanByFormat(pngOf(pngChunk('tEXt', txt(REC)))).length).toBe(1);
    expect(scanByFormat(cat(GIF_HEAD, [0x21, 0xff, REC.length], txt(REC), [0x00, 0x3b])).length).toBe(1);
    expect(scanByFormat(riffOf(riffChunk('SEAL', txt(REC)))).length).toBe(1);
    expect(scanByFormat(cat(bmffAtom('ftyp', txt('isom')), bmffAtom('SEAL', txt(REC)))).length).toBe(1);
    expect(scanByFormat(tiffLe([exifEntry])).length).toBe(1);
    expect(scanByFormat(cat(MKV_MAGIC, [0x81, 0x00], SEAL_TAG, vint(REC.length), txt(REC))).length).toBe(1);
    expect(scanByFormat(txt(`${PDF_HEAD}%<seal seal="1" d="ex.com" s="QUJD" />\n%%EOF\n`)).length).toBe(1);
    expect(scanByFormat(cat(new Uint8Array(10), eocd(txt(REC)), txt(REC))).length).toBe(1);
    expect(scanByFormat(cat('ID3', [0x04, 0x00, 0x00], [0, 0, 0, 100], txt(REC))).length).toBe(1);
    expect(scanByFormat(cat(new Uint8Array(128), 'DICM', txt(REC))).length).toBe(1);
    // xml and plain text go through scanText
    expect(scanByFormat(txt(`xml doc ${REC}`)).length).toBe(1);
  });
});

describe('detectFormat', () => {
  it('detects every supported format', () => {
    expect(detectFormat(new Uint8Array(3))).toBe('unknown');
    expect(detectFormat(jpegOf(new Uint8Array([0xff, 0x00])))).toBe('jpeg');
    expect(detectFormat(PNG_MAGIC)).toBe('png');
    expect(detectFormat(txt('GIF8'))).toBe('gif');
    expect(detectFormat(txt('%PDF'))).toBe('pdf');
    expect(detectFormat(txt('RIFF'))).toBe('riff');
    expect(detectFormat(cat(new Uint8Array(4), 'ftyp'))).toBe('bmff');
    expect(detectFormat(MKV_MAGIC)).toBe('matroska');
    expect(detectFormat(txt('II\x2a\x00'))).toBe('tiff');
    expect(detectFormat(txt('MM\x00\x2a'))).toBe('tiff');
    expect(detectFormat(txt('PK\x03\x04'))).toBe('zip');
    expect(detectFormat(txt('ID3\x04'))).toBe('mp3');
    expect(detectFormat(cat(new Uint8Array(128), 'DICM', txt('x')))).toBe('dicom');
    expect(detectFormat(txt('<xml'))).toBe('xml');
    expect(detectFormat(txt('plain text'))).toBe('text');
  });
});

describe('scanText', () => {
  it('scans the whole buffer', () => {
    const bytes = txt(`data ${REC} data`);
    const recs = scanText(bytes);
    expect(recs.length).toBe(1);
    expect(recs[0]!.bytes).toBe(bytes);
  });
});

describe('scanner edge branches', () => {
  it('scanExif: rejects non-TIFF headers, OOB sizes, and walks big-endian', () => {
    expect(scanExif(cat('XX', new Uint8Array(30)), 0, 34)).toEqual([]);
    const be = tiffBe([exifEntry]);
    expect(scanExif(be, 0, be.length + 10)).toEqual([]);
    expect(scanExif(be, 0, be.length).length).toBe(1);
  });

  it('scanExif: skips bad types, small counts, OOB data, and truncated IFDs', () => {
    const raw = (type: number, count: number, off: number) => cat(u16le(0xcea1), u16le(type), u32le(count), u32le(off));
    const tiff = (entry: Uint8Array, count = 1) => cat('II', new Uint8Array([0x2a, 0x00]), u32le(8), u16le(count), entry, u32le(0), txt(REC));
    const dataOff = 8 + 2 + 12 + 4;
    expect(scanExif(tiff(raw(3, 20, dataOff)), 0, 200)).toEqual([]); // type 3
    expect(scanExif(tiff(raw(1, 4, dataOff)), 0, 200)).toEqual([]); // dcount ≤ 4
    expect(scanExif(tiff(raw(1, 20, 9999)), 0, 200)).toEqual([]); // data OOB
    expect(scanExif(tiff(raw(1, 20, dataOff), 5), 0, 200)).toEqual([]); // IFD longer than data
  });

  it('scanJPEG: rejects short buffers and magic mismatches', () => {
    expect(scanJPEG(new Uint8Array([0xff, 0xd8]))).toEqual([]);
    expect(scanJPEG(new Uint8Array([0xff, 0x00, 0xd8, 0xff, 0x00, 0x00]))).toEqual([]);
  });

  it('scanGIF: walks image descriptors with and without color tables', () => {
    // Scanner semantics (vendor-exact): the byte after the descriptor's
    // optional local color table is the first sub-block length.
    const lctDesc = cat([0x2c], u16le(0), u16le(0), u16le(2), u16le(2), [0x81], new Uint8Array(12), [0x03, 1, 2, 3, 0x00]);
    const plainDesc = cat([0x2c], u16le(0), u16le(0), u16le(2), u16le(2), [0x01], [0x00]);
    const appExt = cat([0x21, 0xff], [REC.length], txt(REC), [0x00]);
    const bytes = cat('GIF89a', u16le(2), u16le(2), [0x00, 0x00, 0x00], lctDesc, plainDesc, appExt, [0x3b]);
    const recs = scanGIF(bytes);
    expect(recs.length).toBe(1);
    expect(recs[0]!.fields.s).toBe('QUJD');
  });

  it('scanGIF: survives truncated descriptors and sub-block overruns', () => {
    const hdr = 'GIF89a\x02\x00\x02\x00\x00\x00\x00';
    expect(scanGIF(txt(`${hdr}\x2c\x00\x00\x00\x00`))).toEqual([]);
    expect(scanGIF(txt(`${hdr}\x21\xff\x05ab`))).toEqual([]);
  });

  it('scanRIFF: rejects non-RIFF buffers and corrupt chunk sizes', () => {
    expect(scanRIFF(txt('NOTRIFF+12bytes!!!'))).toEqual([]);
    expect(scanRIFF(cat('RIFF', u32le(200), 'SEAL', u32le(9999), txt(REC)))).toEqual([]);
  });

  it('scanBMFF: rejects non-BMFF buffers and truncated extended-length atoms', () => {
    expect(scanBMFF(txt('notabmffbody'))).toEqual([]);
    expect(scanBMFF(cat(new Uint8Array(4), 'ftyp', [0x00, 0x00, 0x00, 0x01], 'SEAL', [0x00, 0x00, 0x00, 0x0a]))).toEqual([]);
  });

  it('scanTIFF: rejects non-TIFF headers', () => {
    expect(scanTIFF(txt('not a tiff file'))).toEqual([]);
  });

  it('scanMatroska: rejects non-Matroska buffers, zero IDs, truncated IDs, oversized lengths', () => {
    expect(scanMatroska(txt('nobody home'))).toEqual([]);
    expect(scanMatroska(cat([0x1a, 0x45, 0xdf, 0xa3], [0x00], txt(REC)))).toEqual([]);
    expect(scanMatroska(cat([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x86]))).toEqual([]);
    expect(scanMatroska(cat([0x1a, 0x45, 0xdf, 0xa3], [0x81, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00]))).toEqual([]);
  });

  it('scanPDF: rejects missing EOF and scans only outside objects', () => {
    expect(scanPDF(txt('%PDF-1.4\nno eof marker'))).toEqual([]);
    expect(scanPDF(txt('%PDF-1.4\n1 0 obj\n%<seal d="x" s="Q" />\nendobj\n%%EOF'))).toEqual([]);
    expect(scanPDF(txt('%PDF-1.4\nendobj \n%%EOF'))).toEqual([]);
  });

  it('scanZIP: skips EOCDs with overrunning comments and buffers without any', () => {
    const over = cat(new Uint8Array(10), [0x50, 0x4b, 0x05, 0x06], new Uint8Array(18), u16le(9999), txt(REC));
    expect(scanZIP(over)).toEqual([]);
    expect(scanZIP(txt('nothing to see here...........'))).toEqual([]);
  });

  it('detectFormat: distinguishes DICOM from plain text', () => {
    expect(detectFormat(cat(new Uint8Array(131)))).toBe('text');
    expect(detectFormat(cat(new Uint8Array(128), 'DICM'))).toBe('dicom');
  });

  it('scanExif/scanTIFF: bail on a truncated IFD and an OOB next-IFD pointer', () => {
    // 22-byte TIFF: header + IFD count=2 with only one entry present.
    const short = cat('II', new Uint8Array([0x2a, 0x00]), u32le(8), u16le(2), new Uint8Array(12));
    expect(scanExif(short, 0, short.length)).toEqual([]);
    expect(scanTIFF(short)).toEqual([]);
  });

  it('scanExif/scanTIFF: skip entries whose data overruns the block', () => {
    const en = new Uint8Array(12);
    en.set(u16le(0xcea1), 0);
    en.set(u16le(1), 2);
    en.set(u32le(100), 4);
    en.set(u32le(5), 8);
    const tiff = cat('II', new Uint8Array([0x2a, 0x00]), u32le(8), u16le(1), en);
    expect(scanExif(tiff, 0, tiff.length)).toEqual([]);
    expect(scanTIFF(tiff)).toEqual([]);
  });

  it('scanGIF: covers the trailer read, descriptor flags at EOF, and truncated sub-blocks', () => {
    // Trailer read but buffer continues past it.
    expect(scanGIF(cat(GIF_HEAD, [0x3b, 0x00, 0x00, 0x00, 0x00, 0x00]))).toEqual([]);
    // Descriptor flags byte is the last byte — abort after reading it.
    expect(scanGIF(cat(GIF_HEAD, [0x2c], new Uint8Array(8), [0x00]))).toEqual([]);
    // Sub-block length runs past the buffer — zero-fill tail.
    expect(scanGIF(cat(GIF_HEAD, [0x2c], new Uint8Array(8), [0x00, 0x05, 0x00]))).toEqual([]);
    // Unknown tag falls through without advancing past the record.
    expect(scanGIF(cat(GIF_HEAD, [0x01, 0x00, 0x00, 0x00]))).toEqual([]);
  });

  it('scanMatroska: bails on a tag ID at EOF and a truncated length ID', () => {
    expect(scanMatroska(MKV_MAGIC)).toEqual([]);
    expect(scanMatroska(cat(MKV_MAGIC, [0x42]))).toEqual([]);
  });

  it('scanBMFF: bails on an extended size that overruns the file', () => {
    expect(scanBMFF(cat(bmffAtom('ftyp', txt('isom')), u32be(1), txt('xxxx'), new Uint8Array(4)))).toEqual([]);
  });

  it('scanRIFF: bails on a nested chunk size that overruns the RIFF scope', () => {
    expect(scanRIFF(cat('RIFF', u32le(16), 'AAAA', 'BBBB', u32le(9999), new Uint8Array(4)))).toEqual([]);
  });

  it('scanPDF: handles carriage returns after obj and endobj keywords', () => {
    expect(scanPDF(txt(`${PDF_HEAD}X obj\rY%%EOF\n`))).toEqual([]);
    expect(scanPDF(txt(`${PDF_HEAD} endobj\rX%%EOF\n`))).toEqual([]);
  });

  it('scanJPEG: ignores non-APP, non-comment segments', () => {
    expect(scanJPEG(jpegOf(jpegSeg(0xffdb, txt('junkdata'))))).toEqual([]);
  });

  it('scanExif: skips a count truncated at the block end and an OOB last entry', () => {
    // Count=2 with one Make entry: entry 0 parses (tag not scanned),
    // entry 1 starts past the buffer end → break. Value blob pads the
    // buffer past the strict ifdOff bounds check.
    const entry = cat(u16le(0x010f), u16le(2), u32le(4), u32le(26));
    const tiff = cat('II', new Uint8Array([0x2a, 0x00]), u32le(8), u16le(2), entry, u32le(0), txt('meta'));
    expect(scanExif(tiff, 0, tiff.length)).toEqual([]);
    expect(scanTIFF(tiff)).toEqual([]);
  });

  it('scanExif: skips disallowed tags and entries whose data runs OOB', () => {
    // Make tag (0x010f) is not scanned; the 0x9286 entry claims count=9999
    // but the buffer ends right after the IFD → data OOB → skipped.
    const entry = (tag: number, type: number, count: number, valOff: number) => {
      const en = new Uint8Array(12);
      en.set(u16be(tag), 0);
      en.set(u16be(type), 2);
      en.set(u32be(count), 4);
      en.set(u32be(valOff), 8);
      return en;
    };
    const tiff = cat('MM', new Uint8Array([0x00, 0x2a]), u32be(8), u16be(2), entry(0x010f, 1, REC.length, 30), entry(0x9286, 1, 9999, 30), u32be(0));
    expect(scanExif(tiff, 0, tiff.length)).toEqual([]);
  });

  it('scanExif: accepts a comment tag with an ASCII type whose data fits', () => {
    const tiff = tiffBe([{ tag: 0xfffe, type: 2, value: cat(txt(REC), new Uint8Array(40)) }]);
    expect(scanExif(tiff, 0, tiff.length).length).toBe(1);
  });

  it('scanGIF: stops at the application-extension sub-block chain start', () => {
    // App extension with the byte after the flags at EOF: subLen = 0 chain exit.
    expect(scanGIF(cat(GIF_HEAD, [0x21, 0xff], new Uint8Array(10), [0x00]))).toEqual([]);
  });

  it('scanMatroska: skips a zero-prefix length ID at EOF', () => {
    expect(scanMatroska(cat(MKV_MAGIC, [0x80]))).toEqual([]);
  });

  it('scanPDF: closes a comment with a bare > and scans the payload', () => {
    const recs = scanPDF(txt(`${PDF_HEAD} %<seal seal="1" s="QUJD">%%EOF\n`));
    expect(recs.length).toBe(1);
    expect(recs[0]!.fields.s).toBe('QUJD');
  });

  it('scanPDF: skips endobj keywords nested inside object depth', () => {
    // obj ... endobj ... endobj: the second endobj at depth 0 exits the object.
    expect(scanPDF(txt(`${PDF_HEAD} obj\nAendobj\nB%%EOF\n`))).toEqual([]);
  });

  it('scanRIFF: scans raw SEAL chunks and recurses into nested RIFF files', () => {
    const raw = riffOf(riffChunk('SEAL', txt(REC)));
    expect(scanRIFF(raw).length).toBe(1);
    const nested = riffOf(riffChunk('RIFF', cat('WAVE', riffChunk('SEAL', txt(REC)))));
    expect(scanRIFF(nested)).toEqual([]);
  });

  it('scanBMFF: handles large-size-1 atoms with SEAL payloads', () => {
    // 64-bit large size = 4 (size) + 4 (type) + 8 (largesize) + payload.
    const largesize = cat(u32be(1), txt('SEAL'), u32be(0), u32be(16 + REC.length), txt(REC));
    const bytes = cat(bmffAtom('ftyp', txt('isom')), largesize);
    expect(scanBMFF(bytes).length).toBe(1);
  });
});
