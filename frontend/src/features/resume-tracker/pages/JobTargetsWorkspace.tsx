import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { listJobTargets } from '../../../services/jobTargetsService';
import { JobTargetComposer } from '../components/JobTargetComposer';
import { JOB_TARGET_POLL_MS, jobTargetsKey, statusLabels, targetIsPending, useJobTargetUpdates } from '../jobTargets';

function Targets({ userId }: { userId: string }) {
  useJobTargetUpdates(userId);
  const query = useQuery({
    queryKey: jobTargetsKey(userId),
    queryFn: ({ signal }) => listJobTargets(signal),
    refetchInterval: ({ state }) => state.data?.some(target => targetIsPending(target.status)) ? JOB_TARGET_POLL_MS : false,
    retry: false,
  });

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 text-slate-900 sm:px-8">
      <header className="space-y-2">
        <Link to="/resume" className="inline-flex items-center gap-1.5 text-sm font-medium text-violet-700 hover:underline">
          <ArrowLeft aria-hidden="true" size={16} /> Resume Intelligence
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Job targets</h1>
        <p className="text-sm text-slate-600">Compare your resume with a specific job posting.</p>
      </header>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <JobTargetComposer userId={userId} />
        <section aria-labelledby="saved-targets" className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 id="saved-targets" className="text-lg font-semibold">Saved job targets</h2>
          {query.isPending && <p role="status" className="mt-3 text-sm text-slate-600">Loading job targets…</p>}
          {query.isError && (
            <div className="mt-3 text-sm">
              <p role="alert">Couldn’t load job targets.</p>
              <button type="button" onClick={() => void query.refetch()} className="text-violet-700 underline">Try again</button>
            </div>
          )}
          {query.data?.length === 0 && <p className="mt-3 text-sm text-slate-600">Your analyzed postings will appear here.</p>}
          {query.data && query.data.length > 0 && (
            <ul className="mt-2 divide-y divide-slate-100">
              {query.data.map(target => (
                <li key={target.id}>
                  <Link to={`/resume/targets/${encodeURIComponent(target.id)}`}
                    className="flex items-center justify-between gap-3 py-3 text-sm hover:text-violet-700">
                    <span className="min-w-0">
                      <span className="block break-words font-semibold">{target.role || 'Job posting'}</span>
                      <span className="block break-words text-slate-600">
                        {target.company && `${target.company} · `}
                        <time dateTime={target.createdAt}>{new Date(target.createdAt).toLocaleDateString()}</time>
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                        {target.status === 'ready' && target.matchScore != null ? `${target.matchScore}% match` : statusLabels[target.status]}
                      </span>
                      <ArrowUpRight aria-hidden="true" size={15} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export function JobTargetsWorkspace() {
  const { userId } = useAuth();
  return userId ? <Targets key={userId} userId={userId} /> : null;
}
