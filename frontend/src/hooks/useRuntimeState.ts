// ============================================================================
// useRuntimeState.ts — Runtime State Hook
// ============================================================================
// Fetches unified runtime state from GET /api/runtime-state.
// This is the single source of truth for all progression systems.
// ============================================================================

import { useQuery } from '@tanstack/react-query';
import axiosClient from '../utils/axiosClient';
import { useSse } from './useSse';
import { useUserStore } from '../store/userStore';

export interface RuntimeState {
  userId: string;
  xp: number;
  level: number;
  xpToNextLevel: number;
  streak: number;
  streakRisk: number;
  momentumState: 'building' | 'stable' | 'declining' | 'recovering' | 'dormant';
  fatigueState: 'none' | 'low' | 'moderate' | 'high' | 'burnout';
  trustScore: number;
  emotionalState: 'motivated' | 'focused' | 'calm' | 'neutral' | 'discouraged' | 'overwhelmed';
  recoveryState: 'none' | 'active' | 'paused' | 'complete';
  activeGoals: Array<{
    goalId: string;
    progress: number;
    target: number;
    deadline?: string;
  }>;
  activeChallenges: Array<{
    challengeId: string;
    progress: number;
    target: number;
    startedAt: string;
    expiresAt?: string;
  }>;
  activeAchievements: Array<{
    achievementId: string;
    unlockedAt: string;
  }>;
  progressionPacing: {
    dailyXpRate: number;
    weeklyXpRate: number;
    streakGrowthRate: number;
    optimalSessionLength: number;
    recommendedBreakInterval: number;
  };
  nearMilestones: Array<{
    type: 'level' | 'streak' | 'problems' | 'xp';
    current: number;
    target: number;
    progressPercent: number;
    estimatedCompletion?: string;
  }>;
  // Denormalized stats — eliminates query scatter
  longestStreak: number;
  daysActive: number;
  totalProblemsSolved: number;
  // Session & messaging
  sessionContext: {
    isActive: boolean;
    status?: 'running' | 'paused' | 'completed' | 'abandoned';
    activeDurationMs?: number;
    lastResumedAt?: string | null;
    sessionId?: string;
    mode?: string;
    duration?: number;
    startedAt?: string;
    lastHeartbeat?: string;
    problemsThisSession: number;
    xpThisSession: number;
  };
  currentMessage?: {
    messageId: string;
    tone: 'encouraging' | 'calm' | 'celebratory' | 'gentle-nudge' | 'supportive' | 'silent';
    text: string;
    action?: { label: string; route: string };
    expiresAt: string;
    dismissedAt?: string;
  };
  recentMilestones: Array<{
    type: 'level_up' | 'streak_milestone' | 'achievement_unlocked' | 'goal_completed' | 'challenge_completed';
    label: string;
    occurredAt: string;
    metadata?: Record<string, unknown>;
  }>;
  onboardingStage: 'new' | 'first_problem' | 'first_streak' | 'first_challenge' | 'active';
  engagementPressure: 'none' | 'gentle' | 'normal' | 'intense';
  lastEventId: string;
  lastCalculatedAt: string;
  version: number;
  updatedAt: string;
}

async function fetchRuntimeState(): Promise<RuntimeState> {
  const { data } = await axiosClient.get('/runtime-state');
  if (!data.success) throw new Error(data.error || 'Failed to load runtime state');
  return data.data;
}

export function useRuntimeState() {
  const isAuthenticated = useUserStore((s) => s.isAuthenticated);
  const query = useQuery<RuntimeState>({
    queryKey: ['runtime-state'],
    queryFn: fetchRuntimeState,
    staleTime: 30_000,
    gcTime: 300_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 2,
    enabled: isAuthenticated,
  });

  const invalidateRuntimeState = () => {
    query.refetch();
  };

  useSse({
    onEvent: (event) => {
      // Listen for runtime state updates via SSE
      if (event.type === 'runtime_state_patch' || event.type === 'runtime_state_full') {
        invalidateRuntimeState();
      }
      // Legacy event types for backward compatibility
      if (event.type === 'xp_updated' || event.type === 'level_up') {
        invalidateRuntimeState();
      }
    },
    extraInvalidateKeys: [['runtime-state']],
  });

  return {
    data: query.data,
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: () => query.refetch(),
  };
}
