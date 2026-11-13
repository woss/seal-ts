/**
 * Unit tests for DNS TXT resolution — fetch is stubbed, no network touched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dnsLookup, parseDNSTXT } from './dns.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dnsLookup', () => {
  it('parses TXT answers from the first endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ Answer: [{ type: 16, data: '"seal=1 ka=rsa p=QUJD"' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const recs = await dnsLookup('example.com');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recs.length).toBe(1);
    expect(recs[0]!.p).toBe('QUJD');
  });

  it('concatenates multi-string TXT values and skips non-TXT answers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          Answer: [
            { type: 1, data: '1.2.3.4' },
            { type: 16, data: '"seal=1 " "ka=rsa p=QUJD"' },
          ],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const recs = await dnsLookup('example.com');
    expect(recs.length).toBe(1);
    expect(recs[0]!.ka).toBe('rsa');
  });

  it('skips non-TXT answers and TXT values without seal=1', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          Answer: [
            { type: 1, data: '1.2.3.4' },
            { type: 16, data: '"ka=rsa p=QUJD"' }, // parses but no seal=1 → skipped
          ],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const recs = await dnsLookup('example.com');
    expect(recs.length).toBe(0);
  });

  it('moves down the chain when an endpoint errors and stops on definitive empty', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ Status: 0 }) });
    vi.stubGlobal('fetch', fetchMock);
    const recs = await dnsLookup('example.com');
    expect(recs.length).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops the chain on a definitive empty answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
    const recs = await dnsLookup('example.com');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recs).toEqual([]);
  });

  it('treats a TXT answer with no data as empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ Answer: [{ type: 16 }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await dnsLookup('example.com')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls through non-ok responses to later endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
    const recs = await dnsLookup('example.com');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recs).toEqual([]);
  });

  it('falls through network errors to later endpoints', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const recs = await dnsLookup('example.com');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recs).toEqual([]);
  });

  it('falls through malformed JSON bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(new Error('bad json')) });
    vi.stubGlobal('fetch', fetchMock);
    const recs = await dnsLookup('example.com');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recs).toEqual([]);
  });
});

describe('parseDNSTXT', () => {
  it('parses unquoted values', () => {
    const f = parseDNSTXT('seal=1 ka=rsa p=QUJD');
    expect(f).not.toBeNull();
    expect(f!.seal).toBe('1');
    expect(f!.ka).toBe('rsa');
    expect(f!.p).toBe('QUJD');
    expect(f!._pBin).toEqual(new Uint8Array([65, 66, 67]));
  });

  it('parses quoted values', () => {
    expect(parseDNSTXT('seal="1" p="QUJD"')!.p).toBe('QUJD');
  });

  it('returns null without a seal= field', () => {
    expect(parseDNSTXT('ka=rsa p=QUJD')).toBeNull();
  });

  it('nulls _pBin on an invalid key', () => {
    const f = parseDNSTXT('seal=1 p=!!!');
    expect(f).not.toBeNull();
    expect(f!._pBin).toBeNull();
  });

  it('nulls _pkdBin on an invalid digest key', () => {
    const f = parseDNSTXT('seal=1 pkd=???');
    expect(f).not.toBeNull();
    expect(f!._pkdBin).toBeNull();
  });

  it('returns null on a malformed record', () => {
    expect(parseDNSTXT('1bad=')).toBeNull();
  });
});

describe('dnsLookup — chain behavior', () => {
  it('stops on answers whose TXT entries carry no seal= key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ Answer: [{ type: 16, data: '"v=spf1 -all"' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const recs = await dnsLookup('example.com');
    expect(recs).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts slow endpoints and falls through the chain', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, opts?: { signal?: AbortSignal }) =>
        new Promise<Response>((_, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const p = dnsLookup('example.com');
    await vi.advanceTimersByTimeAsync(15000);
    expect(await p).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
