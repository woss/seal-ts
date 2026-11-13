/**
 * Semantic tests for validateOneRecord/validateBuffer orchestration:
 * warnings, inline-key authentication, revocation, DNS override forms,
 * and every error path (mirrors the C SealVerify / SealInlineAuthenticate /
 * _SealValidateRevoke decision tree).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateSealKeyPair } from '../sign/keygen.js';
import { importPrivateKey } from '../sign/keyutil.js';
import { sealSign } from '../sign/signer.js';
import { b64decode } from './bytes.js';
import { type SealDnsOverride, validateBuffer } from './validate.js';

const te = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Record padded to fixed offsets for hand-built b= specs. */
function rec(s: string, b = 'F~S,s~f'): string {
  return `<seal seal="1" d="example.com" ka="rsa" s="${s}" b="${b}" />`;
}

describe('validateBuffer — early returns', () => {
  it('errors without a d= field', async () => {
    const body = te.encode('<seal seal="1" ka="rsa" s="QUJD" b="F~S,s~f" />');
    const [r] = await validateBuffer(body, 'x.txt');
    expect(r.error).toBe('No domain (d=) in SEAL record');
  });

  it('propagates a malformed s= decode', async () => {
    const body = te.encode(rec('a$b!'));
    const [r] = await validateBuffer(body, 'x.txt', { dnsOverride: 'seal=1 ka=rsa p=QUJD' });
    expect(r.error).toMatch(/base64 signature failed to decode/);
  });

  it('rejects an empty bin signature', async () => {
    const body = te.encode('<seal seal="1" d="example.com" ka="rsa" sf="bin" s="" b="F~S,s~f" />');
    const [r] = await validateBuffer(body, 'x.txt', { dnsOverride: 'seal=1 ka=rsa p=QUJD' });
    expect(r.error).toBe('empty signature');
  });

  it('surfaces a b= range error', async () => {
    const body = te.encode('<seal seal="1" d="example.com" ka="rsa" s="QUJD" b="9~2" />');
    const [r] = await validateBuffer(body, 'x.txt', { dnsOverride: 'seal=1 ka=rsa p=QUJD' });
    expect(r.error).toMatch(/before start/);
  });

  it('rejects an empty range list', async () => {
    const body = te.encode('<seal seal="1" d="example.com" ka="rsa" s="QUJD" b="F~F" />');
    const [r] = await validateBuffer(body, 'x.txt', { dnsOverride: 'seal=1 ka=rsa p=QUJD' });
    expect(r.error).toBe('no bytes to hash (empty range)');
  });

  it('rejects an unknown digest algorithm', async () => {
    const body = te.encode('<seal seal="1" d="example.com" ka="rsa" da="md5" s="QUJD" b="F~S,s~f" />');
    const [r] = await validateBuffer(body, 'x.txt', { dnsOverride: 'seal=1 ka=rsa p=QUJD' });
    expect(r.error).toBe('Unknown digest algorithm: md5');
  });

  it('fails closed with an explicit why for da=sha224 (no WebCrypto digest)', async () => {
    const body = te.encode('<seal seal="1" d="example.com" ka="rsa" da="sha224" s="QUJD" b="F~S,s~f" />');
    const [r] = await validateBuffer(body, 'x.txt', { dnsOverride: 'seal=1 ka=rsa p=QUJD' });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/SHA-224/);
  });

});

describe('validateBuffer — revocation', () => {
  it('revokes a dateless record when r= is set (fails closed)', async () => {
    // sf=base64 → no timestamp; any r= must revoke (cannot compare dates)
    const body = te.encode('<seal seal="1" d="example.com" ka="rsa" sf="base64" s="QUJD" b="F~S,s~f" />');
    const [r] = await validateBuffer(body, 'x.txt', {
      dnsOverride: 'seal=1 ka=rsa p=QUJD r=20200101000000',
    });
    expect(r.revoked).toBe(true);
  });

  it('reports a domain default revoke when no key is published', async () => {
    const body = te.encode(rec('QUJD'));
    const [r] = await validateBuffer(body, 'x.txt', { dnsOverride: 'seal=1 ka=rsa' });
    expect(r.revoked).toBe(true);
    expect(r.error).toBe('domain default revoke');
  });
});

describe('validateBuffer — DNS matching and multi-record fallback', () => {
  it('skips DNS records whose fields disagree with the record', async () => {
    const body = te.encode(rec('QUJD'));
    const [r] = await validateBuffer(body, 'x.txt', {
      dnsOverride: ['seal=1 ka=rsa kv=2 p=QUJD', 'seal=1 ka=ecdsa p=QUJD'],
    });
    // No DNS record matched
    expect(r.valid).toBe(false);
    expect(r.error).toBe('could not validate against any DNS record');
  });

  it('continues to the next DNS record after a signature mismatch', async () => {
    const body = te.encode(rec('QUJD'));
    const [r] = await validateBuffer(body, 'x.txt', {
      dnsOverride: [
        { seal: '1', ka: 'rsa', p: b64decode('QUJD') }, // real SPKI? no — importKey fails
        { seal: '1', ka: 'rsa' }, // keyless → default revoke
      ],
    });
    expect(r.revoked).toBe(true);
    expect(r.error).toBe('domain default revoke');
  });

  it('reports no usable public key when p= fails to decode', async () => {
    const body = te.encode(rec('QUJD'));
    const [r] = await validateBuffer(body, 'x.txt', { dnsOverride: 'seal=1 ka=rsa p=!!!' });
    expect(r.valid).toBe(false);
    expect(r.error).toBe('DNS record has no usable public key');
  });

  it('reports a signature mismatch against a real key', async () => {
    const kp = await generateSealKeyPair('rsa');
    const body = te.encode(rec('QUJD'));
    const [r] = await validateBuffer(body, 'x.txt', { dnsOverride: `seal=1 ka=rsa p=${kp.spkiB64}` });
    expect(r.valid).toBe(false);
    expect(r.error).toBe('signature mismatch');
  });

  it('reports a crypto verification error for a malformed key', async () => {
    const body = te.encode(rec('QUJD'));
    const [r] = await validateBuffer(body, 'x.txt', { dnsOverride: 'seal=1 ka=rsa p=YWJj' });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/Verification error/);
  });
});

describe('validateBuffer — verifyOverride and override forms', () => {
  it('honours verifyOverride (skips crypto) for object overrides', async () => {
    const body = te.encode(rec('QUJD'));
    const [r] = await validateBuffer(body, 'x.txt', {
      dnsOverride: { seal: '1', ka: 'rsa', p: 'QUJD', _pBin: b64decode('QUJD') },
      verifyOverride: true,
    });
    expect(r.valid).toBe(true);
    expect(r.auth).toBe(true);
  });

  it('accepts dnsOverrideMap (string, object, and array forms)', async () => {
    const body = te.encode(rec('QUJD'));
    for (const ov of [
      'seal=1 ka=rsa p=QUJD',
      { seal: '1', ka: 'rsa', p: 'QUJD', _pBin: b64decode('QUJD') },
      [{ seal: '1', ka: 'rsa', p: 'QUJD', _pBin: b64decode('QUJD') }],
    ] as Array<string | SealDnsOverride | Array<string | SealDnsOverride>>) {
      const [r] = await validateBuffer(body, 'x.txt', {
        dnsOverrideMap: { 'example.com': ov },
        verifyOverride: true,
      });
      expect(r.valid, JSON.stringify(ov)).toBe(true);
    }
  });
});

describe('validateBuffer — inline keys (pk=)', () => {
  async function inlineFixture() {
    const kp = await generateSealKeyPair('rsa');
    const key = await importPrivateKey(kp.pkcs8B64, 'rsa');
    const { embedded } = await sealSign(te.encode('inline body'), {
      domain: 'example.com',
      key,
      alg: 'rsa',
      timestamp: '20260101000000',
      // pk= is appended by hand below instead
    });
    // Swap the signed record for one that carries pk= (signer does not emit it):
    // rebuild the record with the same signature value, keep b= text spec.
    const m = /s="([^"]+)"/.exec(new TextDecoder().decode(embedded))!;
    return { kp, sig: m[1]! };
  }

  function inlineRecord(sig: string, pk: string): string {
    return `<seal seal="1" d="example.com" ka="rsa" da="sha256" sf="date:base64" ts="20260101000000" pk="${pk}" s="${sig}" b="F~S,s~f" />`;
  }

  it('authenticates an inline key that exactly matches DNS p=', async () => {
    const { kp, sig } = await inlineFixture();
    const rec = inlineRecord(sig, kp.spkiB64);
    const file = te.encode(rec);
    // b=F~S,s~f hashes around the signature; the record was signed differently,
    // so the body digest mismatches — use verifyOverride to test ONLY the key auth.
    const [r] = await validateBuffer(file, 'x.txt', {
      dnsOverride: `seal=1 ka=rsa p=${kp.spkiB64}`,
      verifyOverride: true,
    });
    expect(r.valid).toBe(true);
    expect(r.auth).toBe(true);
  });

  it('authenticates an inline key via pkd= key digest', async () => {
    const { kp, sig } = await inlineFixture();
    const pkBin = b64decode(kp.spkiB64);
    const digest = await crypto.subtle.digest('SHA-256', pkBin);
    const pkd = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const file = te.encode(inlineRecord(sig, kp.spkiB64));
    const [r] = await validateBuffer(file, 'x.txt', {
      dnsOverride: `seal=1 ka=rsa pkd=${pkd} pka=sha256`,
      verifyOverride: true,
    });
    expect(r.valid).toBe(true);
    expect(r.auth).toBe(true);
  });

  it('fails inline auth on a pkd mismatch (valid via verifyOverride, auth false)', async () => {
    const { kp, sig } = await inlineFixture();
    const file = te.encode(inlineRecord(sig, kp.spkiB64));
    const [r] = await validateBuffer(file, 'x.txt', {
      dnsOverride: 'seal=1 ka=rsa pkd=QUJD pka=sha256',
      verifyOverride: true,
    });
    // Vendor flow: inline auth failure does NOT return — the record still
    // validates against its own pk= (skipped by verifyOverride). auth=false
    // is the unauthenticated-inline-key signal.
    expect(r.valid).toBe(true);
    expect(r.auth).toBe(false);
  });

  it('fails inline auth with pkd but no pka', async () => {
    const { kp, sig } = await inlineFixture();
    const file = te.encode(inlineRecord(sig, kp.spkiB64));
    const [r] = await validateBuffer(file, 'x.txt', {
      dnsOverride: 'seal=1 ka=rsa pkd=QUJD',
      verifyOverride: true,
    });
    expect(r.valid).toBe(true);
    expect(r.auth).toBe(false);
  });

  it('fails inline auth with an unknown pka', async () => {
    const { kp, sig } = await inlineFixture();
    const file = te.encode(inlineRecord(sig, kp.spkiB64));
    const [r] = await validateBuffer(file, 'x.txt', {
      dnsOverride: 'seal=1 ka=rsa pkd=QUJD pka=md5',
      verifyOverride: true,
    });
    expect(r.valid).toBe(true);
    expect(r.auth).toBe(false);
  });

  it('skips inline-only DNS entries for non-inline records', async () => {
    const body = te.encode(rec('QUJD'));
    const [r] = await validateBuffer(body, 'x.txt', {
      dnsOverride: [{ seal: '1', ka: 'rsa', pkd: 'QUJD', pka: 'sha256' }, { seal: '1', ka: 'rsa' }],
      verifyOverride: true,
    });
    // First entry skipped (inline-only), second is keyless → default revoke
    expect(r.revoked).toBe(true);
  });
});

describe('validateBuffer — warnings and byte descriptions', () => {
  it('warns on missing start-of-file coverage (prepend attack)', async () => {
    const body = te.encode('x'.repeat(40) + rec('QUJD', '40~S,s~f'));
    const [r] = await validateBuffer(body, 'x.txt', {
      dnsOverride: 'seal=1 ka=rsa p=QUJD',
      verifyOverride: true,
    });
    expect(r.warnings.join(' ')).toMatch(/prepend attack/);
  });

  it('warns on missing previous-signature coverage (insertion attack) for record 2', async () => {
    const one = rec('QUJD');
    const two = rec('QUJD', '40~S,s~f').replace('d="example.com"', 'd="example.com" id="2"');
    const body = te.encode(one + '  ' + two);
    const results = await validateBuffer(body, 'x.txt', {
      dnsOverride: 'seal=1 ka=rsa p=QUJD',
      verifyOverride: true,
    });
    expect(results.length).toBe(2);
    expect(results[1]!.warnings.join(' ')).toMatch(/insertion attack/);
    expect(results[1]!.recordIndex).toBe(2);
  });

  it('appends the non-finalizing note for partial coverage', async () => {
    // b=F~S ends the digest at the signature start — the trailing bytes are
    // outside coverage, so the record must not claim finalization.
    const body = te.encode(rec('QUJD', 'F~S') + 'trailing');
    const [r] = await validateBuffer(body, 'x.txt', {
      dnsOverride: 'seal=1 ka=rsa p=QUJD',
      verifyOverride: true,
    });
    expect(r.fields.byteDesc).toContain('data may be appended');
  });

  it('describes end-side previous-signature tokens (F~p, F~P) on record 2', async () => {
    const one = rec('QUJD');
    const body = te.encode(one + '  ' + rec('QUJD', 'F~p').replace('s="QUJD"', 's="QUJE"'));
    const results = await validateBuffer(body, 'x.txt', {
      dnsOverride: 'seal=1 ka=rsa p=QUJD',
      verifyOverride: true,
    });
    expect(results[1]!.fields.byteDesc).toMatch(/Start of file to end of previous signature/);

    const body2 = te.encode(one + '  ' + rec('QUJD', 'F~P').replace('s="QUJD"', 's="QUJE"'));
    const results2 = await validateBuffer(body2, 'x.txt', {
      dnsOverride: 'seal=1 ka=rsa p=QUJD',
      verifyOverride: true,
    });
    expect(results2[1]!.fields.byteDesc).toMatch(/Start of file to start of previous signature/);
  });
});

describe('validateBuffer — byte descriptions (token matrix)', () => {
  const cases: Array<[string, RegExp]> = [
    ['P~f', /Start of previous signature to end of file/],
    ['p~f', /End of previous signature to end of file/],
    ['S~f', /Start of signature to end of file/],
    ['s~f', /End of signature to end of file/],
    ['F~s', /Start of file to end of signature/],
    ['F~S', /Start of file to start of signature/],
    ['10~f', /Absolute offset to end of file/],
  ];
  for (const [spec, desc] of cases) {
    it(`b=${spec}`, async () => {
      const body = te.encode(rec('QUJD', spec));
      const [r] = await validateBuffer(body, 'x.txt', {
        dnsOverride: 'seal=1 ka=rsa p=QUJD',
        verifyOverride: true,
      });
      expect(r.fields.byteDesc).toMatch(desc);
    });
  }

  it('replaces the description with an absolute marker for an end-side literal', async () => {
    const body = te.encode(rec('QUJD', 'F~10'));
    const [r] = await validateBuffer(body, 'x.txt', {
      dnsOverride: 'seal=1 ka=rsa p=QUJD',
      verifyOverride: true,
    });
    expect(r.fields.byteDesc).toMatch(/^Absolute offset/);
  });

  it('appends the start-of-file note for an end-side F literal', async () => {
    const body = te.encode(rec('QUJD', 'F~F+9'));
    const [r] = await validateBuffer(body, 'x.txt', { dnsOverride: 'seal=1 ka=rsa p=QUJD' });
    expect(r.fields.byteDesc).toContain('start of file');
  });
});

describe('validateBuffer — missing filename fallback', () => {
  it('reports (unknown) with and without records', async () => {
    const [none] = await validateBuffer(te.encode('nothing to see here...........'));
    expect(none!.filename).toBe('(unknown)');

    const [r] = await validateBuffer(te.encode(rec('QUJD')), undefined, {
      dnsOverride: 'seal=1 ka=rsa p=QUJD',
      verifyOverride: true,
    });
    expect(r.valid).toBe(true);
    expect(r.filename).toBe('(unknown)');
  });
});

describe('validateBuffer — dnsOverrideMap', () => {
  it('honors a valid string override for the record domain', async () => {
    const body = te.encode(rec('QUJD'));
    const [r] = await validateBuffer(body, 'x.txt', {
      dnsOverrideMap: { 'example.com': 'seal=1 ka=rsa p=QUJD' },
      verifyOverride: true,
    });
    expect(r.valid).toBe(true);
  });

  it('honors object and array overrides', async () => {
    const body = te.encode(rec('QUJD'));
    for (const map of [
      { 'example.com': { seal: '1', ka: 'rsa', p: 'QUJD', _pBin: b64decode('QUJD') } },
      { 'example.com': ['seal=1 ka=rsa p=QUJD'] },
    ] as Array<Record<string, string | Array<string | SealDnsOverride>>>) {
      const [r] = await validateBuffer(body, 'x.txt', { dnsOverrideMap: map, verifyOverride: true });
      expect(r.valid).toBe(true);
    }
  });

  it('reports no DNS record when the map entry fails to parse', async () => {
    const body = te.encode(rec('QUJD'));
    const [r] = await validateBuffer(body, 'x.txt', {
      dnsOverrideMap: { 'example.com': 'ka=rsa' },
    });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/No SEAL DNS record found/);
  });
});

describe('validateBuffer — matching and inline fallbacks', () => {
  it('skips DNS records whose uid= disagrees with the record', async () => {
    const body = te.encode(rec('QUJD'));
    const [r] = await validateBuffer(body, 'x.txt', {
      dnsOverride: 'seal=1 ka=rsa p=QUJD uid=other',
      verifyOverride: true,
    });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/could not validate against any DNS record/);
  });

  it('reports cannot-authenticate when DNS has no pkd/pka for an inline record', async () => {
    const kp = await generateSealKeyPair('rsa');
    const rec = `<seal seal="1" d="example.com" ka="rsa" pk="${kp.spkiB64}" s="QUJD" b="F~S,s~f" />`;
    const [r] = await validateBuffer(te.encode(rec), 'x.txt', {
      dnsOverride: 'seal=1 ka=rsa p=QUJD',
      verifyOverride: true,
    });
    expect(r.valid).toBe(true);
    expect(r.auth).toBe(false);
  });

  it('resolves DNS for real (no override) via the DoH chain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ Answer: [{ type: 16, data: '"seal=1 ka=rsa p=QUJD"' }] }),
      }),
    );
    const [r] = await validateBuffer(te.encode(rec('QUJD')), 'x.txt', { verifyOverride: true });
    expect(r.valid).toBe(true);
  });
});
