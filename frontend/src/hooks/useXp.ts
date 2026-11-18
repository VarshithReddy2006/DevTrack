// ============================================================================
// useXp.ts — XP State Hook with SSE Real-time Updates
// ============================================================================
// Fetches user XP from GET /api/xp and listens to xp_updated/level_up SSE
// events for real-time progress. XP data is freshened on sync completion.
// ============================================================================

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import axiosClient from '../utils/axiosClient';
import { useSse } from './useSse';

// ---------------------------------------------------------------------------
// Types — mirror backend processor return
// ---------------------------------------------------------------------------

export interface XpState {
  totalXp: number;
  currentLevel: number;
  xpToNextLevel: number;
  xpInCurrentLevel: number;
  progressPercent: number;
  lifetimeStats: LifetimeStats;
}

export interface LifetimeStats {
  totalProblemsSolved: number;
  easySolved: number;
  mediumSolved: number;
  hardSolved: number;
  totalContests: number;
  dailyStreaks: number;
  longestStreak: number;
  totalSyncs: number;
  totalXpEarned: number;
}

// ---------------------------------------------------------------------------
// Fetch XP from backend
// ---------------------------------------------------------------------------

async function fetchUserXp(): Promise<XpState> {
  const { data } = await axiosClient.get('/xp');
  if (!data.success) throw new Error(data.error || 'Failed to load XP');
  return data.data;
}

// ---------------------------------------------------------------------------
// useXp — real-time XP state with SSE integration
// ---------------------------------------------------------------------------

const DEFAULT_STATS: LifetimeStats = {
  totalProblemsSolved: 0,
  easySolved: 0,
  mediumSolved: 0,
  hardSolved: 0,
  totalContests: 0,
  dailyStreaks: 0,
  longestStreak: 0,
  totalSyncs: 0,
  totalXpEarned: 0,
};

export function useXp(): XpState & {
  loading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const queryClient = useQueryClient();

  const query = useQuery<XpState>({
    queryKey: ['xp', 'state'],
    queryFn: fetchUserXp,
    staleTime: 30_000,
    gcTime: 300_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 2,
  });

  const invalidateXp = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['xp', 'state'] });
  }, [queryClient]);

  useSse({
    onEvent: (event) => {
      if (event.type === 'xp_updated' || event.type === 'level_up') {
        invalidateXp();
      }
    },
    extraInvalidateKeys: [['xp', 'state']],
    invalidateOn: ['xp_updated', 'level_up'],
  });

  return {
    totalXp: query.data?.totalXp ?? 0,
    currentLevel: query.data?.currentLevel ?? 1,
    xpToNextLevel: query.data?.xpToNextLevel ?? 100,
    xpInCurrentLevel: query.data?.xpInCurrentLevel ?? 0,
    progressPercent: query.data?.progressPercent ?? 0,
    lifetimeStats: query.data?.lifetimeStats ?? DEFAULT_STATS,
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: () => query.refetch(),
  };
}