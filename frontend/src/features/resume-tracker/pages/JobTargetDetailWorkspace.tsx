import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, LoaderCircle } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { getJobTarget } from '../../../services/jobTargetsService';
import { GapList } from '../components/GapList';
import { MatchBreakdown } from '../components/MatchBreakdown';
import { MissingKeywords } from '../components/MissingKeywords';
import { RewriteSuggestions } from '../components/RewriteSuggestions';
import { JOB_TARGET_POLL_MS, jobTargetKey, statusLabels, targetIsPending, useJobTargetUpdates } from '../jobTargets';

function TargetDetail({ userId, targetId }: { userId: string; targetId: string }) {
  useJobTargetUpdates(userId);
  const query = useQuery({
    queryKey: jobTargetKey(userId, targetId),
    queryFn: ({ signal }) => getJobTarget(targetId, signal),
    refetchInterval: ({ state }) => targetIsPending(state.data?.status) ? JOB_TARGET_POLL_MS : false,
    retry: false,
  });
  const target = query.data;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-8 text-slate-900 sm:px-8">
      <header className="space-y-2">
        <Link to="/resume/targets" className="inline-flex items-center gap-1.5 text-sm font-medium text-violet-700 hover:underline">
          <ArrowLeft aria-hidden="true" size={16} /> Job targets
        </Link>
        <h1 className="break-words text-3xl font-bold tracking-tight">{target?.role || 'Job target'}</h1>
        {target?.company && <p className="text-sm text-slate-600">{target.company}</p>}
      </header>
      {query.isPending && <p role="status" className="text-sm text-slate-600">Loading job target…</p>}
      {query.isError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p role="alert">Couldn’t load the latest job target status.</p>
          <button type="button" className="mt-2 underline" onClick={() => void query.refetch()}>Try again</button>
        </div>
      )}
      {target && targetIsPending(target.status) && (
        <p role="status" className="flex items-center gap-2 rounded-xl border border-violet-100 bg-violet-50 p-4 text-sm text-violet-800">
          <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
          {statusLabels[target.status]} · This page updates automatically.
        </p>
      )}
      {target?.status === 'failed' && (
        <div className="space-y-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p role="alert">{target.errorMessage || 'This posting couldn’t be analyzed.'}</p>
          <Link to="/resume/targets" className="underline">Submit another posting</Link>
        </div>
      )}
      {target?.status === 'ready' && target.match && (
        <>
          {target.analysisMode === 'taxonomy_only' && <p className="text-sm text-slate-600">Keyword and evidence analysis</p>}
          <MatchBreakdown match={target.match} />
          <div className="grid gap-5 md:grid-cols-2">
            <MissingKeywords keywords={target.missingKeywords} />
            <GapList gaps={target.gaps} />
          </div>
          <RewriteSuggestions userId={userId} targetId={target.id} suggestions={target.rewriteSuggestions} />
        </>
      )}
    </div>
  );
}

export function JobTargetDetailWorkspace() {
  const { userId } = useAuth();
  const { jobTargetId } = useParams();
  return userId && jobTargetId ? <TargetDetail key={JSON.stringify([userId, jobTargetId])} userId={userId} targetId={jobTargetId} /> : null;
}
