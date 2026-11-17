import type { Application } from 'express';

/**
 * Parse the TRUST_PROXY env var: the number of reverse proxies (hops) sitting
 * between the internet and this process, e.g. 1 for Render or the nginx
 * container in docker-compose.prod.yml.
 *
 * Unset, empty or 0 means "no proxy" and returns undefined so Express keeps its
 * default (req.ip is the socket address). Anything that is not a plain
 * non-negative integer throws, so a typo like "true" fails at startup instead
 * of silently trusting every X-Forwarded-For header.
 */
export function parseTrustProxy(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`TRUST_PROXY must be a non-negative integer (number of proxy hops). Got: ${raw}`);
  }
  const hops = Number(value);
  if (!Number.isSafeInteger(hops) || hops > 32) {
    throw new Error(`TRUST_PROXY must be between 0 and 32. Got: ${raw}`);
  }
  return hops === 0 ? undefined : hops;
}

/** Make req.ip (and the IP-keyed rate limiters) use the client address behind a proxy. */
export function configureTrustProxy(app: Application, hops: number | undefined): void {
  if (hops !== undefined) app.set('trust proxy', hops);
}
