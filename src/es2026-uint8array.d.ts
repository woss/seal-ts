// Ambient typings for the ES2026 Uint8Array base64/hex proposal (runtime support:
// Node 24+, Deno 2.x, Chrome 140+, Safari 18.2+, Firefox 133+).
// shortcut: TypeScript 5.9+ ships these in lib — delete this file after the TS bump.
interface Uint8Array {
  toBase64(options?: { alphabet?: 'base64' | 'base64url'; lastChunkHandling?: 'loose' | 'strict' | 'stop-on-partial' }): string;
  toHex(): string;
}
interface Uint8ArrayConstructor {
  fromBase64(
    s: string,
    options?: { alphabet?: 'base64' | 'base64url'; lastChunkHandling?: 'loose' | 'strict' | 'stop-on-partial' },
  ): Uint8Array;
  fromHex(s: string): Uint8Array;
}
