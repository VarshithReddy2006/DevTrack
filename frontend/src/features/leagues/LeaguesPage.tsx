import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageShell } from '../../components/layout/PageShell';
import { getCurrentStandings, setLeagueParticipation } from '../../services/leaguesService';
import { StandingsTable } from './components/StandingsTable';
import { useRankDeltas } from './useRankDeltas';

const LEAGUE_QUERY_KEY = ['leagues', 'current'] as const;

export default function LeaguesPage() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: LEAGUE_QUERY_KEY,
    queryFn: ({ signal }) => getCurrentStandings({ signal }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    // fail fast (the endpoint may not be deployed yet); Try Again and the interval cover transient errors
    retry: false,
  });
  const join = useMutation({
    mutationFn: () => setLeagueParticipation(true),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LEAGUE_QUERY_KEY }),
  });
  const previousRanks = useRankDeltas(data);

  return (
    <PageShell
      title="Weekly League"
      subtitle={<p className="text-sm text-zinc-500">Compete on XP with your cohort until the week resets</p>}
      status={isError ? 'error' : isPending ? 'loading' : 'success'}
      error={isError ? (error instanceof Error ? error.message : 'Unable to load league standings.') : null}
      onRetry={() => void refetch()}
    >
      <div className="mx-auto w-full max-w-[800px] pb-12">
        {isPending && <p className="text-sm text-zinc-500" role="status">Loading standings...</p>}
        {data && (
          <StandingsTable
            view={data}
            previousRanks={previousRanks}
            onJoin={() => join.mutate()}
            joining={join.isPending}
            onWeekEnd={() => void queryClient.invalidateQueries({ queryKey: LEAGUE_QUERY_KEY })}
          />
        )}
        {join.isError && (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {join.error instanceof Error ? join.error.message : 'Could not join the league.'}
          </p>
        )}
      </div>
    </PageShell>
  );
}
