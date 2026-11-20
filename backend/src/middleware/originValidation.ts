// src/middleware/originValidation.ts — defence in depth against cross-site state changes.
//
// For POST/PUT/PATCH/DELETE:
//   - Origin (or, failing that, Referer) must be on the allowlist when the browser sends one
//   - Sec-Fetch-Site: cross-site is refused unless the Origin is explicitly allowlisted (a configured CORS origin)
//   - requests with none of these headers (curl, server-to-server) pass, since they carry their own bearer token
// Safe methods and exempt path prefixes (signed webhooks) are never checked here.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { errorResponse } from '../shared/response.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface OriginValidationOptions {
  /** Exact origins, or a wildcard subdomain such as https://*.preview.devtrack.sh. */
  allowedOrigins: string[];
  /** Path prefixes skipped entirely. These endpoints must verify their own signature. */
  exemptPathPrefixes?: string[];
  /** Called on each rejection, for monitoring. Must not throw. */
  onReject?: (info: { method: string; path: string; origin?: string; secFetchSite?: string; reason: string }) => void;
}

export const DEFAULT_EXEMPT_PREFIXES = ['/api/v2/webhooks/'];

function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Parses ALLOWED_ORIGINS style input: comma separated, blanks ignored. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function originMatches(origin: string, allowed: string[]): boolean {
  const o = normalizeOrigin(origin);
  if (!o) return false;
  const host = new URL(o);
  for (const entry of allowed) {
    const star = entry.match(/^(https?):\/\/\*\.(.+)$/i);
    if (star) {
      // *.example.com matches a.example.com and a.b.example.com, never example.com itself or evilexample.com.
      if (host.protocol === `${star[1].toLowerCase()}:` && host.hostname.endsWith(`.${star[2].toLowerCase()}`)) return true;
      continue;
    }
    if (normalizeOrigin(entry) === o) return true;
  }
  return false;
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function originValidation(options: OriginValidationOptions): RequestHandler {
  const exempt = options.exemptPathPrefixes ?? DEFAULT_EXEMPT_PREFIXES;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!STATE_CHANGING.has(req.method.toUpperCase())) return next();
    const path = req.originalUrl ?? req.url ?? '';
    if (exempt.some((p) => path.startsWith(p))) return next();

    const origin = header(req, 'origin');
    const referer = header(req, 'referer');
    const site = header(req, 'sec-fetch-site')?.toLowerCase();

    const reject = (reason: string): void => {
      try {
        options.onReject?.({ method: req.method, path, origin, secFetchSite: site, reason });
      } catch {
        // monitoring must not change the response
      }
      errorResponse(res, 'Forbidden', 'FORBIDDEN', 403);
    };

    if (origin !== undefined) {
      if (!originMatches(origin, options.allowedOrigins)) return reject('origin_not_allowed');
      return next(); // an allowlisted origin is a configured CORS origin, even when the browser calls it cross-site
    }

    if (site === 'cross-site') return reject('cross_site');

    if (referer !== undefined && !originMatches(referer, options.allowedOrigins)) {
      return reject('referer_not_allowed');
    }

    next();
  };
}
