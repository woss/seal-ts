/**
 * Faithful port of hackerfactor/SEAL-JS seal-tests.html (upstream commit
 * ed80e4e9…) to vitest. Every check() from the browser suite maps 1:1 to an
 * expect() here; helpers are copied verbatim from the suite body.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { seal } from './seal.js';

const te = new TextEncoder();
const td = new TextDecoder();

function bytes(s: string): Uint8Array {
  return te.encode(s);
}
function str(b: Uint8Array, s: number, e: number): string {
  return td.decode(b.subarray(s, e));
}
function find(s: string) {
  return seal._findAllSEALRecords(bytes(s));
}
function ranges(spec: string, fLen: number, sS: number, sE: number, pS = 0, pE = 0) {
  return seal._computeByteRanges(spec, fLen, sS, sE, pS, pE).ranges;
}
function rangeErr(spec: string, fLen: number, sS: number, sE: number, pS = 0, pE = 0) {
  return seal._computeByteRanges(spec, fLen, sS, sE, pS, pE).error;
}

// Minimal valid JPEG: FFD8 + APP8 (ffe8) "SEAL\0" + record + FFDA (SOS)
function makeJPEG(sealText: string): Uint8Array {
  const sealBytes = bytes(sealText);
  const appData = bytes('SEAL\0');
  const blockBody = new Uint8Array(appData.length + sealBytes.length);
  blockBody.set(appData);
  blockBody.set(sealBytes, appData.length);
  const blockLen = blockBody.length + 2;
  const buf = new Uint8Array(4 + 2 + blockBody.length + 2);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe8;
  buf[4] = (blockLen >> 8) & 0xff;
  buf[5] = blockLen & 0xff;
  buf.set(blockBody, 6);
  buf[buf.length - 2] = 0xff;
  buf[buf.length - 1] = 0xda;
  return buf;
}

function makeChunk(name: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = name.charCodeAt(i);
  }
  chunk.set(data, 8);
  return chunk;
}

function makePNG(sealText: string): Uint8Array {
  const magic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = new Uint8Array(13);
  const ihdrChunk = makeChunk('IHDR', ihdrData);
  const sealData = bytes(sealText);
  const sealChunk = makeChunk('sEAl', sealData);
  const iendChunk = makeChunk('IEND', new Uint8Array(0));
  const total = magic.length + ihdrChunk.length + sealChunk.length + iendChunk.length;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(magic, off);
  off += magic.length;
  out.set(ihdrChunk, off);
  off += ihdrChunk.length;
  out.set(sealChunk, off);
  off += sealChunk.length;
  out.set(iendChunk, off);
  return out;
}

function makeZIP(sealText: string): Uint8Array {
  const lfh = new Uint8Array(30 + 5);
  lfh[0] = 0x50;
  lfh[1] = 0x4b;
  lfh[2] = 0x03;
  lfh[3] = 0x04;
  lfh[26] = 5;
  lfh[27] = 0;
  const fname = bytes('a.txt');
  lfh.set(fname, 30);

  const cdfh = new Uint8Array(46 + 5);
  cdfh[0] = 0x50;
  cdfh[1] = 0x4b;
  cdfh[2] = 0x01;
  cdfh[3] = 0x02;
  cdfh[28] = 5;
  cdfh[29] = 0;
  cdfh.set(fname, 46);

  const lfhSize = lfh.length;
  const cdOffset = lfhSize;
  const cdSize = cdfh.length;
  const sealBytes = bytes(sealText);
  const commentLen = sealBytes.length;

  const eocd = new Uint8Array(22 + commentLen);
  eocd[0] = 0x50;
  eocd[1] = 0x4b;
  eocd[2] = 0x05;
  eocd[3] = 0x06;
  eocd[8] = 1;
  eocd[9] = 0;
  eocd[10] = 1;
  eocd[11] = 0;
  eocd[12] = cdSize & 0xff;
  eocd[13] = (cdSize >> 8) & 0xff;
  eocd[14] = 0;
  eocd[15] = 0;
  eocd[16] = cdOffset & 0xff;
  eocd[17] = (cdOffset >> 8) & 0xff;
  eocd[18] = 0;
  eocd[19] = 0;
  eocd[20] = commentLen & 0xff;
  eocd[21] = (commentLen >> 8) & 0xff;
  eocd.set(sealBytes, 22);

  const out = new Uint8Array(lfhSize + cdSize + eocd.length);
  let off = 0;
  out.set(lfh, off);
  off += lfhSize;
  out.set(cdfh, off);
  off += cdSize;
  out.set(eocd, off);
  return out;
}

function makeJPEGWithJFIF(sealText: string): Uint8Array {
  const sealBytes = bytes(sealText);
  const jfifLabel = bytes('JFIF\0');
  const blockBody = new Uint8Array(jfifLabel.length + sealBytes.length);
  blockBody.set(jfifLabel);
  blockBody.set(sealBytes, jfifLabel.length);
  const blockLen = blockBody.length + 2;
  const buf = new Uint8Array(4 + 2 + blockBody.length + 2);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe0;
  buf[4] = (blockLen >> 8) & 0xff;
  buf[5] = blockLen & 0xff;
  buf.set(blockBody, 6);
  buf[buf.length - 2] = 0xff;
  buf[buf.length - 1] = 0xda;
  return buf;
}

function makeGIFWithGraphicControl(sealText: string): Uint8Array {
  const sealData = bytes(sealText);
  const subLen = Math.min(255, sealData.length);
  const buf = new Uint8Array(6 + 3 + 1 + 3 + subLen + 2 + 1);
  buf.set(bytes('GIF89a'));
  buf[6] = 0;
  buf[7] = 1;
  buf[8] = 0;
  buf[9] = 1;
  buf[10] = 0;
  let off = 11;
  buf[off++] = 0x21;
  buf[off++] = 0xf9; // graphic control, NOT app extension
  buf[off++] = subLen;
  buf.set(sealData.subarray(0, subLen), off);
  off += subLen;
  buf[off++] = 0; // end of sub-blocks
  buf[off++] = 0x3b; // trailer
  return buf;
}

function makeRIFFWebP(sealText: string): Uint8Array {
  const sealData = bytes(sealText);
  const padded = sealData.length + (sealData.length % 2);
  const fileSize = 4 + 8 + padded;
  const buf = new Uint8Array(12 + fileSize);
  buf[0] = 0x52;
  buf[1] = 0x49;
  buf[2] = 0x46;
  buf[3] = 0x46;
  const totalSize = buf.length - 8;
  buf[4] = totalSize & 0xff;
  buf[5] = (totalSize >> 8) & 0xff;
  buf[6] = (totalSize >> 16) & 0xff;
  buf[7] = (totalSize >> 24) & 0xff;
  buf[8] = 0x57;
  buf[9] = 0x45;
  buf[10] = 0x42;
  buf[11] = 0x50;
  buf[12] = 0x53;
  buf[13] = 0x45;
  buf[14] = 0x41;
  buf[15] = 0x4c; // "SEAL"
  buf[16] = sealData.length & 0xff;
  buf[17] = (sealData.length >> 8) & 0xff;
  buf[18] = (sealData.length >> 16) & 0xff;
  buf[19] = (sealData.length >> 24) & 0xff;
  buf.set(sealData, 20);
  return buf;
}

function makeBMFF(sealText: string): Uint8Array {
  const ftyp = new Uint8Array(16);
  ftyp[0] = 0;
  ftyp[1] = 0;
  ftyp[2] = 0;
  ftyp[3] = 16;
  for (let i = 0; i < 4; i++) {
    ftyp[4 + i] = 'ftyp'.charCodeAt(i);
  }
  for (let i = 0; i < 4; i++) {
    ftyp[8 + i] = 'mp42'.charCodeAt(i);
  }
  for (let i = 0; i < 4; i++) {
    ftyp[12 + i] = 'mp42'.charCodeAt(i);
  }

  const sealData = bytes(sealText);
  const sealAtom = new Uint8Array(8 + sealData.length);
  const sealLen = sealAtom.length;
  sealAtom[0] = (sealLen >> 24) & 0xff;
  sealAtom[1] = (sealLen >> 16) & 0xff;
  sealAtom[2] = (sealLen >> 8) & 0xff;
  sealAtom[3] = sealLen & 0xff;
  for (let i = 0; i < 4; i++) {
    sealAtom[4 + i] = 'SEAL'.charCodeAt(i);
  }
  sealAtom.set(sealData, 8);

  const buf = new Uint8Array(ftyp.length + sealAtom.length);
  buf.set(ftyp);
  buf.set(sealAtom, ftyp.length);
  return buf;
}

beforeAll(() => {
  expect(seal).toBeDefined();
});

describe('parseDNSTXT — unquoted (as returned by real DNS TXT)', () => {
  it('parses fields', () => {
    const dns = seal._parseDNSTXT('seal=1 ka=rsa p=abc123');
    expect(dns && dns.seal).toBe('1');
    expect(dns && dns.ka).toBe('rsa');
    expect(dns && dns.p).toBe('abc123');
    expect(seal._parseDNSTXT('not a seal')).toBe(null);
    expect(seal._parseDNSTXT('')).toBe(null);
  });
});

describe('parseDNSTXT — quoted (wrapped by DoH JSON)', () => {
  it('parses quoted values', () => {
    const d2 = seal._parseDNSTXT('seal="1" ka="rsa" kv="2" p="PUBKEY=="');
    expect(d2 && d2.seal).toBe('1');
    expect(d2 && d2.kv).toBe('2');
    expect(d2 && d2.p).toBe('PUBKEY==');
  });
});

describe('parseDNSTXT — _pBin pre-decoded', () => {
  it('pre-decodes p= to binary', () => {
    const d3 = seal._parseDNSTXT('seal=1 ka=rsa p=aGVsbG8=');
    const pBin = d3?._pBin;
    expect(pBin instanceof Uint8Array).toBe(true);
    expect(pBin ? Array.from(pBin) : null).toEqual([104, 101, 108, 108, 111]);
  });
});

describe('computeByteRanges — standard patterns', () => {
  it('expands S/s/F/f/P/p tokens', () => {
    expect(ranges('~S,s~', 1000, 400, 600)).toEqual([
      [0, 400],
      [600, 1000],
    ]);
    expect(ranges('F~S,s~f', 1000, 400, 600)).toEqual([
      [0, 400],
      [600, 1000],
    ]);
    expect(ranges('0~500', 1000, 400, 600)).toEqual([[0, 500]]);
    expect(ranges('100~900', 1000, 400, 600)).toEqual([[100, 900]]);
    expect(ranges('P~S,s~f', 1000, 400, 600, 100, 200)).toEqual([
      [100, 400],
      [600, 1000],
    ]);
    expect(ranges('p~S,s~f', 1000, 400, 600, 100, 200)).toEqual([
      [200, 400],
      [600, 1000],
    ]);
  });
});

describe('computeByteRanges — arithmetic offsets', () => {
  it('supports +- arithmetic', () => {
    expect(ranges('F~S,s~s+4,s+8~f', 1000, 400, 600)).toEqual([
      [0, 400],
      [600, 604],
      [608, 1000],
    ]);
    expect(ranges('S+8~s', 1000, 400, 600)).toEqual([[408, 600]]);
    expect(ranges('F~S-10', 1000, 400, 600)).toEqual([[0, 390]]);
  });
});

describe('computeByteRanges — edge cases & errors', () => {
  it('handles empty spec, overflow, inversion, zero-length', () => {
    expect(ranges('', 1000, 400, 600)).toEqual([]);
    expect(rangeErr('~S,s~', 500, 400, 600) !== null).toBe(true);
    expect(rangeErr('600~400', 1000, 400, 600) !== null).toBe(true);
    expect(ranges('200~200', 1000, 400, 600)).toEqual([]);
  });
});

describe('decodeSig — base64', () => {
  it('decodes base64 and url-safe base64', () => {
    const s = seal._decodeSig('aGVsbG8=', 'base64');
    expect(s.error).toBe(null);
    expect(Array.from(s.sigBytes)).toEqual([104, 101, 108, 108, 111]);
    expect(s.timestamp).toBe(null);
    expect(seal._decodeSig('aGVs-G8_', 'base64').error).toBe(null);
  });
});

describe('decodeSig — hex', () => {
  it('decodes lower and upper hex, rejects invalid', () => {
    const s = seal._decodeSig('68656c6c6f', 'hex');
    expect(Array.from(s.sigBytes)).toEqual([104, 101, 108, 108, 111]);
    const S = seal._decodeSig('68656C6C6F', 'HEX');
    expect(Array.from(S.sigBytes)).toEqual([104, 101, 108, 108, 111]);
    expect(typeof seal._decodeSig('6865zz', 'hex').error).toBe('string');
  });
});

describe('decodeSig — date prefix', () => {
  it('extracts timestamps', () => {
    const s = seal._decodeSig('20241001120000:aGVsbG8=', 'date:base64');
    expect(s.timestamp).toBe('20241001120000');
    expect(Array.from(s.sigBytes)).toEqual([104, 101, 108, 108, 111]);
    const s3 = seal._decodeSig('20241001120000.123:aGVsbG8=', 'date3:base64');
    expect(s3.timestamp).toBe('20241001120000.123');
    expect(typeof seal._decodeSig('2024:aGVsbG8=', 'date:base64').error).toBe('string');
  });
});

describe('decodeSig — bad input', () => {
  it('errors on garbage and empty input', () => {
    expect(typeof seal._decodeSig('!!!', 'base64').error).toBe('string');
    expect(typeof seal._decodeSig('', 'base64').error).toBe('string');
  });
});

describe('findAllSEALRecords — basic parsing', () => {
  it('parses fields and locates raw signature bytes', () => {
    const r = find('<seal seal="1" ka="rsa" d="ex.com" b="~S,s~" s="SIGVAL" />');
    expect(r.length).toBe(1);
    expect(r[0].fields.seal).toBe('1');
    expect(r[0].fields.d).toBe('ex.com');
    expect(r[0].fields.ka).toBe('rsa');
    expect(r[0].fields.b).toBe('~S,s~');
    expect(r[0].fields.s).toBe('SIGVAL');
    const buf = bytes('<seal seal="1" ka="rsa" d="ex.com" b="~S,s~" s="SIGVAL" />');
    expect(str(buf, r[0].rawSigStart, r[0].rawSigEnd)).toBe('SIGVAL');
  });
});

describe('findAllSEALRecords — XMP entity-encoded form', () => {
  it('parses entity-encoded records', () => {
    const r1 = find('&lt;seal seal="1" d="ex.com" s="SIG2" />');
    expect(r1.length).toBe(1);
    expect(r1[0] && r1[0].fields.s).toBe('SIG2');
    expect(find('&lt;seal seal="1" d="ex.com" s="SIG3" /&gt;').length).toBe(1);
    expect(find('<foo> &lt;seal seal="1" d="ex.com" s="SIG4" /> </foo>').length).toBe(1);
  });
});

describe('findAllSEALRecords — XML PI form', () => {
  it('parses processing-instruction records', () => {
    const r = find('<?seal seal="1" d="ex.com" s="SIG5" ?>');
    expect(r.length).toBe(1);
    expect(r[0] && r[0].fields.s).toBe('SIG5');
    expect(find('<?SEAL seal="1" d="ex.com" s="SIG6" ?>').length).toBe(1);
  });
});

describe('findAllSEALRecords — multiple records', () => {
  it('finds consecutive records', () => {
    const r = find('<seal seal="1" d="a.com" s="S1" />' + '<seal seal="1" d="b.com" s="S2" />');
    expect(r.length).toBe(2);
    expect(r[0].fields.d).toBe('a.com');
    expect(r[1].fields.d).toBe('b.com');
    expect(r[0].recStart + r[0].recEnd <= r[1].recStart).toBe(true);
  });
});

describe('findAllSEALRecords — field value edge cases', () => {
  it('handles escapes, quoting, all fields, missing s=', () => {
    const r1 = find('<seal seal="1" d="ex.com" s="S" info="A\\/B" />');
    expect(r1[0] && r1[0].fields.info).toBe('A/B');

    const r2 = find("<seal seal='1' d='ex.com' s='SQUOTE' />");
    expect(r2[0] && r2[0].fields.s).toBe('SQUOTE');

    const r3 = find(
      '<seal seal="1" ka="rsa" da="sha256" sf="base64" kv="1" ' +
        'id="user@ex.com" d="ex.com" b="~S,s~" s="SIG" ' +
        'copyright="© 2024" info="Test image" />',
    );
    expect(r3[0] && r3[0].fields.ka).toBe('rsa');
    expect(r3[0] && r3[0].fields.da).toBe('sha256');
    expect(r3[0] && r3[0].fields.copyright).toBe('© 2024');
    expect(r3[0] && r3[0].fields.info).toBe('Test image');
    expect(r3[0] && r3[0].fields.id).toBe('user@ex.com');

    const r4 = find('<seal seal="1" d="ex.com" ka="rsa" />');
    expect(r4.length).toBe(1);
    expect(r4[0] && r4[0].rawSigStart).toBe(-1);
  });
});

describe('findAllSEALRecords — noise tolerance', () => {
  it('finds nothing in noise, finds record after binary prefix', () => {
    expect(find('').length).toBe(0);
    expect(find('hello world').length).toBe(0);
    expect(find('<seal').length).toBe(0);
    const prefix = '\x00\x01\x02\x03\xFF\xD8\xFF';
    const r = find(prefix + '<seal seal="1" d="x.com" s="SIG" />');
    expect(r.length).toBe(1);
  });
});

describe('validateBuffer — no SEAL record', () => {
  it('reports a single invalid result', async () => {
    const res = await seal.validateBuffer(bytes('no seal here'), 'test.txt');
    expect(res.length).toBe(1);
    expect(res[0].valid).toBe(false);
    expect(res[0].error).toBe('No SEAL record found in file');
    expect(res[0].filename).toBe('test.txt');
  });
});

describe('validateBuffer — missing s= field', () => {
  it('fails with an error', async () => {
    const res = await seal.validateBuffer(bytes('<seal seal="1" d="ex.com" ka="rsa" />'), 'nosig.txt');
    expect(res[0].valid).toBe(false);
    expect(typeof res[0].error).toBe('string');
  });
});

describe('validateBuffer — attack warnings', () => {
  it('warns when b= has no F or P anchor', async () => {
    const res = await seal.validateBuffer(
      bytes('<seal seal="1" d="ex.com" b="~S,s~" s="SIG" />'),
      'test.txt',
      { dnsOverride: 'seal=1 ka=rsa p=aGVsbG8=' },
    );
    expect(res[0].warnings && res[0].warnings.length > 0).toBe(true);
  });
});

describe('validateBuffer — dnsOverride (string)', () => {
  it('uses the supplied TXT record', async () => {
    const res = await seal.validateBuffer(
      bytes('<seal seal="1" ka="rsa" da="sha256" b="~S,s~" d="ex.com" s="FAKESIG" />'),
      'test.txt',
      { dnsOverride: 'seal=1 ka=rsa p=aGVsbG8=' },
    );
    expect(res[0].error !== 'No SEAL DNS record found for seal._seal.ex.com').toBe(true);
    expect(res[0].domain).toBe('ex.com');
  });
});

describe('validateBuffer — dnsOverride (object)', () => {
  it('accepts a pre-parsed record object', async () => {
    const res = await seal.validateBuffer(
      bytes('<seal seal="1" ka="rsa" da="sha256" b="~S,s~" d="ex.com" s="FAKESIG" />'),
      'test.txt',
      {
        dnsOverride: {
          seal: '1',
          ka: 'rsa',
          p: 'aGVsbG8=',
          _pBin: new Uint8Array([104, 101, 108, 108, 111]),
        },
      },
    );
    expect(res[0].domain).toBe('ex.com');
  });
});

describe('validateBuffer — dnsOverrideMap', () => {
  it('resolves per-domain overrides', async () => {
    const res = await seal.validateBuffer(
      bytes('<seal seal="1" ka="rsa" da="sha256" b="~S,s~" d="photos.example" s="FAKESIG" />'),
      'test.txt',
      { dnsOverrideMap: { 'photos.example': 'seal=1 ka=rsa p=aGVsbG8=' } },
    );
    expect(res[0].domain).toBe('photos.example');
  });
});

describe('validateBuffer — revocation check', () => {
  it('flags sigdates after r=', async () => {
    const res = await seal.validateBuffer(
      bytes(
        '<seal seal="1" ka="rsa" da="sha256" sf="date:base64" b="~S,s~" d="revoke.com" s="20240601120000:FAKESIG" />',
      ),
      'test.txt',
      { dnsOverrideMap: { 'revoke.com': 'seal=1 ka=rsa r=20230101000000 p=aGVsbG8=' }, verifyOverride: true },
    );
    expect(res[0].revoked).toBe(true);
  });

  it('does not flag sigdates before r=', async () => {
    const res = await seal.validateBuffer(
      bytes(
        '<seal seal="1" ka="rsa" da="sha256" sf="date:base64" b="~S,s~" d="revoke.com" s="20230601120000:FAKESIG" />',
      ),
      'test.txt',
      { dnsOverrideMap: { 'revoke.com': 'seal=1 ka=rsa r=20240101000000 p=aGVsbG8=' }, verifyOverride: true },
    );
    expect(res[0].revoked).toBe(false);
  });

  it('r= without p= revokes post-revoke timestamp', async () => {
    const res = await seal.validateBuffer(
      bytes(
        '<seal seal="1" ka="rsa" da="sha256" sf="date:base64" b="~S,s~" d="revoke.com" s="20240601120000:FAKESIG" />',
      ),
      'test.txt',
      {
        dnsOverrideMap: { 'revoke.com': ['seal=1 ka=rsa r=20230101000000', 'seal=1 ka=rsa p=aGVsbG8='] },
        verifyOverride: true,
      },
    );
    expect(res[0].revoked).toBe(true);
  });

  it('r= without p= allows pre-revoke date with matching key', async () => {
    const res = await seal.validateBuffer(
      bytes(
        '<seal seal="1" ka="rsa" da="sha256" sf="date:base64" b="~S,s~" d="revoke.com" s="20220601120000:FAKESIG" />',
      ),
      'test.txt',
      {
        dnsOverrideMap: { 'revoke.com': ['seal=1 ka=rsa r=20230101000000', 'seal=1 ka=rsa p=aGVsbG8='] },
        verifyOverride: true,
      },
    );
    expect(res[0].revoked).toBe(false);
    expect(res[0].valid).toBe(true);
  });

  it('r=revoke flags revoked', async () => {
    const res = await seal.validateBuffer(
      bytes('<seal seal="1" ka="rsa" da="sha256" b="~S,s~" d="revoke.com" s="FAKESIG" />'),
      'test.txt',
      { dnsOverrideMap: { 'revoke.com': 'seal=1 ka=rsa r=revoke p=aGVsbG8=' } },
    );
    expect(res[0].revoked).toBe(true);
  });
});

describe('validateBuffer — global revoke (p=revoke)', () => {
  it('flags globally revoked key', async () => {
    const res = await seal.validateBuffer(
      bytes('<seal seal="1" ka="rsa" da="sha256" b="~S,s~" d="revoke.com" s="FAKESIG" />'),
      'test.txt',
      { dnsOverride: 'seal=1 ka=rsa p=revoke' },
    );
    expect(res[0].revoked).toBe(true);
  });
});

describe('validateBuffer — multiple records: recordIndex / recordCount', () => {
  it('indexes results', async () => {
    const res = await seal.validateBuffer(
      bytes(
        '<seal seal="1" d="a.com" b="F~S,s~f" s="SIG1" />' +
          '<seal seal="1" d="b.com" b="P~S,s~f" s="SIG2" />',
      ),
      'multi.jpg',
      { dnsOverride: 'seal=1 ka=rsa p=aGVsbG8=' },
    );
    expect(res.length).toBe(2);
    expect(res[0].recordIndex).toBe(1);
    expect(res[1].recordIndex).toBe(2);
    expect(res[0].recordCount).toBe(2);
    expect(res[0].domain).toBe('a.com');
    expect(res[1].domain).toBe('b.com');
  });
});

describe('validateBuffer — kv mismatch rejects DNS record', () => {
  it('fails to find a matching DNS record', async () => {
    const res = await seal.validateBuffer(
      bytes('<seal seal="1" ka="rsa" da="sha256" kv="2" b="~S,s~" d="ex.com" s="FAKESIG" />'),
      'test.txt',
      { dnsOverride: 'seal=1 ka=rsa kv=1 p=aGVsbG8=' },
    );
    expect(res[0].valid).toBe(false);
  });
});

describe('detectFormat — magic bytes', () => {
  it('detects all supported formats', () => {
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(seal.detectFormat(JPEG)).toBe('jpeg');
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(seal.detectFormat(PNG)).toBe('png');
    const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38]);
    expect(seal.detectFormat(GIF)).toBe('gif');
    expect(seal.detectFormat(bytes('%PDF-1.7'))).toBe('pdf');
    const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(seal.detectFormat(ZIP)).toBe('zip');
    const MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
    expect(seal.detectFormat(MP4)).toBe('bmff');
    expect(seal.detectFormat(bytes('<?xml version="1.0"'))).toBe('xml');
  });
});

describe('Format scanner: JPEG', () => {
  it('finds record in APP8, coordinate space is full file', () => {
    const jpegBuf = makeJPEG('<seal seal="1" d="ex.com" b="F~S,s~f" s="SIGJPEG" />');
    const recs = seal._scanByFormat(jpegBuf);
    expect(recs.length).toBe(1);
    expect(recs[0] && recs[0].fields.s).toBe('SIGJPEG');
    expect(recs[0] && recs[0].bytes.length).toBe(jpegBuf.length);

    const jpegNoSeal = makeJPEG('no seal here');
    expect(seal._scanByFormat(jpegNoSeal).length).toBe(0);

    const notJpeg = bytes('<seal seal="1" d="ex.com" s="SIG" />');
    expect(seal._scanByFormat(notJpeg).length).toBe(1);
  });
});

describe('Format scanner: PNG', () => {
  it('scans sEAl and tEXt chunks', () => {
    const pngBuf = makePNG('<seal seal="1" d="ex.com" b="F~S,s~s+4,s+8~f" s="SIGPNG" />');
    const recs = seal._scanByFormat(pngBuf);
    expect(recs.length).toBe(1);
    expect(recs[0] && recs[0].fields.s).toBe('SIGPNG');

    const pngTextBuf = new Uint8Array(makePNG('<seal seal="1" d="ex.com" s="SIGTEXT" />'));
    const sealOff = 8 + 25; // magic + IHDR chunk (13+12=25)
    pngTextBuf[sealOff + 4] = 0x74; // t
    pngTextBuf[sealOff + 5] = 0x45; // E
    pngTextBuf[sealOff + 6] = 0x58; // X
    pngTextBuf[sealOff + 7] = 0x74; // t
    expect(seal._scanByFormat(pngTextBuf).length).toBe(1);
  });
});

describe('Format scanner: ZIP', () => {
  it('finds the EOCD-comment record', () => {
    const zipBuf = makeZIP('<seal seal="1" d="ex.com" b="F~S,s~f" s="SIGZIP" />');
    const recs = seal._scanByFormat(zipBuf);
    expect(recs.length >= 1).toBe(true);
    if (recs.length >= 1) {
      expect(recs[0].fields.s).toBe('SIGZIP');
      expect(recs[0].bytes instanceof Uint8Array).toBe(true);
    }
  });
});

describe('Format scanner: RIFF (WebP)', () => {
  it('finds the SEAL chunk', () => {
    const buf = makeRIFFWebP('<seal seal="1" d="ex.com" s="SIGRIFF" />');
    const recs = seal._scanByFormat(buf);
    expect(recs.length).toBe(1);
    expect(recs[0] && recs[0].fields.s).toBe('SIGRIFF');
  });
});

describe('Format scanner: BMFF (MP4/HEIC)', () => {
  it('finds the SEAL atom', () => {
    const buf = makeBMFF('<seal seal="1" d="ex.com" s="SIGBMFF" />');
    const recs = seal._scanByFormat(buf);
    expect(recs.length).toBe(1);
    expect(recs[0] && recs[0].fields.s).toBe('SIGBMFF');
  });
});

describe('Format scanner: no format cross-contamination', () => {
  it('skips JFIF blocks and GIF graphic-control extensions', () => {
    const jfifBuf = makeJPEGWithJFIF('<seal seal="1" d="ex.com" s="SHOULDNOTFIND" />');
    expect(seal._scanByFormat(jfifBuf).length).toBe(0);

    const gifGC = makeGIFWithGraphicControl('<seal seal="1" d="ex.com" s="SHOULDNOTFIND" />');
    expect(seal._scanByFormat(gifGC).length).toBe(0);
  });
});
