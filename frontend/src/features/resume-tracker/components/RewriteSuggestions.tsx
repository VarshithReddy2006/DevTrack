import { useMutation, useQueryClient } from '@tanstack/react-query';
import { acceptJobTargetRewrite, type JobTargetDetail, type RewriteSuggestion } from '../../../services/jobTargetsService';
import { jobTargetKey } from '../jobTargets';

function RewriteCard({ userId, targetId, suggestion }: { userId: string; targetId: string; suggestion: RewriteSuggestion }) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => acceptJobTargetRewrite(targetId, suggestion.id),
    retry: false,
    onSuccess: async () => {
      const key = jobTargetKey(userId, targetId);
      await client.cancelQueries({ queryKey: key, exact: true });
      client.setQueryData<JobTargetDetail>(key, target => target && ({
        ...target,
        rewriteSuggestions: target.rewriteSuggestions.map(rewrite =>
          rewrite.id === suggestion.id ? { ...rewrite, accepted: true } : rewrite),
      }));
    },
  });

  return (
    <li className="space-y-3 rounded-xl border border-slate-200 p-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="min-w-0 rounded-lg bg-slate-50 p-3">
          <dt className="font-medium text-slate-700">Original bullet</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words">{suggestion.originalText}</dd>
        </div>
        <div className="min-w-0 rounded-lg bg-violet-50 p-3">
          <dt className="font-medium text-violet-800">Suggested rewrite</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words">{suggestion.rewrittenText}</dd>
        </div>
      </dl>
      {suggestion.accepted ? (
        <p role="status" className="text-sm font-medium text-emerald-700">Rewrite accepted.</p>
      ) : (
        <button type="button" onClick={() => mutation.mutate()} disabled={mutation.isPending}
          className="rounded-lg bg-violet-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {mutation.isPending ? 'Accepting…' : 'Accept rewrite'}
        </button>
      )}
      {mutation.isError && <p role="alert" className="text-sm text-red-700">{mutation.error.message || 'Couldn’t accept this rewrite.'}</p>}
    </li>
  );
}

export function RewriteSuggestions({ userId, targetId, suggestions }: {
  userId: string;
  targetId: string;
  suggestions: RewriteSuggestion[];
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby="rewrite-suggestions">
      <h2 id="rewrite-suggestions" className="text-lg font-semibold">STAR rewrite suggestions</h2>
      {suggestions.length ? (
        <ul className="mt-4 space-y-3">
          {suggestions.map(suggestion => <RewriteCard key={suggestion.id} userId={userId} targetId={targetId} suggestion={suggestion} />)}
        </ul>
      ) : <p className="mt-3 text-sm text-slate-600">No rewrite suggestions available.</p>}
    </section>
  );
}
