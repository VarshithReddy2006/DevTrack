import { useEffect, useMemo } from 'react';
import type { CohortStandings, RankSnapshot } from './types';
import { loadRankSnapshot, saveRankSnapshot, toRankSnapshot } from './leagueUtils';

/**
 * Ranks from the previous visit to this cohort, so the table can show how places moved.
 * The baseline is read once per cohort and week; the latest ranks are stored for the next
 * visit, so refetches while the page is open do not wipe the deltas.
 */
export function useRankDeltas(view: CohortStandings | undefined): RankSnapshot | null {
  const weekKey = view?.participating ? view.weekKey : null;
  const cohortId = view?.participating ? view.cohortId : null;

  const baseline = useMemo(
    () => (weekKey ? loadRankSnapshot(weekKey, cohortId) : null),
    [weekKey, cohortId],
  );

  const standings = view?.standings;
  useEffect(() => {
    if (!weekKey || !standings || standings.length === 0) return;
    saveRankSnapshot(weekKey, cohortId, toRankSnapshot(standings));
  }, [weekKey, cohortId, standings]);

  return baseline;
}
