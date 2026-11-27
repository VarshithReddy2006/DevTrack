import React from 'react';
import { motion } from 'framer-motion';
import { Shield, Clock, AlertCircle, CheckCircle, Info, RefreshCw } from 'lucide-react';
import { useUIStore } from '../../../store/uiStore';
import { useSseConnectionState, type ConnectionStatus } from '../../../hooks/useSse';

interface Props {
  confidence: number;
  isDegraded?: boolean;
  isSyncError?: boolean;
  connectionStatus?: ConnectionStatus;
  providerCount?: number;
  lastSyncedAt?: string | null;
  verificationCoverage?: number;
}

const CONFIDENCE_STYLES = {
  emerald: { dot: 'bg-emerald-500', text: 'text-emerald-600' },
  amber: { dot: 'bg-amber-500', text: 'text-amber-600' },
  rose: { dot: 'bg-rose-500', text: 'text-rose-600' },
} as const;

export const TrustConfidenceLayer: React.FC<Props> = ({
  confidence,
  isDegraded = false,
  isSyncError = false,
  connectionStatus,
  providerCount = 0,
  lastSyncedAt,
  verificationCoverage = 0,
}) => {
  const isOnline = useUIStore((s) => s.isOnline);
  const sseStatus = useUIStore((s) => s.sseStatus);
  const isInfrastructureDegraded = useUIStore((s) => s.isInfrastructureDegraded);
  const liveSse = useSseConnectionState();

  const resolvedConnection: ConnectionStatus =
    connectionStatus ??
    (liveSse.isManaged
      ? liveSse.connectionStatus
      : sseStatus === 'reconnecting'
        ? 'reconnecting'
        : 'connected');

  const statusMeta = (() => {
    if (!isOnline || resolvedConnection === 'disconnected') {
      return {
        label: 'Offline',
        textClass: 'text-rose-600',
        icon: <AlertCircle size={12} className="text-rose-500 shrink-0" />,
      };
    }
    if (resolvedConnection === 'reconnecting' || resolvedConnection === 'connecting') {
      return {
        label: 'Reconnecting…',
        textClass: 'text-amber-600',
        icon: <RefreshCw size={12} className="text-amber-500 shrink-0 motion-safe:animate-spin" />,
      };
    }
    if (isDegraded || isInfrastructureDegraded || isSyncError) {
      return {
        label: 'Degraded',
        textClass: 'text-amber-600',
        icon: <AlertCircle size={12} className="text-amber-500 shrink-0" />,
      };
    }
    return {
      label: 'Operational',
      textClass: 'text-emerald-600',
      icon: <Info size={12} className="text-slate-400 shrink-0" />,
    };
  })();

  const confidenceLevel = confidence >= 80 ? 'High' : confidence >= 50 ? 'Moderate' : 'Low';
  const confidenceColor = confidence >= 80 ? 'emerald' : confidence >= 50 ? 'amber' : 'rose';
  const confidenceStyle = CONFIDENCE_STYLES[confidenceColor];

  const formatSyncTime = (ts: string | null | undefined) => {
    if (!ts) return 'Never';
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 5) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${Math.floor(diffHours / 24)}d ago`;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.5, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl bg-slate-50/80 border border-slate-200/50 p-5"
    >
      <div className="flex items-center gap-2 mb-3">
        <Shield size={14} className="text-slate-400" />
        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Trust & Confidence</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Confidence */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-100">
          <div className={`w-2 h-2 rounded-full shrink-0 ${confidenceStyle.dot}`} />
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Confidence</p>
            <p className={`text-xs font-bold ${confidenceStyle.text}`}>{confidenceLevel} ({confidence}%)</p>
          </div>
        </div>

        {/* Data Freshness */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-100">
          <Clock size={12} className="text-slate-400 shrink-0" />
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Data Freshness</p>
            <p className="text-xs font-bold text-slate-700">{formatSyncTime(lastSyncedAt)}</p>
          </div>
        </div>

        {/* Verification Coverage */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-100">
          <CheckCircle size={12} className="text-slate-400 shrink-0" />
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Verification</p>
            <p className="text-xs font-bold text-slate-700">{verificationCoverage}% covered</p>
          </div>
        </div>

        {/* Synchronized Status */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-100">
          {statusMeta.icon}
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Status</p>
            <p className={`text-xs font-bold ${statusMeta.textClass}`}>
              {statusMeta.label}
            </p>
          </div>
        </div>
      </div>

      {/* Providers */}
      {providerCount > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-[10px] text-slate-400 font-medium">
          <span>{providerCount} data provider{providerCount !== 1 ? 's' : ''} connected</span>
          <span>Transparency: Active</span>
        </div>
      )}
    </motion.div>
  );
};
