import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCurrentStandings } from '../../services/leaguesService';
import { useUserStore } from '../../store/userStore';
import { LEAGUE_QUERY_KEY } from './leagueQuery';
import { detectPromotion, loadSeenDivision, saveSeenDivision, type LeaguePromotion } from './leagueUtils';
import type { CohortStandings, LeagueDivision } from './types';

export interface ActiveLeaguePromotion extends LeaguePromotion {
  cohortSize: number;
  promotionSlots: number;
}

/**
 * Compares the user's current division with the last one they acknowledged.
 * The first division seen on a device is stored silently, and demotions only
 * update the stored division, so the celebration shows for real promotions only.
 */
export function useLeaguePromotion() {
  const userId = useUserStore((state) => (state.isAuthenticated ? state.user?.id ?? null : null));
  const { data } = useQuery<CohortStandings>({
    queryKey: LEAGUE_QUERY_KEY,
    queryFn: ({ signal }) => getCurrentStandings({ signal }),
    enabled: !!userId,
    staleTime: 5 * 60_000,
    // The leagues endpoint may be unavailable; the celebration is optional.
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [acknowledged, setAcknowledged] = useState<{ userId: string; to: LeagueDivision } | null>(null);

  const current = data?.participating ? data.division : null;
  const cohortSize = data?.cohortSize ?? 0;
  const promotionSlots = data?.promotionSlots ?? 0;

  const promotion = useMemo<ActiveLeaguePromotion | null>(() => {
    if (!userId || !current) return null;
    if (acknowledged?.userId === userId && acknowledged.to === current) return null;
    const found = detectPromotion(loadSeenDivision(userId), current);
    return found ? { ...found, cohortSize, promotionSlots } : null;
  }, [userId, current, cohortSize, promotionSlots, acknowledged]);

  // Without a promotion to celebrate, keep the stored division in step silently.
  useEffect(() => {
    if (!userId || !current || promotion) return;
    if (loadSeenDivision(userId) !== current) saveSeenDivision(userId, current);
  }, [userId, current, promotion]);

  const acknowledge = useCallback(() => {
    if (!userId || !promotion) return;
    saveSeenDivision(userId, promotion.to);
    setAcknowledged({ userId, to: promotion.to });
  }, [userId, promotion]);

  return { promotion, acknowledge };
}
