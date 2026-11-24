import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
const histogram = vi.hoisted(() => ({ count: 10, percentile: vi.fn(() => 20e6), reset: vi.fn(), enable: vi.fn() }));
vi.mock('node:perf_hooks', () => ({ monitorEventLoopDelay: vi.fn(() => histogram) }));
import { livenessHandler, readinessHandler, readEventLoopLagMs, runReadiness } from '../../../shared/runtime/healthProbes.js';
const healthy = { eventLoopP99Ms: 10, heapUsedBytes: 50, heapTotalBytes: 100 };
const deps = (runtime = healthy) => ({ pingMongo: async () => true, readRuntime: () => runtime });
beforeEach(() => { histogram.count = 10; histogram.percentile.mockReturnValue(20e6); histogram.reset.mockClear(); });
describe('runtime pressure readiness', () => {
  it('reads p99 in milliseconds without resetting on repeated probes', () => {
    histogram.percentile.mockReturnValue(900e6);
    expect(readEventLoopLagMs()).toBe(900); expect(readEventLoopLagMs()).toBe(900);
    expect(histogram.percentile).toHaveBeenCalledWith(99); expect(histogram.reset).not.toHaveBeenCalled();
  });
  it.each([500.001, 2000])('sheds traffic at lag %s without dependency failure', async lag => {
    const result = await runReadiness(deps({ ...healthy, eventLoopP99Ms: lag }));
    expect(result.ready).toBe(false); expect(result.checks.mongodb).toBe('up'); expect(result.checks.eventLoop).toBe('down'); expect(result.diagnostics.eventLoopP99Ms).toBe(lag);
  });
  it('accepts exact boundaries and rejects heap pressure just above 90 percent', async () => {
    expect((await runReadiness(deps({ ...healthy, eventLoopP99Ms: 500, heapUsedBytes: 90 }))).ready).toBe(true);
    const result = await runReadiness(deps({ ...healthy, heapUsedBytes: 90.01 }));
    expect(result.ready).toBe(false); expect(result.checks.heap).toBe('down'); expect(result.diagnostics.heapRatio).toBe(0.9001);
  });
  it.each([NaN, Infinity, -1])('does not treat unavailable lag %s as healthy', async lag => {
    const result = await runReadiness(deps({ ...healthy, eventLoopP99Ms: lag }));
    expect(result.ready).toBe(false); expect(result.diagnostics.eventLoopP99Ms).toBeNull();
  });
  it.each([{ heapUsedBytes: NaN }, { heapUsedBytes: -1 }, { heapTotalBytes: 0 }, { heapTotalBytes: Infinity }, { heapUsedBytes: 101 }])('rejects invalid heap samples %j', async sample => {
    const result = await runReadiness(deps({ ...healthy, ...sample }));
    expect(result.ready).toBe(false); expect(result.checks.heap).toBe('down'); expect(result.diagnostics.heapRatio).toBeNull();
  });
  it('recovers on a later healthy sample without restarting the process', async () => {
    let pressure = true;
    const config = { ...deps(), readRuntime: () => ({ ...healthy, eventLoopP99Ms: pressure ? 700 : 20 }) };
    expect((await runReadiness(config)).ready).toBe(false); pressure = false;
    expect((await runReadiness(config)).ready).toBe(true);
  });
  it('preserves MongoDB, Redis and queue failures alongside runtime diagnostics', async () => {
    const result = await runReadiness({ ...deps(), pingRedis: async () => { throw Error('offline'); }, checkQueues: async () => true });
    expect(result.ready).toBe(false); expect(result.checks).toMatchObject({ mongodb: 'up', redis: 'down', queues: 'up', eventLoop: 'up', heap: 'up' });
  });
  it('fails closed on a runtime reader error with JSON-safe nulls', async () => {
    const result = await runReadiness({ ...deps(), readRuntime: () => { throw Error('unavailable'); } });
    expect(result.ready).toBe(false); expect(result.diagnostics).toEqual({ eventLoopP99Ms: null, heapUsedBytes: null, heapTotalBytes: null, heapRatio: null });
  });
  it('handler returns 503 with diagnostics while liveness remains 200', async () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await readinessHandler(deps({ ...healthy, eventLoopP99Ms: 800 }))({} as Request, response as unknown as Response);
    expect(response.status).toHaveBeenLastCalledWith(503); expect(response.json).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unavailable', diagnostics: expect.objectContaining({ eventLoopP99Ms: 800 }) }));
    livenessHandler()({} as Request, response as unknown as Response);
    expect(response.status).toHaveBeenLastCalledWith(200); expect(response.json).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ok' }));
  });
});
