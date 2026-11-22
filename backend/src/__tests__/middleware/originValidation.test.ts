import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXEMPT_PREFIXES,
  originMatches,
  originValidation,
  parseAllowedOrigins,
} from '../../middleware/originValidation.js';
import { env } from '../../config/index.js';

const ALLOWED = [
  'https://devtrack.sh',
  'https://app.devtrack.sh',
  'https://*.preview.devtrack.sh',
  'http://*.preview.local:3000',
];

function run(
  method: string,
  headers: Record<string, string> = {},
  url = '/api/v2/profile',
  onReject = vi.fn(),
  allowed = ALLOWED
) {
  const mw = originValidation({ allowedOrigins: allowed, onReject });
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn();
  mw({ method, headers, originalUrl: url, url } as never, res as never, next);
  return { res, next, onReject };
}

describe('originMatches', () => {
  it('matches exact origins and normalises case, default ports and trailing paths', () => {
    expect(originMatches('https://devtrack.sh', ALLOWED)).toBe(true);
    expect(originMatches('HTTPS://DevTrack.sh:443', ALLOWED)).toBe(true);
    expect(originMatches('https://devtrack.sh/some/page?q=1', ALLOWED)).toBe(true);
    expect(originMatches('https://app.devtrack.sh', ALLOWED)).toBe(true);
  });

  it('supports wildcard subdomains but not the bare domain or lookalikes', () => {
    expect(originMatches('https://pr-12.preview.devtrack.sh', ALLOWED)).toBe(true);
    expect(originMatches('https://a.b.preview.devtrack.sh', ALLOWED)).toBe(true);
    expect(originMatches('https://preview.devtrack.sh', ALLOWED)).toBe(false);
    expect(originMatches('https://evilpreview.devtrack.sh', ALLOWED)).toBe(false);
    expect(originMatches('https://pr-12.preview.devtrack.sh.evil.com', ALLOWED)).toBe(false);
    expect(originMatches('http://pr-12.preview.devtrack.sh', ALLOWED)).toBe(false);
  });

  it('validates port for wildcard origins', () => {
    // Port 8080 does not match https wildcard without port
    expect(originMatches('https://pr-12.preview.devtrack.sh:8080', ALLOWED)).toBe(false);
    // Matching port on port-specific wildcard
    expect(originMatches('http://pr-1.preview.local:3000', ALLOWED)).toBe(true);
    expect(originMatches('http://pr-1.preview.local:4000', ALLOWED)).toBe(false);
  });

  it('never allows malicious domains that merely contain a trusted domain name', () => {
    expect(originMatches('https://devtrack.sh.evil.com', ALLOWED)).toBe(false);
    expect(originMatches('https://notdevtrack.sh', ALLOWED)).toBe(false);
    expect(originMatches('https://evil-devtrack.sh', ALLOWED)).toBe(false);
  });

  it('rejects junk, the null origin, and invalid schemes', () => {
    for (const bad of [
      'null',
      '',
      'not a url',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://',
      'https://',
      '//evil.com',
    ]) {
      expect(originMatches(bad, ALLOWED)).toBe(false);
    }
  });
});

describe('parseAllowedOrigins', () => {
  it('splits, trims and drops blanks', () => {
    expect(parseAllowedOrigins(' https://a.com , ,https://b.com ')).toEqual(['https://a.com', 'https://b.com']);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('   ')).toEqual([]);
  });
});

describe('originValidation - Comprehensive Acceptance Criteria', () => {
  // 1. Same-origin requests
  it('1. allows same-origin requests', () => {
    expect(run('POST', { 'sec-fetch-site': 'same-origin', origin: 'https://devtrack.sh' }).next).toHaveBeenCalledOnce();
    // Same-origin navigation without Origin header
    expect(run('POST', { 'sec-fetch-site': 'same-origin' }).next).toHaveBeenCalledOnce();
  });

  // 2. Trusted configured origins
  it('2. allows explicitly configured trusted origins', () => {
    expect(run('POST', { origin: 'https://devtrack.sh' }).next).toHaveBeenCalledOnce();
    expect(run('POST', { origin: 'https://app.devtrack.sh' }).next).toHaveBeenCalledOnce();
    expect(run('PUT', { origin: 'https://devtrack.sh' }).next).toHaveBeenCalledOnce();
    expect(run('DELETE', { origin: 'https://app.devtrack.sh' }).next).toHaveBeenCalledOnce();
  });

  // 3. Untrusted origins
  it('3. rejects untrusted origins with 403 Forbidden', () => {
    const { res, onReject } = run('POST', { origin: 'https://evil.com' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ reason: 'origin_not_allowed', origin: 'https://evil.com' }));

    const attacker = run('POST', { origin: 'https://attacker.org' });
    expect(attacker.res.status).toHaveBeenCalledWith(403);
  });

  // 4. Sec-Fetch-Site cross-site requests
  it('4. rejects Sec-Fetch-Site cross-site requests when origin is missing or untrusted', () => {
    // Missing origin + cross-site
    const noOrigin = run('POST', { 'sec-fetch-site': 'cross-site' });
    expect(noOrigin.res.status).toHaveBeenCalledWith(403);
    expect(noOrigin.onReject).toHaveBeenCalledWith(expect.objectContaining({ reason: 'cross_site' }));

    // Untrusted origin + cross-site
    const untrusted = run('POST', { origin: 'https://evil.com', 'sec-fetch-site': 'cross-site' });
    expect(untrusted.res.status).toHaveBeenCalledWith(403);
    expect(untrusted.onReject).toHaveBeenCalledWith(expect.objectContaining({ reason: 'origin_not_allowed' }));
  });

  // 5. Missing Sec-Fetch-Site
  it('5. handles missing Sec-Fetch-Site safely', () => {
    // Trusted origin with missing Sec-Fetch-Site passes
    expect(run('POST', { origin: 'https://app.devtrack.sh' }).next).toHaveBeenCalledOnce();

    // Untrusted origin with missing Sec-Fetch-Site is rejected
    expect(run('POST', { origin: 'https://evil.com' }).res.status).toHaveBeenCalledWith(403);

    // Non-browser client (curl / mobile app / server-to-server) without browser headers passes
    expect(run('POST', { authorization: 'Bearer secret-token' }).next).toHaveBeenCalledOnce();
  });

  // 6. Malformed Origin headers
  it('6. handles malformed Origin headers safely without crashing', () => {
    const malformedCases = ['null', 'not-a-valid-url', 'javascript:alert(1)', 'file:///etc/hosts', 'http://'];
    for (const badOrigin of malformedCases) {
      const { res, onReject } = run('POST', { origin: badOrigin });
      expect(res.status).toHaveBeenCalledWith(403);
      expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ reason: 'origin_not_allowed' }));
    }
  });

  // 7. Referer fallback
  it('7. uses Referer as a fallback only when Origin is missing', () => {
    // Trusted Referer when Origin is absent
    expect(run('POST', { referer: 'https://app.devtrack.sh/settings' }).next).toHaveBeenCalledOnce();

    // Untrusted Referer when Origin is absent
    const bad = run('POST', { referer: 'https://evil.com/attack.html' });
    expect(bad.res.status).toHaveBeenCalledWith(403);
    expect(bad.onReject).toHaveBeenCalledWith(expect.objectContaining({ reason: 'referer_not_allowed' }));

    // Malformed Referer
    const malformed = run('POST', { referer: 'invalid-url' });
    expect(malformed.res.status).toHaveBeenCalledWith(403);

    // If Origin is present and untrusted, Referer cannot override it
    const spoofAttempt = run('POST', { origin: 'https://evil.com', referer: 'https://app.devtrack.sh/settings' });
    expect(spoofAttempt.res.status).toHaveBeenCalledWith(403);
    expect(spoofAttempt.onReject).toHaveBeenCalledWith(expect.objectContaining({ reason: 'origin_not_allowed' }));
  });

  // 8. Wildcard subdomains
  it('8. supports secure wildcard subdomains for preview deployments', () => {
    expect(run('POST', { origin: 'https://pr-9.preview.devtrack.sh', 'sec-fetch-site': 'cross-site' }).next).toHaveBeenCalledOnce();
    expect(run('POST', { origin: 'https://branch.sub.preview.devtrack.sh' }).next).toHaveBeenCalledOnce();
  });

  // 9. Malicious domain wildcard bypass attempts
  it('9. blocks malicious domain wildcard bypass attempts', () => {
    const bypassAttempts = [
      'https://preview.devtrack.sh',
      'https://evilpreview.devtrack.sh',
      'https://pr-9.preview.devtrack.sh.evil.com',
      'http://pr-9.preview.devtrack.sh',
      'https://pr-9.preview.devtrack.sh:8080',
    ];
    for (const bad of bypassAttempts) {
      const { res, onReject } = run('POST', { origin: bad });
      expect(res.status).toHaveBeenCalledWith(403);
      expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ reason: 'origin_not_allowed' }));
    }
  });

  // 10. GET, HEAD, OPTIONS safe methods
  it('10. leaves safe methods (GET, HEAD, OPTIONS) accessible', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(run(method, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.com' }).next).toHaveBeenCalledOnce();
      expect(run(method, { origin: 'null' }).next).toHaveBeenCalledOnce();
    }
  });

  // 11. POST, PUT, PATCH, DELETE state-changing methods
  it('11. enforces origin validation across all mutating methods (POST, PUT, PATCH, DELETE)', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      // Blocked on cross-site / untrusted
      const blocked = run(method, { 'sec-fetch-site': 'cross-site' });
      expect(blocked.res.status).toHaveBeenCalledWith(403);
      expect(blocked.next).not.toHaveBeenCalled();

      // Allowed on trusted origin
      const allowed = run(method, { origin: 'https://app.devtrack.sh' });
      expect(allowed.next).toHaveBeenCalledOnce();
    }
  });

  // 12. Webhook exemptions
  it('12. exempts designated webhook paths from browser origin checks', () => {
    const { next } = run(
      'POST',
      { origin: 'https://clerk.com', 'sec-fetch-site': 'cross-site' },
      '/api/v2/webhooks/clerk'
    );
    expect(next).toHaveBeenCalledOnce();

    // Lookalike paths are NOT exempt
    const lookalike = run('POST', { 'sec-fetch-site': 'cross-site' }, '/api/v2/webhooksx/clerk');
    expect(lookalike.res.status).toHaveBeenCalledWith(403);

    const normalApi = run('POST', { 'sec-fetch-site': 'cross-site' }, '/api/v2/quests');
    expect(normalApi.res.status).toHaveBeenCalledWith(403);
  });

  // Resilience: monitoring callback throws
  it('still answers 403 if the monitoring callback throws', () => {
    const mw = originValidation({
      allowedOrigins: ALLOWED,
      onReject: () => {
        throw new Error('monitoring crashed');
      },
    });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    mw(
      { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, originalUrl: '/x', url: '/x' } as never,
      res as never,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('13. Webhook HMAC verification integration', () => {
  let server: Server;
  let base: string;
  const WEBHOOK_SECRET = 'super-secret-signing-key-1234';

  beforeAll(async () => {
    const app = express();
    app.use(express.json());

    // Mount origin validation with standard webhook exemptions
    app.use(
      originValidation({
        allowedOrigins: ['https://devtrack.sh'],
        exemptPathPrefixes: DEFAULT_EXEMPT_PREFIXES,
      })
    );

    // Mock webhook route with HMAC signature verification middleware
    app.post('/api/v2/webhooks/clerk', (req: Request, res: Response) => {
      const signature = req.get('x-webhook-signature');
      if (!signature) {
        res.status(401).json({ error: 'Missing signature' });
        return;
      }

      const expected = createHmac('sha256', WEBHOOK_SECRET)
        .update(JSON.stringify(req.body))
        .digest('hex');

      if (signature !== expected) {
        res.status(401).json({ error: 'Invalid HMAC signature' });
        return;
      }

      res.status(200).json({ success: true, event: req.body.type });
    });

    server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('exempts webhook from origin checks but still verifies valid HMAC signature', async () => {
    const payload = { type: 'user.created', id: 'usr_123' };
    const validSignature = createHmac('sha256', WEBHOOK_SECRET)
      .update(JSON.stringify(payload))
      .digest('hex');

    // Cross-site request from clerk.com with VALID signature
    const response = await fetch(`${base}/api/v2/webhooks/clerk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://clerk.com',
        'Sec-Fetch-Site': 'cross-site',
        'x-webhook-signature': validSignature,
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.event).toBe('user.created');
  });

  it('exempts webhook from origin checks but rejects invalid HMAC signature with 401', async () => {
    const payload = { type: 'user.updated', id: 'usr_123' };

    // Cross-site request from clerk.com with INVALID signature
    const response = await fetch(`${base}/api/v2/webhooks/clerk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://clerk.com',
        'Sec-Fetch-Site': 'cross-site',
        'x-webhook-signature': 'invalid-tampered-signature',
      },
      body: JSON.stringify(payload),
    });

    // HMAC verification caught the forgery and returned 401, not bypassed
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Invalid HMAC signature');
  });

  it('rejects missing HMAC signature on webhook endpoint with 401', async () => {
    const payload = { type: 'user.deleted', id: 'usr_123' };

    const response = await fetch(`${base}/api/v2/webhooks/clerk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://clerk.com',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Missing signature');
  });
});

describe('14. Full Express server middleware chain integration', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    const allowed = ['https://devtrack.sh', 'https://*.preview.devtrack.sh'];

    // CORS middleware with originMatches
    app.use(
      cors({
        origin: (origin, callback) => {
          if (!origin || originMatches(origin, allowed)) {
            return callback(null, true);
          }
          return callback(null, false);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      })
    );

    // Origin validation middleware
    app.use(originValidation({ allowedOrigins: allowed }));

    app.use(express.json());

    // Test routes
    app.get('/api/test', (_req, res) => {
      res.json({ message: 'get ok' });
    });

    app.post('/api/test', (req, res) => {
      res.json({ message: 'post ok', body: req.body });
    });

    server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('sets CORS headers on preflight OPTIONS for allowed origin', async () => {
    const res = await fetch(`${base}/api/test`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://devtrack.sh',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://devtrack.sh');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('sets CORS headers on preflight OPTIONS for wildcard subdomain', async () => {
    const res = await fetch(`${base}/api/test`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://pr-42.preview.devtrack.sh',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://pr-42.preview.devtrack.sh');
  });

  it('does NOT set CORS headers for untrusted origin', async () => {
    const res = await fetch(`${base}/api/test`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('blocks untrusted POST request with 403 Forbidden', async () => {
    const res = await fetch(`${base}/api/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.com',
      },
      body: JSON.stringify({ action: 'tamper' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('FORBIDDEN');
    expect(body.success).toBe(false);
  });

  it('allows trusted POST request with 200 OK', async () => {
    const res = await fetch(`${base}/api/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://devtrack.sh',
      },
      body: JSON.stringify({ action: 'create' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('post ok');
    expect(body.body.action).toBe('create');
  });

  it('allows GET request regardless of origin', async () => {
    const res = await fetch(`${base}/api/test`, {
      method: 'GET',
      headers: {
        Origin: 'https://evil.com',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('get ok');
  });
});
