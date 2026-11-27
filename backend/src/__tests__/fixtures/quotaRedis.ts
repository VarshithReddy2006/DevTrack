import { CONSUME_QUOTA_SCRIPT } from '../../modules/ai/quota.service.js';

// In-memory stand-in for `redis.eval(CONSUME_QUOTA_SCRIPT, ...)`. Redis runs a script
// without interleaving other commands, so the body below runs as one synchronous step.
// `ttls` holds the expiry in seconds; a value without an entry there means TTL -1.
export function quotaEval(values: Map<string, string>, ttls = new Map<string, number>()) {
  return async (script: string, numKeys: number, ...args: Array<string | number>): Promise<[number, number]> => {
    if (script !== CONSUME_QUOTA_SCRIPT || numKeys !== 1) {
      throw new Error('Unmocked Lua script in test');
    }
    // Yield first so concurrent callers really overlap before their script runs.
    await Promise.resolve();

    const [key, limitArg, ttlArg] = args.map(String);
    const limit = Number(limitArg);
    const ttl = Number(ttlArg);
    if (!values.has(key)) ttls.delete(key);

    const current = Number(values.get(key) ?? '0');
    if (current >= limit) {
      if (values.has(key) && !ttls.has(key)) ttls.set(key, ttl);
      return [0, current];
    }
    const used = current + 1;
    values.set(key, String(used));
    if (!ttls.has(key)) ttls.set(key, ttl);
    return [1, used];
  };
}
