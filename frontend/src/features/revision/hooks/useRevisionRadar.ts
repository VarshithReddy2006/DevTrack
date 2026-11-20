import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../../lib/queryClient';
import { fetchDueCards, fetchRevisionAnalytics, MAX_DUE_CARDS } from '../../../services/revisionService';
import { useUserStore } from '../../../store/userStore';

function useUserId(): string | null {
  return useUserStore((state) => state.user?.id ?? null);
}

export function useRevisionAnalytics() {
  const userId = useUserId();
  return useQuery({
    queryKey: queryKeys.revision.analytics,
    queryFn: ({ signal }) => fetchRevisionAnalytics(signal),
    enabled: !!userId,
  });
}

/** Cards due now, up to the API cap. Used for the overdue badge and the start button state. */
export function useDueCardSummary() {
  const userId = useUserId();
  return useQuery({
    queryKey: queryKeys.revision.dueSummary,
    queryFn: ({ signal }) => fetchDueCards(MAX_DUE_CARDS, signal),
    enabled: !!userId,
  });
}
