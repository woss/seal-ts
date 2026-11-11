import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The vendored validator must stay byte-identical to the upstream file this
 * package was built against. The 10-line VENDORED header is ours; everything
 * after it is the upstream body, pinned by sha256.
 *
 * A deliberate re-vendor updates BOTH the upstream file and the pinned hash
 * here and in the header, together.
 */
const UPSTREAM_SHA256 = '675383ec7b21402718009ec3317a52cfa57b962e2f2dc975503eae55e061b1fa';
const HEADER_LINES = 10;

describe('vendored seal-validator.js integrity', () => {
  it('upstream body matches the pinned upstream sha256', async () => {
    const path = fileURLToPath(new URL('./vendor/seal-validator.js', import.meta.url));
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n');
    expect(lines.slice(0, 4).join('\n')).toContain('VENDORED - DO NOT EDIT');
    const body = lines.slice(HEADER_LINES).join('\n');
    expect(createHash('sha256').update(body).digest('hex')).toBe(UPSTREAM_SHA256);
  });
});
