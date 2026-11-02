import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { FocusSession, UnifiedRuntimeState } from '../../db/models/index.js';
import { FocusEngine } from '../activity/focusEngine.service.js';
import { UnifiedRuntimeStateService } from './unifiedRuntimeState.service.js';

vi.mock('../../shared/sse/index.js', () => ({ eventBus: { emitRuntimeStatePatch: vi.fn() } }));

afterEach(() => vi.useRealTimers());

describe('focus pause persistence', () => {
  it('excludes paused wall time from completion duration and survives a database read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
    const engine = new FocusEngine();
    const { sessionId } = await engine.startSession(new Types.ObjectId().toString(), 'deep_work', 25);
    vi.setSystemTime(new Date('2026-11-02T10:02:00Z'));
    expect(await engine.pauseSession(sessionId)).toMatchObject({ activeDurationMs: 120_000, lastResumedAt: null });
    vi.setSystemTime(new Date('2026-11-02T11:02:00Z'));
    expect((await FocusSession.findById(sessionId))?.status).toBe('paused');
    expect(await engine.resumeSession(sessionId)).toMatchObject({ activeDurationMs: 120_000 });
    vi.setSystemTime(new Date('2026-11-02T11:05:00Z'));
    expect(await engine.completeSession(sessionId)).toMatchObject({ actualDuration: 5, activeDurationMs: 300_000 });
    expect(await FocusSession.findById(sessionId)).toMatchObject({ status: 'completed', actualDurationMinutes: 5, activeDurationMs: 300_000 });
  });

  it('persists pause and resume in runtime state for refetch and rejects invalid transitions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
    const userId = new Types.ObjectId().toString();
    const engine = new FocusEngine();
    const { sessionId, startedAt } = await engine.startSession(userId, 'deep_work', 25);
    await UnifiedRuntimeState.create({ userId: new Types.ObjectId(userId), sessionContext: {
      isActive: true, sessionId, status: 'running', duration: 25, mode: 'deep_work', startedAt,
      lastResumedAt: startedAt, activeDurationMs: 0,
    } });
    const service = new UnifiedRuntimeStateService();
    vi.spyOn(service, 'getRuntimeStateFresh').mockImplementation(() => service.getRuntimeState(userId));
    vi.setSystemTime(new Date('2026-11-02T10:02:00Z'));
    expect((await service.pauseFocusSession(userId))?.sessionContext).toMatchObject({ status: 'paused', activeDurationMs: 120_000, lastResumedAt: null });
    vi.setSystemTime(new Date('2026-11-02T11:02:00Z'));
    expect((await service.getRuntimeState(userId))?.sessionContext).toMatchObject({ status: 'paused', activeDurationMs: 120_000 });
    expect(await service.pauseFocusSession(userId)).toBeNull();
    expect((await service.resumeFocusSession(userId))?.sessionContext).toMatchObject({ status: 'running', activeDurationMs: 120_000 });
    expect(await service.resumeFocusSession(userId)).toBeNull();
    expect((await service.getRuntimeState(userId))?.sessionContext.status).toBe('running');
  });

  it('cancels without completing the stored session', async () => {
    const userId = new Types.ObjectId().toString();
    const engine = new FocusEngine();
    const { sessionId, startedAt } = await engine.startSession(userId, 'debug', 25);
    await UnifiedRuntimeState.create({ userId: new Types.ObjectId(userId), sessionContext: { isActive: true, sessionId, status: 'running', startedAt } });
    const service = new UnifiedRuntimeStateService();
    vi.spyOn(service, 'getRuntimeStateFresh').mockImplementation(() => service.getRuntimeState(userId));
    expect((await service.cancelFocusSession(userId))?.sessionContext).toMatchObject({ isActive: false, status: 'abandoned' });
    expect((await FocusSession.findById(sessionId))?.status).toBe('abandoned');
  });
});
