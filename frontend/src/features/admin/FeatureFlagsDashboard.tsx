import { History, Sliders } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import type { AdminFeatureFlag } from '../../services/opsFlagsService';
import { FlagAuditTable } from './components/FlagAuditTable';
import { FlagSlider } from './components/FlagSlider';
import { useAdminFlags, useFlagAudit, useUpdateFlag } from './hooks/useAdminFlags';

function errorMessage(error: unknown, fallback: string): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : fallback;
}

function FlagRow({ flag }: { flag: AdminFeatureFlag }) {
  const update = useUpdateFlag();
  const allowlisted = flag.allowedUserIds.length;
  const audience = flag.enabled
    ? `${flag.rolloutPercent}% of users${allowlisted ? ` plus ${allowlisted} allowlisted` : ''}`
    : 'Nobody (switched off)';

  return (
    <li className="space-y-3 rounded-xl border border-zinc-900 bg-zinc-900/25 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-xs font-bold text-zinc-200">
            {flag.name}
            <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-black uppercase ${flag.enabled ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
              {flag.enabled ? 'Active' : 'Inactive'}
            </span>
          </h3>
          <p className="mt-0.5 font-mono text-[10px] text-zinc-500">{flag.key} · v{flag.version}</p>
          {flag.description && <p className="mt-1 text-[11px] text-zinc-400">{flag.description}</p>}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={flag.enabled}
          aria-label={`${flag.name} enabled`}
          disabled={update.isPending}
          onClick={() => update.mutate({ key: flag.key, changes: { enabled: !flag.enabled } })}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 disabled:opacity-60 ${flag.enabled ? 'bg-emerald-500' : 'bg-zinc-700'}`}
        >
          <span aria-hidden="true" className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${flag.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </div>

      <div className="space-y-1.5 rounded-lg border border-zinc-900/60 bg-zinc-950/20 px-3 py-2">
        <div className="flex items-center justify-between text-[11px] font-bold text-zinc-500">
          <span>Rollout</span>
          <span className="text-zinc-400">Target: {audience}</span>
        </div>
        <FlagSlider
          value={flag.rolloutPercent}
          label={`Rollout percentage for ${flag.name}`}
          onCommit={(rolloutPercent) => update.mutate({ key: flag.key, changes: { rolloutPercent } })}
        />
      </div>

      <p role="status" aria-live="polite" className="min-h-4 text-[10px] text-zinc-500">
        {update.isPending ? 'Saving…' : ''}
      </p>
      {update.isError && (
        <p role="alert" className="text-[11px] text-red-400">{errorMessage(update.error, 'The flag could not be updated.')}</p>
      )}
    </li>
  );
}

/** Admin view of stored feature flags: kill switch, rollout slider and recent changes. */
export function FeatureFlagsDashboard() {
  const flags = useAdminFlags();
  const audit = useFlagAudit();

  return (
    <div className="space-y-6">
      <Card className="border-zinc-800/80 bg-zinc-950/40">
        <CardHeader className="border-b border-zinc-900 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-bold">
            <Sliders size={15} className="text-emerald-400" aria-hidden="true" />
            Feature flags
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {flags.isPending && <p role="status" className="py-6 text-center text-xs text-zinc-500">Loading feature flags…</p>}
          {flags.isError && (
            <div role="alert" className="py-6 text-center text-xs text-red-400">
              {errorMessage(flags.error, 'Could not load feature flags.')}
              <button type="button" onClick={() => void flags.refetch()} className="ml-2 underline">Try again</button>
            </div>
          )}
          {flags.isSuccess && flags.data.length === 0 && (
            <p className="py-6 text-center text-xs text-zinc-500">No feature flags are stored yet.</p>
          )}
          {flags.isSuccess && flags.data.length > 0 && (
            <ul className="space-y-4" aria-label="Feature flags">
              {flags.data.map((flag) => <FlagRow key={flag.key} flag={flag} />)}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="border-zinc-800/80 bg-zinc-950/40">
        <CardHeader className="border-b border-zinc-900 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-bold">
            <History size={15} className="text-zinc-400" aria-hidden="true" />
            Recent changes
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {audit.isPending && <p role="status" className="py-6 text-center text-xs text-zinc-500">Loading audit log…</p>}
          {audit.isError && (
            <p role="alert" className="py-6 text-center text-xs text-red-400">
              {errorMessage(audit.error, 'Could not load the audit log.')}
              <button type="button" onClick={() => void audit.refetch()} className="ml-2 underline">Try again</button>
            </p>
          )}
          {audit.isSuccess && <FlagAuditTable entries={audit.data} />}
        </CardContent>
      </Card>
    </div>
  );
}
