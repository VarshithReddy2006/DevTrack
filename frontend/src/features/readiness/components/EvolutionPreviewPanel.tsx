import React from 'react';
import { motion } from 'framer-motion';
import { Sparkles, CheckCircle, Zap, Server } from 'lucide-react';

interface Milestone {
  id: string;
  label: string;
  type: string;
  timestamp?: string | null;
}

interface Props {
  milestones: Milestone[];
}

const typeConfig: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
  achievement: { icon: <Sparkles size={12} />, color: 'text-indigo-500', bg: 'bg-indigo-50' },
  progress: { icon: <CheckCircle size={12} />, color: 'text-emerald-500', bg: 'bg-emerald-50' },
  infrastructure: { icon: <Server size={12} />, color: 'text-cyan-500', bg: 'bg-cyan-50' },
  default: { icon: <Zap size={12} />, color: 'text-amber-500', bg: 'bg-amber-50' },
};

export const EvolutionPreviewPanel: React.FC<Props> = ({ milestones }) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl bg-white border border-slate-200/80 p-6 shadow-xs"
    >
      <div className="flex items-center gap-2.5 mb-4">
        <div className="w-8 h-8 rounded-xl bg-indigo-50 flex items-center justify-center">
          <Zap size={14} className="text-indigo-500" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-slate-800">Engineering Evolution</h3>
          <p className="text-[10px] font-medium text-indigo-500 uppercase tracking-wider">Recent progression</p>
        </div>
      </div>

      {!milestones || milestones.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-6 text-center">
          <Sparkles size={18} className="mx-auto text-slate-400 mb-2" />
          <p className="text-xs font-medium text-slate-600">
            Complete a mission or sync new commits to record your first milestone.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {milestones.map((ms, i) => {
            const cfg = typeConfig[ms.type] || typeConfig.default;
            return (
              <motion.div
                key={ms.id || i}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.5 + i * 0.06 }}
                className="flex items-center gap-3 px-3 py-2 rounded-xl bg-slate-50/50 hover:bg-slate-50 transition-colors"
              >
                <div className={`w-6 h-6 rounded-lg ${cfg.bg} flex items-center justify-center shrink-0`}>
                  <span className={cfg.color}>{cfg.icon}</span>
                </div>
                <span className="text-xs font-medium text-slate-700">{ms.label}</span>
              </motion.div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
};
