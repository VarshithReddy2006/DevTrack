// src/middleware/securityHeaders.ts - helmet configuration (CSP, HSTS, framing) for every response
import helmet from 'helmet';
import type { RequestHandler } from 'express';

/**
 * Content-Security-Policy for responses served by the API. The only HTML the
 * backend renders is the public profile shell and the PDF export markup, so the
 * policy stays tight: same-origin scripts, no plugins, no framing.
 *
 * helmet merges these with its own defaults (base-uri 'self', form-action 'self',
 * script-src-attr 'none', upgrade-insecure-requests), then frameAncestors
 * replaces the default 'self' so nobody can embed a backend page.
 */
export const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'https:'],
  connectSrc: ["'self'"],
  fontSrc: ["'self'"],
  objectSrc: ["'none'"],
  mediaSrc: ["'self'"],
  frameSrc: ["'none'"],
  frameAncestors: ["'none'"],
};

export interface SecurityHeadersOptions {
  /** Production pins HSTS with includeSubDomains and preload; other envs keep helmet's default HSTS. */
  isProd: boolean;
}

/** The CSP is the same in every environment so dev and test see what prod sees. */
export function securityHeaders({ isProd }: SecurityHeadersOptions): RequestHandler {
  return helmet({
    contentSecurityPolicy: { directives: CSP_DIRECTIVES },
    // X-Frame-Options agrees with frame-ancestors 'none' for browsers that ignore CSP.
    frameguard: { action: 'deny' },
    hsts: isProd ? {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    } : undefined,
  });
}
