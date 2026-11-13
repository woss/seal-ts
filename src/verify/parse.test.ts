/**
 * Unit tests for the SEAL record parser.
 */
import { describe, expect, it } from 'vitest';

import { enc } from './bytes.js';
import { findAllSEALRecords, parseSEALRecord } from './parse.js';

function rec(s: string, xmlMode = 0) {
  return parseSEALRecord(enc.encode(s), 0, xmlMode);
}

describe('parseSEALRecord', () => {
  it('parses a standard record', () => {
    const r = rec('<seal seal="1" d="example.com" p="abc" />');
    expect(r).not.toBeNull();
    expect(r!.fields.seal).toBe('1');
    expect(r!.fields.d).toBe('example.com');
    expect(r!.fields.p).toBe('abc');
    expect(r!.rawSigStart).toBe(-1);
  });

  it('tracks signature value offsets', () => {
    const r = rec('<seal seal="1" d="x" s="QUJD" />');
    expect(r).not.toBeNull();
    // '<seal seal="1" d="x" s="' is 24 bytes — value starts after the quote
    expect(r!.rawSigStart).toBe(24);
    expect(r!.rawSigEnd).toBe(28);
  });

  it('parses single-quoted values', () => {
    expect(rec("<seal seal='1' d='x' />")!.fields.d).toBe('x');
  });

  it('parses unquoted values', () => {
    expect(rec('<seal seal=1 d=x />')!.fields.d).toBe('x');
  });

  it('parses entity-encoded XMP records', () => {
    const r = rec('&lt;seal seal=&quot;1&quot; d=&quot;example.com&quot; s=&quot;QUJD&quot; /&gt;', 1);
    expect(r).not.toBeNull();
    expect(r!.fields.seal).toBe('1');
    expect(r!.fields.d).toBe('example.com');
    expect(r!.rawSigStart).not.toBe(-1);
  });

  it('parses XML processing-instruction records', () => {
    const r = rec('<?seal seal="1" d="example.com" s="QUJD" ?>', 2);
    expect(r).not.toBeNull();
    expect(r!.fields.d).toBe('example.com');
  });

  it('handles backslash escapes in values', () => {
    expect(rec('<seal seal="1" d="a\\qb" />')!.fields.d).toBe('aqb');
  });

  it('lets the last duplicate field win', () => {
    expect(rec('<seal seal="1" d="a" d="b" />')!.fields.d).toBe('b');
  });

  it('decodes XML entities inside entity-quoted values', () => {
    const r = rec('&lt;seal seal=&quot;1&quot; d=&quot;a&lt;b&quot; /&gt;', 1);
    expect(r!.fields.d).toBe('a<b');
  });

  it('returns null without a seal= field', () => {
    expect(rec('<foo bar="x" />')).toBeNull();
  });

  it('returns null on a non-alphanumeric field name', () => {
    expect(rec('<seal 1bad="x" />')).toBeNull();
  });

  it('returns null when a name is not followed by =', () => {
    expect(rec('<seal abcd />')).toBeNull();
  });

  it('parses a value that runs to the end of the buffer', () => {
    const r = rec('<seal seal="1');
    expect(r).not.toBeNull();
    expect(r!.fields.seal).toBe('1');
    expect(r!.rawSigStart).toBe(-1);
  });
});

describe('findAllSEALRecords', () => {
  it('finds multiple records with correct offsets', () => {
    const bytes = enc.encode('a <seal seal="1" s="QQ==" /> b <seal seal="1" s="Qg==" /> c');
    const recs = findAllSEALRecords(bytes);
    expect(recs.length).toBe(2);
    expect(recs[0]!.rawSigStart).toBe(20);
    expect(recs[1]!.rawSigStart).toBe(49);
  });

  it('finds entity-encoded records', () => {
    const bytes = enc.encode('x &lt;seal seal=&quot;1&quot; s=&quot;QQ==&quot; /&gt; y');
    const recs = findAllSEALRecords(bytes);
    expect(recs.length).toBe(1);
    expect(recs[0]!.fields.seal).toBe('1');
  });

  it('finds processing-instruction records case-insensitively', () => {
    const bytes = enc.encode('x <?SEAL seal="1" s="QQ==" ?> y');
    const recs = findAllSEALRecords(bytes);
    expect(recs.length).toBe(1);
  });

  it('finds records without an s= field and reports -1', () => {
    const bytes = enc.encode('x <seal seal="1" d="y" /> z');
    const recs = findAllSEALRecords(bytes);
    expect(recs.length).toBe(1);
    expect(recs[0]!.rawSigStart).toBe(-1);
  });

  it('advances past records that fail to parse', () => {
    expect(findAllSEALRecords(enc.encode('x <seal oops'))).toEqual([]);
  });
});

describe('parseSEALRecord — closer variants (vendor-exact)', () => {
  const rec = (s: string, xmlMode = 0) => parseSEALRecord(enc.encode(s), 0, xmlMode);

  it('accepts a bare > closer', () => {
    const r = rec('<seal seal="1" d="x" s="Q">');
    expect(r).not.toBeNull();
    expect(r!.fields.s).toBe('Q');
    expect(r!.fields.d).toBe('x');
  });

  it('accepts /> and /> without a space', () => {
    expect(rec('<seal seal="1" d="x" s="Q"/>')!.fields.s).toBe('Q');
    expect(rec('<seal seal="1" d="x" s="Q" />')!.fields.s).toBe('Q');
  });

  it('accepts ?> and stray > in PI mode', () => {
    expect(rec('<?seal seal="1" d="x" s="Q"?>', 2)!.fields.s).toBe('Q');
  });

  it('accepts &gt; and /&gt; and &lt;/ closers in entity mode', () => {
    expect(rec('&lt;seal seal="1" d="x" s="Q"&gt;', 1)!.fields.s).toBe('Q');
    expect(rec('&lt;seal seal="1" d="x" s="Q"/&gt;', 1)!.fields.s).toBe('Q');
    expect(rec('&lt;seal seal="1" d="x" s="Q"&lt;/x&gt;', 1)!.fields.s).toBe('Q');
  });

  it('accepts spaced and mixed plain closers in entity mode', () => {
    // Whitespace between value and closer forces the loop-head check path
    expect(rec('&lt;seal seal="1" d="x" s="Q" &gt;', 1)!.fields.s).toBe('Q');
    expect(rec('&lt;seal seal="1" d="x" s="Q" >', 1)!.fields.s).toBe('Q');
    expect(rec('&lt;seal seal="1" d="x" s="Q" />', 1)!.fields.s).toBe('Q');
    expect(rec('&lt;seal seal="1" d="x" s="Q" &lt;/x&gt;', 1)!.fields.s).toBe('Q');
    expect(rec('&lt;seal seal="1" d="x" s="Q" &lt;o', 1)).toBeNull();
  });

  it('accepts unquoted values ended by whitespace or &', () => {
    expect(rec('<seal seal=1 d=x >')!.fields.seal).toBe('1');
    expect(rec('&lt;seal seal=1&gt;', 1)!.fields.seal).toBe('1');
  });

  it('returns null on unterminated records', () => {
    expect(rec('<seal seal="1" d="x" s="Q"<')).toBeNull();
    expect(rec('<seal seal="1"   ')).toBeNull();
    expect(rec('<?seal seal="1" d="x" >', 2)).toBeNull();
    expect(rec('&lt;seal seal="1" d="x" &lt;oops', 1)).toBeNull();
  });

  it('closes on a plain </...> marker after a quoted value', () => {
    const r = rec('<seal seal="1" s="QUJD" </>');
    expect(r).not.toBeNull();
    expect(r!.fields.s).toBe('QUJD');
  });

  it('entity closer without a trailing &gt; runs the skip loop to the end', () => {
    // Value ends directly at an '&lt;' — the closer scanner finds no '&gt;'
    // and consumes the remainder of the buffer.
    const r = rec('&lt;seal seal="1"&lt;tail', 1);
    expect(r).not.toBeNull();
    expect(r!.fields.seal).toBe('1');
  });
});
