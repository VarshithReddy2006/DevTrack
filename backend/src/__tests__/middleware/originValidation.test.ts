import { describe, expect, it, vi } from 'vitest';
import { originMatches, originValidation, parseAllowedOrigins } from '../../middleware/originValidation.js';

const ALLOWED = ['https://devtrack.sh', 'https://app.devtrack.sh', 'https://*.preview.devtrack.sh'];

function run(method: string, headers: Record<string, string> = {}, url = '/api/v2/profile', onReject = vi.fn()) {
  const mw = originValidation({ allowedOrigins: ALLOWED, onReject });
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
  });
  it('supports wildcard subdomains but not the bare domain or lookalikes', () => {
    expect(originMatches('https://pr-12.preview.devtrack.sh', ALLOWED)).toBe(true);
    expect(originMatches('https://a.b.preview.devtrack.sh', ALLOWED)).toBe(true);
    expect(originMatches('https://preview.devtrack.sh', ALLOWED)).toBe(false);
    expect(originMatches('https://evilpreview.devtrack.sh', ALLOWED)).toBe(false);
    expect(originMatches('https://pr-12.preview.devtrack.sh.evil.com', ALLOWED)).toBe(false);
    expect(originMatches('http://pr-12.preview.devtrack.sh', ALLOWED)).toBe(false);
  });
  it('rejects junk, the null origin, and other schemes', () => {
    for (const bad of ['null', '', 'not a url', 'file:///etc/passwd', 'javascript:alert(1)', 'https://devtrack.sh.evil.com']) {
      expect(originMatches(bad, ALLOWED)).toBe(false);
    }
  });
});

describe('parseAllowedOrigins', () => {
  it('splits, trims and drops blanks', () => {
    expect(parseAllowedOrigins(' https://a.com , ,https://b.com ')).toEqual(['https://a.com', 'https://b.com']);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
});

describe('originValidation', () => {
  it('blocks cross-site state changes for every mutating method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const { res, next, onReject } = run(method, { 'sec-fetch-site': 'cross-site' });
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
      expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ reason: 'cross_site' }));
    }
  });

  it('allows same-origin, same-site and none', () => {
    for (const site of ['same-origin', 'same-site', 'none']) {
      expect(run('POST', { 'sec-fetch-site': site }).next).toHaveBeenCalledOnce();
    }
  });

  it('leaves safe methods alone, even cross-site', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(run(method, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.com' }).next).toHaveBeenCalledOnce();
    }
  });

  it('allows an allowlisted Origin, including when the browser reports cross-site', () => {
    expect(run('POST', { origin: 'https://app.devtrack.sh', 'sec-fetch-site': 'same-site' }).next).toHaveBeenCalledOnce();
    expect(run('POST', { origin: 'https://pr-9.preview.devtrack.sh', 'sec-fetch-site': 'cross-site' }).next).toHaveBeenCalledOnce();
  });

  it('blocks an Origin that is not on the list, even with a friendly Sec-Fetch-Site', () => {
    const { res, onReject } = run('POST', { origin: 'https://evil.com', 'sec-fetch-site': 'same-origin' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ reason: 'origin_not_allowed', origin: 'https://evil.com' }));
    expect(run('POST', { origin: 'null' }).res.status).toHaveBeenCalledWith(403);
  });

  it('falls back to Referer when there is no Origin', () => {
    expect(run('POST', { referer: 'https://app.devtrack.sh/settings' }).next).toHaveBeenCalledOnce();
    const bad = run('POST', { referer: 'https://evil.com/attack.html' });
    expect(bad.res.status).toHaveBeenCalledWith(403);
    expect(bad.onReject).toHaveBeenCalledWith(expect.objectContaining({ reason: 'referer_not_allowed' }));
  });

  it('lets non-browser clients through when no browser headers are present', () => {
    expect(run('POST', { authorization: 'Bearer x' }).next).toHaveBeenCalledOnce();
  });

  it('exempts webhook paths from the browser checks', () => {
    const { next } = run('POST', { origin: 'https://clerk.com', 'sec-fetch-site': 'cross-site' }, '/api/v2/webhooks/clerk');
    expect(next).toHaveBeenCalledOnce();
    // but a lookalike path is not exempt
    expect(run('POST', { 'sec-fetch-site': 'cross-site' }, '/api/v2/webhooksx/clerk').res.status).toHaveBeenCalledWith(403);
  });

  it('still answers 403 if the monitoring callback throws', () => {
    const mw = originValidation({ allowedOrigins: ALLOWED, onReject: () => { throw new Error('boom'); } });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    mw({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, originalUrl: '/x', url: '/x' } as never, res as never, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
