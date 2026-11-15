import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { FocusSession, UnifiedRuntimeState } from '../../../db/models/index.js';
import { FocusEngine } from '../../../modules/activity/focusEngine.service.js';
import { unifiedRuntimeStateService } from '../../../modules/runtime-state/unifiedRuntimeState.service.js';
import { cacheManager } from '../../../shared/cache/cacheManager.js';

vi.mock('../../../shared/cache/cacheManager.js', () => ({
  cacheManager: {
    invalidateDashboard: vi.fn().mockResolvedValue(undefined),
    invalidateAllUserCache: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../shared/sse/index.js', () => ({
  eventBus: {
    emitRuntimeStatePatch: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../shared/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('FocusEngine.abortSession and UnifiedRuntimeState reconciliation', () => {
  const engine = new FocusEngine();
  const userId = new Types.ObjectId().toString();

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it('aborts running session, clears lastResumedAt, updates UnifiedRuntimeState and invalidates cache', async () => {
    const startedAt = new Date(Date.now() - 15 * 60 * 1000);
    const session = await FocusSession.create({
      userId: new Types.ObjectId(userId),
      mode: 'pomodoro',
      status: 'running',
      startedAt,
      lastResumedAt: startedAt,
      lastHeartbeatAt: startedAt,
      plannedDurationMinutes: 25,
      activeDurationMs: 5000,
    });

    await UnifiedRuntimeState.create({
      userId: new Types.ObjectId(userId),
      sessionContext: {
        isActive: true,
        sessionId: session._id.toString(),
        status: 'running',
        startedAt,
        lastResumedAt: startedAt,
        duration: 25,
        mode: 'pomodoro',
      },
    });

    await engine.abortSession(session._id.toString(), userId);

    const updatedSession = await FocusSession.findById(session._id);
    expect(updatedSession).not.toBeNull();
    expect(updatedSession!.status).toBe('abandoned');
    expect(updatedSession!.completedAt).toBeInstanceOf(Date);
    expect(updatedSession!.lastResumedAt).toBeNull();

    const runtimeState = await UnifiedRuntimeState.findOne({ userId: new Types.ObjectId(userId) });
    expect(runtimeState).not.toBeNull();
    expect(runtimeState!.sessionContext).toMatchObject({
      isActive: false,
      status: 'abandoned',
      lastResumedAt: null,
    });

    expect(cacheManager.invalidateDashboard).toHaveBeenCalledWith(userId);
  });

  it('aborts paused session correctly and synchronizes runtime state', async () => {
    const startedAt = new Date(Date.now() - 30 * 60 * 1000);
    const session = await FocusSession.create({
      userId: new Types.ObjectId(userId),
      mode: 'deep_work',
      status: 'paused',
      startedAt,
      lastResumedAt: null,
      lastHeartbeatAt: startedAt,
      plannedDurationMinutes: 50,
      activeDurationMs: 15 * 60 * 1000,
    });

    await UnifiedRuntimeState.create({
      userId: new Types.ObjectId(userId),
      sessionContext: {
        isActive: true,
        sessionId: session._id.toString(),
        status: 'paused',
        startedAt,
        lastResumedAt: null,
        duration: 50,
        mode: 'deep_work',
      },
    });

    await engine.abortSession(session._id.toString(), userId);

    const updatedSession = await FocusSession.findById(session._id);
    expect(updatedSession!.status).toBe('abandoned');
    expect(updatedSession!.completedAt).toBeInstanceOf(Date);
    expect(updatedSession!.lastResumedAt).toBeNull();

    const runtimeState = await UnifiedRuntimeState.findOne({ userId: new Types.ObjectId(userId) });
    expect(runtimeState!.sessionContext).toMatchObject({
      isActive: false,
      status: 'abandoned',
      lastResumedAt: null,
    });

    expect(cacheManager.invalidateDashboard).toHaveBeenCalledWith(userId);
  });

  it('no-ops when session does not belong to the user or is already completed', async () => {
    const otherUserId = new Types.ObjectId().toString();
    const session = await FocusSession.create({
      userId: new Types.ObjectId(otherUserId),
      mode: 'pomodoro',
      status: 'completed',
      startedAt: new Date(),
      plannedDurationMinutes: 25,
    });

    await engine.abortSession(session._id.toString(), userId);

    const unchanged = await FocusSession.findById(session._id);
    expect(unchanged!.status).toBe('completed');
    expect(cacheManager.invalidateDashboard).not.toHaveBeenCalledWith(userId);
  });

  it('cancelFocusSession orchestrates session abort, runtime state transition, and cache invalidation', async () => {
    const cancelUserId = new Types.ObjectId().toString();
    const startedAt = new Date();
    const session = await FocusSession.create({
      userId: new Types.ObjectId(cancelUserId),
      mode: 'pomodoro',
      status: 'running',
      startedAt,
      lastResumedAt: startedAt,
      lastHeartbeatAt: startedAt,
      plannedDurationMinutes: 25,
      activeDurationMs: 0,
    });

    await UnifiedRuntimeState.create({
      userId: new Types.ObjectId(cancelUserId),
      sessionContext: {
        isActive: true,
        sessionId: session._id.toString(),
        status: 'running',
        startedAt,
        lastResumedAt: startedAt,
        duration: 25,
        mode: 'pomodoro',
      },
    });

    const result = await unifiedRuntimeStateService.cancelFocusSession(cancelUserId);
    expect(result).not.toBeNull();
    expect(result!.sessionContext).toMatchObject({
      isActive: false,
      status: 'abandoned',
      lastResumedAt: null,
    });

    const abortedSession = await FocusSession.findById(session._id);
    expect(abortedSession!.status).toBe('abandoned');
    expect(abortedSession!.lastResumedAt).toBeNull();

    expect(cacheManager.invalidateDashboard).toHaveBeenCalledWith(cancelUserId);
  });
});
