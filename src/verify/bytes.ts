/**
 * Byte-level utilities for the SEAL verifier: typed-array readers, sequence
 * search, base64/hex decoding, XML entity and backslash unescaping.
 *
 * Faithful TypeScript port of the reference validator's helpers
 * (mirrors the C `SealXmlDecode` / `SealStrDecode` helpers).
 */

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function u8(buf: ArrayBuffer | Uint8Array): Uint8Array {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

export function decodeStr(bytes: Uint8Array, start: number, end: number): string {
  return dec.decode(bytes.subarray(start, end));
}

/** Find `needle` in `hay` at or after `from`; -1 when absent. */
export function findSeq(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const n0 = needle[0];
  const nl = needle.length;
  outer: for (let i = from, lim = hay.length - nl; i <= lim; i++) {
    if (hay[i] !== n0) {continue;}
    for (let j = 1; j < nl; j++) {if (hay[i + j] !== needle[j]) {continue outer;}}
    return i;
  }
  return -1;
}

/** True when the ASCII string `str` starts at `offset` in `bytes`. */
export function matchAt(bytes: Uint8Array, offset: number, str: string): boolean {
  if (offset + str.length > bytes.length) {return false;}
  for (let i = 0; i < str.length; i++)
    {if (bytes[offset + i] !== str.charCodeAt(i)) {return false;}}
  return true;
}

export function readBE16(b: Uint8Array, o: number): number {
  return ((b[o] & 0xff) << 8) | (b[o + 1] & 0xff);
}
export function readBE32(b: Uint8Array, o: number): number {
  return (((b[o] & 0xff) * 0x1000000) + ((b[o + 1] & 0xff) << 16) + ((b[o + 2] & 0xff) << 8) + (b[o + 3] & 0xff)) >>> 0;
}
export function readLE16(b: Uint8Array, o: number): number {
  return ((b[o + 1] & 0xff) << 8) | (b[o] & 0xff);
}
export function readLE32(b: Uint8Array, o: number): number {
  return (((b[o + 3] & 0xff) * 0x1000000) + ((b[o + 2] & 0xff) << 16) + ((b[o + 1] & 0xff) << 8) + (b[o] & 0xff)) >>> 0;
}

/** Standard base64 decode (handles URL-safe variants too). */
export function b64decode(str: string): Uint8Array {
  const s = str.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  // Validate: only base64 chars + padding allowed
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {throw new Error('Invalid base64 characters');}
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {out[i] = raw.charCodeAt(i);}
  return out;
}

export function hexdecode(str: string): Uint8Array | null {
  const s = str.trim();
  if (s.length % 2 !== 0) {return null;}
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2) {
    const v = parseInt(s.substring(i, i + 2), 16);
    if (isNaN(v)) {return null;}
    out[i / 2] = v;
  }
  return out;
}

const XML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
};

export function xmlDecode(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;|&gt;|&quot;|&apos;|&amp;/g, (m) => XML_ENTITIES[m] || m);
}

/** Reverse backslash escaping (mirrors SealStrDecode). */
export function strDecode(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}
