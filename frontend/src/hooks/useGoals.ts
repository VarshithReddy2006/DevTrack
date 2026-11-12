// Goals and challenges integration with optimistic updates
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { telemetry } from '../lib/telemetry/analytics';
import axiosClient from '../utils/axiosClient';
import type { ApiMission, ApiMutationResponse } from '../types/api.types';

// API client functions
const goalsApi = {
  getGoals: async (): Promise<ApiMission[]> => {
    const response = await axiosClient.get('/goals');
    return response.data.data || [];
  },

  completeGoal: async (goalId: string): Promise<ApiMutationResponse> => {
    const response = await axiosClient.post(`/goals/${goalId}/complete`);
    return response.data;
  },

  updateProgress: async (goalId: string, progress: number): Promise<ApiMutationResponse> => {
    const response = await axiosClient.patch(`/goals/${goalId}/progress`, { progress });
    return response.data;
  },
};

export function useGoals() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['goals'],
    queryFn: goalsApi.getGoals,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  const completeMutation = useMutation({
    mutationFn: (goalId: string) => goalsApi.completeGoal(goalId),
    onMutate: async (goalId) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['goals'] });

      // Snapshot previous value
      const previousGoals = queryClient.getQueryData<ApiMission[]>(['goals']);

      // Optimistically update
      queryClient.setQueryData<ApiMission[]>(['goals'], (old) =>
        old?.map((goal) =>
          goal.id === goalId ? { ...goal, status: 'completed' as const } : goal
        ) || []
      );

      return { previousGoals };
    },
    onSuccess: (_response, goalId) => {
      telemetry.track('goal_complete', { goalId, type: 'mission' });
    },
    onError: (_err, _goalId, context) => {
      // Rollback on error
      if (context?.previousGoals) {
        queryClient.setQueryData(['goals'], context.previousGoals);
      }
    },
    onSettled: () => {
      // Refetch to ensure server state
      queryClient.invalidateQueries({ queryKey: ['goals'] });
    },
  });

  const updateProgressMutation = useMutation({
    mutationFn: ({ goalId, progress }: { goalId: string; progress: number }) =>
      goalsApi.updateProgress(goalId, progress),
    onMutate: async ({ goalId, progress }) => {
      await queryClient.cancelQueries({ queryKey: ['goals'] });

      const previousGoals = queryClient.getQueryData<ApiMission[]>(['goals']);

      queryClient.setQueryData<ApiMission[]>(['goals'], (old) =>
        old?.map((goal) =>
          goal.id === goalId ? { ...goal, currentCount: progress } : goal
        ) || []
      );

      return { previousGoals };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousGoals) {
        queryClient.setQueryData(['goals'], context.previousGoals);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['goals'] });
    },
  });

  return {
    goals: query.data || [],
    isLoading: query.isLoading,
    error: query.error,
    completeGoal: completeMutation.mutate,
    updateProgress: updateProgressMutation.mutate,
    isCompleting: completeMutation.isPending,
    isUpdating: updateProgressMutation.isPending,
  };
}
