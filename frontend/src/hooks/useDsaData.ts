// ============================================================================
// useDsaData.ts — DSA Data Hook (TanStack Query)
// ============================================================================
// Derives DSA page data from the DSA dashboard endpoint (GET /api/dsa/dashboard)
// and the paginated detail endpoints (submissions and contests).
// Uses TanStack Query for caching, polling, and cache invalidation.
// ============================================================================

import { useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchDsaDashboard,
  fetchDsaSubmissions,
  fetchDsaContests,
  fetchSchedulerStatus,
} from '../services/dsaService';
import { queryKeys } from '../lib/queryClient';
import axiosClient from '../utils/axiosClient';
import { useSse } from './useSse';
import { useXp } from './useXp';
import type {
  DsaData,
  Platform,
  Submission,
} from '../types/dsa';
import type { ApiDsaDashboardResponse } from '../types/api.types';
import type { SchedulerStatus } from '../services/dsaService';

const VALID_PLATFORMS: ReadonlySet<string> = new Set<Platform>([
  'leetcode',
  'codeforces',
  'codechef',
  'github',
]);

function isDsaPlatform(name: string): name is Platform {
  return VALID_PLATFORMS.has(name);
}

// ---------------------------------------------------------------------------
// Sub-queries — each fetches independently; failures are isolated
// ---------------------------------------------------------------------------

function useDsaDashboard() {
  return useQuery<ApiDsaDashboardResponse>({
    queryKey: queryKeys.dsa.dashboard,
    queryFn: async ({ signal }) => {
      const res = await fetchDsaDashboard({ signal });
      if (!res.success) throw new Error(res.message || 'Failed to load dashboard');
      return res.data;
    },
    staleTime: 30_000,
    gcTime: 300_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });
}

function useDsaSubmissions() {
  return useQuery<Submission[]>({
    queryKey: queryKeys.dsa.submissions({ pageSize: 100 }),
    queryFn: async ({ signal }) => {
      const res = await fetchDsaSubmissions({ pageSize: 100 }, { signal });
      if (!res.success) throw new Error(res.message || 'Failed to load submissions');
      return res.data.submissions
        .filter((s) => isDsaPlatform(s.platform))
        .map((s) => ({
          id: s.id,
          status: s.status === 'accepted' ? 'accepted' : 'wrong',
          problem: s.problemName,
          topic: s.problemCategory ?? 'General',
          platform: s.platform as Platform,
          language: s.language,
          date: new Date(s.submittedAt).toLocaleDateString('en-US', {
            month: 'short',
            day: '2-digit',
            year: 'numeric',
          }),
          difficulty: (s.problemDifficulty as 'easy' | 'medium' | 'hard') ?? undefined,
        }));
    },
    staleTime: 30_000,
    gcTime: 300_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });
}

function useDsaContests() {
  return useQuery({
    queryKey: queryKeys.dsa.contests({ pageSize: 20 }),
    queryFn: async ({ signal }) => {
      const res = await fetchDsaContests({ pageSize: 20 }, { signal });
      if (!res.success) throw new Error(res.message || 'Failed to load contests');
      return res.data.contests
        .filter((c) => isDsaPlatform(c.platform))
        .map((c) => ({
          id: c.id,
          contestName: c.contestName,
          platform: c.platform as Platform,
          rank: c.rank,
          totalParticipants: c.totalParticipants,
          problemsSolved: c.problemsSolved,
          ratingChange: c.ratingChange,
          participatedAt: c.participatedAt,
        }));
    },
    staleTime: 60_000,
    gcTime: 300_000,
    refetchInterval: 300_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });
}

// Scheduler status — drives sync state / stale-data indicators (polled)
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes without a successful sync → stale

function useSchedulerStatus() {
  return useQuery<SchedulerStatus>({
    queryKey: queryKeys.dsa.syncStatus,
    queryFn: async ({ signal }) => {
      const res = await fetchSchedulerStatus({ signal });
      if (!res.success) throw new Error(res.message || 'Failed to load scheduler status');
      return res.data;
    },
    // Poll every 20s — lightweight, no DB load on backend
    staleTime: 10_000,
    gcTime: 30_000,
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 3000),
  });
}

function deriveStaleState(schedulerStatus: SchedulerStatus | undefined): boolean {
  if (!schedulerStatus) return false;
  if (schedulerStatus.status === 'running') return false;
  const lastCompleted = schedulerStatus.lastSyncCompletedAt;
  if (!lastCompleted) return true; // Never synced
  const elapsed = Date.now() - new Date(lastCompleted).getTime();
  return elapsed > STALE_THRESHOLD_MS;
}

// ---------------------------------------------------------------------------
// Sync mutation — invalidates all DSA queries on completion
// ---------------------------------------------------------------------------

function useSyncMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (platformName?: string) => {
      const url = platformName
        ? `/platforms/sync/${platformName}`
        : '/platforms/sync-all';
      const { data } = await axiosClient.post(url);
      return data;
    },
    onSuccess: () => {
      // Invalidate DSA data AND scheduler status so frontend reflects fresh state
      queryClient.invalidateQueries({ queryKey: queryKeys.dsa.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.dsa.syncStatus });
    },
  });
}

// ---------------------------------------------------------------------------
// Main hook — merges sub-queries into unified DsaData shape
// ---------------------------------------------------------------------------

export function useDsaData(): {
  data: DsaData | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  sync: () => void;
  isSyncing: boolean;
  isDataStale: boolean;
  schedulerStatus: SchedulerStatus | undefined;
  connectionStatus: import('./useSse').ConnectionStatus;
  xp: import('./useXp').XpState;
} {
  const dashboardQ = useDsaDashboard();
  const submissionsQ = useDsaSubmissions();
  const contestsQ = useDsaContests();
  const schedulerStatusQ = useSchedulerStatus();
  const syncMutation = useSyncMutation();
  const sse = useSse();
  const xp = useXp();

  const isLoading =
    dashboardQ.isLoading ||
    submissionsQ.isLoading ||
    contestsQ.isLoading;

  const errorMessage =
    dashboardQ.error?.message ||
    submissionsQ.error?.message ||
    (contestsQ.error instanceof Error ? contestsQ.error.message : null) ||
    null;

  // Stale detection: no successful sync in 5+ minutes and not currently syncing
  const isDataStale = useMemo(
    () => deriveStaleState(schedulerStatusQ.data),
    [schedulerStatusQ.data]
  );

  const data = useMemo<DsaData | null>(() => {
    if (!dashboardQ.data) return null;

    const { stats, heatmap, topics, solvedByDifficulty, platformOverview } = dashboardQ.data;
    return {
      stats,
      heatmap,
      topics,
      solvedByDifficulty,
      submissions: submissionsQ.data ?? [],
      contests: contestsQ.data ?? [],
      platformOverview: platformOverview.flatMap(item =>
        isDsaPlatform(item.platform)
          ? [{ ...item, platform: item.platform, rank: item.rank == null ? null : String(item.rank) }]
          : []
      ),
    };
  }, [dashboardQ.data, submissionsQ.data, contestsQ.data]);

  // Stable refetch — wrapped in useCallback so it never changes reference
  const refetch = useCallback(() => {
    void dashboardQ.refetch();
    void submissionsQ.refetch();
    void contestsQ.refetch();
    void schedulerStatusQ.refetch();
  }, [dashboardQ, submissionsQ, contestsQ, schedulerStatusQ]);

  const sync = () => syncMutation.mutate(undefined);

  return {
    data,
    loading: isLoading,
    error: errorMessage,
    refetch,
    sync,
    isSyncing: syncMutation.isPending,
    isDataStale,
    schedulerStatus: schedulerStatusQ.data,
    connectionStatus: sse.connectionStatus,
    xp: {
      totalXp: xp.totalXp,
      currentLevel: xp.currentLevel,
      xpToNextLevel: xp.xpToNextLevel,
      xpInCurrentLevel: xp.xpInCurrentLevel,
      progressPercent: xp.progressPercent,
      lifetimeStats: xp.lifetimeStats,
    },
  };
}
