/**
 * DNS TXT resolution and SEAL DNS-record parsing
 * (mirrors the C `SealDnsTXT` / `SealDnsParse` and the upstream DoH chain).
 */
import { b64decode,enc } from './bytes.js';
import { parseSEALRecord,type SealRecordFields } from './parse.js';

/**
 * DNS-over-HTTPS lookup for TXT records at `domain`.
 * DoH chain: Google → Quad9 → Cloudflare, 5-second abort each.
 * A valid response with no Answer is definitive-empty (stops the chain).
 * Returns an array of parsed DNS record field objects (may be empty).
 */
export async function dnsLookup(domain: string): Promise<Array<SealRecordFields & { _pBin?: Uint8Array | null; _pkdBin?: Uint8Array | null }>> {
  const dohEndpoints = [
    `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=TXT`,
    `https://dns.quad9.net:5053/dns-query?name=${encodeURIComponent(domain)}&type=TXT`,
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`,
  ];

  let records: Array<SealRecordFields & { _pBin?: Uint8Array | null; _pkdBin?: Uint8Array | null }> = [];
  for (const url of dohEndpoints) {
    try {
      const resp = await fetchWithTimeout(url, { headers: { Accept: 'application/dns-json' } }, 5000);
      if (!resp.ok) {continue;}
      const data = (await resp.json()) as { Answer?: Array<{ type?: number; data?: string }> };
      // A valid response with no Answer means the domain exists but has no
      // TXT records — treat as definitive empty and stop trying.
      if (!data.Answer) {
        records = [];
        break;
      }

      for (const ans of data.Answer) {
        if (ans.type !== 16) {continue;} // TXT = 16
        // Strip surrounding quotes and concatenate strings
        const txt = (ans.data || '').replace(/^"|"$/g, '').replace(/"\s*"/g, '').trim();
        const rec = parseDNSTXT(txt);
        if (rec) {records.push(rec);}
      }
      // Got a definitive answer — stop.
      break;
    } catch {
      /* timeout or network error — try next endpoint */
    }
  }

  return records;
}

async function fetchWithTimeout(url: string, opts: RequestInit, ms = 5000): Promise<Response> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Parse a SEAL DNS TXT record.
 * The C code wraps it in "<seal ... />" and re-uses SealParse().
 * DNS TXT values may use unquoted OR quoted attributes.
 * Returns the parsed fields object (with _pBin/_pkdBin decoded), or null.
 */
export function parseDNSTXT(txt: string): (SealRecordFields & { _pBin?: Uint8Array | null; _pkdBin?: Uint8Array | null }) | null {
  // Wrap as a synthetic SEAL record so our parser can handle it
  const synthetic = enc.encode('<seal ' + txt + ' />');
  const result = parseSEALRecord(synthetic, 0, 0);
  if (!result) {return null;}
  const f = result.fields;
  if (!f.seal) {return null;}

  // Pre-decode the public key to binary (mirrors @p-bin in C)
  if (f.p) {
    try {
      f._pBin = b64decode(f.p);
    } catch {
      f._pBin = null;
    }
  }
  if (f.pkd) {
    try {
      f._pkdBin = b64decode(f.pkd);
    } catch {
      f._pkdBin = null;
    }
  }
  return f;
}
