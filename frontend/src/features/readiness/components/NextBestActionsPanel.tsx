import React from 'react';
import { motion } from 'framer-motion';
import type { ReadinessSnapshot } from '../../../services/readinessService';

interface Props {
  data: ReadinessSnapshot;
}

export const NextBestActionsPanel: React.FC<Props> = ({ data }) => {
  if (!data.nextBestActions || data.nextBestActions.length === 0) return null;

  return (
    <div className="bg-gradient-to-br from-indigo-900 to-slate-900 rounded-[32px] p-8 shadow-xl text-white">
      <div className="flex items-center justify-between mb-8">
        <div>
           <h3 className="text-2xl font-bold">What should I do next?</h3>
           <p className="text-indigo-200 mt-1 font-medium">Highest-leverage progression actions</p>
        </div>
        <div className="h-12 w-12 rounded-2xl bg-indigo-500/20 flex items-center justify-center border border-indigo-500/30">
           <svg className="w-6 h-6 text-indigo-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
           </svg>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {data.nextBestActions.map((action, i) => {
          const fallbackUrl =
            action.category === 'dsa'
              ? '/readiness/dsa'
              : action.category === 'core'
                ? '/readiness/roadmap'
                : '/projects';
          const destination = action.actionUrl || fallbackUrl;
          return (
            <motion.div
              key={action.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.1 }}
              className="bg-white/5 backdrop-blur-md rounded-2xl p-6 border border-white/10 hover:bg-white/10 transition-colors group relative overflow-hidden"
            >
              {action.priority === 'high' && (
                <div className="absolute top-0 left-0 w-1 h-full bg-rose-500" />
              )}
              <div className="flex flex-col sm:flex-row justify-between items-start gap-4 pl-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-3 mb-3">
                    <span className={`text-[10px] uppercase font-black tracking-wider px-2.5 py-1 rounded-full ${action.priority === 'high' ? 'bg-rose-500/20 text-rose-300' : 'bg-indigo-500/20 text-indigo-300'}`}>
                      {action.priority} priority
                    </span>
                    <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-white/10 text-slate-300">
                      {action.category}
                    </span>
                  </div>
                  <h4 className="text-xl font-bold text-white mb-2">{action.title}</h4>
                  <p className="text-sm text-slate-300 leading-relaxed mb-4">{action.description}</p>
                  <div className="bg-black/30 rounded-xl p-3 inline-block border border-white/5">
                    <p className="text-xs text-indigo-200 font-medium flex items-start gap-2">
                      <svg className="w-4 h-4 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {action.why}
                    </p>
                  </div>
                </div>
                <a
                  href={destination}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-white px-3.5 py-2 text-xs font-bold text-indigo-950 shadow-md hover:bg-indigo-50 transition-colors cursor-pointer"
                >
                  Take Action →
                </a>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
};
