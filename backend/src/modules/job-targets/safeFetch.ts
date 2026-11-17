// src/modules/job-targets/safeFetch.ts — SSRF-guarded HTTP fetch for job-description URLs.
// Only the isolated worker-ai process may call this; the API process never resolves user URLs.
//
// Rules: http(s) only, no embedded credentials, every resolved address must be public,
// the connection is pinned to the address that was validated (so a second DNS answer
// cannot swap in a private one), redirects are followed by hand and re-validated per
// hop (max 3), body capped at 2 MB, total time capped at 10 s.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const SAFE_FETCH_MAX_REDIRECTS = 3;
export const SAFE_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const SAFE_FETCH_TIMEOUT_MS = 10_000;

export type SafeFetchErrorCode =
  | 'INVALID_URL'
  | 'BLOCKED_PROTOCOL'
  | 'BLOCKED_HOST'
  | 'BLOCKED_ADDRESS'
  | 'DNS_FAILED'
  | 'TOO_MANY_REDIRECTS'
  | 'BAD_REDIRECT'
  | 'RESPONSE_TOO_LARGE'
  | 'TIMEOUT'
  | 'REQUEST_FAILED';

export class SafeFetchError extends Error {
  constructor(public readonly code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
  });
}

/** Expands any valid IPv6 text form to eight 16-bit groups. */
function expandV6(ip: string): number[] | null {
  let s = ip.split('%')[0].toLowerCase();
  const v4tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const n = ipv4ToInt(v4tail[1]);
    s = s.slice(0, -v4tail[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => parseInt(g, 16));
  return out.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? null : out;
}

function isBlockedV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true; // unparseable: refuse
  const embeddedV4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), :: and ::1
    return g[5] === 0 && g[6] === 0 && g[7] <= 1 ? true : isBlockedV4(embeddedV4);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedV4(embeddedV4); // NAT64
  if (g[0] === 0x2002) return isBlockedV4(`${g[1] >> 8}.${g[1] & 0xff}.${g[2] >> 8}.${g[2] & 0xff}`); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/** True when the address must never be fetched from the server. */
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true;
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home.arpa'];

export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h === 'metadata' || h === 'metadata.google.internal' || BLOCKED_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface SafeFetchResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface SafeFetchOptions {
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface SafeFetchDeps {
  /** Returns every address the host resolves to. */
  resolve: (hostname: string) => Promise<string[]>;
  /** Performs one request to an already validated address. Must not follow redirects. */
  request: (target: { url: URL; ip: string; headers: Record<string, string>; timeoutMs: number; maxBytes: number }) => Promise<RawResponse>;
}

const defaultResolve = async (hostname: string): Promise<string[]> => {
  try {
    const rows = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return rows.map((r) => r.address);
  } catch (err) {
    throw new SafeFetchError('DNS_FAILED', `could not resolve ${hostname}: ${(err as Error).message}`);
  }
};

const defaultRequest: SafeFetchDeps['request'] = ({ url, ip, headers, timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: { 'user-agent': 'DevTrack-JobFetcher/1.0', accept: 'text/html,text/plain,application/json;q=0.9', ...headers },
        // Pin the socket to the address that passed validation. SNI and the Host header still use the hostname.
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          const family = net.isIP(ip);
          if (opts && opts.all) cb(null, [{ address: ip, family }]);
          else cb(null, ip, family);
        }) as unknown as net.LookupFunction,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            done(() => reject(new SafeFetchError('RESPONSE_TOO_LARGE', `response exceeds ${maxBytes} bytes`)));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          done(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])),
              body: Buffer.concat(chunks),
            }),
          ),
        );
        res.on('error', (e) => done(() => reject(new SafeFetchError('REQUEST_FAILED', e.message))));
      },
    );
    req.on('timeout', () => {
      done(() => reject(new SafeFetchError('TIMEOUT', `no response within ${timeoutMs} ms`)));
      req.destroy();
    });
    req.on('error', (e) => done(() => reject(e instanceof SafeFetchError ? e : new SafeFetchError('REQUEST_FAILED', e.message))));
    req.end();
  });

const defaultDeps: SafeFetchDeps = { resolve: defaultResolve, request: defaultRequest };

/** Parses and screens a URL string, returning the URL and the address to connect to. */
async function vet(raw: string, deps: SafeFetchDeps): Promise<{ url: URL; ip: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError('INVALID_URL', 'not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('BLOCKED_PROTOCOL', `protocol ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) throw new SafeFetchError('INVALID_URL', 'credentials in the URL are not allowed');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(host)) throw new SafeFetchError('BLOCKED_HOST', `host ${host} is not allowed`);

  const addresses = net.isIP(host) ? [host] : await deps.resolve(host);
  if (addresses.length === 0) throw new SafeFetchError('DNS_FAILED', `no addresses for ${host}`);
  // Every answer must be public; one private record is enough to refuse (rebinding mixes them).
  const bad = addresses.find(isBlockedAddress);
  if (bad) throw new SafeFetchError('BLOCKED_ADDRESS', `${host} resolves to a non-public address`);
  return { url, ip: addresses[0] };
}

export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
  deps: SafeFetchDeps = defaultDeps,
): Promise<SafeFetchResponse> {
  const maxRedirects = options.maxRedirects ?? SAFE_FETCH_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? SAFE_FETCH_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SafeFetchError('TIMEOUT', `exceeded ${timeoutMs} ms`);

    const { url, ip } = await vet(current, deps);
    const res = await deps.request({ url, ip, headers: options.headers ?? {}, timeoutMs: remaining, maxBytes });

    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop === maxRedirects) throw new SafeFetchError('TOO_MANY_REDIRECTS', `more than ${maxRedirects} redirects`);
      try {
        current = new URL(res.headers.location, url).toString();
      } catch {
        throw new SafeFetchError('BAD_REDIRECT', 'redirect target is not a valid URL');
      }
      continue; // the next loop vets the new target from scratch
    }
    return { status: res.status, url: url.toString(), headers: res.headers, body: res.body };
  }
  throw new SafeFetchError('TOO_MANY_REDIRECTS', `more than ${maxRedirects} redirects`);
}
