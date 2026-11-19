import type { Browser, HTTPRequest, LaunchOptions, Page } from 'puppeteer';
import { SafeFetchError, safeFetch } from '../safeFetch.js';

export const HEADLESS_TIMEOUT_MS = 10_000;
export const HEADLESS_MAX_BYTES = 5 * 1024 * 1024;
export const HEADLESS_MAX_REQUESTS = 100;
export const MIN_JOB_WORDS = 150;

// No direct browser egress: intercepted GETs are fulfilled through DNS-pinned safeFetch.
// The dead proxy also covers popups, WebSockets and browser background traffic.
export const SCRAPER_LAUNCH_OPTIONS: LaunchOptions = {
  headless: true,
  pipe: true,
  timeout: HEADLESS_TIMEOUT_MS,
  protocolTimeout: HEADLESS_TIMEOUT_MS,
  args: ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-quic', '--disable-background-networking',
    '--disable-extensions', '--disable-sync', '--disable-component-update',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--js-flags=--max-old-space-size=128'],
};

const CSP = "default-src 'none'; script-src http: https: 'unsafe-inline' 'unsafe-eval'; connect-src http: https:; style-src http: https: 'unsafe-inline'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin";
const allowedResources = new Set(['document', 'script', 'stylesheet', 'xhr', 'fetch']);

export interface ScraperDeps {
  launch: (options: LaunchOptions) => Promise<Browser>;
  fetch: typeof safeFetch;
}

const defaults: ScraperDeps = {
  launch: async options => (await import('puppeteer')).default.launch(options),
  fetch: safeFetch,
};

export function normalizeJobText(text: string): string {
  return text.normalize('NFKC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/gu, ' ').trim();
}

export function hasEnoughJobText(text: string): boolean {
  return normalizeJobText(text).split(/\s+/u).filter(Boolean).length >= MIN_JOB_WORDS;
}

async function closeWithin(work: () => Promise<unknown>, onFailure: () => void = () => undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('browser cleanup timeout')), 1000);
    })]);
  } catch { onFailure(); }
  finally { clearTimeout(timer); }
}

async function closeBrowser(browser: Browser): Promise<void> {
  await closeWithin(() => browser.close(), () => {
    try { browser.process()?.kill('SIGKILL'); } catch { /* Already exited. */ }
  });
}

/** One disposable sandboxed browser per bounded render; never retries with --no-sandbox. */
export async function scrapeJobText(url: string, deps: ScraperDeps = defaults): Promise<string> {
  const controller = new AbortController();
  let browser: Browser | undefined;
  let page: Page | undefined;
  let failure: unknown;
  let bytes = 0;
  let requests = 0;
  const pending = new Set<Promise<void>>();
  const deadline = Date.now() + HEADLESS_TIMEOUT_MS;
  const fail = (error: unknown) => {
    failure ??= error;
    controller.abort(failure);
  };
  const remaining = () => Math.max(1, deadline - Date.now());
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  // Always attach a handler, including if launch fails before Promise.race starts.
  void aborted.catch(() => undefined);
  const timer = setTimeout(() => fail(new SafeFetchError('TIMEOUT', 'headless render exceeded 10 seconds')), HEADLESS_TIMEOUT_MS);
  const handle = async (request: HTTPRequest) => {
    try {
      if (controller.signal.aborted) { await request.abort(); return; }
      const target = new URL(request.url());
      if (!['http:', 'https:'].includes(target.protocol)) throw new SafeFetchError('BLOCKED_PROTOCOL', 'browser protocol refused');
      if (target.port && target.port !== (target.protocol === 'https:' ? '443' : '80')) {
        throw new SafeFetchError('BLOCKED_PROTOCOL', 'nonstandard browser port refused');
      }
      if (request.method() !== 'GET' || !allowedResources.has(request.resourceType())) { await request.abort(); return; }
      // Serialize requests so the shared byte budget cannot be oversubscribed.
      const response = await deps.fetch(target.href, { maxBytes: HEADLESS_MAX_BYTES - bytes,
        timeoutMs: remaining(), followRedirects: false, signal: controller.signal,
        headers: { 'accept-encoding': 'identity' } });
      bytes += response.body.length;
      if (bytes > HEADLESS_MAX_BYTES) throw new SafeFetchError('RESPONSE_TOO_LARGE', 'headless payload exceeds 5MB');
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        throw new SafeFetchError('RESPONSE_TOO_LARGE', 'encoded browser payload refused');
      }
      const headers: Record<string, string> = {
        'content-type': response.headers['content-type'] ?? 'text/plain',
        'content-security-policy': CSP,
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      };
      if (response.headers.location) headers.location = response.headers.location;
      // No cookies, credentials or other browser headers are forwarded upstream.
      await request.respond({ status: response.status, headers, body: response.body });
    } catch (error) {
      fail(error);
      await request.abort().catch(() => undefined);
    }
  };
  let chain = Promise.resolve();
  const onRequest = (request: HTTPRequest) => {
    if (controller.signal.aborted || ++requests > HEADLESS_MAX_REQUESTS) {
      if (!controller.signal.aborted) fail(new SafeFetchError('RESPONSE_TOO_LARGE', 'too many browser requests'));
      void request.abort().catch(() => undefined);
      return;
    }
    const task = chain.then(() => handle(request));
    chain = task.catch(fail);
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(fail);
  };
  try {
    // Fetch the initial document before launching Chromium, rejecting SSRF without starting a browser.
    const initial = await Promise.race([deps.fetch(url, { maxBytes: HEADLESS_MAX_BYTES,
      timeoutMs: remaining(), signal: controller.signal, headers: { 'accept-encoding': 'identity' } }), aborted]);
    bytes += initial.body.length;
    if (bytes > HEADLESS_MAX_BYTES) throw new SafeFetchError('RESPONSE_TOO_LARGE', 'headless payload exceeds 5MB');
    if (initial.status < 200 || initial.status >= 300) throw new SafeFetchError('REQUEST_FAILED', 'headless document HTTP request failed');
    if (initial.headers['content-encoding'] && initial.headers['content-encoding'] !== 'identity') {
      throw new SafeFetchError('RESPONSE_TOO_LARGE', 'encoded browser payload refused');
    }
    // Close an eventual launch result even if cancellation wins the race first.
    const launching = deps.launch({ ...SCRAPER_LAUNCH_OPTIONS, timeout: remaining(), protocolTimeout: remaining(), signal: controller.signal });
    void launching.then(async launched => {
      if (controller.signal.aborted && browser !== launched) await closeBrowser(launched);
    }).catch(() => undefined);
    browser = await Promise.race([launching, aborted]);
    controller.signal.throwIfAborted();
    page = await Promise.race([browser.newPage(), aborted]);
    await Promise.race([(async () => {
      await page!.setBypassServiceWorker(true);
      await page!.setCacheEnabled(false);
      await page!.setRequestInterception(true);
    })(), aborted]);
    // Serve the already-vetted first document without a second network fetch.
    let first = true;
    page.on('request', request => {
      if (first && request.url() === initial.url && request.isNavigationRequest()) {
        first = false;
        const task = request.respond({ status: initial.status, headers: { 'content-type': 'text/html',
          'content-security-policy': CSP, 'cache-control': 'no-store' }, body: initial.body }).catch(fail);
        pending.add(task);
        void task.finally(() => pending.delete(task)).catch(fail);
      } else onRequest(request);
    });
    const render = async () => {
      await page!.goto(initial.url, { waitUntil: 'networkidle0', timeout: remaining() });
      // Dynamic pages can populate after their first request settles.
      await page!.waitForFunction(() => {
        const root = document.querySelector('main, article') as HTMLElement | null;
        return ((root ?? document.body)?.innerText.trim().split(/\s+/).length ?? 0) >= 150;
      },
        { timeout: remaining() });
      const text = await page!.evaluate(() => {
        document.querySelectorAll('script, style, noscript, nav, header, footer, iframe, svg').forEach(node => node.remove());
        const root = document.querySelector('main, article') as HTMLElement | null;
        return (root ?? document.body)?.innerText ?? '';
      });
      if (Buffer.byteLength(text) > HEADLESS_MAX_BYTES) throw new SafeFetchError('RESPONSE_TOO_LARGE', 'rendered text exceeds 5MB');
      return normalizeJobText(text).slice(0, 50_000);
    };
    const text = await Promise.race([render(), aborted]);
    if (failure) throw failure;
    if (!hasEnoughJobText(text)) throw new SafeFetchError('REQUEST_FAILED', 'rendered posting has fewer than 150 words');
    return text;
  } catch (error) {
    throw failure ?? error;
  } finally {
    clearTimeout(timer);
    controller.abort(new SafeFetchError('TIMEOUT', 'render finished'));
    controller.signal.removeEventListener('abort', onAbort);
    if (page) await closeWithin(() => page!.close());
    if (browser) await closeBrowser(browser);
    await closeWithin(() => Promise.allSettled(pending));
  }
}
