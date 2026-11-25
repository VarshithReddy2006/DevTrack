import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserPool,
  type PoolBrowserContextLike,
  type PoolBrowserLike,
  type PoolPageLike,
} from '../../../../modules/resume/export/browserPool.js';

interface FakePage extends PoolPageLike {
  id: string;
  closed: boolean;
  metricsData?: { JSHeapUsedSize?: number };
}

interface FakeContext extends PoolBrowserContextLike<FakePage> {
  id: string;
  closed: boolean;
  pages: FakePage[];
}

interface FakeBrowser extends PoolBrowserLike<FakePage> {
  id: string;
  closed: boolean;
  connected: boolean;
  contexts: FakeContext[];
  emitDisconnect: () => void;
}

function createFakeBrowserHarness(options: {
  failNewPageOnContext?: number;
  metricsHeapBytes?: number;
  launchDelayMs?: number;
} = {}) {
  const browsers: FakeBrowser[] = [];
  let browserSeq = 0;
  let contextSeq = 0;
  let pageSeq = 0;

  const launcher = vi.fn(async (): Promise<FakeBrowser> => {
    if (options.launchDelayMs) {
      await new Promise(resolve => setTimeout(resolve, options.launchDelayMs));
    }

    const emitter = new EventEmitter();
    const browserId = `browser-${++browserSeq}`;
    const contexts: FakeContext[] = [];

    const browser: FakeBrowser = {
      id: browserId,
      closed: false,
      connected: true,
      contexts,
      on(event, listener) {
        emitter.on(event, listener);
        return this;
      },
      off(event, listener) {
        emitter.off(event, listener);
        return this;
      },
      emitDisconnect() {
        browser.connected = false;
        emitter.emit('disconnected');
      },
      async createBrowserContext() {
        const ctxNumber = ++contextSeq;
        const pages: FakePage[] = [];
        const ctx: FakeContext = {
          id: `ctx-${ctxNumber}`,
          closed: false,
          pages,
          async newPage() {
            if (options.failNewPageOnContext === ctxNumber) {
              throw new Error('newPage failed');
            }
            const page: FakePage = {
              id: `page-${++pageSeq}`,
              closed: false,
              async close() {
                page.closed = true;
              },
              async metrics() {
                return { JSHeapUsedSize: options.metricsHeapBytes ?? 1024 };
              },
            };
            pages.push(page);
            return page;
          },
          async close() {
            ctx.closed = true;
          },
        };
        contexts.push(ctx);
        return ctx;
      },
      async newPage() {
        const ctx = await browser.createBrowserContext!();
        return ctx.newPage();
      },
      async close() {
        browser.closed = true;
        browser.connected = false;
      },
    };

    browsers.push(browser);
    return browser;
  });

  return { launcher, browsers };
}

const poolsToCleanup: Array<BrowserPool<FakePage>> = [];

function createPool(
  harness: ReturnType<typeof createFakeBrowserHarness>,
  overrides: ConstructorParameters<typeof BrowserPool<FakePage>>[0] = {},
) {
  const pool = new BrowserPool<FakePage>({
    launcher: harness.launcher,
    ...overrides,
  });
  poolsToCleanup.push(pool);
  return pool;
}

afterEach(async () => {
  vi.useRealTimers();
  while (poolsToCleanup.length > 0) {
    const pool = poolsToCleanup.pop()!;
    await pool.close();
  }
});

describe('BrowserPool', () => {
  it('shares a single warm browser across concurrent initial requests and isolates contexts', async () => {
    const harness = createFakeBrowserHarness({ launchDelayMs: 20 });
    const pool = createPool(harness, { maxConcurrency: 4 });

    const seenPages: FakePage[] = [];
    await Promise.all(
      [1, 2, 3, 4].map(i =>
        pool.withPage(async page => {
          seenPages.push(page);
          return i;
        }),
      ),
    );

    expect(harness.launcher).toHaveBeenCalledTimes(1);
    expect(harness.browsers).toHaveLength(1);
    const [browser] = harness.browsers;
    expect(browser.closed).toBe(false);
    expect(browser.contexts).toHaveLength(4);
    expect(new Set(seenPages.map(p => p.id)).size).toBe(4);
    expect(browser.contexts.every(c => c.closed)).toBe(true);
    expect(seenPages.every(p => p.closed)).toBe(true);
    expect(pool.getStats()).toMatchObject({
      hasBrowser: true,
      browserConnected: true,
      activeRenders: 0,
      queuedRequests: 0,
      renderCount: 4,
      totalRenders: 4,
    });
  });

  it('closes page and context even when the render callback throws, and makes releasePage idempotent', async () => {
    const harness = createFakeBrowserHarness();
    const pool = createPool(harness);

    await expect(
      pool.withPage(async () => {
        throw new Error('render boom');
      }),
    ).rejects.toThrow('render boom');

    const [browser] = harness.browsers;
    expect(browser.contexts).toHaveLength(1);
    expect(browser.contexts[0].closed).toBe(true);
    expect(browser.contexts[0].pages[0].closed).toBe(true);
    expect(pool.getStats().activeRenders).toBe(0);

    const page = await pool.acquirePage();
    await pool.releasePage(page);
    await pool.releasePage(page);
    expect(pool.getStats().activeRenders).toBe(0);
    expect(pool.getStats().totalRenders).toBe(2);
  });

  it('cleans up the created context and releases slot if newPage throws', async () => {
    const harness = createFakeBrowserHarness({ failNewPageOnContext: 1 });
    const pool = createPool(harness, { maxConcurrency: 1 });

    await expect(pool.acquirePage()).rejects.toThrow('newPage failed');

    expect(harness.browsers[0].contexts[0].closed).toBe(true);
    expect(pool.getStats().activeRenders).toBe(0);

    const next = await pool.withPage(async p => p.id);
    expect(next).toBe('page-1');
  });

  it('enforces maxConcurrency with FIFO queuing and rejects queue overflow with 503', async () => {
    const harness = createFakeBrowserHarness();
    const pool = createPool(harness, { maxConcurrency: 2, maxQueueSize: 2, acquireTimeoutMs: 5000 });

    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });

    const order: string[] = [];
    const r1 = pool.withPage(async () => {
      order.push('start-1');
      await firstGate;
      order.push('end-1');
    });
    const r2 = pool.withPage(async () => {
      order.push('start-2');
      await secondGate;
      order.push('end-2');
    });

    await vi.waitFor(() => expect(pool.getStats().activeRenders).toBe(2));

    const r3 = pool.withPage(async () => {
      order.push('run-3');
      return 3;
    });
    const r4 = pool.withPage(async () => {
      order.push('run-4');
      return 4;
    });

    expect(pool.getStats().queuedRequests).toBe(2);
    await expect(pool.withPage(async () => 5)).rejects.toMatchObject({ statusCode: 503 });

    releaseFirst();
    releaseSecond();

    expect(await Promise.all([r1, r2, r3, r4])).toEqual([undefined, undefined, 3, 4]);
    expect(order.indexOf('run-3')).toBeLessThan(order.indexOf('run-4'));
  });

  it('times out queued waiters with 503 after acquireTimeoutMs', async () => {
    vi.useFakeTimers();
    const harness = createFakeBrowserHarness();
    const pool = createPool(harness, { maxConcurrency: 1, maxQueueSize: 4, acquireTimeoutMs: 100 });

    let releaseFirst!: () => void;
    const first = pool.withPage(
      () => new Promise<void>(resolve => { releaseFirst = resolve; }),
    );
    await vi.waitFor(() => expect(pool.getStats().activeRenders).toBe(1));

    const queued = expect(pool.withPage(async () => 'never')).rejects.toMatchObject({ statusCode: 503 });
    await vi.advanceTimersByTimeAsync(120);
    await queued;
    expect(pool.getStats().queuedRequests).toBe(0);

    releaseFirst();
    await first;
  });

  it('recycles the browser after maxRendersPerBrowser without interrupting in-flight renders', async () => {
    const harness = createFakeBrowserHarness();
    const pool = createPool(harness, { maxConcurrency: 2, maxRendersPerBrowser: 2 });

    let finishSlow!: () => void;
    const slowRender = pool.withPage(
      () => new Promise<string>(resolve => { finishSlow = () => resolve('slow'); }),
    );
    await vi.waitFor(() => expect(pool.getStats().activeRenders).toBe(1));

    await pool.withPage(async () => 'fast-1');
    // Second render completes while first is still active -> retired on next completion or at count=2.
    await pool.withPage(async () => 'fast-2');

    const [firstBrowser] = harness.browsers;
    expect(firstBrowser.closed).toBe(false);
    expect(pool.getStats().recycles).toBe(1);

    // New render starts on a brand-new browser while slowRender still holds firstBrowser open.
    const onNewBrowser = await pool.withPage(async () => 'fresh');
    expect(onNewBrowser).toBe('fresh');
    expect(harness.browsers).toHaveLength(2);
    expect(firstBrowser.closed).toBe(false);

    finishSlow();
    expect(await slowRender).toBe('slow');
    expect(firstBrowser.closed).toBe(true);
    expect(harness.browsers[1].closed).toBe(false);
  });

  it('recycles the browser when memory usage reaches maxMemoryBytes', async () => {
    const harness = createFakeBrowserHarness();
    let reportedBytes = 100 * 1024 * 1024;
    const pool = createPool(harness, {
      maxMemoryBytes: 256 * 1024 * 1024,
      getMemoryUsageBytes: () => reportedBytes,
    });

    await pool.withPage(async () => 'under-limit');
    expect(harness.browsers).toHaveLength(1);
    expect(harness.browsers[0].closed).toBe(false);

    reportedBytes = 300 * 1024 * 1024;
    await pool.withPage(async () => 'over-limit');
    expect(harness.browsers[0].closed).toBe(true);
    expect(pool.getStats().recycles).toBe(1);

    reportedBytes = 50 * 1024 * 1024;
    await pool.withPage(async () => 'fresh-browser');
    expect(harness.browsers).toHaveLength(2);
    expect(harness.browsers[1].closed).toBe(false);
  });

  it('automatically recovers by launching a new browser after unexpected disconnect', async () => {
    const harness = createFakeBrowserHarness();
    const pool = createPool(harness);

    await pool.withPage(async () => 'first');
    expect(harness.browsers).toHaveLength(1);

    harness.browsers[0].emitDisconnect();
    expect(pool.getStats().browserConnected).toBe(false);

    await pool.withPage(async () => 'recovered');
    expect(harness.browsers).toHaveLength(2);
    expect(harness.browsers[1].connected).toBe(true);
  });

  it('drains active renders, rejects queued waiters, and closes browser on shutdown and SIGTERM', async () => {
    const harness = createFakeBrowserHarness();
    const initialSigtermCount = process.listenerCount('SIGTERM');
    const pool = createPool(harness, {
      maxConcurrency: 1,
      registerSignalHandlers: true,
      shutdownTimeoutMs: 5000,
    });

    let started = false;
    let finishActive!: () => void;
    const active = pool.withPage(
      () => new Promise<string>(resolve => {
        started = true;
        finishActive = () => resolve('done');
      }),
    );
    await vi.waitFor(() => expect(started).toBe(true));
    expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount + 1);

    const queued = expect(pool.withPage(async () => 'queued')).rejects.toThrow('shutting down');

    // Simulate SIGTERM delivery.
    const handler = process.listeners('SIGTERM').at(-1)!;
    handler('SIGTERM');

    await queued;
    expect(harness.browsers[0].closed).toBe(false);

    finishActive();
    expect(await active).toBe('done');
    await vi.waitFor(() => expect(harness.browsers[0].closed).toBe(true));
    expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount);
  });
});
