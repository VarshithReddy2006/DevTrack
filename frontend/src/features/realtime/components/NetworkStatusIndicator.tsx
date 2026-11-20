import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Activity, Clock, HeartPulse, RefreshCw, Wifi } from 'lucide-react';
import { cn } from '../../../lib/design-system/tokens.css';
import { getSseDiagnostics, reconnectNow, type ConnectionStatus } from '../../../hooks/useSse';
import { useNetworkLatency } from '../../../hooks/useNetworkLatency';
import { formatAgo, formatDuration, getNetworkHealth, type NetworkHealthLevel } from '../networkHealth';

const LEVEL_STYLES: Record<NetworkHealthLevel, { dot: string; text: string; badge: string; title: string }> = {
  healthy: { dot: 'bg-emerald-500', text: 'text-emerald-600', badge: 'bg-emerald-50 text-emerald-700', title: 'Healthy' },
  degraded: { dot: 'bg-amber-500', text: 'text-amber-600', badge: 'bg-amber-50 text-amber-700', title: 'Degraded' },
  poor: { dot: 'bg-rose-500', text: 'text-rose-600', badge: 'bg-rose-50 text-rose-700', title: 'Slow' },
  offline: { dot: 'bg-rose-500', text: 'text-rose-600', badge: 'bg-rose-50 text-rose-700', title: 'Offline' },
};

function Row({ icon, label, value, valueClass }: { icon: ReactNode; label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11px]">
      <dt className="flex items-center gap-2 text-slate-500">{icon}<span>{label}</span></dt>
      <dd className={cn('font-bold text-slate-700', valueClass)}>{value}</dd>
    </div>
  );
}

interface NetworkStatusIndicatorProps {
  status: ConnectionStatus;
}

/** Compact top bar pill showing API latency and live-stream health, with a details popover. */
export function NetworkStatusIndicator({ status }: NetworkStatusIndicatorProps) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const { pingMs, lastPingAt, failed, pingNow } = useNetworkLatency(status === 'connected');

  // Heartbeats don't re-render the app, so re-read timings on a timer (faster while the details are open).
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), open ? 1_000 : 5_000);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const diagnostics = getSseDiagnostics();
  const health = getNetworkHealth({
    status, pingMs, pingFailed: failed, now,
    lastHeartbeatAt: diagnostics.lastHeartbeatAt, lastEventAt: diagnostics.lastEventAt,
  });
  const style = LEVEL_STYLES[health.level];
  const connected = status === 'connected';
  const canReconnect = status === 'reconnecting' || status === 'disconnected';
  const latencyValue = pingMs !== null ? `${pingMs}ms` : connected && failed ? 'No response' : '—';

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onBlur={(event) => { if (!containerRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label={`Connection ${style.title.toLowerCase()}: ${health.label}. Show connection details`}
        data-level={health.level}
        className="flex items-center gap-1.5 text-[10px] font-bold tracking-tight text-slate-500 transition-colors hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6]"
      >
        <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', style.dot, health.level === 'offline' && 'animate-pulse')} />
        <span className={cn('tabular-nums', health.level !== 'healthy' && style.text)}>{health.label}</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            id={popoverId}
            role="dialog"
            aria-label="Connection details"
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute right-0 z-50 mt-2.5 w-64 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-xl"
          >
            <div className="mb-2 flex items-center justify-between border-b border-slate-100 pb-2">
              <span className="text-[9px] font-extrabold uppercase tracking-wider text-slate-400">Connection</span>
              <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-tight', style.badge)}>{style.title}</span>
            </div>
            {health.reason && <p className="mb-2 text-[11px] text-slate-600">{health.reason}</p>}

            <dl className="space-y-2">
              <Row icon={<Wifi size={12} className="text-slate-400" />} label="API ping" value={latencyValue} valueClass={style.text} />
              <Row icon={<Clock size={12} className="text-slate-400" />} label="Live stream uptime" value={connected && diagnostics.connectedAt ? formatDuration(now - diagnostics.connectedAt) : '—'} />
              <Row icon={<Activity size={12} className="text-slate-400" />} label="Last event" value={formatAgo(diagnostics.lastEventAt, now)} />
              <Row
                icon={<HeartPulse size={12} className="text-slate-400" />}
                label="Last heartbeat"
                value={connected ? formatAgo(diagnostics.lastHeartbeatAt, now) : '—'}
                valueClass={health.heartbeatStale ? 'text-amber-600' : undefined}
              />
              <Row icon={<RefreshCw size={12} className="text-slate-400" />} label="Reconnects" value={String(diagnostics.totalReconnects)} />
            </dl>

            {canReconnect && (
              <button type="button" onClick={reconnectNow} className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#8B5CF6] px-3 py-2 text-xs font-semibold text-white hover:bg-[#7C4DEB] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6]">
                <RefreshCw size={12} aria-hidden="true" /> Reconnect now
              </button>
            )}
            {connected && health.level !== 'healthy' && (
              <button type="button" onClick={pingNow} className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6]">
                <Wifi size={12} aria-hidden="true" /> Check again
              </button>
            )}
            <p className="mt-3 text-[9px] text-slate-400">
              {lastPingAt ? `Pinged ${formatAgo(lastPingAt, now)}. ` : ''}Pings pause while this tab is in the background.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
