import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { UnifiedRuntimeState } from '../../../db/models/index.js';
import { UnifiedRuntimeStateService, type RuntimeStateEvent } from '../../../modules/runtime-state/unifiedRuntimeState.service.js';
import { eventBus } from '../../../shared/sse/index.js';
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: { emitRuntimeStatePatch: vi.fn() } }));
const services: UnifiedRuntimeStateService[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => { for (const service of services.splice(0)) await service.flushPendingEvents().catch(() => {}); vi.restoreAllMocks(); });
const create = (ms = 20) => { const service = new UnifiedRuntimeStateService(ms); services.push(service); return service; };
const event = (userId: string, index: number, eventType = 'xp_awarded', data: Record<string, unknown> = { xpAwarded: 2 }) => ({ userId, eventId: `event-${index}`, eventType, data, timestamp: new Date() });
async function seed() {
  const userId = new Types.ObjectId().toHexString();
  await UnifiedRuntimeState.create({ userId, xp: 10, lastCalculatedAt: new Date() }); return userId;
}

describe('runtime-state bounded write coalescing', () => {
  it('50 rapid calls use one write and one absolute SSE patch, with exact summed XP', async () => {
    const userId = await seed(); const service = create(500);
    const writes = vi.spyOn(UnifiedRuntimeState, 'findByIdAndUpdate');
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => service.updateFromEvent(event(userId, i))));
    expect(writes).toHaveBeenCalledTimes(1); expect(eventBus.emitRuntimeStatePatch).toHaveBeenCalledTimes(1);
    expect(results.every(state => state.xp === 110)).toBe(true);
    expect((await UnifiedRuntimeState.findOne({ userId }))!.xp).toBe(110);
    expect(eventBus.emitRuntimeStatePatch).toHaveBeenCalledWith(userId, expect.objectContaining({ xp: 110 }));
  });
  it('keeps terminal session status and latest heartbeat without replacing progression fields', async () => {
    const userId = await seed(); const service = create(); const startedAt = new Date();
    const input = [event(userId, 0, 'focus_session_started', { startedAt, duration: 25, mode: 'deep', sessionId: 'session' }),
      event(userId, 1), event(userId, 2, 'focus_session_heartbeat'),
      event(userId, 3, 'focus_session_paused', { activeDurationMs: 1000 }),
      event(userId, 4, 'focus_session_resumed', { activeDurationMs: 1000, lastResumedAt: new Date() }),
      event(userId, 5, 'focus_session_stopped', { activeDurationMs: 2000 })];
    const states = await Promise.all(input.map(row => service.updateFromEvent(row)));
    expect(states[0].xp).toBe(12); expect(states[0].sessionContext).toMatchObject({ isActive: false, status: 'completed', activeDurationMs: 2000, lastResumedAt: null });
    expect(eventBus.emitRuntimeStatePatch).toHaveBeenCalledWith(userId, expect.objectContaining({ xp: 12, sessionContext: expect.objectContaining({ status: 'completed' }) }));
  });
  it('committed XP totals avoid double increments and stale reordered levels', async () => {
    const userId = await seed(); const service = create();
    const rows = [event(userId, 1, 'xp_awarded', { xpAwarded: 20, newTotalXp: 300, levelAfter: 3, xpToNextLevel: 200 }),
      event(userId, 2, 'xp_awarded', { xpAwarded: 10, newTotalXp: 100, levelAfter: 2, xpToNextLevel: 150 })];
    await Promise.all(rows.map(row => service.updateFromEvent(row)));
    const state = await UnifiedRuntimeState.findOne({ userId }); expect(state).toMatchObject({ xp: 300, level: 3, xpToNextLevel: 200 });
  });
  it('does not lose delta-only XP following an absolute total in the same window', async () => {
    const userId = await seed(); const service = create();
    await Promise.all([service.updateFromEvent(event(userId, 1, 'xp_awarded', { newTotalXp: 50 })), service.updateFromEvent(event(userId, 2))]);
    expect((await UnifiedRuntimeState.findOne({ userId }))!.xp).toBe(52);
  });
  it('different users have independent buffers', async () => {
    const ids = await Promise.all([seed(), seed()]); const service = create();
    await Promise.all(ids.map(id => service.updateFromEvent(event(id, 1))));
    for (const userId of ids) expect((await UnifiedRuntimeState.findOne({ userId }))!.xp).toBe(12);
    expect(eventBus.emitRuntimeStatePatch).toHaveBeenCalledTimes(2);
  });
  it('a failed write rejects every waiter, publishes no patch, and later windows recover', async () => {
    const userId = await seed(); const service = create();
    const write = vi.spyOn(UnifiedRuntimeState, 'findByIdAndUpdate').mockRejectedValueOnce(new Error('write failed'));
    const results = await Promise.allSettled([service.updateFromEvent(event(userId, 1)), service.updateFromEvent(event(userId, 2))]);
    expect(results.every(result => result.status === 'rejected')).toBe(true); expect(eventBus.emitRuntimeStatePatch).not.toHaveBeenCalled();
    write.mockRestore(); await service.updateFromEvent(event(userId, 3)); expect((await UnifiedRuntimeState.findOne({ userId }))!.xp).toBe(12);
    await expect(service.flushPendingEvents()).rejects.toThrow('write failed');
  });
  it('explicit drain flushes without waiting for the full window and snapshots caller data', async () => {
    const userId = await seed(); const service = create(60000); const row = event(userId, 1);
    const result = service.updateFromEvent(row); row.data.xpAwarded = 999;
    await service.flushPendingEvents(); expect((await result).xp).toBe(12);
  });
  it('an overlapping flush waits for the previous write and cannot overwrite newer session state', async () => {
    const userId = await seed(); const service = create();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const original = service.getRuntimeStateFresh.bind(service); let reads = 0;
    vi.spyOn(service, 'getRuntimeStateFresh').mockImplementation(async id => { reads++; if (reads === 1) await gate; return original(id); });
    const first = service.updateFromEvent(event(userId, 1));
    await vi.waitFor(() => expect(reads).toBe(1));
    const second = service.updateFromEvent(event(userId, 2));
    const draining = service.flushPendingEvents(); expect(reads).toBe(1); release(); await draining; await Promise.all([first, second]);
    expect(reads).toBe(2); expect((await UnifiedRuntimeState.findOne({ userId }))!.xp).toBe(14);
  });
  it('a missing user state is rebuilt once and a 50-event burst needs at most three writes', async () => {
    const userId = new Types.ObjectId().toHexString(); const service = create();
    const rebuildWrites = vi.spyOn(UnifiedRuntimeState, 'findOneAndUpdate');
    const patchWrites = vi.spyOn(UnifiedRuntimeState, 'findByIdAndUpdate');
    await Promise.all(Array.from({ length: 50 }, (_, i) => service.updateFromEvent(event(userId, i))));
    expect(rebuildWrites.mock.calls.length + patchWrites.mock.calls.length).toBeLessThanOrEqual(3);
    expect((await UnifiedRuntimeState.findOne({ userId }))!.xp).toBe(100);
  });
  it('SSE transport failure after persistence does not turn a committed delta into a failed award', async () => {
    const userId = await seed(); const service = create();
    vi.mocked(eventBus.emitRuntimeStatePatch).mockRejectedValueOnce(new Error('transport offline'));
    expect((await service.updateFromEvent(event(userId, 1))).xp).toBe(12);
    expect((await UnifiedRuntimeState.findOne({ userId }))!.xp).toBe(12);
  });
});
