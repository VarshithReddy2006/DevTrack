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

  async updateFromEvent(event: RuntimeStateEvent): Promise<IUnifiedRuntimeState> {
    const { userId, eventType, data } = event;
    const state = await this.getRuntimeStateFresh(userId);
    if (!state) {
      return await this.rebuildRuntimeState(userId, { fromEventId: event.eventId });
    }

    const updates: Record<string, unknown> = {};
    const incUpdates: Record<string, number> = {};

    switch (eventType) {
      case 'xp_awarded':
        incUpdates.xp = (data.xpAwarded as number) ?? 0;
        if (data.levelAfter) updates.level = data.levelAfter;
        if (data.xpToNextLevel) updates.xpToNextLevel = data.xpToNextLevel;
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
        updates['sessionContext.lastHeartbeat'] = new Date();
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
        updates['sessionContext.lastHeartbeat'] = new Date();
        break;
      case 'focus_session_cancelled':
        updates['sessionContext.isActive'] = false;
        updates['sessionContext.status'] = 'abandoned';
        updates['sessionContext.lastResumedAt'] = null;
        updates['sessionContext.lastHeartbeat'] = new Date();
        break;
      default:
        return await this.rebuildRuntimeState(userId, { fromEventId: event.eventId });
    }

    const updateDoc: Record<string, unknown> = {
      lastEventId: event.eventId,
      lastCalculatedAt: new Date(),
    };
    
    if (Object.keys(updates).length > 0) updateDoc.$set = updates;
    if (Object.keys(incUpdates).length > 0) updateDoc.$inc = incUpdates;

    const updatedState = await UnifiedRuntimeState.findByIdAndUpdate(state._id, updateDoc, { new: true });

    const delta: Record<string, unknown> = { ...updates, ...incUpdates };
    if (Object.keys(delta).length > 0) {
      void eventBus.emitRuntimeStatePatch(userId, delta);
    }

    return updatedState!;
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
    const timing = await focusEngine.pauseSession(state.sessionContext.sessionId);
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
    const timing = await focusEngine.resumeSession(state.sessionContext.sessionId);
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
    await focusEngine.abortSession(state.sessionContext.sessionId);
    return this.updateFromEvent({
      eventId: `focus_cancel_${userId}_${Date.now()}`,
      eventType: 'focus_session_cancelled', userId, timestamp: new Date(), data: {},
    });
  }

  async heartbeatFocusSession(userId: string): Promise<IUnifiedRuntimeState> {
    const state = await this.getRuntimeStateFresh(userId);
    if (state?.sessionContext?.sessionId) {
      const { focusEngine } = await import('../activity/focusEngine.service.js');
      await focusEngine.recordHeartbeat(state.sessionContext.sessionId);
    }

    return await this.updateFromEvent({
      eventId: `focus_hb_${userId}_${Date.now()}`,
      eventType: 'focus_session_heartbeat',
      userId,
      timestamp: new Date(),
      data: {},
    });
  }

  async stopFocusSession(userId: string): Promise<IUnifiedRuntimeState> {
    const state = await this.getRuntimeStateFresh(userId);
    let qualityScore = 100;
    let activeDurationMs = state?.sessionContext?.activeDurationMs ?? 0;
    
    if (state?.sessionContext?.sessionId) {
      const { focusEngine } = await import('../activity/focusEngine.service.js');
      const result = await focusEngine.completeSession(state.sessionContext.sessionId);
      if (result) {
        qualityScore = result.qualityScore;
        activeDurationMs = result.activeDurationMs;
      }
    }

    return await this.updateFromEvent({
      eventId: `focus_stop_${userId}_${Date.now()}`,
      eventType: 'focus_session_stopped',
      userId,
      timestamp: new Date(),
      data: { stoppedAt: new Date(), qualityScore, activeDurationMs },
    });
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
