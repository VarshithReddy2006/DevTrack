// src/modules/runtime-state/unifiedRuntimeState.service.ts — Unified Runtime State Service
// Single source of truth for all progression systems.
// Event-driven, replay-safe, SSE-synchronized runtime state management.

import { Types } from 'mongoose';
import {
  UnifiedRuntimeState,
  UserXp,
  UserStreakLog,
  type IUnifiedRuntimeState,
  type MomentumState,
  type FatigueState,
  type EmotionalState,
  type RecoveryState,
  type OnboardingStage,
  type EngagementPressure,
  type NearMilestoneRef,
  type ProgressionPacing,
  type IUserXp,
} from '../../db/models/index.js';
import type { StreakStatus } from '../streak/streak.service.js';
import { eventBus } from '../../shared/sse/index.js';
import { logger } from '../../shared/logger.js';
import { getUserXp } from '../xp/processor.js';
import { getStreakStatus } from '../streak/streak.service.js';
import type { FocusSessionResult } from '../activity/focusEngine.service.js';

export interface RuntimeStateEvent {
  eventId: string;
  eventType: string;
  userId: string;
  timestamp: Date;
  data: Record<string, unknown>;
}

export interface RebuildOptions {
  fromEventId?: string;
  force?: boolean;
}

export class UnifiedRuntimeStateService {
  private pending = new Map<string, {
    events: RuntimeStateEvent[];
    waiters: Array<{ resolve: (state: IUnifiedRuntimeState) => void; reject: (error: unknown) => void }>;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private tails = new Map<string, Promise<void>>();
  private outstanding = 0;
  private drainError: unknown;

  constructor(private readonly coalesceMs = 500) {}

  async updateFromEvent(event: RuntimeStateEvent): Promise<IUnifiedRuntimeState> {
    // Bound queued and in-flight calls. Callers receive an explicit failure,
    // never a successful acknowledgement for data that was discarded.
    if (this.outstanding >= 10000) throw new Error('Runtime state buffer is full');
    new Types.ObjectId(event.userId);
    const copy = structuredClone(event);
    this.outstanding++;
    return new Promise((resolve, reject) => {
      let batch = this.pending.get(event.userId);
      if (!batch) {
        batch = { events: [], waiters: [], timer: setTimeout(() => this.flushUser(event.userId), this.coalesceMs) };
        this.pending.set(event.userId, batch);
      }
      batch.events.push(copy); batch.waiters.push({ resolve, reject });
    });
  }

  private flushUser(userId: string): void {
    const batch = this.pending.get(userId);
    if (!batch) return;
    this.pending.delete(userId); clearTimeout(batch.timer);
    const run = async () => {
      try {
        const state = await this.applyEventBatch(batch.events);
        batch.waiters.forEach(waiter => waiter.resolve(state));
      } catch (error) {
        this.drainError = error;
        batch.waiters.forEach(waiter => waiter.reject(error));
      } finally { this.outstanding -= batch.events.length; }
    };
    // A slow flush cannot be overtaken by the next window for the same user.
    const tail = (this.tails.get(userId) ?? Promise.resolve()).then(run).finally(() => {
      if (this.tails.get(userId) === tail) this.tails.delete(userId);
    });
    this.tails.set(userId, tail);
  }

  async flushPendingEvents(): Promise<void> {
    while (this.pending.size || this.tails.size) {
      for (const userId of this.pending.keys()) this.flushUser(userId);
      await Promise.all(this.tails.values());
    }
    const error = this.drainError; this.drainError = undefined;
    if (error) throw error;
  }
  async getRuntimeState(userId: string): Promise<IUnifiedRuntimeState | null> {
    const state = await UnifiedRuntimeState.findOne({ userId: new Types.ObjectId(userId) });
    return state;
  }

  async getRuntimeStateFresh(userId: string): Promise<IUnifiedRuntimeState | null> {
    let state = await this.getRuntimeState(userId);
    if (!state || this.isStateStale(state)) {
      state = await this.rebuildRuntimeState(userId);
    }
    return state;
  }

  async rebuildRuntimeState(userId: string, options?: RebuildOptions): Promise<IUnifiedRuntimeState> {
    const userObjId = new Types.ObjectId(userId);
    logger.info('[runtime-state] Rebuilding runtime state', { userId, options });
    
    const [userXp, streakStatus, userAnalytics] = await Promise.all([
      getUserXp(userId),
      getStreakStatus(userId, 'unified'),
      this.fetchUserAnalytics(userObjId),
    ]);

    const momentumState = this.calculateMomentumState(streakStatus, userXp as any);
    const fatigueState: FatigueState = 'none';
    const emotionalState: EmotionalState = 'focused';
    const recoveryState: RecoveryState = 'none';
    const trustScore = 0.8;

    const progressionPacing: ProgressionPacing = {
      dailyXpRate: userXp?.totalXp ? Math.round(userXp.totalXp / 30) : 0,
      weeklyXpRate: userXp?.totalXp ? Math.round(userXp.totalXp / 4) : 0,
      streakGrowthRate: 0,
      optimalSessionLength: 30,
      recommendedBreakInterval: 60,
    };

    const nearMilestones = this.calculateNearMilestones(userXp as any, streakStatus);
    const onboardingStage: OnboardingStage = 'active';
    const engagementPressure: EngagementPressure = 'normal';

    const streakRisk = this.calculateStreakRisk(streakStatus);
    const longestStreak = userAnalytics?.bestStreak ?? streakStatus.currentStreak;
    const daysActive = userAnalytics?.totalActiveDays ?? 0;
    const totalProblemsSolved = userAnalytics?.totalProblemsSolved ?? 0;

    const state = await UnifiedRuntimeState.findOneAndUpdate(
      { userId: userObjId },
      {
        $set: {
          xp: userXp?.totalXp ?? 0,
          level: userXp?.currentLevel ?? 1,
          xpToNextLevel: userXp?.xpToNextLevel ?? 100,
          streak: streakStatus.currentStreak,
          streakRisk,
          momentumState,
          fatigueState,
          trustScore,
          emotionalState,
          recoveryState,
          activeGoals: [],
          activeChallenges: [],
          activeAchievements: [],
          progressionPacing,
          nearMilestones,
          longestStreak,
          daysActive,
          totalProblemsSolved,
          recentMilestones: [],
          onboardingStage,
          engagementPressure,
          lastEventId: options?.fromEventId ?? '',
          lastCalculatedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    return state;
  }

  private async applyEventBatch(events: RuntimeStateEvent[]): Promise<IUnifiedRuntimeState> {
    const userId = events[0].userId;
    const handled = new Set(['xp_awarded', 'streak_updated', 'focus_session_started', 'focus_session_heartbeat',
      'focus_session_paused', 'focus_session_resumed', 'focus_session_stopped', 'focus_session_cancelled']);
    const state = events.some(event => !handled.has(event.eventType))
      ? await this.rebuildRuntimeState(userId, { fromEventId: events.at(-1)!.eventId })
      : await this.getRuntimeStateFresh(userId);
    if (!state) throw new Error('Runtime state is unavailable');
    const updates: Record<string, unknown> = {};
    const incUpdates: Record<string, number> = {};
    let hasAbsoluteXp = false;
    let highestXp = state.xp;
    for (const event of events) {
      const { eventType, data } = event;
      switch (eventType) {
        case 'xp_awarded':
          if (typeof data.newTotalXp === 'number' && Number.isFinite(data.newTotalXp)) {
            const total = data.newTotalXp;
            if (total >= highestXp) {
              highestXp = total;
              if (data.levelAfter !== undefined) updates.level = data.levelAfter;
              if (data.xpToNextLevel !== undefined) updates.xpToNextLevel = data.xpToNextLevel;
            }
            hasAbsoluteXp = true;
          } else {
            const award = (data.xpAwarded as number) ?? 0;
            incUpdates.xp = (incUpdates.xp ?? 0) + award;
            highestXp += award;
          }
          if (!hasAbsoluteXp && data.levelAfter !== undefined) updates.level = data.levelAfter;
          if (!hasAbsoluteXp && data.xpToNextLevel !== undefined) updates.xpToNextLevel = data.xpToNextLevel;
          break;
        case 'streak_updated':
          updates.streak = data.currentStreak;
          updates.streakRisk = this.calculateStreakRisk(data as any);
          updates.momentumState = this.calculateMomentumState(data as any, state as any);
          break;
        case 'focus_session_started':
          updates['sessionContext.isActive'] = true;
          updates['sessionContext.status'] = 'running';
          updates['sessionContext.startedAt'] = data.startedAt;
          updates['sessionContext.lastResumedAt'] = data.startedAt;
          updates['sessionContext.activeDurationMs'] = 0;
          updates['sessionContext.lastHeartbeat'] = data.startedAt;
          updates['sessionContext.duration'] = data.duration;
          updates['sessionContext.mode'] = data.mode;
          if (data.sessionId) updates['sessionContext.sessionId'] = data.sessionId;
          break;
        case 'focus_session_heartbeat':
          updates['sessionContext.lastHeartbeat'] = event.timestamp;
          break;
        case 'focus_session_paused':
          updates['sessionContext.status'] = 'paused';
          updates['sessionContext.activeDurationMs'] = data.activeDurationMs;
          updates['sessionContext.lastResumedAt'] = null;
          break;
        case 'focus_session_resumed':
          updates['sessionContext.status'] = 'running';
          updates['sessionContext.activeDurationMs'] = data.activeDurationMs;
          updates['sessionContext.lastResumedAt'] = data.lastResumedAt;
          break;
        case 'focus_session_stopped':
          updates['sessionContext.isActive'] = false;
          updates['sessionContext.status'] = 'completed';
          updates['sessionContext.activeDurationMs'] = data.activeDurationMs;
          updates['sessionContext.lastResumedAt'] = null;
          updates['sessionContext.lastHeartbeat'] = event.timestamp;
          break;
        case 'focus_session_cancelled':
          updates['sessionContext.isActive'] = false;
          updates['sessionContext.status'] = 'abandoned';
          updates['sessionContext.lastResumedAt'] = null;
          updates['sessionContext.lastHeartbeat'] = event.timestamp;
          break;
        default:
          break;
      }

    }
    const updateDoc: Record<string, unknown> = {
      $set: { ...updates, lastEventId: events.at(-1)!.eventId, lastCalculatedAt: new Date() },
    };
    if (hasAbsoluteXp) {
      // XP producers carry committed totals. Use the largest total rather than
      // adding it again after a stale/missing state was rebuilt from UserXp.
      updateDoc.$max = { xp: highestXp };
      delete incUpdates.xp;
    }
    if (Object.keys(incUpdates).length) updateDoc.$inc = incUpdates;
    const updated = await UnifiedRuntimeState.findByIdAndUpdate(state._id, updateDoc, { new: true });
    if (!updated) throw new Error('Runtime state disappeared during flush');
    const patch: Record<string, unknown> = { ...updates };
    if (hasAbsoluteXp || incUpdates.xp !== undefined) patch.xp = updated.xp;
    // Session fields are transient; coalesce them separately from progression
    // and publish the resulting absolute session state once per flush.
    if (Object.keys(updates).some(key => key.startsWith('sessionContext.'))) {
      for (const key of Object.keys(patch)) if (key.startsWith('sessionContext.')) delete patch[key];
      patch.sessionContext = updated.sessionContext;
    }
    if (Object.keys(patch).length) {
      try { await eventBus.emitRuntimeStatePatch(userId, patch); }
      catch (error) { logger.warn('[runtime-state] Patch delivery failed after commit', { userId, error }); }
    }
    return updated;
  }
  async startFocusSession(userId: string, duration: number, mode: string): Promise<IUnifiedRuntimeState> {
    const { focusEngine } = await import('../activity/focusEngine.service.js');
    const { sessionId, startedAt } = await focusEngine.startSession(userId, mode, duration);

    return await this.updateFromEvent({
      eventId: `focus_start_${userId}_${Date.now()}`,
      eventType: 'focus_session_started',
      userId,
      timestamp: new Date(),
      data: { startedAt, duration, mode, sessionId },
    });
  }

  async pauseFocusSession(userId: string): Promise<IUnifiedRuntimeState | null> {
    const state = await this.getRuntimeStateFresh(userId);
    if (!state?.sessionContext?.isActive || !state.sessionContext.sessionId) return null;
    const { focusEngine } = await import('../activity/focusEngine.service.js');
    const timing = await focusEngine.pauseSession(state.sessionContext.sessionId, userId);
    if (!timing) return null;
    return this.updateFromEvent({
      eventId: `focus_pause_${userId}_${Date.now()}`,
      eventType: 'focus_session_paused', userId, timestamp: new Date(), data: { ...timing },
    });
  }

  async resumeFocusSession(userId: string): Promise<IUnifiedRuntimeState | null> {
    const state = await this.getRuntimeStateFresh(userId);
    if (!state?.sessionContext?.isActive || !state.sessionContext.sessionId) return null;
    const { focusEngine } = await import('../activity/focusEngine.service.js');
    const timing = await focusEngine.resumeSession(state.sessionContext.sessionId, userId);
    if (!timing) return null;
    return this.updateFromEvent({
      eventId: `focus_resume_${userId}_${Date.now()}`,
      eventType: 'focus_session_resumed', userId, timestamp: new Date(), data: { ...timing },
    });
  }

  async cancelFocusSession(userId: string): Promise<IUnifiedRuntimeState | null> {
    const state = await this.getRuntimeStateFresh(userId);
    if (!state?.sessionContext?.isActive || !state.sessionContext.sessionId) return null;
    const { focusEngine } = await import('../activity/focusEngine.service.js');
    await focusEngine.abortSession(state.sessionContext.sessionId, userId);
    return this.updateFromEvent({
      eventId: `focus_cancel_${userId}_${Date.now()}`,
      eventType: 'focus_session_cancelled', userId, timestamp: new Date(), data: {},
    });
  }

  async heartbeatFocusSession(userId: string): Promise<IUnifiedRuntimeState> {
    const state = await this.getRuntimeStateFresh(userId);
    if (state?.sessionContext?.sessionId) {
      const { focusEngine } = await import('../activity/focusEngine.service.js');
      await focusEngine.recordHeartbeat(state.sessionContext.sessionId, userId);
    }

    return await this.updateFromEvent({
      eventId: `focus_hb_${userId}_${Date.now()}`,
      eventType: 'focus_session_heartbeat',
      userId,
      timestamp: new Date(),
      data: {},
    });
  }

  /**
   * Stops the user's focus session. `completed` is set only for the call that
   * actually moved a running/paused session to completed, so callers can award
   * XP and streak exactly once. Replays and stops with no session return
   * `completed: null` and leave the runtime state alone.
   */
  async stopFocusSession(userId: string): Promise<{ state: IUnifiedRuntimeState; completed: FocusSessionResult | null }> {
    const state = await this.getRuntimeStateFresh(userId);
    const sessionId = state?.sessionContext?.sessionId;
    let completed: FocusSessionResult | null = null;

    if (sessionId) {
      const { focusEngine } = await import('../activity/focusEngine.service.js');
      completed = await focusEngine.completeSession(sessionId, userId);
    }

    // Nothing was running and the stored context is already inactive: no-op.
    if (!completed && !state?.sessionContext?.isActive) {
      return { state: state ?? await this.rebuildRuntimeState(userId), completed: null };
    }

    const updated = await this.updateFromEvent({
      eventId: `focus_stop_${userId}_${Date.now()}`,
      eventType: 'focus_session_stopped',
      userId,
      timestamp: new Date(),
      data: {
        stoppedAt: new Date(),
        qualityScore: completed?.qualityScore ?? 100,
        activeDurationMs: completed?.activeDurationMs ?? state?.sessionContext?.activeDurationMs ?? 0,
      },
    });
    return { state: updated, completed };
  }

  async invalidateState(userId: string): Promise<void> {
    await UnifiedRuntimeState.deleteOne({ userId: new Types.ObjectId(userId) });
  }

  private calculateMomentumState(streakStatus: StreakStatus, userXp: IUserXp | null): MomentumState {
    if (!streakStatus || !userXp) return 'building';
    return streakStatus.currentStreak >= 7 ? 'stable' : 'building';
  }

  private calculateNearMilestones(userXp: IUserXp | null, streakStatus: StreakStatus): NearMilestoneRef[] {
    const milestones: NearMilestoneRef[] = [];
    if (userXp) {
      const levelProgress = userXp.xpToNextLevel > 0 ? (userXp.xpToNextLevel - userXp.totalXp) / userXp.xpToNextLevel : 0;
      if (levelProgress < 0.3 && levelProgress >= 0) {
        milestones.push({
          type: 'level',
          current: userXp.currentLevel,
          target: userXp.currentLevel + 1,
          progressPercent: (1 - levelProgress) * 100,
        });
      }
    }
    return milestones;
  }

  private calculateStreakRisk(streakStatus: StreakStatus): number {
    if (!streakStatus || streakStatus.currentStreak === 0 || !streakStatus.lastActiveDate) return 0;
    const hoursSinceActivity = (Date.now() - streakStatus.lastActiveDate.getTime()) / (1000 * 60 * 60);
    return Math.min(hoursSinceActivity / 24, 1);
  }

  private async fetchUserAnalytics(userObjId: Types.ObjectId): Promise<{ bestStreak: number; totalActiveDays: number; totalProblemsSolved: number } | null> {
    try {
      const { UserAnalytics } = await import('../../db/models/index.js');
      const analytics = await UserAnalytics.findOne({ userId: userObjId }).lean();
      if (!analytics) return null;
      return {
        bestStreak: (analytics as any).bestStreak ?? 0,
        totalActiveDays: (analytics as any).totalActiveDays ?? 0,
        totalProblemsSolved: (analytics as any).totalProblemsSolved ?? 0,
      };
    } catch (err) {
      logger.warn('[UnifiedRuntimeState] Failed to fetch user analytics', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private isStateStale(state: IUnifiedRuntimeState): boolean {
    return Date.now() - new Date(state.lastCalculatedAt).getTime() > 5 * 60 * 1000;
  }
}

export const unifiedRuntimeStateService = new UnifiedRuntimeStateService();
