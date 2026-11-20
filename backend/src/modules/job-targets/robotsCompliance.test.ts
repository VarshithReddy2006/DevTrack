import { describe, expect, it, vi } from 'vitest';
import {
  BOT_USER_AGENT,
  RobotsCompliance,
  RobotsDisallowedError,
  ROBOTS_CACHE_TTL_MS,
  crawlDelayMs,
  isAllowed,
  parseRobots,
} from './robotsCompliance.js';

describe('parseRobots + isAllowed', () => {
  it('blocks a disallowed path for the wildcard group and allows the rest', () => {
    const r = parseRobots('User-agent: *\nDisallow: /jobs/\n');
    expect(isAllowed(r, '/jobs/123')).toBe(false);
    expect(isAllowed(r, '/careers/123')).toBe(true);
  });

  it('prefers the DevTrackBot group over *', () => {
    const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: DevTrackBot\nDisallow: /private\n');
    expect(isAllowed(r, '/jobs/1')).toBe(true);
    expect(isAllowed(r, '/private/x')).toBe(false);
  });

  it('uses the longest match and lets Allow win a tie', () => {
    const r = parseRobots('User-agent: *\nDisallow: /jobs/\nAllow: /jobs/public/\nDisallow: /same\nAllow: /same\n');
    expect(isAllowed(r, '/jobs/secret')).toBe(false);
    expect(isAllowed(r, '/jobs/public/1')).toBe(true);
    expect(isAllowed(r, '/same')).toBe(true);
  });

  it('supports * and $ in paths', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /search?*q=\n');
    expect(isAllowed(r, '/files/cv.pdf')).toBe(false);
    expect(isAllowed(r, '/files/cv.pdf.html')).toBe(true);
    expect(isAllowed(r, '/search?page=2&q=dev')).toBe(false);
  });

  it('treats an empty Disallow as allow-all and ignores comments, BOM and junk lines', () => {
    const r = parseRobots('﻿# hello\nUser-agent: * # everyone\nDisallow:\nnonsense line\n');
    expect(isAllowed(r, '/anything')).toBe(true);
  });

  it('shares one group across stacked User-agent lines', () => {
    const r = parseRobots('User-agent: googlebot\nUser-agent: devtrackbot\nDisallow: /x\n');
    expect(isAllowed(r, '/x/1')).toBe(false);
  });

  it('allows everything when there is no matching group', () => {
    expect(isAllowed(parseRobots('User-agent: otherbot\nDisallow: /\n'), '/jobs')).toBe(true);
    expect(isAllowed(parseRobots(''), '/jobs')).toBe(true);
  });
});

describe('crawlDelayMs', () => {
  it('defaults to 1 second and honours larger site values', () => {
    expect(crawlDelayMs(null)).toBe(1000);
    expect(crawlDelayMs(parseRobots('User-agent: *\nCrawl-delay: 5\n'))).toBe(5000);
  });
  it('never goes below 1 s and caps hostile values', () => {
    expect(crawlDelayMs(parseRobots('User-agent: *\nCrawl-delay: 0.2\n'))).toBe(1000);
    expect(crawlDelayMs(parseRobots('User-agent: *\nCrawl-delay: 99999\n'))).toBe(30_000);
    expect(crawlDelayMs(parseRobots('User-agent: *\nCrawl-delay: abc\n'))).toBe(1000);
  });
});

function setup(responses: Record<string, { status: number; body: string } | Error>) {
  let t = 1_000_000;
  const fetchRobots = vi.fn(async (origin: string) => {
    const r = responses[origin] ?? { status: 404, body: '' };
    if (r instanceof Error) throw r;
    return r;
  });
  const c = new RobotsCompliance({ fetchRobots, now: () => t });
  return { c, fetchRobots, advance: (ms: number) => { t += ms; } };
}

describe('RobotsCompliance.check', () => {
  it('rejects a disallowed path with a 422 robots_disallowed error', async () => {
    const { c } = setup({ 'https://jobs.example.com': { status: 200, body: 'User-agent: *\nDisallow: /jobs/\n' } });
    const err = await c.check('https://jobs.example.com/jobs/42').catch((e) => e);
    expect(err).toBeInstanceOf(RobotsDisallowedError);
    expect(err.code).toBe('robots_disallowed');
    expect(err.statusCode).toBe(422);
  });

  it('allows an allowed path and returns the identifying user agent', async () => {
    const { c } = setup({ 'https://jobs.example.com': { status: 200, body: 'User-agent: *\nDisallow: /admin\n' } });
    const r = await c.check('https://jobs.example.com/careers/42');
    expect(r.userAgent).toBe(BOT_USER_AGENT);
    expect(r.waitMs).toBe(0);
  });

  it('treats a missing robots.txt (404) as allow-all', async () => {
    const { c } = setup({});
    await expect(c.check('https://nofile.example.com/anything')).resolves.toMatchObject({ waitMs: 0 });
  });

  it('refuses when robots.txt cannot be fetched or returns a server error', async () => {
    const { c } = setup({
      'https://down.example.com': { status: 503, body: '' },
      'https://boom.example.com': new Error('ECONNRESET'),
    });
    await expect(c.check('https://down.example.com/jobs/1')).rejects.toBeInstanceOf(RobotsDisallowedError);
    await expect(c.check('https://boom.example.com/jobs/1')).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it('spaces requests to the same host by the default 1 s', async () => {
    const { c, advance } = setup({});
    expect((await c.check('https://a.example.com/1')).waitMs).toBe(0);
    expect((await c.check('https://a.example.com/2')).waitMs).toBe(1000);
    expect((await c.check('https://a.example.com/3')).waitMs).toBe(2000);
    advance(10_000);
    expect((await c.check('https://a.example.com/4')).waitMs).toBe(0);
  });

  it('uses the site Crawl-delay and keeps hosts independent', async () => {
    const { c } = setup({ 'https://slow.example.com': { status: 200, body: 'User-agent: *\nCrawl-delay: 4\n' } });
    await c.check('https://slow.example.com/1');
    expect((await c.check('https://slow.example.com/2')).waitMs).toBe(4000);
    expect((await c.check('https://other.example.com/1')).waitMs).toBe(0);
  });

  it('caches robots.txt for 24 hours and refetches after that', async () => {
    const { c, fetchRobots, advance } = setup({ 'https://a.example.com': { status: 200, body: 'User-agent: *\n' } });
    await c.check('https://a.example.com/1');
    await c.check('https://a.example.com/2');
    expect(fetchRobots).toHaveBeenCalledTimes(1);
    advance(ROBOTS_CACHE_TTL_MS + 1);
    await c.check('https://a.example.com/3');
    expect(fetchRobots).toHaveBeenCalledTimes(2);
  });

  it('does not reserve a slot for a rejected URL', async () => {
    const { c } = setup({ 'https://a.example.com': { status: 200, body: 'User-agent: *\nDisallow: /no\n' } });
    await expect(c.check('https://a.example.com/no')).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect((await c.check('https://a.example.com/yes')).waitMs).toBe(0);
  });

  it('matches against the query string too', async () => {
    const { c } = setup({ 'https://a.example.com': { status: 200, body: 'User-agent: *\nDisallow: /view?id=\n' } });
    await expect(c.check('https://a.example.com/view?id=9')).rejects.toBeInstanceOf(RobotsDisallowedError);
  });
});
