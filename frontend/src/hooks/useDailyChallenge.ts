// src/hooks/useDailyChallenge.ts
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getTodayChallenge } from '../services/dailyChallengeService';
import type { DailyChallengeData } from '../services/dailyChallengeService';
import { useSse } from './useSse';

export interface DailyChallengeState {
  challenge: DailyChallengeData | null;
  userCompleted: boolean;
}

async function fetchTodayChallenge(): Promise<DailyChallengeState> {
  const { data } = await getTodayChallenge();
  if (!data.success) throw new Error('Failed to load daily challenge');
  return data.data;
}

export function useDailyChallenge() {
  const queryClient = useQueryClient();

  const query = useQuery<DailyChallengeState>({
    queryKey: ['dailyChallenge', 'today'],
    queryFn: fetchTodayChallenge,
    staleTime: 60_000,
    gcTime: 300_000,
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
    retry: 2,
  });

  const invalidateChallenge = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['dailyChallenge', 'today'] });
  }, [queryClient]);

  useSse({
    onEvent: (event) => {
      if (event.type === 'challenge_completed') {
        invalidateChallenge();
      }
    },
    extraInvalidateKeys: [['dailyChallenge', 'today']],
    invalidateOn: ['challenge_completed'],
  });

  return {
    challenge: query.data?.challenge ?? null,
    userCompleted: query.data?.userCompleted ?? false,
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: () => query.refetch(),
  };
}
