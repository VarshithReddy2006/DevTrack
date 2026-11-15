import React from 'react';
import { motion } from 'framer-motion';
import { Code2, Target, CheckCircle, Zap, Cpu, RefreshCw } from 'lucide-react';
import { useDSAIntelligence } from '../../features/readiness/hooks/useDSAIntelligence';
import { TrustConfidenceLayer } from '../../features/readiness/components/TrustConfidenceLayer';
import { EmptyState } from '../../components/shared/EmptyState';

// ─── Difficulty Distribution ───
const DifficultyChart: React.FC<{ dist: { easy: number; medium: number; hard: number; total: number } }> = ({ dist }) => {
  const total = dist.total || 1;
  const isZeroState = dist.total === 0;

  return (
    <div className="relative overflow-hidden rounded-3xl bg-black/40 backdrop-blur-xl border border-white/10 p-4 sm:p-8 shadow-2xl group hover:border-white/20 transition-all duration-500">
      <div className="absolute top-0 right-0 -mr-20 -mt-20 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl opacity-50 group-hover:opacity-100 transition-opacity duration-700" />
      
      <div className="relative z-10">
        <h3 className="text-lg font-black text-white tracking-tight mb-6">Difficulty Distribution</h3>
        
        {isZeroState ? (
           <div className="flex flex-col items-center justify-center py-6">
             <Cpu className="w-12 h-12 text-gray-600 mb-3 animate-pulse" />
             <p className="text-gray-400 font-medium tracking-wide">Awaiting initial telemetry...</p>
           </div>
        ) : (
          <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:gap-6">
            {[
              { label: 'Easy', value: dist.easy, color: 'bg-emerald-400', glow: 'shadow-[0_0_15px_rgba(52,211,153,0.5)]', pct: Math.round((dist.easy / total) * 100) },
              { label: 'Medium', value: dist.medium, color: 'bg-amber-400', glow: 'shadow-[0_0_15px_rgba(251,191,36,0.5)]', pct: Math.round((dist.medium / total) * 100) },
              { label: 'Hard', value: dist.hard, color: 'bg-rose-400', glow: 'shadow-[0_0_15px_rgba(244,63,94,0.5)]', pct: Math.round((dist.hard / total) * 100) },
            ].map((d) => (
              <div key={d.label} className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2">
                  <span className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">{d.label}</span>
                  <span className="text-2xl font-black text-white">{d.value}</span>
                </div>
                <div className="w-full h-2.5 bg-black/50 rounded-full overflow-hidden border border-white/5">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${d.pct}%` }}
                    transition={{ delay: 0.4, duration: 1, type: 'spring' }}
                    className={`h-full ${d.color} ${d.glow} rounded-full`}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        
        {!isZeroState && (
          <div className="mt-6 pt-4 border-t border-white/5 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500">Total Analyzed</span>
            <span className="text-sm font-black text-white bg-white/10 px-3 py-1 rounded-full">{dist.total}</span>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Main Page ───
const DSAIntelligencePage: React.FC = () => {
  const { data, isLoading, isFetching, isRefetchError, error, refetch } = useDSAIntelligence();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 max-w-[1400px] mx-auto w-full pb-16 px-4 animate-pulse pt-8">
        <div className="h-16 w-64 bg-indigo-900/20 rounded-2xl border border-indigo-500/20" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <div key={i} className="h-32 bg-white/5 rounded-3xl border border-white/10" />)}
        </div>
        <div className="h-64 bg-white/5 rounded-3xl border border-white/10" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] bg-[#0a0a0a] text-white">
        <EmptyState 
          size="lg" 
          icon="alert" 
          title="Neural Link Severed" 
          description={error?.message || "Could not load algorithmic analysis."} 
          action={
            <button 
              onClick={() => refetch()} 
              className="px-6 py-2 bg-indigo-500 text-white font-bold rounded-xl hover:bg-indigo-600 transition-colors shadow-[0_0_15px_rgba(99,102,241,0.4)]"
            >
              Re-establish Connection
            </button>
          }
        />
      </div>
    );
  }

  const containerVariants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.1 }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 300, damping: 24 } }
  };

  const isZeroState = data.readinessScore === 0 && data.consistencyScore === 0 && data.difficultyDistribution.total === 0;

  return (
    <div className="min-h-screen bg-[#050505] text-white selection:bg-indigo-500/30 pb-16 px-4 md:px-8 relative overflow-hidden font-sans">
      
      {/* Ambient Background */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-600/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-violet-600/10 rounded-full blur-[120px]" />
      </div>

      <div className="max-w-[1400px] mx-auto w-full relative z-10 pt-8">
        
        {/* We use a custom header to perfectly match the dark theme, skipping the default WorkspaceHeader if it clashes, 
            but for compatibility we'll render it and wrap it if needed. The prompt allows us to "build it to next level". */}
        <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="mb-10 flex items-center gap-4">
           <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-[0_0_30px_rgba(99,102,241,0.4)]">
             <Code2 className="w-6 h-6 text-white" />
           </div>
           <div>
             <h1 className="text-3xl font-black tracking-tight text-white">DSA Intelligence</h1>
             <p className="text-sm font-semibold text-indigo-300 uppercase tracking-widest mt-1">Algorithmic Maturity Engine</p>
           </div>
        </motion.div>

        {isZeroState && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mb-8 flex flex-col gap-4 rounded-3xl border border-indigo-500/20 bg-indigo-500/10 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-6"
          >
            <div className="flex items-center gap-4">
              <div className="shrink-0 rounded-xl bg-indigo-500/20 p-3">
                <Cpu className="w-6 h-6 text-indigo-400" />
              </div>
              <div>
                <h3 className="text-white font-bold text-lg">Zero-Gravity Mode Active</h3>
                <p className="text-indigo-200/70 text-sm">We are awaiting your first telemetry packet. Solve a problem to ignite the engine.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void refetch({ cancelRefetch: false })}
              disabled={isFetching}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-white px-6 py-2 font-bold text-black transition-transform enabled:hover:scale-105 disabled:opacity-70"
            >
              {isFetching && <RefreshCw size={16} aria-hidden="true" className="motion-safe:animate-spin" />}
              {isFetching ? 'Syncing…' : 'Sync Data'}
            </button>
          </motion.div>
        )}

        {isRefetchError && !isFetching && (
          <p role="alert" className="mb-4 text-sm text-rose-300">
            Could not refresh DSA data. Showing the last loaded results.
          </p>
        )}

        <motion.div variants={containerVariants} initial="hidden" animate="show" className="flex flex-col gap-8">
          
          {/* ─── Key Metrics ─── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Readiness Core', value: data.readinessScore, suffix: '%', icon: <Target className="w-5 h-5 text-indigo-400" />, color: 'from-indigo-500/20 to-indigo-900/10', border: 'hover:border-indigo-500/30' },
              { label: 'Consistency', value: data.consistencyScore, suffix: '%', icon: <Zap className="w-5 h-5 text-emerald-400" />, color: 'from-emerald-500/20 to-emerald-900/10', border: 'hover:border-emerald-500/30' },
              { label: 'Hard Progress', value: data.hardProgressScore, suffix: '%', icon: <Cpu className="w-5 h-5 text-rose-400" />, color: 'from-rose-500/20 to-rose-900/10', border: 'hover:border-rose-500/30' },
              { label: 'Impact Factor', value: data.readinessImpact, suffix: 'pts', icon: <CheckCircle className="w-5 h-5 text-cyan-400" />, color: 'from-cyan-500/20 to-cyan-900/10', border: 'hover:border-cyan-500/30' },
            ].map((m) => (
              <motion.div
                key={m.label}
                variants={itemVariants}
                className={`rounded-3xl bg-gradient-to-br ${m.color} border border-white/5 p-3 sm:p-4 xl:p-6 backdrop-blur-md shadow-lg ${m.border} transition-all duration-300 hover:-translate-y-1 group relative overflow-hidden`}
              >
                <div className="flex justify-between items-start mb-4">
                  <div className="p-2 bg-black/20 rounded-lg border border-white/5">{m.icon}</div>
                </div>
                <div>
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">{m.label}</p>
                  <div className="flex flex-wrap items-baseline gap-x-1">
                    <span className="min-w-0 break-all text-2xl font-black text-white sm:text-3xl md:text-4xl">{m.value}</span>
                    <span className="text-sm font-bold text-gray-500">{m.suffix}</span>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>

          {/* ─── Difficulty Distribution ─── */}
          <motion.div variants={itemVariants} className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-12">
              <DifficultyChart dist={data.difficultyDistribution} />
            </div>
          </motion.div>

          {/* ─── Intelligence Cards (Empty Center Area) ─── */}
          <motion.div variants={itemVariants} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            {/* Strong Areas */}
            <div className="rounded-3xl bg-black/40 backdrop-blur-xl border border-white/10 p-6 shadow-xl hover:border-emerald-500/30 transition-colors group">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 bg-emerald-500/10 rounded-lg">
                  <CheckCircle size={18} className="text-emerald-400" />
                </div>
                <h3 className="text-sm font-bold text-white uppercase tracking-widest">Fortified Domains</h3>
              </div>
              {data.strongTopics && data.strongTopics.length > 0 ? (
                <div className="space-y-3">
                  {data.strongTopics.map((t, i) => (
                    <div key={i} className="flex items-center justify-between px-4 py-3 rounded-2xl bg-white/5 border border-white/5 group-hover:bg-emerald-500/5 transition-colors">
                      <span className="text-sm font-bold text-gray-300">{typeof t === 'string' ? t : t.topic}</span>
                      {typeof t !== 'string' && (
                         <div className="flex items-center gap-2">
                           <div className="w-16 h-1.5 bg-black/50 rounded-full overflow-hidden">
                             <div className="h-full bg-emerald-400 rounded-full" style={{ width: `${t.mastery}%` }} />
                           </div>
                           <span className="text-xs font-black text-emerald-400">{t.mastery}%</span>
                         </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center border border-dashed border-white/10 rounded-2xl">
                  <p className="text-xs text-gray-500 font-medium">Insufficient data for domain profiling.</p>
                </div>
              )}
            </div>

            {/* Weak Areas */}
            <div className="rounded-3xl bg-black/40 backdrop-blur-xl border border-white/10 p-6 shadow-xl hover:border-rose-500/30 transition-colors group">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 bg-rose-500/10 rounded-lg">
                  <Target size={18} className="text-rose-400" />
                </div>
                <h3 className="text-sm font-bold text-white uppercase tracking-widest">Vulnerable Sectors</h3>
              </div>
              {data.weakTopics && data.weakTopics.length > 0 ? (
                <div className="space-y-3">
                  {data.weakTopics.map((t, i) => (
                    <div key={i} className="flex items-center justify-between px-4 py-3 rounded-2xl bg-white/5 border border-white/5 group-hover:bg-rose-500/5 transition-colors">
                      <span className="text-sm font-bold text-gray-300">{typeof t === 'string' ? t : t.topic}</span>
                      {typeof t !== 'string' && (
                         <div className="flex items-center gap-2">
                           <div className="w-16 h-1.5 bg-black/50 rounded-full overflow-hidden">
                             <div className="h-full bg-rose-400 rounded-full" style={{ width: `${t.mastery}%` }} />
                           </div>
                           <span className="text-xs font-black text-rose-400">{t.mastery}%</span>
                         </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center border border-dashed border-white/10 rounded-2xl">
                  <p className="text-xs text-gray-500 font-medium">No critical vulnerabilities detected.</p>
                </div>
              )}
            </div>

            {/* Recommended Next Topics */}
            <div className="rounded-3xl bg-gradient-to-br from-indigo-900/40 to-violet-900/40 backdrop-blur-xl border border-indigo-500/30 p-6 shadow-xl relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/20 rounded-full blur-2xl group-hover:bg-indigo-500/30 transition-colors" />
              <div className="relative z-10">
                <div className="flex items-center gap-3 mb-6">
                  <div className="p-2 bg-indigo-500/20 rounded-lg">
                    <Zap size={18} className="text-indigo-400" />
                  </div>
                  <h3 className="text-sm font-bold text-white uppercase tracking-widest">Tactical Directives</h3>
                </div>
                {data.nextTopics && data.nextTopics.length > 0 ? (
                  <div className="space-y-3">
                    {data.nextTopics.map((topic, i) => (
                      <div key={i} className="flex items-center gap-3 bg-black/30 border border-white/5 rounded-2xl p-4 hover:border-indigo-500/50 transition-colors cursor-default">
                        <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center text-[10px] font-black text-indigo-300">
                          {i + 1}
                        </div>
                        <h4 className="text-sm font-bold text-gray-200">{topic}</h4>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="py-8 text-center border border-dashed border-white/10 rounded-2xl">
                    <p className="text-xs text-gray-500 font-medium">Awaiting algorithmic processing...</p>
                  </div>
                )}
              </div>
            </div>
          </motion.div>

          {/* ─── Trust ─── */}
          <motion.div variants={itemVariants}>
            <div className="rounded-3xl bg-black/40 backdrop-blur-xl border border-white/10 p-6">
               {/* Re-using the TrustConfidenceLayer but wrapping it in dark styling to ensure it fits */}
               <div className="opacity-90 grayscale-[0.2]">
                 <TrustConfidenceLayer
                    confidence={data.confidenceScore}
                    verificationCoverage={data.verificationCoverage}
                  />
               </div>
            </div>
          </motion.div>
          
        </motion.div>
      </div>
    </div>
  );
};

export default DSAIntelligencePage;
