/**
 * SEAL signer — builds `<seal ... />` records and embeds them in JPEG
 * (APP8 segment with the spec's "SEAL\0" label), PNG (seAl chunk), or
 * appends to text formats, producing files the vendored validator
 * authenticates byte-exactly.
 */
// Side-effect import: registers the vendored validator on globalThis.
import '../seal.js';

import { sha256, signPreImage } from './crypto.js';
import { type SealKeyAlg, toB64 } from './keyutil.js';

interface SealApi {
  detectFormat(bytes: Uint8Array): string;
  _computeByteRanges(
    bSpec: string,
    fileLen: number,
    sigStart: number,
    sigEnd: number,
    prevStart: number,
    prevEnd: number,
  ): { ranges: Array<[number, number]>; error: string | null };
}

// Vendored validator registers itself on globalThis (browser-script heritage).
// The side-effect import of '../seal.js' has run synchronously before any
// call into this module, so SEAL is always present at the call sites below.
const sealGlobal = globalThis as unknown as { SEAL?: SealApi };
const SEAL = sealGlobal.SEAL as SealApi;

export interface SealSignOptions {
  /** Domain whose DNS TXT record publishes the public key (d=). */
  domain: string;
  /** Imported signing key (from importPrivateKey / generateSealKeyPair). */
  key: CryptoKey;
  /** Key algorithm — must match the DNS record's ka=. Default: rsa. */
  alg?: SealKeyAlg;
  /** Optional signer identity (id=) — included in the double digest. */
  id?: string;
  /** 14-digit UTC timestamp. Default: now. */
  timestamp?: string;
  /** Signature value encoding (sf=). Default: base64. */
  sigFormat?: 'base64' | 'hex';
}

export interface SealSignature {
  /** The plain `<seal ... />` record string. */
  record: string;
  /** Container bytes with the record embedded (base64 signature included). */
  embedded: Uint8Array;
  /** Where the record landed: 'jpeg' (COM), 'png' (sEAl chunk), 'text' (append). */
  format: 'jpeg' | 'png' | 'text';
}

const encoder = new TextEncoder();

function utcTimestamp(now: Date): string {
  return now.toISOString().slice(0, 19).replaceAll(/[-:T]/g, '');
}

function xmlEscape(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function buildRecord(
  domain: string,
  ka: SealKeyAlg,
  id: string | undefined,
  ts: string,
  sigB64: string,
  spec: string,
  sf: string,
): string {
  const attrs =
    `<seal seal="1" d="${xmlEscape(domain)}" ka="${ka}" da="sha256" sf="${sf}"` +
    (id !== undefined ? ` id="${xmlEscape(id)}" uid="${xmlEscape(id)}"` : '') +
    ` b="${spec}" s="`;
  return attrs + ts + ':' + sigB64 + '" />';
}

interface EmbedResult {
  bytes: Uint8Array;
  recOffset: number;
}

function embedJPEG(bytes: Uint8Array, record: string): EmbedResult {
  // detectFormat already gated this call on exact SOI magic — no re-check.
  // Spec v1.2.12: APP8 segment carrying the "SEAL\0" label, not a COM segment.
  const payload = encoder.encode(record);
  const label = encoder.encode('SEAL\0');
  if (payload.length + label.length + 2 > 65533) {
    throw new Error(
      `SEAL record too large for JPEG APP8 segment: ${payload.length + label.length + 2} bytes`,
    );
  }
  const segLen = 2 + label.length + payload.length;
  const seg = new Uint8Array(4 + label.length + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xe8; // APP8
  seg[2] = segLen >> 8;
  seg[3] = segLen & 0xff;
  seg.set(label, 4);
  seg.set(payload, 4 + label.length);
  const out = new Uint8Array(bytes.length + seg.length);
  out.set(bytes.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(bytes.subarray(2), 2 + seg.length);
  return { bytes: out, recOffset: 6 + label.length };
}

// Reuse of a single table across calls; computed once on first use.
let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function embedPNG(bytes: Uint8Array, record: string): EmbedResult {
  // detectFormat already gated this call on exact PNG magic — no re-check.
  const payload = encoder.encode(record);
  const type = encoder.encode('seAl');
  const chunk = new Uint8Array(12 + payload.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, payload.length);
  chunk.set(type, 4);
  chunk.set(payload, 8);
  dv.setUint32(8 + payload.length, crc32(new Uint8Array([...type, ...payload])));

  // Insert after the first chunk (IHDR): it starts at 8, its length is at 8.
  if (bytes.length < 16) {
    throw new Error('PNG too small: no IHDR chunk');
  }
  const ihdrLen = new DataView(bytes.buffer, bytes.byteOffset + 8).getUint32(0);
  const insertAt = 8 + 12 + ihdrLen;
  if (insertAt + 8 > bytes.length) {
    throw new Error('PNG truncated before IHDR chunk end');
  }
  const out = new Uint8Array(bytes.length + chunk.length);
  out.set(bytes.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(bytes.subarray(insertAt), insertAt + chunk.length);
  return { bytes: out, recOffset: insertAt + 8 };
}

function embedText(bytes: Uint8Array, record: string): EmbedResult {
  const rec = encoder.encode(record);
  const needsNl = bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a;
  const sep = encoder.encode(needsNl ? '\n' : '');
  const out = new Uint8Array(bytes.length + sep.length + rec.length + 1);
  out.set(bytes, 0);
  out.set(sep, bytes.length);
  out.set(rec, bytes.length + sep.length);
  out[out.length - 1] = 0x0a;
  return { bytes: out, recOffset: bytes.length + sep.length };
}

/**
 * Sign a container and embed the SEAL record.
 *
 * Two-pass: the signature is computed over the final file geometry with the
 * signature value itself excluded (b="F~S,s~f"), so a placeholder record is
 * embedded first, digested, then re-embedded with the real signature.
 */
export async function sealSign(container: Uint8Array, opts: SealSignOptions): Promise<SealSignature> {
  const alg = opts.alg ?? 'rsa';
  const ts = opts.timestamp ?? utcTimestamp(new Date());
  const sf = `date:${opts.sigFormat ?? 'base64'}`;
  if (!/^\d{14}$/.test(ts)) {
    throw new Error(`timestamp must be 14 digits (YYYYMMDDhhmmss), got: ${ts}`);
  }
  // Spec uid= rules: no whitespace or quotes; an empty id would also break the
  // double digest (we would hash "ts:id:" while the validator's `f.id || null`
  // treats it as absent).
  if (opts.id !== undefined && (opts.id === '' || /[\s"']/.test(opts.id))) {
    throw new Error(
      `id must be non-empty with no whitespace or quotes (uid= rules), got: ${JSON.stringify(opts.id)}`,
    );
  }

  const format = SEAL.detectFormat(container);
  let embed: (bytes: Uint8Array, record: string) => EmbedResult;
  let formatName: SealSignature['format'];
  if (format === 'jpeg') {
    embed = embedJPEG;
    formatName = 'jpeg';
  } else if (format === 'png') {
    embed = embedPNG;
    formatName = 'png';
  } else {
    embed = embedText;
    formatName = 'text';
  }

  // Probe embed to learn where the record lands (depends on container
  // framing only, not on the record text). The digest b= spec is anchored to
  // it because binary containers have length/CRC framing around the record
  // that must stay OUT of the signed ranges: those bytes change between the
  // placeholder pass and the final embed (JPEG COM length, PNG chunk length
  // and chunk CRC), which would make the digest unverifiable.
  const placeholder = 'AAAA';
  const probe = embed(container, buildRecord(opts.domain, alg, opts.id, ts, placeholder, 'F~S,s~f', sf));
  const recStart = probe.recOffset;
  const spec =
    formatName === 'text'
      ? 'F~S,s~f'
      : formatName === 'jpeg'
        ? `${recStart}~S,s~f`
        : `${recStart}~S,s~s+4,s+8~f`; // also skip the 4 CRC bytes after the record

  const first = embed(container, buildRecord(opts.domain, alg, opts.id, ts, placeholder, spec, sf));
  // The validator's rawSigStart/rawSigEnd span the ENTIRE s= value including
  // the timestamp prefix (decodeSig strips it later), so the spec's S/s
  // anchors resolve to the value start/end.
  const headLen = buildRecord(opts.domain, alg, opts.id, ts, '', spec, sf).lastIndexOf('s="') + 3;
  const sigStart = recStart + headLen;
  const sigEnd = sigStart + ts.length + 1 + placeholder.length;

  const r1 = SEAL._computeByteRanges(spec, first.bytes.length, sigStart, sigEnd, 0, 0);
  // Spec is built from validated offsets (recStart ≤ sigStart < sigEnd ≤ file
  // length, only legal grammar chars) — computeByteRanges can never reject it.
  const ranges = r1.ranges as Array<[number, number]>;
  let totalLen = 0;
  for (const [s, e] of ranges) {
    totalLen += e - s;
  }
  const preimageBytes = new Uint8Array(totalLen);
  let off = 0;
  for (const [s, e] of ranges) {
    preimageBytes.set(first.bytes.subarray(s, e), off);
    off += e - s;
  }
  const digest = await sha256(preimageBytes);

  // Double digest (mirrors SealDoubleDigest): ts ":" [id ":"] primaryDigest
  const head = encoder.encode(ts + ':');
  const mid = opts.id !== undefined ? encoder.encode(opts.id + ':') : new Uint8Array(0);
  const doubleInput = new Uint8Array(head.length + mid.length + digest.length);
  doubleInput.set(head, 0);
  doubleInput.set(mid, head.length);
  doubleInput.set(digest, head.length + mid.length);
  const signature = await signPreImage(opts.key, alg, doubleInput);

  // Pass 2: real signature, same insertion point. Tail bytes between the
  // s= value and EOF are fixed text and windows are EOF-anchored, so a
  // different signature length than the placeholder's is safe.
  const sigValue = opts.sigFormat === 'hex' ? Buffer.from(signature).toString('hex') : toB64(signature);
  const record = buildRecord(opts.domain, alg, opts.id, ts, sigValue, spec, sf);
  const final = embed(container, record);
  return { record, embedded: final.bytes, format: formatName };
}
