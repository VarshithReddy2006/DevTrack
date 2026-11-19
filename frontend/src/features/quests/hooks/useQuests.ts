import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../../lib/queryClient';
import { questsService } from '../services/questsService';

export function useQuests() {
  return useQuery({
    queryKey: queryKeys.quests.all,
    queryFn: ({ signal }) => questsService.list(signal),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}
