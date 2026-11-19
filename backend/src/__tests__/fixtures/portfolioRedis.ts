import { vi } from 'vitest';

export const values = new Map<string, { value: string; expiresAt?: number }>();
export const tags = new Map<string, Set<string>>();
function get(key: string): string | null {
  const entry = values.get(key);
  if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) { values.delete(key); return null; }
  return entry?.value ?? null;
}
export const portfolioRedis = {
  status: 'ready',
  mget: vi.fn(async (...keys: string[]) => keys.map(get)),
  del: vi.fn(async (...keys: string[]) => { for (const key of keys) values.delete(key); return keys.length; }),
  eval: vi.fn(async (script: string, count: number, ...args: Array<string | number>) => {
    const keys = args.slice(0, count).map(String);
    const argv = args.slice(count).map(String);
    if (script.includes('SMEMBERS')) {
      values.set(keys[0], { value: String(Number(get(keys[0]) ?? '0') + 1) });
      const members = tags.get(keys[1]) ?? new Set<string>();
      for (const key of members) if (get(`${key}:tag`) === argv[0]) { values.delete(key); values.delete(`${key}:tag`); }
      tags.delete(keys[1]);
      return members.size;
    }
    if ((get(keys[1]) ?? '0') !== argv[0]) return 0;
    const expiresAt = Date.now() + Number(argv[2]) * 1000;
    values.set(keys[0], { value: argv[1], expiresAt });
    values.set(keys[3], { value: argv[3], expiresAt });
    const members = tags.get(keys[2]) ?? new Set<string>();
    members.add(keys[0]); tags.set(keys[2], members);
    return 1;
  }),
};

export function resetPortfolioRedis() {
  values.clear(); tags.clear(); portfolioRedis.status = 'ready';
  portfolioRedis.mget.mockReset(); portfolioRedis.eval.mockReset(); portfolioRedis.del.mockReset();
}
