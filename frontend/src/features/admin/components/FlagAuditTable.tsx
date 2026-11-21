import type { FlagAuditEntry } from '../../../services/opsFlagsService';

const FIELD_LABELS: Record<FlagAuditEntry['changes'][number]['field'], string> = {
  name: 'Name',
  description: 'Description',
  enabled: 'Status',
  rolloutPercent: 'Rollout',
  allowedUserIds: 'Allowlist',
};

export function formatAuditValue(field: FlagAuditEntry['changes'][number]['field'], value: unknown): string {
  if (field === 'enabled') return value ? 'Active' : 'Inactive';
  if (field === 'rolloutPercent') return `${typeof value === 'number' ? value : 0}%`;
  if (field === 'allowedUserIds') {
    const count = Array.isArray(value) ? value.length : 0;
    return `${count} user${count === 1 ? '' : 's'}`;
  }
  const text = typeof value === 'string' ? value : '';
  return text ? `“${text.length > 40 ? `${text.slice(0, 40)}…` : text}”` : '(empty)';
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

interface FlagAuditTableProps {
  entries: FlagAuditEntry[];
}

/** Recent flag changes: when, which flag, who, and each setting's old and new value. */
export function FlagAuditTable({ entries }: FlagAuditTableProps) {
  if (entries.length === 0) {
    return <p className="py-6 text-center text-xs text-zinc-500">No flag changes have been recorded yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[11px]">
        <caption className="sr-only">Recent feature flag changes</caption>
        <thead className="border-b border-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
          <tr>
            <th scope="col" className="py-2 pr-3 font-bold">When</th>
            <th scope="col" className="py-2 pr-3 font-bold">Flag</th>
            <th scope="col" className="py-2 pr-3 font-bold">Changed by</th>
            <th scope="col" className="py-2 font-bold">Change</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-900/70">
          {entries.map((entry) => (
            <tr key={entry._id} className="align-top">
              <td className="whitespace-nowrap py-2 pr-3 text-zinc-400">
                <time dateTime={entry.createdAt}>{TIME_FORMAT.format(new Date(entry.createdAt))}</time>
              </td>
              <td className="py-2 pr-3 font-mono text-zinc-300">
                {entry.flagKey}
                <span className="ml-1 text-zinc-600">v{entry.version}</span>
              </td>
              <td className="py-2 pr-3 text-zinc-300">{entry.actorUsername || entry.actorId}</td>
              <td className="py-2 text-zinc-300">
                <ul className="space-y-0.5">
                  {entry.created && <li className="text-emerald-400">Created the flag</li>}
                  {entry.changes.map((change) => (
                    <li key={change.field}>
                      <span className="text-zinc-500">{FIELD_LABELS[change.field] ?? change.field}: </span>
                      {formatAuditValue(change.field, change.from)} <span aria-hidden="true">→</span>
                      <span className="sr-only"> to </span> {formatAuditValue(change.field, change.to)}
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
