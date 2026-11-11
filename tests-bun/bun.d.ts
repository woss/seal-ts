// Runner module: typed locally so CI typecheck needs no bun-types dependency.
declare module 'bun:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function expect(value: unknown): { toBe(v: unknown): void; toEqual(v: unknown): void };
}
