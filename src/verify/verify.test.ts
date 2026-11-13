/**
 * Direct tests for the native verify modules (src/verify/*).
 *
 * The upstream suite exercises the facade; this file exercises the native
 * modules directly — including the positive-crypto path (sign with our
 * signer, validate natively) that the upstream vectors lack.
 */
import { describe, expect, it } from 'vitest';

import { generateSealKeyPair } from '../sign/keygen.js';
import { importPrivateKey } from '../sign/keyutil.js';
import { sealSign } from '../sign/signer.js';
import { parseDNSTXT } from './dns.js';
import { findAllSEALRecords,parseSEALRecord } from './parse.js';
import { computeByteRanges } from './ranges.js';
import { detectFormat, scanByFormat } from './scan.js';
import { validateBuffer } from './validate.js';

const te = new TextEncoder();

describe('parse (native)', () => {
  it('parses a standard record', () => {
    const rec = parseSEALRecord(
      te.encode('<seal seal="1" d="example.com" p="abc" />'),
      0,
      0,
    );
    expect(rec).not.toBeNull();
    expect(rec!.fields.d).toBe('example.com');
    expect(rec!.fields.p).toBe('abc');
  });

  it('locates records with signature offsets', () => {
    const body = te.encode('hello <seal seal="1" d="example.com" s="QUJD" /> world');
    const recs = findAllSEALRecords(body);
    expect(recs.length).toBe(1);
    expect(recs[0].rawSigStart).toBeGreaterThan(0);
    expect(recs[0].rawSigEnd).toBeGreaterThan(recs[0].rawSigStart);
  });
});

describe('ranges (native)', () => {
  it('computes F~f as the whole file', () => {
    const { ranges, error } = computeByteRanges('F~f', 100, 10, 20, 0, 0);
    expect(error).toBeNull();
    expect(ranges).toEqual([[0, 100]]);
  });

  it('blanks the signature value', () => {
    const { ranges, error } = computeByteRanges('F~S,s~f', 100, 40, 60, 0, 0);
    expect(error).toBeNull();
    expect(ranges).toEqual([
      [0, 40],
      [60, 100],
    ]);
  });
});

describe('scan (native)', () => {
  it('detects formats like the vendor', () => {
    expect(detectFormat(te.encode('%PDF-1.4 ...'))).toBe('pdf');
    expect(detectFormat(te.encode('hello world'))).toBe('text');
  });

  it('finds a text-embedded record', () => {
    const bytes = te.encode('data data <seal seal="1" d="example.com" s="QUJD" /> end');
    const recs = scanByFormat(bytes);
    expect(recs.length).toBe(1);
    expect(recs[0].fields.d).toBe('example.com');
  });
});

describe('dns (native)', () => {
  it('parses TXT fields', () => {
    const f = parseDNSTXT('seal=1 ka=rsa p=KEYKEY');
    expect(f).not.toBeNull();
    expect(f!.p).toBe('KEYKEY');
    expect(f!.ka).toBe('rsa');
  });
});

describe('native end-to-end (signer → native verifier)', () => {
  it('validates a freshly signed text file', async () => {
    const kp = await generateSealKeyPair('rsa');
    const key = await importPrivateKey(kp.pkcs8B64, kp.alg);
    const domain = 'example.com';
    const body = te.encode('The quick brown fox jumps over the lazy dog.');

    const { embedded } = await sealSign(body, {
      domain,
      id: 'doc-001',
      key,
      alg: 'rsa',
    });

    const dns = `seal=1 ka=rsa p=${kp.spkiB64}`;
    const results = await validateBuffer(embedded, 'doc.txt', { dnsOverride: dns });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const r = results[0];
    expect(r.valid).toBe(true);
    expect(r.auth).toBe(true);
    expect(r.revoked).toBe(false);
    expect(r.error).toBeNull();
    expect(r.domain).toBe(domain);
  });

  it('rejects a tampered body', async () => {
    const kp = await generateSealKeyPair('rsa');
    const key = await importPrivateKey(kp.pkcs8B64, kp.alg);
    const body = te.encode('The quick brown fox jumps over the lazy dog.');

    const { embedded } = await sealSign(body, {
      domain: 'example.com',
      id: 'doc-001',
      key,
      alg: 'rsa',
    });

    // Flip one covered byte (first byte of the body)
    const tampered = new Uint8Array(embedded);
    tampered[0] = tampered[0] ^ 0x01;

    const dns = `seal=1 ka=rsa p=${kp.spkiB64}`;
    const results = await validateBuffer(tampered, 'doc.txt', { dnsOverride: dns });
    expect(results[0].valid).toBe(false);
    expect(results[0].error).toMatch(/signature mismatch/i);
  });

  it('flags a revoked key before crypto', async () => {
    const kp = await generateSealKeyPair('rsa');
    const key = await importPrivateKey(kp.pkcs8B64, kp.alg);
    const body = te.encode('revocation test body');

    const { embedded } = await sealSign(body, {
      domain: 'example.com',
      id: 'doc-revoke',
      key,
      alg: 'rsa',
    });

    const dns = `seal=1 ka=rsa p=${kp.spkiB64} r=20200101000000`;
    const results = await validateBuffer(embedded, 'doc.txt', { dnsOverride: dns });
    expect(results[0].valid).toBe(false);
    expect(results[0].revoked).toBe(true);
    expect(results[0].error).toMatch(/revoke/i);
  });
});

describe('native validateBuffer negative paths', () => {
  it('reports no record', async () => {
    const results = await validateBuffer(te.encode('no seal here'), 'x.txt');
    expect(results.length).toBe(1);
    expect(results[0].error).toMatch(/No SEAL record/i);
  });

  it('reports missing DNS when the override lacks seal=1', async () => {
    const body = te.encode('<seal seal="1" d="example.com" s="QUJD" kv="1" />');
    const results = await validateBuffer(body, 'x.txt', { dnsOverride: 'ka=rsa p=QUJD' });
    expect(results[0].valid).toBe(false);
    expect(results[0].error).toMatch(/No SEAL DNS record found/i);
  });
});
