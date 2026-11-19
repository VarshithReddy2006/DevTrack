import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../../lib/queryClient';
import { questsService } from '../services/questsService';

export function useClaimQuest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (questId: string) => questsService.claim(questId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quests.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.xp.current }),
      ]);
    },
  });
}
