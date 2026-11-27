import React from 'react';
import {
  Activity,
  Box,
  Cpu,
  Database,
  ExternalLink,
  GitBranch,
  Globe,
  HardDrive,
  Layers,
  Lock,
  Network,
  Radio,
  Server,
  Shield,
  Workflow,
  Zap,
} from 'lucide-react';

export type TopologyCategory =
  | 'databases'
  | 'queues'
  | 'gateways'
  | 'infrastructure'
  | 'observability';

export type TopologyIconKey =
  | 'database'
  | 'server'
  | 'hard-drive'
  | 'zap'
  | 'layers'
  | 'radio'
  | 'network'
  | 'globe'
  | 'shield'
  | 'box'
  | 'cpu'
  | 'activity'
  | 'git-branch'
  | 'lock'
  | 'workflow';

export interface TopologyNode {
  id: string;
  name: string;
  category: TopologyCategory;
  description: string;
  iconKey: TopologyIconKey;
  tags: string[];
  evidenceSource?: string;
  repositoryUrl?: string | null;
}

export interface TopologyNodeCardProps {
  node: TopologyNode;
  selected?: boolean;
  onSelect?: (node: TopologyNode) => void;
}

const ICON_MAP: Record<TopologyIconKey, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  database: Database,
  server: Server,
  'hard-drive': HardDrive,
  zap: Zap,
  layers: Layers,
  radio: Radio,
  network: Network,
  globe: Globe,
  shield: Shield,
  box: Box,
  cpu: Cpu,
  activity: Activity,
  'git-branch': GitBranch,
  lock: Lock,
  workflow: Workflow,
};

const CATEGORY_STYLE: Record<
  TopologyCategory,
  { badge: string; iconBg: string; borderSelected: string; label: string }
> = {
  databases: {
    badge: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    iconBg: 'bg-indigo-50 text-indigo-600 border-indigo-100',
    borderSelected: 'border-indigo-500 ring-2 ring-indigo-500/20',
    label: 'Database',
  },
  queues: {
    badge: 'bg-amber-50 text-amber-800 border-amber-200',
    iconBg: 'bg-amber-50 text-amber-600 border-amber-100',
    borderSelected: 'border-amber-500 ring-2 ring-amber-500/20',
    label: 'Queue',
  },
  gateways: {
    badge: 'bg-cyan-50 text-cyan-800 border-cyan-200',
    iconBg: 'bg-cyan-50 text-cyan-600 border-cyan-100',
    borderSelected: 'border-cyan-500 ring-2 ring-cyan-500/20',
    label: 'Gateway',
  },
  infrastructure: {
    badge: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    iconBg: 'bg-emerald-50 text-emerald-600 border-emerald-100',
    borderSelected: 'border-emerald-500 ring-2 ring-emerald-500/20',
    label: 'Infrastructure',
  },
  observability: {
    badge: 'bg-violet-50 text-violet-800 border-violet-200',
    iconBg: 'bg-violet-50 text-violet-600 border-violet-100',
    borderSelected: 'border-violet-500 ring-2 ring-violet-500/20',
    label: 'Observability',
  },
};

/** Accepts only explicit http(s) URLs to avoid javascript: or protocol-relative links. */
export function sanitizeExternalUrl(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('//')) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export const TopologyNodeCard: React.FC<TopologyNodeCardProps> = ({
  node,
  selected = false,
  onSelect,
}) => {
  const IconComponent = ICON_MAP[node.iconKey] ?? Server;
  const styles = CATEGORY_STYLE[node.category];
  const safeRepoUrl = sanitizeExternalUrl(node.repositoryUrl);

  return (
    <article
      data-testid={`topology-node-${node.id}`}
      data-category={node.category}
      className={`flex flex-col justify-between rounded-2xl border bg-white p-4 transition-all ${
        selected
          ? styles.borderSelected
          : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'
      }`}
    >
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${styles.iconBg}`}
            >
              <IconComponent className="h-5 w-5" aria-hidden={true} />
            </div>
            <div className="min-w-0">
              <h4 className="truncate text-sm font-bold text-slate-900">{node.name}</h4>
              <span
                className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${styles.badge}`}
              >
                {styles.label}
              </span>
            </div>
          </div>

          {onSelect && (
            <button
              type="button"
              onClick={() => onSelect(node)}
              aria-pressed={selected}
              aria-label={`Inspect ${node.name} topology signal`}
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                selected
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
              }`}
            >
              {selected ? 'Selected' : 'Inspect'}
            </button>
          )}
        </div>

        <p className="mt-3 text-xs leading-relaxed text-slate-600">{node.description}</p>

        {node.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {node.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {(node.evidenceSource || safeRepoUrl) && (
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
          {node.evidenceSource ? (
            <span className="truncate font-mono text-[10px] text-slate-500">
              Source: {node.evidenceSource}
            </span>
          ) : (
            <span />
          )}

          {safeRepoUrl && (
            <a
              href={safeRepoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1 font-semibold text-indigo-600 hover:text-indigo-700"
            >
              Repo
              <ExternalLink className="h-3 w-3" aria-hidden={true} />
            </a>
          )}
        </div>
      )}
    </article>
  );
};
