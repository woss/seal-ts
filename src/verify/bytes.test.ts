/**
 * Unit tests for the byte-level verify helpers.
 */
import { describe, expect, it } from 'vitest';

import {
  b64decode,
  decodeStr,
  enc,
  findSeq,
  hexdecode,
  matchAt,
  readBE16,
  readBE32,
  readLE16,
  readLE32,
  strDecode,
  u8,
  xmlDecode,
} from './bytes.js';

describe('u8', () => {
  it('passes through typed arrays', () => {
    const a = new Uint8Array([1]);
    expect(u8(a)).toBe(a);
  });
  it('wraps ArrayBuffers', () => {
    const b = new ArrayBuffer(3);
    expect(u8(b).length).toBe(3);
  });
});

describe('decodeStr', () => {
  it('decodes a sub-range', () => {
    expect(decodeStr(enc.encode('hello world'), 6, 11)).toBe('world');
  });
});

describe('findSeq', () => {
  it('finds a needle', () => {
    expect(findSeq(enc.encode('hello world'), enc.encode('wor'))).toBe(6);
  });
  it('misses cleanly', () => {
    expect(findSeq(enc.encode('hello'), enc.encode('xyz'))).toBe(-1);
  });
  it('continues past partial matches', () => {
    // 'wo' matches the needle prefix, then fails on 'x' — the outer loop resumes.
    expect(findSeq(enc.encode('wo wox'), enc.encode('wox'))).toBe(3);
  });
});

describe('matchAt', () => {
  it('matches at offset', () => {
    expect(matchAt(enc.encode('%PDF-1.4'), 0, '%PDF')).toBe(true);
  });
  it('fails past the end', () => {
    expect(matchAt(enc.encode('abc'), 1, 'bcd')).toBe(false);
  });
  it('fails on mismatch', () => {
    expect(matchAt(enc.encode('abd'), 0, 'abc')).toBe(false);
  });
});

describe('readers', () => {
  it('reads big-endian 16/32', () => {
    expect(readBE16(new Uint8Array([0x01, 0x02]), 0)).toBe(0x0102);
    expect(readBE32(new Uint8Array([0x01, 0x02, 0x03, 0x04]), 0)).toBe(0x01020304);
  });
  it('reads little-endian 16/32', () => {
    expect(readLE16(new Uint8Array([0x01, 0x02]), 0)).toBe(0x0201);
    expect(readLE32(new Uint8Array([0x01, 0x02, 0x03, 0x04]), 0)).toBe(0x04030201);
  });
});

describe('b64decode', () => {
  it('decodes standard base64', () => {
    expect(Array.from(b64decode('aGVsbG8='))).toEqual([104, 101, 108, 108, 111]);
  });
  it('accepts URL-safe variants', () => {
    expect(b64decode('aGVs-G8_').length).toBe(6);
  });
  it('strips whitespace', () => {
    expect(b64decode('aGVs\nbG8=')).toEqual(b64decode('aGVsbG8='));
  });
  it('rejects invalid characters', () => {
    expect(() => b64decode('a$b')).toThrow(/Invalid base64/);
  });
  it('rejects bad padding', () => {
    expect(() => b64decode('a=')).toThrow();
  });
});

describe('hexdecode', () => {
  it('decodes hex', () => {
    expect(Array.from(hexdecode('48656c6c6f')!)).toEqual([72, 101, 108, 108, 111]);
  });
  it('returns null on odd length', () => {
    expect(hexdecode('486')).toBeNull();
  });
  it('returns null on non-hex', () => {
    expect(hexdecode('zz')).toBeNull();
  });
});

describe('xmlDecode', () => {
  it('decodes numeric and hex entities', () => {
    expect(xmlDecode('&#x41;&#65;')).toBe('AA');
  });
  it('decodes named entities', () => {
    expect(xmlDecode('&lt;&gt;&quot;&apos;&amp;')).toBe('<>"\'&');
  });
  it('leaves unknown input alone', () => {
    expect(xmlDecode('plain')).toBe('plain');
  });
});

describe('strDecode', () => {
  it('unescapes backslashes', () => {
    expect(strDecode('a\\qb')).toBe('aqb');
  });
});

describe('xmlDecode — character references', () => {
  it('decodes hex and decimal numeric references', () => {
    expect(xmlDecode('&#x263A;')).toBe('☺');
    expect(xmlDecode('&#9731;')).toBe('☃');
  });
});
