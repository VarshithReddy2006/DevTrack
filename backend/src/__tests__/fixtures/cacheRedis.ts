import { vi } from 'vitest';

// Deterministic Redis command boundary, including TTL and atomic generation
// semantics. Tests use real cache/service code and control DB-read interleavings.
export const entries = new Map<string, { value: string; expires?: number }>();
function read(key: string): string | null {
  const entry = entries.get(key);
  if (entry?.expires !== undefined && entry.expires <= Date.now()) {
    entries.delete(key);
    return null;
  }
  return entry?.value ?? null;
}
export const redis = {
  status: 'ready',
  mget: vi.fn(async (...keys: string[]) => keys.map(read)),
  eval: vi.fn(async (script: string, count: number, ...args: Array<string | number>) => {
    const keys = args.slice(0, count).map(String);
    if (script.includes("redis.call('INCR'")) {
      for (let i = 0; i < keys.length; i += 2) {
        entries.set(keys[i + 1], { value: String(Number(read(keys[i + 1]) ?? '0') + 1) });
        entries.delete(keys[i]);
      }
      return 1;
    }
    const [generation, data, ttl] = args.slice(count).map(String);
    if ((read(keys[1]) ?? '0') !== generation) return 0;
    entries.set(keys[0], { value: data, expires: Date.now() + Number(ttl) * 1000 });
    return 1;
  }),
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
