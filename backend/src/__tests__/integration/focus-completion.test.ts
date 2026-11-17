import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  ActivityEvent, DailyActivity, FocusSession, Mission, ProcessedEvent,
  UnifiedRuntimeState, User, UserStreakLog, UserXp, XpTransaction,
} from '../../db/models/index.js';
import { OutboxEvent } from '../../db/models/outboxEvent.model.js';
import { ReadinessInput } from '../../db/models/readinessInput.model.js';
import { FocusEngine } from '../../modules/activity/focusEngine.service.js';
import { processDomainReadinessJob } from '../../modules/readiness/workers/domainReadiness.worker.js';
import type { DomainEventEnvelope } from '../../shared/events/eventContract.js';
import { QueueNames } from '../../shared/jobs/types.js';
import { createDomainOutboxRelay, processFocusCompletionJob } from '../../workers/focus-completion.worker.js';

vi.mock('../../shared/cache/cacheManager.js', () => ({
  cacheManager: { invalidateDashboard: vi.fn(), invalidateAllUserCache: vi.fn(), invalidateUserStreak: vi.fn() },
}));
vi.mock('../../shared/sse/index.js', () => ({
  eventBus: {
    emitMissionProgress: vi.fn(), emitNotificationCreated: vi.fn(), emitRuntimeStatePatch: vi.fn(),
    emitStreakMilestone: vi.fn(), emitStreakAtRisk: vi.fn(), emitXpUpdated: vi.fn(), emitLevelUp: vi.fn(),
  },
}));
vi.mock('../../modules/leagues/workers/leagueScore.worker.js', () => ({ enqueueLeagueScore: vi.fn() }));

const engine = new FocusEngine();

beforeAll(async () => {
  await Promise.all([
    FocusSession.init(), OutboxEvent.init(), ProcessedEvent.init(), XpTransaction.init(),
    UserXp.init(), UserStreakLog.init(), DailyActivity.init(), ActivityEvent.init(), Mission.init(),
    ReadinessInput.init(), UnifiedRuntimeState.init(),
  ]);
});
afterEach(() => vi.restoreAllMocks());

async function startQualifiedSession(userId: string): Promise<string> {
  const { sessionId } = await engine.startSession(userId, { mode: 'deep_work', plannedSec: 1500 });
  await FocusSession.updateOne({ _id: sessionId }, {
    $set: { lastResumedAt: new Date(Date.now() - 1_500_000), coveredHeartbeatIntervals: 24 },
  });
  return sessionId;
}

async function ownerId(): Promise<string> {
  return String((await User.findOne({ clerkId: 'clerk_test_integration_user' }).orFail())._id);
}

it('rolls back focus and runtime state when the outbox write fails, then returns the persisted completion on replay', async () => {
  const userId = await ownerId();
  const sessionId = await startQualifiedSession(userId);
  await UnifiedRuntimeState.create({ userId, sessionContext: { sessionId, isActive: true, status: 'running' } });
  const outboxWrite = vi.spyOn(OutboxEvent, 'create').mockRejectedValueOnce(new Error('Outbox unavailable'));
  await expect(engine.completeSession(sessionId, userId)).rejects.toThrow('Outbox unavailable');
  expect(await FocusSession.findById(sessionId)).toMatchObject({ status: 'running', isOpen: true });
  expect(await UnifiedRuntimeState.findOne({ userId })).toMatchObject({ sessionContext: { isActive: true } });
  expect(await OutboxEvent.countDocuments({ aggregateId: sessionId })).toBe(0);

  const attempts = await Promise.all([engine.completeSession(sessionId, userId), engine.completeSession(sessionId, userId)]);
  expect(attempts.map(result => result?.replayed).sort()).toEqual([false, true]);
  const completed = attempts[0]!.session;
  expect(completed).toMatchObject({
    status: 'completed', isOpen: false, xp: { amount: 50, reason: 'qualified', capApplied: false },
  });
  expect(await UnifiedRuntimeState.findOne({ userId })).toMatchObject({ sessionContext: { isActive: false, status: 'completed' } });
  const replay = await engine.completeSession(sessionId, userId);
  expect(replay?.session.toJSON()).toEqual(completed.toJSON());
  expect(replay?.replayed).toBe(true);
  expect(outboxWrite).toHaveBeenCalledTimes(2);
  expect(await OutboxEvent.countDocuments({ aggregateId: sessionId, status: 'pending' })).toBe(1);
});

it('fans out committed completions and settles each effect once despite relay and consumer retries', async () => {
  const userId = await ownerId();
  const mission = await Mission.create({
    userId, type: 'daily', category: 'consistency', templateKey: 'focus',
    title: 'Complete a focus session', description: 'Sustained focus', targetCount: 1,
    xpReward: 20, expiresAt: new Date(Date.now() + 60_000),
  });
  const sessionId = await startQualifiedSession(userId);
  await engine.completeSession(sessionId, userId);
  expect(await XpTransaction.countDocuments({ userId })).toBe(0);
  expect(await DailyActivity.countDocuments({ userId })).toBe(0);

  const jobs = new Map<string, DomainEventEnvelope>();
  let failPublish = true;
  const relay = createDomainOutboxRelay(async (queue, jobId, event) => {
    expect(jobId).toBe(event.id);
    if (queue === QueueNames.DOMAIN_FOCUS_MISSIONS && failPublish) throw new Error('Queue unavailable');
    jobs.set(queue, event);
  });
  expect(await relay.tick()).toBe(1);
  expect(await OutboxEvent.findOne({ aggregateId: sessionId })).toMatchObject({ status: 'pending', attempts: 1 });

  failPublish = false;
  await OutboxEvent.updateOne({ aggregateId: sessionId }, { $set: { nextAttemptAt: new Date(0) } });
  expect(await relay.tick()).toBe(1);
  expect(await OutboxEvent.findOne({ aggregateId: sessionId })).toMatchObject({ status: 'published' });
  expect([...jobs.keys()].sort()).toEqual([
    QueueNames.DOMAIN_FOCUS_ACTIVITY, QueueNames.DOMAIN_FOCUS_MISSIONS, QueueNames.DOMAIN_FOCUS_STREAK,
    QueueNames.DOMAIN_FOCUS_XP, QueueNames.DOMAIN_READINESS,
  ].sort());

  const missionQueue = QueueNames.DOMAIN_FOCUS_MISSIONS;
  vi.spyOn(XpTransaction, 'create').mockRejectedValueOnce(new Error('Reward unavailable'));
  await expect(processFocusCompletionJob(missionQueue, jobs.get(missionQueue)!)).rejects.toThrow('Reward unavailable');
  expect(await Mission.findById(mission._id)).toMatchObject({ status: 'completed', currentCount: 1 });

  for (const [queue, event] of jobs) {
    for (let replay = 0; replay < 2; replay++) {
      if (queue === QueueNames.DOMAIN_READINESS) await processDomainReadinessJob(event);
      else await processFocusCompletionJob(queue, event);
    }
  }
  expect(await XpTransaction.find({ userId, sourceType: 'focus_session' }).lean()).toMatchObject([{ sourceId: sessionId, xpAwarded: 50 }]);
  expect(await XpTransaction.find({ userId, sourceId: `mission_${mission._id}` }).lean()).toMatchObject([{ xpAwarded: 20 }]);
  expect(await UserXp.findOne({ userId })).toMatchObject({ totalXp: 570 });
  expect(await UserStreakLog.find({ userId, streakType: 'focus' }).lean()).toMatchObject([
    { activityCount: 1, sources: [`focus_session:${sessionId}`] },
  ]);
  expect(await Mission.findById(mission._id)).toMatchObject({ status: 'completed', currentCount: 1 });
  expect(await ActivityEvent.countDocuments({ userId, type: 'focus_session' })).toBe(1);
  expect(await DailyActivity.find({ userId }).lean()).toMatchObject([{ count: 1 }]);
  expect(await ProcessedEvent.countDocuments({ consumer: { $in: ['activity.focusSessionCompleted', 'missions.focusSessionCompleted'] } })).toBe(2);
  expect(await ReadinessInput.countDocuments({ userId })).toBe(1);
});

it('reserves the completion-day cap before any queued XP has settled', async () => {
  const userId = await ownerId();
  const ids: string[] = [];
  for (let count = 0; count < 5; count++) {
    const id = await startQualifiedSession(userId);
    ids.push(id);
    await engine.completeSession(id, userId);
  }
  expect(await FocusSession.findById(ids[4])).toMatchObject({ xp: { amount: 0, reason: 'daily_cap_reached', capApplied: true } });
  const queued: DomainEventEnvelope[] = [];
  const relay = createDomainOutboxRelay(async (queue, _jobId, event) => {
    if (queue === QueueNames.DOMAIN_FOCUS_XP) queued.push(event);
  });
  await relay.tick();
  for (const event of queued.reverse()) await processFocusCompletionJob(QueueNames.DOMAIN_FOCUS_XP, event);
  const ledger = await XpTransaction.find({ userId, sourceType: 'focus_session' });
  expect(ledger.map(row => row.sourceId).sort()).toEqual(ids.slice(0, 4).sort());
  expect(await UserXp.findOne({ userId })).toMatchObject({ totalXp: 700 });
}, 20_000);
