// src/shared/runtime/healthProbes.ts — liveness (/healthz) and readiness (/readyz) handlers
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Request, Response } from 'express';

export const MAX_EVENT_LOOP_LAG_MS = 100;
const DEPENDENCY_TIMEOUT_MS = 2000;

const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

/** Worst event-loop delay seen since the previous probe, in ms. */
export function readEventLoopLagMs(): number {
  const max = loopDelay.max / 1e6;
  loopDelay.reset();
  return Number.isFinite(max) ? max : 0;
}

export function livenessHandler(lagMs: () => number = readEventLoopLagMs) {
  return (_req: Request, res: Response): void => {
    const lag = lagMs();
    const ok = lag < MAX_EVENT_LOOP_LAG_MS;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'unhealthy',
      eventLoopLagMs: Math.round(lag * 10) / 10,
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

export async function runReadiness(deps: ReadinessDeps): Promise<{ ready: boolean; checks: Record<string, CheckResult> }> {
  const t = deps.timeoutMs ?? DEPENDENCY_TIMEOUT_MS;
  const [mongodb, redis, queues] = await Promise.all([
    probe(deps.pingMongo, t),
    probe(deps.pingRedis, t),
    probe(deps.checkQueues, t),
  ]);
  const checks = { mongodb, redis, queues };
  const ready = Object.values(checks).every((c) => c !== 'down');
  return { ready, checks };
}

export function readinessHandler(deps: ReadinessDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    const { ready, checks } = await runReadiness(deps);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks });
  };
}
