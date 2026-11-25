import { readFile } from 'node:fs/promises';
import puppeteer, { type LaunchOptions, type Page } from 'puppeteer';
import { logger } from '../../../shared/logger.js';

export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_MAX_QUEUE_SIZE = 32;
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000;
export const DEFAULT_LAUNCH_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RENDERS_PER_BROWSER = 500;
export const DEFAULT_MAX_MEMORY_BYTES = 512 * 1024 * 1024;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface PoolPageLike {
  close(): Promise<void>;
  metrics?(): Promise<{ JSHeapUsedSize?: number }>;
}

export interface PoolBrowserContextLike<TPage extends PoolPageLike = PoolPageLike> {
  newPage(): Promise<TPage>;
  close(): Promise<void>;
}

export interface PoolBrowserLike<TPage extends PoolPageLike = PoolPageLike> {
  connected?: boolean;
  isConnected?(): boolean;
  createBrowserContext?(): Promise<PoolBrowserContextLike<TPage>>;
  newPage(): Promise<TPage>;
  close(): Promise<void>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  process?(): { pid?: number } | null;
}

export interface BrowserPoolOptions<TPage extends PoolPageLike = Page> {
  /** Maximum number of concurrent active pages/renders (default: 4). */
  maxConcurrency?: number;
  /** Maximum number of queued waiters before failing fast with 503 (default: 32). */
  maxQueueSize?: number;
  /** Maximum wait time for a queued slot in milliseconds (default: 15000). */
  acquireTimeoutMs?: number;
  /** Maximum time allowed for Chromium launch in milliseconds (default: 15000). */
  launchTimeoutMs?: number;
  /** Recycle the underlying Chromium instance after this many renders (default: 500). */
  maxRendersPerBrowser?: number;
  /** Recycle the underlying Chromium instance when memory usage reaches this threshold (default: 512 MiB). */
  maxMemoryBytes?: number;
  /** Maximum time shutdown waits for active renders to finish before forcing close (default: 10000). */
  shutdownTimeoutMs?: number;
  /** Puppeteer launch options override. */
  launchOptions?: LaunchOptions;
  /** Custom browser launcher (primarily for testing). */
  launcher?: (options: LaunchOptions) => Promise<PoolBrowserLike<TPage>>;
  /** Custom memory probe returning bytes used by the browser process or page (primarily for testing). */
  getMemoryUsageBytes?: (browser: PoolBrowserLike<TPage>, page: TPage) => Promise<number | null> | number | null;
  /** Register SIGTERM/SIGINT handlers lazily when a browser is launched (default: false). */
  registerSignalHandlers?: boolean;
}

export interface BrowserPoolStats {
  hasBrowser: boolean;
  browserConnected: boolean;
  activeRenders: number;
  queuedRequests: number;
  renderCount: number;
  totalRenders: number;
  recycles: number;
  shuttingDown: boolean;
}

interface BrowserEntry<TPage extends PoolPageLike> {
  browser: PoolBrowserLike<TPage>;
  renderCount: number;
  activeCount: number;
  retiring: boolean;
  closePromise: Promise<void> | null;
  onDisconnected: () => void;
}

interface PageLease<TPage extends PoolPageLike> {
  entry: BrowserEntry<TPage>;
  context: PoolBrowserContextLike<TPage> | null;
  released: boolean;
}

interface QueueWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function createBusyError(): Error & { statusCode: number } {
  return Object.assign(new Error('PDF renderer is busy. Try again shortly.'), { statusCode: 503 });
}

function isBrowserConnected<TPage extends PoolPageLike>(browser: PoolBrowserLike<TPage>): boolean {
  if (typeof browser.connected === 'boolean') return browser.connected;
  if (typeof browser.isConnected === 'function') return browser.isConnected();
  return true;
}

async function readLinuxProcessRssBytes(pid: number): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

async function defaultMemoryProbe<TPage extends PoolPageLike>(
  browser: PoolBrowserLike<TPage>,
  page: TPage,
): Promise<number | null> {
  const pid = browser.process?.()?.pid;
  if (typeof pid === 'number' && pid > 0) {
    const rss = await readLinuxProcessRssBytes(pid);
    if (rss !== null) return rss;
  }
  if (typeof page.metrics === 'function') {
    try {
      const metrics = await page.metrics();
      if (typeof metrics?.JSHeapUsedSize === 'number') {
        return metrics.JSHeapUsedSize;
      }
    } catch {
      // Ignore metrics errors on closing or mocked pages.
    }
  }
  return null;
}

/**
 * Manages a single warm headless Chromium instance and dispenses isolated
 * incognito BrowserContexts per PDF render with bounded concurrency queuing,
 * automatic browser recycling, and graceful shutdown.
 */
export class BrowserPool<TPage extends PoolPageLike = Page> {
  private readonly maxConcurrency: number;
  private readonly maxQueueSize: number;
  private readonly acquireTimeoutMs: number;
  private readonly launchTimeoutMs: number;
  private readonly maxRendersPerBrowser: number;
  private readonly maxMemoryBytes: number;
  private readonly shutdownTimeoutMs: number;
  private readonly launchOptions: LaunchOptions;
  private readonly launcher: (options: LaunchOptions) => Promise<PoolBrowserLike<TPage>>;
  private readonly getMemoryUsageBytes: (
    browser: PoolBrowserLike<TPage>,
    page: TPage,
  ) => Promise<number | null> | number | null;
  private readonly registerSignalHandlers: boolean;

  private currentEntry: BrowserEntry<TPage> | null = null;
  private launchPromise: Promise<BrowserEntry<TPage>> | null = null;
  private readonly retiringEntries = new Set<BrowserEntry<TPage>>();
  private readonly leases = new Map<TPage, PageLease<TPage>>();
  private readonly waitQueue: QueueWaiter[] = [];
  private readonly drainWaiters: Array<() => void> = [];

  private activeSlots = 0;
  private totalRenders = 0;
  private recycles = 0;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private signalHandler: (() => void) | null = null;

  constructor(options: BrowserPoolOptions<TPage> = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.maxQueueSize = Math.max(0, options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);
    this.acquireTimeoutMs = Math.max(1, options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS);
    this.launchTimeoutMs = Math.max(1, options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS);
    this.maxRendersPerBrowser = Math.max(1, options.maxRendersPerBrowser ?? DEFAULT_MAX_RENDERS_PER_BROWSER);
    this.maxMemoryBytes = Math.max(1, options.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES);
    this.shutdownTimeoutMs = Math.max(1, options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
    this.launchOptions = {
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      timeout: this.launchTimeoutMs,
      protocolTimeout: this.launchTimeoutMs,
      ...options.launchOptions,
    };
    const defaultLauncher = (opts: LaunchOptions): Promise<PoolBrowserLike<Page>> => puppeteer.launch(opts);
    this.launcher = options.launcher ?? (defaultLauncher as unknown as (options: LaunchOptions) => Promise<PoolBrowserLike<TPage>>);
    this.getMemoryUsageBytes = options.getMemoryUsageBytes ?? defaultMemoryProbe;
    this.registerSignalHandlers = options.registerSignalHandlers ?? false;
  }

  /** Pre-warms the shared browser instance without blocking if already launched. */
  async warmUp(): Promise<void> {
    if (this.shuttingDown) {
      throw new Error('BrowserPool is shutting down');
    }
    await this.ensureBrowser();
  }

  /** Acquires an isolated incognito page from the warm browser pool. */
  async acquirePage(): Promise<TPage> {
    if (this.shuttingDown) {
      throw new Error('BrowserPool is shutting down');
    }

    await this.acquireSlot();
    if (this.shuttingDown) {
      this.releaseSlot();
      throw new Error('BrowserPool is shutting down');
    }

    let entry: BrowserEntry<TPage> | null = null;
    let context: PoolBrowserContextLike<TPage> | null = null;
    let page: TPage | null = null;

    try {
      entry = await this.ensureBrowser();
      entry.activeCount++;

      context = typeof entry.browser.createBrowserContext === 'function'
        ? await entry.browser.createBrowserContext()
        : null;
      page = context ? await context.newPage() : await entry.browser.newPage();

      this.leases.set(page, { entry, context, released: false });
      return page;
    } catch (error) {
      if (page) {
        await page.close().catch(closeError => {
          logger.warn('[BrowserPool] Failed to close page after acquire error', { error: String(closeError) });
        });
      }
      if (context) {
        await context.close().catch(closeError => {
          logger.warn('[BrowserPool] Failed to close browser context after acquire error', { error: String(closeError) });
        });
      }
      if (entry) {
        entry.activeCount = Math.max(0, entry.activeCount - 1);
        if (entry.retiring && entry.activeCount === 0) {
          void this.closeEntry(entry);
        }
      }
      this.releaseSlot();
      throw error;
    }
  }

  /** Closes the page and its isolated browser context, then returns capacity to the pool. */
  async releasePage(page: TPage): Promise<void> {
    const lease = this.leases.get(page);
    if (!lease || lease.released) {
      return;
    }

    lease.released = true;
    this.leases.delete(page);
    const { entry, context } = lease;

    let shouldRecycle = false;
    try {
      const memoryBytes = await Promise.resolve(this.getMemoryUsageBytes(entry.browser, page)).catch(() => null);
      if (typeof memoryBytes === 'number' && memoryBytes >= this.maxMemoryBytes) {
        shouldRecycle = true;
        logger.info('[BrowserPool] Recycling browser due to memory threshold', {
          memoryBytes,
          maxMemoryBytes: this.maxMemoryBytes,
          renderCount: entry.renderCount + 1,
        });
      }
    } finally {
      await page.close().catch(error => {
        logger.warn('[BrowserPool] Could not close PDF page', { error: String(error) });
      });
      if (context) {
        await context.close().catch(error => {
          logger.warn('[BrowserPool] Could not close PDF browser context', { error: String(error) });
        });
      }

      entry.renderCount++;
      this.totalRenders++;
      if (!shouldRecycle && entry.renderCount >= this.maxRendersPerBrowser) {
        shouldRecycle = true;
        logger.info('[BrowserPool] Recycling browser after max render count', {
          renderCount: entry.renderCount,
          maxRendersPerBrowser: this.maxRendersPerBrowser,
        });
      }

      if (shouldRecycle && this.currentEntry === entry) {
        this.retireEntry(entry);
        this.recycles++;
      }

      entry.activeCount = Math.max(0, entry.activeCount - 1);
      if (entry.retiring && entry.activeCount === 0) {
        await this.closeEntry(entry);
      }

      this.releaseSlot();
    }
  }

  /** Runs a callback with an isolated page and guarantees context cleanup on success or failure. */
  async withPage<T>(fn: (page: TPage) => Promise<T>): Promise<T> {
    const page = await this.acquirePage();
    try {
      return await fn(page);
    } finally {
      await this.releasePage(page);
    }
  }

  getStats(): BrowserPoolStats {
    return {
      hasBrowser: this.currentEntry !== null,
      browserConnected: this.currentEntry !== null && isBrowserConnected(this.currentEntry.browser),
      activeRenders: this.activeSlots,
      queuedRequests: this.waitQueue.length,
      renderCount: this.currentEntry?.renderCount ?? 0,
      totalRenders: this.totalRenders,
      recycles: this.recycles,
      shuttingDown: this.shuttingDown,
    };
  }

  /** Gracefully drains active renders and closes any running Chromium instances. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shuttingDown = true;
    this.shutdownPromise = this.performShutdown();
    try {
      await this.shutdownPromise;
    } finally {
      this.shutdownPromise = null;
    }
  }

  /** Alias for shutdown() that also allows re-use after tests reset state. */
  async close(): Promise<void> {
    await this.shutdown();
    this.shuttingDown = false;
  }

  private async performShutdown(): Promise<void> {
    this.detachSignalHandlers();

    // Reject any pending queued waiters immediately.
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      clearTimeout(waiter.timer);
      waiter.reject(new Error('BrowserPool is shutting down'));
    }

    // Wait for any in-flight browser launch to settle before closing.
    if (this.launchPromise) {
      await this.launchPromise.catch(() => undefined);
    }

    // Wait for active renders to finish up to shutdownTimeoutMs.
    if (this.activeSlots > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>(resolve => {
          this.drainWaiters.push(resolve);
        }),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, this.shutdownTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      this.drainWaiters.length = 0;
    }

    if (this.currentEntry) {
      this.retireEntry(this.currentEntry);
    }

    const toClose = [...this.retiringEntries];
    await Promise.all(toClose.map(entry => this.closeEntry(entry)));
  }

  private acquireSlot(): Promise<void> {
    if (this.activeSlots < this.maxConcurrency) {
      this.activeSlots++;
      return Promise.resolve();
    }

    if (this.waitQueue.length >= this.maxQueueSize) {
      return Promise.reject(createBusyError());
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: QueueWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waitQueue.indexOf(waiter);
          if (idx !== -1) {
            this.waitQueue.splice(idx, 1);
          }
          reject(createBusyError());
        }, this.acquireTimeoutMs),
      };
      this.waitQueue.push(waiter);
    });
  }

  private releaseSlot(): void {
    const next = this.waitQueue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
      return;
    }

    this.activeSlots = Math.max(0, this.activeSlots - 1);
    if (this.activeSlots === 0 && this.drainWaiters.length > 0) {
      const waiters = this.drainWaiters.splice(0, this.drainWaiters.length);
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  private async ensureBrowser(): Promise<BrowserEntry<TPage>> {
    if (this.currentEntry && !this.currentEntry.retiring && isBrowserConnected(this.currentEntry.browser)) {
      return this.currentEntry;
    }

    if (this.currentEntry && !isBrowserConnected(this.currentEntry.browser)) {
      this.retireEntry(this.currentEntry);
    }

    if (this.launchPromise) {
      return this.launchPromise;
    }

    this.launchPromise = (async () => {
      const browser = await this.launcher(this.launchOptions);
      if (this.shuttingDown) {
        await browser.close().catch(() => undefined);
        throw new Error('BrowserPool is shutting down');
      }

      const entry: BrowserEntry<TPage> = {
        browser,
        renderCount: 0,
        activeCount: 0,
        retiring: false,
        closePromise: null,
        onDisconnected: () => {
          this.retireEntry(entry);
          if (entry.activeCount === 0) {
            void this.closeEntry(entry);
          }
        },
      };

      browser.on?.('disconnected', entry.onDisconnected);
      this.currentEntry = entry;
      this.attachSignalHandlers();
      return entry;
    })();

    try {
      return await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }

  private retireEntry(entry: BrowserEntry<TPage>): void {
    entry.retiring = true;
    if (this.currentEntry === entry) {
      this.currentEntry = null;
    }
    this.retiringEntries.add(entry);
  }

  private closeEntry(entry: BrowserEntry<TPage>): Promise<void> {
    if (entry.closePromise) {
      return entry.closePromise;
    }
    entry.retiring = true;
    if (this.currentEntry === entry) {
      this.currentEntry = null;
    }
    entry.browser.off?.('disconnected', entry.onDisconnected);
    entry.closePromise = entry.browser
      .close()
      .catch(error => {
        logger.warn('[BrowserPool] Could not close PDF browser', { error: String(error) });
      })
      .finally(() => {
        this.retiringEntries.delete(entry);
      });
    return entry.closePromise;
  }

  private attachSignalHandlers(): void {
    if (!this.registerSignalHandlers || this.signalHandler) {
      return;
    }
    this.signalHandler = () => {
      void this.shutdown();
    };
    process.on('SIGTERM', this.signalHandler);
    process.on('SIGINT', this.signalHandler);
  }

  private detachSignalHandlers(): void {
    if (!this.signalHandler) {
      return;
    }
    process.off('SIGTERM', this.signalHandler);
    process.off('SIGINT', this.signalHandler);
    this.signalHandler = null;
  }
}

export const browserPool = new BrowserPool<Page>({
  registerSignalHandlers: true,
});

export async function shutdownBrowserPool(): Promise<void> {
  await browserPool.shutdown();
}

export async function resetBrowserPool(): Promise<void> {
  await browserPool.close();
}
