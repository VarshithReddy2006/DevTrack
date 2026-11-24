// src/shared/runtime/healthProbes.ts — liveness (/healthz) and readiness (/readyz) handlers
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Request, Response } from 'express';

export const MAX_EVENT_LOOP_LAG_MS = 500;
export const MAX_HEAP_RATIO = 0.9;
const DEPENDENCY_TIMEOUT_MS = 2000;

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let previousLagMs = Number.NaN;
const currentLagMs = () => loopDelay.count > 0 ? loopDelay.percentile(99) / 1e6 : Number.NaN;
// Probe traffic must not reset the histogram or hide pressure from other probes.
const samplingTimer = setInterval(() => {
  previousLagMs = currentLagMs();
  loopDelay.reset();
}, 1000);
samplingTimer.unref();

/** Conservative p99 across the previous and current one-second windows, in ms. */
export function readEventLoopLagMs(): number {
  const samples = [previousLagMs, currentLagMs()].filter(Number.isFinite);
  return samples.length ? Math.max(...samples) : Number.NaN;
}

export function livenessHandler() {
  return (_req: Request, res: Response): void => {
    // Transient overload sheds traffic through readiness, not restart loops.
    res.status(200).json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
    });
  };
}

export type CheckResult = 'up' | 'down' | 'skipped';

export interface ReadinessDeps {
  pingMongo: () => Promise<unknown>;
  /** Omit when Redis is not configured for this deployment. */
  pingRedis?: () => Promise<unknown>;
  /** Resolves when every queue answers; omit when Redis is not configured. */
  checkQueues?: () => Promise<unknown>;
  timeoutMs?: number;
  readRuntime?: () => { eventLoopP99Ms: number; heapUsedBytes: number; heapTotalBytes: number };
}

async function probe(fn: (() => Promise<unknown>) | undefined, timeoutMs: number): Promise<CheckResult> {
  if (!fn) return 'skipped';
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runReadiness(deps: ReadinessDeps) {
  const t = deps.timeoutMs ?? DEPENDENCY_TIMEOUT_MS;
  const [mongodb, redis, queues] = await Promise.all([
    probe(deps.pingMongo, t),
    probe(deps.pingRedis, t),
    probe(deps.checkQueues, t),
  ]);
  let runtime;
  try {
    if (deps.readRuntime) runtime = deps.readRuntime();
    else {
      const memory = process.memoryUsage();
      runtime = { eventLoopP99Ms: readEventLoopLagMs(), heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal };
    }
  } catch {
    runtime = { eventLoopP99Ms: NaN, heapUsedBytes: NaN, heapTotalBytes: NaN };
  }
  const validLag = Number.isFinite(runtime.eventLoopP99Ms) && runtime.eventLoopP99Ms >= 0;
  const validHeap = Number.isFinite(runtime.heapUsedBytes) && Number.isFinite(runtime.heapTotalBytes)
    && runtime.heapUsedBytes >= 0 && runtime.heapTotalBytes > 0 && runtime.heapUsedBytes <= runtime.heapTotalBytes;
  const heapRatio = validHeap ? runtime.heapUsedBytes / runtime.heapTotalBytes : null;
  const checks: Record<string, CheckResult> = { mongodb, redis, queues,
    eventLoop: validLag && runtime.eventLoopP99Ms <= MAX_EVENT_LOOP_LAG_MS ? 'up' : 'down',
    heap: heapRatio !== null && heapRatio <= MAX_HEAP_RATIO ? 'up' : 'down' };
  const diagnostics = {
    eventLoopP99Ms: validLag ? runtime.eventLoopP99Ms : null,
    heapUsedBytes: validHeap ? runtime.heapUsedBytes : null,
    heapTotalBytes: validHeap ? runtime.heapTotalBytes : null,
    heapRatio,
  };
  const ready = Object.values(checks).every((c) => c !== 'down');
  return { ready, checks, diagnostics };
}

export function readinessHandler(deps: ReadinessDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    const { ready, checks, diagnostics } = await runReadiness(deps);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks, diagnostics });
  };
}
