import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '../../../components/shared/Icon';
import { getApiHealth, getPlatformSyncStatuses, type PlatformSyncStatus } from '../../../services/systemHealthService';

type HealthState = 'healthy' | 'warning' | 'error' | 'syncing' | 'disconnected' | 'unknown';
interface SystemStatus { id: string; label: string; status: HealthState; detail: string; icon: string }
interface SystemHealthBarProps { onSettingsChange?: (status: SystemStatus[]) => void }

const platforms = [
  { id: 'github', label: 'GitHub', icon: 'brand-github' },
  { id: 'leetcode', label: 'LeetCode', icon: 'code-bracket' },
  { id: 'codeforces', label: 'Codeforces', icon: 'code-bracket' },
  { id: 'codechef', label: 'CodeChef', icon: 'code-bracket' },
] as const;

const pendingStatuses: SystemStatus[] = [
  { id: 'api', label: 'API', icon: 'server', status: 'unknown', detail: 'Checking…' },
  ...platforms.map(({ id, label, icon }) => ({ id, label, icon, status: 'unknown' as const, detail: 'Checking…' })),
];

export function platformStatus(platform: PlatformSyncStatus | undefined, now = Date.now()): Pick<SystemStatus, 'status' | 'detail'> {
  if (!platform || !platform.isConnected) return { status: 'disconnected', detail: 'Not connected' };
  if (platform.syncStatus === 'syncing') return { status: 'syncing', detail: 'Sync in progress' };
  if (platform.syncStatus === 'error' || platform.syncStatus === 'failed') return { status: 'error', detail: 'Last sync failed' };
  if (platform.syncStatus !== 'success' || !platform.lastSyncedAt) return { status: 'unknown', detail: 'No successful sync yet' };
  const syncedAt = Date.parse(platform.lastSyncedAt);
  if (!Number.isFinite(syncedAt) || syncedAt > now) return { status: 'unknown', detail: 'Sync time unavailable' };
  const hoursAgo = Math.floor((now - syncedAt) / 3_600_000);
  if (hoursAgo >= 24) return { status: 'warning', detail: `Last synced ${hoursAgo}h ago` };
  if (hoursAgo > 0) return { status: 'healthy', detail: `Last synced ${hoursAgo}h ago` };
  const minutesAgo = Math.floor((now - syncedAt) / 60_000);
  return { status: 'healthy', detail: minutesAgo ? `Last synced ${minutesAgo}m ago` : 'Synced less than a minute ago' };
}

const colors: Record<HealthState, { bg: string; dot: string; text: string }> = {
  healthy: { bg: 'bg-dt-success/10', dot: 'bg-dt-success', text: 'text-dt-success' },
  warning: { bg: 'bg-dt-warning/10', dot: 'bg-dt-warning', text: 'text-dt-warning' },
  error: { bg: 'bg-dt-error/10', dot: 'bg-dt-error', text: 'text-dt-error' },
  syncing: { bg: 'bg-dt-primary/10', dot: 'bg-dt-primary animate-pulse', text: 'text-dt-primary' },
  disconnected: { bg: 'bg-dt-bg/60', dot: 'bg-dt-textMuted/50', text: 'text-dt-textMuted' },
  unknown: { bg: 'bg-dt-bg/60', dot: 'bg-dt-textMuted/50', text: 'text-dt-textMuted' },
};

export const SystemHealthBar: React.FC<SystemHealthBarProps> = ({ onSettingsChange }) => {
  const [statuses, setStatuses] = useState<SystemStatus[]>(pendingStatuses);
  const [expanded, setExpanded] = useState(false);
  const [checking, setChecking] = useState(true);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setChecking(true);
    setStatuses(pendingStatuses);
    const [api, sync] = await Promise.allSettled([getApiHealth(), getPlatformSyncStatuses()]);
    if (currentRequest !== requestId.current) return;
    const apiStatus: SystemStatus = api.status === 'fulfilled'
      ? { id: 'api', label: 'API', icon: 'server',
          status: api.value.health.status === 'ok' && !api.value.health.degraded ? 'healthy' : 'warning',
          detail: `${api.value.health.degraded ? 'Degraded' : 'Responding'} · ${api.value.latencyMs}ms` }
      : { id: 'api', label: 'API', icon: 'server', status: 'error', detail: 'Health check unavailable' };
    const platformStatuses = platforms.map(({ id, label, icon }): SystemStatus => ({
      id, label, icon,
      ...(sync.status === 'fulfilled'
        ? platformStatus(sync.value.find(item => item.platformName.toLowerCase() === id))
        : { status: 'unknown' as const, detail: 'Sync status unavailable' }),
    }));
    const next = [apiStatus, ...platformStatuses];
    setStatuses(next);
    setLastChecked(new Date());
    setChecking(false);
    onSettingsChange?.(next);
  }, [onSettingsChange]);

  useEffect(() => {
    const activeRequest = requestId;
    void refresh();
    return () => { activeRequest.current++; };
  }, [refresh]);

  const healthyCount = statuses.filter(item => item.status === 'healthy').length;
  return (
    <div className="relative">
      <motion.button type="button" aria-label="Show system status" aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/60 border border-dt-primary/5 hover:bg-white/80 transition-all duration-200"
        whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
        <div className="flex items-center gap-1.5">
          {statuses.slice(0, 3).map(item => <div key={item.id} className={`w-2 h-2 rounded-full ${colors[item.status].dot}`} />)}
        </div>
        <span className="text-xs font-semibold text-dt-textSecondary/70">
          {checking ? 'Checking status…' : `${healthyCount}/${statuses.length} healthy`}
        </span>
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={12} className="text-dt-textMuted/50" />
      </motion.button>
      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ opacity: 0, y: -10, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }} transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="absolute top-full right-0 mt-2 w-72 bg-white/95 backdrop-blur-2xl border border-dt-primary/10 rounded-2xl shadow-[0_16px_48px_rgba(124,92,252,0.12)] overflow-hidden z-50">
            <div className="px-4 py-3 border-b border-dt-primary/5 bg-dt-bg/30">
              <h4 className="text-xs font-black text-dt-text uppercase tracking-wider">System Status</h4>
            </div>
            <div className="p-3 space-y-1">
              {statuses.map(item => (
                <div key={item.id} className={`flex items-center gap-3 px-3 py-2.5 rounded-xl ${colors[item.status].bg}`}>
                  <Icon name={item.icon} size={16} className={colors[item.status].text} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-dt-text">{item.label}</span>
                      <div className={`w-2 h-2 rounded-full ${colors[item.status].dot}`} />
                    </div>
                    <p className={`text-[11px] font-medium ${colors[item.status].text} mt-0.5`}>{item.detail}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="px-4 py-2.5 border-t border-dt-primary/5 bg-dt-bg/30 flex items-center justify-between">
              <span className="text-[11px] font-medium text-dt-textMuted/50">
                {lastChecked ? `Checked ${lastChecked.toLocaleTimeString()}` : 'Awaiting first check'}
              </span>
              <button type="button" disabled={checking} onClick={() => void refresh()}
                className="text-[11px] font-black text-dt-primary uppercase tracking-wider hover:underline disabled:opacity-50">
                {checking ? 'Checking…' : 'Refresh'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
