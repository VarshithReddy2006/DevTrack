import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser, HTTPRequest } from 'puppeteer';
import { safeFetch, type RawResponse } from '../safeFetch.js';
import { HEADLESS_MAX_BYTES, HEADLESS_MAX_REQUESTS, SCRAPER_LAUNCH_OPTIONS, hasEnoughJobText, scrapeJobText } from './headlessScraper.js';

const text = Array.from({ length: 160 }, (_, index) => 'engineering' + index).join(' ');
const root = 'https://jobs.example/';
const raw = (html: string, headers = { 'content-type': 'text/html' }): RawResponse => ({ status: 200, headers, body: Buffer.from(html) });
const staticResponse = () => ({ ...raw('<main id="job"></main>'), url: root });
function browserFixture(subrequests: Array<{ url: string; method?: string; resource?: string }> = []) {
  const page = Object.assign(new EventEmitter(), {
    setBypassServiceWorker: vi.fn(), setCacheEnabled: vi.fn(), setRequestInterception: vi.fn(), close: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn(), waitForFunction: vi.fn(), evaluate: vi.fn(async () => text),
  });
  const requests: Array<{ abort: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> }> = [];
  page.goto.mockImplementation(async () => {
    for (const [index, spec] of [{ url: root, resource: 'document' }, ...subrequests].entries()) {
      await new Promise<void>((resolve, reject) => {
        const request = {
          url: () => spec.url, method: () => spec.method ?? 'GET', resourceType: () => spec.resource ?? 'fetch',
          isNavigationRequest: () => index === 0,
          abort: vi.fn(async () => { reject(new Error('request aborted')); }),
          respond: vi.fn(async () => { resolve(); }),
        };
        requests.push(request);
        page.emit('request', request as unknown as HTTPRequest);
      });
    }
  });
  const browser = { newPage: vi.fn(async () => page), close: vi.fn().mockResolvedValue(undefined), process: vi.fn(() => ({ kill: vi.fn() })) };
  const launch = vi.fn(async () => browser as unknown as Browser);
  const fetch = vi.fn<typeof safeFetch>(async () => staticResponse());
  return { page, browser, requests, deps: { launch, fetch } };
}
afterEach(() => { vi.useRealTimers(); });

describe('bounded headless scraper', () => {
  it('serves every request from safeFetch rather than browser networking and cleans up', async () => {
    const { deps, page, browser, requests } = browserFixture([{ url: root + 'app.js', resource: 'script' }]);
    expect(await scrapeJobText(root, deps)).toBe(text);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(deps.fetch.mock.calls[1][1]).toMatchObject({ followRedirects: false, maxBytes: HEADLESS_MAX_BYTES - staticResponse().body.length });
    expect(requests[1].respond.mock.calls[0][0].headers).not.toHaveProperty('set-cookie');
    expect(page.setBypassServiceWorker).toHaveBeenCalledWith(true);
    expect(page.setCacheEnabled).toHaveBeenCalledWith(false);
    expect(page.close).toHaveBeenCalledOnce(); expect(browser.close).toHaveBeenCalledOnce();
    expect(SCRAPER_LAUNCH_OPTIONS.args).not.toContain('--no-sandbox');
    expect(SCRAPER_LAUNCH_OPTIONS.args).toContain('--proxy-bypass-list=<-loopback>');
    expect(SCRAPER_LAUNCH_OPTIONS.pipe).toBe(true);
  });
  it.each(['http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'http://[::1]/', 'http://10.0.0.1/'])('rejects private subrequest %s without a transport call', async url => {
    const fixture = browserFixture([{ url }]);
    const transport = vi.fn(async () => raw('public'));
    fixture.deps.fetch.mockImplementation((target, options) => safeFetch(target, options, {
      resolve: async () => ['93.184.216.34'], request: transport,
    }));
    await expect(scrapeJobText(root, fixture.deps)).rejects.toMatchObject({ code: expect.stringMatching(/^BLOCKED_/) });
    expect(transport).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });
  it.each(['file:///etc/passwd', 'gopher://public.example/', 'https://jobs.example:9999/'])('aborts unsafe protocol/port %s', async url => {
    const { deps, browser } = browserFixture([{ url }]);
    await expect(scrapeJobText(root, deps)).rejects.toMatchObject({ code: 'BLOCKED_PROTOCOL' });
    expect(deps.fetch).toHaveBeenCalledOnce(); expect(browser.close).toHaveBeenCalledOnce();
  });
  it('rejects a private initial URL before launching Chromium', async () => {
    const { deps } = browserFixture();
    deps.fetch.mockImplementation((target, options) => safeFetch(target, options));
    await expect(scrapeJobText('http://localhost/', deps)).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
    expect(deps.launch).not.toHaveBeenCalled();
  });
  it('enforces the cumulative response budget and refuses encoded responses', async () => {
    const { deps, browser } = browserFixture([{ url: root + 'app.js' }]);
    deps.fetch.mockResolvedValueOnce({ ...staticResponse(), body: Buffer.alloc(HEADLESS_MAX_BYTES) });
    deps.fetch.mockResolvedValueOnce({ ...staticResponse(), body: Buffer.from('x') });
    await expect(scrapeJobText(root, deps)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(browser.close).toHaveBeenCalledOnce();
    deps.fetch.mockResolvedValueOnce({ ...staticResponse(), headers: { 'content-encoding': 'gzip' } });
    await expect(scrapeJobText(root, deps)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
  it('refuses over 100 intercepted resources', async () => {
    const { deps } = browserFixture(Array.from({ length: HEADLESS_MAX_REQUESTS + 1 }, (_, index) => ({ url: root + index })));
    await expect(scrapeJobText(root, deps)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(deps.fetch).toHaveBeenCalledTimes(HEADLESS_MAX_REQUESTS + 1);
  });
  it.each([{ method: 'POST', resource: 'fetch' }, { method: 'GET', resource: 'image' }])('never fetches unsupported browser traffic %j', async spec => {
    const { deps, requests } = browserFixture([{ url: root + 'extra', ...spec }]);
    await expect(scrapeJobText(root, deps)).rejects.toThrow('request aborted');
    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(requests[1].abort).toHaveBeenCalledOnce();
  });
  it('rejects a failed initial HTTP document and a compressed subresource', async () => {
    const { deps } = browserFixture();
    deps.fetch.mockResolvedValueOnce({ ...staticResponse(), status: 404 });
    await expect(scrapeJobText(root, deps)).rejects.toMatchObject({ code: 'REQUEST_FAILED' });
    expect(deps.launch).not.toHaveBeenCalled();
    const encoded = browserFixture([{ url: root + 'app.js', resource: 'script' }]);
    encoded.deps.fetch.mockResolvedValueOnce(staticResponse()).mockResolvedValueOnce({ ...staticResponse(), headers: { 'content-encoding': 'br' } });
    await expect(scrapeJobText(root, encoded.deps)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
  it('closes browser on page creation failure and rejects launch failure without a fallback sandbox flag', async () => {
    const { deps, browser } = browserFixture();
    browser.newPage.mockRejectedValueOnce(new Error('new page failed'));
    await expect(scrapeJobText(root, deps)).rejects.toThrow('new page failed');
    expect(browser.close).toHaveBeenCalledOnce();
    deps.launch.mockRejectedValueOnce(new Error('sandbox unavailable'));
    await expect(scrapeJobText(root, deps)).rejects.toThrow('sandbox unavailable');
    expect(deps.launch).toHaveBeenCalledTimes(2);
  });
  it('bounds hung rendering to ten seconds and closes the page and browser', async () => {
    vi.useFakeTimers();
    const { deps, page, browser } = browserFixture();
    page.goto.mockImplementation(() => new Promise(() => {}));
    const checked = expect(scrapeJobText(root, deps)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10000);
    await checked;
    expect(page.close).toHaveBeenCalledOnce(); expect(browser.close).toHaveBeenCalledOnce();
  });
  it('rejects sparse or oversized rendered text', async () => {
    const { deps, page } = browserFixture();
    page.evaluate.mockResolvedValueOnce('too short');
    await expect(scrapeJobText(root, deps)).rejects.toThrow('150 words');
    const oversized = browserFixture();
    oversized.page.evaluate.mockResolvedValueOnce('x'.repeat(HEADLESS_MAX_BYTES + 1));
    await expect(scrapeJobText(root, oversized.deps)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(hasEnoughJobText('word '.repeat(149))).toBe(false);
    expect(hasEnoughJobText('word '.repeat(150))).toBe(true);
  });
  it('closes a browser which finishes launching after the deadline', async () => {
    vi.useFakeTimers();
    const { deps, browser } = browserFixture();
    let launched!: (browser: Browser) => void;
    deps.launch.mockImplementationOnce(() => new Promise<Browser>(resolve => { launched = resolve; }));
    const checked = expect(scrapeJobText(root, deps)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10000);
    await checked;
    launched(browser as unknown as Browser);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.close).toHaveBeenCalledOnce();
  });
  it('kills its owned browser process when graceful cleanup hangs', async () => {
    vi.useFakeTimers();
    const { deps, browser } = browserFixture();
    const kill = vi.fn(); browser.process.mockReturnValue({ kill });
    browser.close.mockImplementationOnce(() => new Promise(() => {}));
    const scraped = scrapeJobText(root, deps);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await scraped).toBe(text);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });
});
