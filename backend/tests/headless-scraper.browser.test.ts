import { describe, expect, it, vi } from 'vitest';
import puppeteer from 'puppeteer';
import { safeFetch, type RawResponse, type SafeFetchDeps } from '../src/modules/job-targets/safeFetch.js';
import { scrapeJobText } from '../src/modules/job-targets/workers/headlessScraper.js';

const text = Array.from({ length: 160 }, (_, index) => 'engineering' + index).join(' ');
const root = 'https://jobs.example/';
const raw = (html: string, headers = { 'content-type': 'text/html' }): RawResponse => ({ status: 200, headers, body: Buffer.from(html) });
describe('real sandboxed Chromium with public-address network fixtures', () => {
  // No real site is contacted. The actual safeFetch vetting and Chromium interception run.
  function fixtureFetch(pages: Record<string, RawResponse>, transport = vi.fn<SafeFetchDeps['request']>()) {
    transport.mockImplementation(async ({ url }) => pages[url.href] ?? raw('not found'));
    const network: SafeFetchDeps = { resolve: async () => ['93.184.216.34'], request: transport };
    return { fetch: (url: string, options = {}) => safeFetch(url, options, network), transport };
  }
  it('extracts a client-rendered posting via script and JSON GET, preserving relative redirects', async () => {
    const network = fixtureFetch({
      [root]: raw('<html><body><nav>unrelated navigation</nav><main id="job"></main><script src="/app.js"></script></body></html>'),
      [root + 'app.js']: raw("fetch('/old').then(r=>r.json()).then(data=>document.querySelector('#job').textContent=data.text)", { 'content-type': 'application/javascript' }),
      [root + 'old']: { status: 302, headers: { location: '/data' }, body: Buffer.alloc(0) },
      [root + 'data']: raw(JSON.stringify({ text }), { 'content-type': 'application/json' }),
    });
    expect(await scrapeJobText(root, { ...network, launch: options => puppeteer.launch(options) })).toBe(text);
    expect(network.transport.mock.calls.map(([request]) => request.url.href)).toEqual([root, root + 'app.js', root + 'old', root + 'data']);
  });
  it('aborts a redirect from a public subresource to cloud metadata without transport access', async () => {
    const network = fixtureFetch({
      [root]: raw('<html><body><main>' + text + '</main><script>fetch("/redirect")</script></body></html>'),
      [root + 'redirect']: { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' }, body: Buffer.alloc(0) },
    });
    await expect(scrapeJobText(root, { ...network, launch: options => puppeteer.launch(options) })).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    expect(network.transport.mock.calls.some(([request]) => request.url.hostname === '169.254.169.254')).toBe(false);
  });
  it('waits for delayed main content even when navigation already has 150 words', async () => {
    const network = fixtureFetch({
      [root]: raw('<html><body><nav>' + text + '</nav><main id="job"></main><script>setTimeout(() => {document.querySelector("#job").textContent=' + JSON.stringify(text) + '}, 1600)</script></body></html>'),
    });
    expect(await scrapeJobText(root, { ...network, launch: options => puppeteer.launch(options) })).toBe(text);
  });
});
