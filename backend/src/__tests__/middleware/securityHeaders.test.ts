import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPublicProfileShell } from '../../modules/profile/ogShell.routes.js';
import { PublicProfileService } from '../../modules/profile/publicProfile.service.js';
import { CSP_DIRECTIVES, securityHeaders } from '../../middleware/securityHeaders.js';

vi.mock('../../modules/profile/publicProfile.service.js', () => ({
  PublicProfileService: { getPublishedPreview: vi.fn() },
}));
vi.mock('../../shared/cache/cacheManager.js', () => ({
  cacheManager: { getOrSet: async (_key: string, load: () => Promise<unknown>) => load() },
}));

let server: Server | undefined;

async function start(isProd: boolean): Promise<string> {
  const app = express();
  app.use(securityHeaders({ isProd }));
  app.get('/page', (_req, res) => {
    res.type('html').send('<!doctype html><title>shell</title>');
  });
  app.get('/data', (_req, res) => {
    res.json({ ok: true });
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
}

async function stop(): Promise<void> {
  const current = server;
  server = undefined;
  if (current) await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
}

afterEach(stop);

function directives(header: string | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values.join(' '));
  }
  return map;
}

describe.each([
  ['production', true],
  ['non-production', false],
])('CSP in %s', (_label, isProd) => {
  it('forbids framing and plugins and pins the base URI', async () => {
    const base = await start(isProd);
    const response = await fetch(base + '/page');
    const policy = directives(response.headers.get('content-security-policy'));
    expect(policy.get('frame-ancestors')).toBe("'none'");
    expect(policy.get('object-src')).toBe("'none'");
    expect(policy.get('base-uri')).toBe("'self'");
    expect(policy.get('form-action')).toBe("'self'");
    expect(policy.get('frame-src')).toBe("'none'");
  });

  it('only lets scripts come from the same origin', async () => {
    const base = await start(isProd);
    const policy = directives((await fetch(base + '/page')).headers.get('content-security-policy'));
    expect(policy.get('default-src')).toBe("'self'");
    expect(policy.get('script-src')).toBe("'self'");
    expect(policy.get('script-src-attr')).toBe("'none'");
    expect(policy.get('connect-src')).toBe("'self'");
    expect(policy.get('style-src')).toBe("'self' 'unsafe-inline'");
    expect(policy.get('img-src')).toBe("'self' data: https:");
  });

  it('is sent on JSON responses and agrees with X-Frame-Options', async () => {
    const base = await start(isProd);
    const response = await fetch(base + '/data');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

it('sends the same policy in every environment', async () => {
  const prodBase = await start(true);
  const prod = (await fetch(prodBase + '/page')).headers.get('content-security-policy');
  await stop();
  const devBase = await start(false);
  const dev = (await fetch(devBase + '/page')).headers.get('content-security-policy');
  expect(dev).toBe(prod);
});

it('keeps the exported directives in step with what is served', async () => {
  const base = await start(false);
  const policy = directives((await fetch(base + '/page')).headers.get('content-security-policy'));
  expect(policy.get('frame-ancestors')).toBe(CSP_DIRECTIVES.frameAncestors.join(' '));
  expect(policy.get('script-src')).toBe(CSP_DIRECTIVES.scriptSrc.join(' '));
});

describe('HSTS', () => {
  it('pins includeSubDomains and preload in production', async () => {
    const base = await start(true);
    const hsts = (await fetch(base + '/page')).headers.get('strict-transport-security');
    expect(hsts).toBe('max-age=31536000; includeSubDomains; preload');
  });

  it('does not ask for preload outside production', async () => {
    const base = await start(false);
    const hsts = (await fetch(base + '/page')).headers.get('strict-transport-security');
    expect(hsts).not.toContain('preload');
  });
});

describe('public profile HTML shell', () => {
  it('gets the CSP too, and its redirect script is allowed by script-src', async () => {
    vi.mocked(PublicProfileService.getPublishedPreview).mockResolvedValue({
      displayName: 'Sam',
      description: 'Builds APIs',
      imageUrl: null,
      isIndexable: true,
    } as never);
    const app = express();
    app.use(securityHeaders({ isProd: false }));
    registerPublicProfileShell(app, 'https://portfolio.example.test');
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;

    const response = await fetch(base + '/u/sam');
    expect(response.status).toBe(200);
    const policy = directives(response.headers.get('content-security-policy'));
    expect(policy.get('frame-ancestors')).toBe("'none'");
    expect(policy.get('script-src')).toBe("'self'");
    const html = await response.text();
    // The shell only loads a same-origin script and has no inline script for the policy to block.
    expect(html).toContain('<script src="/u/.well-known/portfolio-redirect.js" defer></script>');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);

    const script = await fetch(base + '/u/.well-known/portfolio-redirect.js');
    expect(script.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});
