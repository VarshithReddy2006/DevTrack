// src/hooks/useAiInsights.ts — AI Insights Hook
import { useQuery } from '@tanstack/react-query';
import { observationService, type HeuristicInsight } from '../services/observationService';
import { useUserStore } from '../store/userStore';

export function useAiInsights() {
  const isAuthenticated = useUserStore((state) => state.isAuthenticated);

  const query = useQuery<HeuristicInsight[]>({
    queryKey: ['aiInsights'],
    enabled: isAuthenticated,
    queryFn: async () => {
      const response = await observationService.getInsights();
      if (!response.success) throw new Error('Failed to load AI insights');
      return response.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: true,
  });

  return {
    insights: query.data ?? [],
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: () => isAuthenticated ? query.refetch() : undefined,
  };
}
