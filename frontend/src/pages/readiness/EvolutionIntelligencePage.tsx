import React from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, Zap, AlertTriangle, ArrowRight, Activity, Calendar } from 'lucide-react';
import { useReadinessDomain } from '../../features/readiness/hooks/useReadinessData';
import { WorkspaceHeader } from '../../features/readiness/components/WorkspaceHeader';
import type { EvolutionIntelligenceNormalized } from '../../services/readinessService';
import { EmptyState } from '../../components/shared/EmptyState';
import { useNavigate } from 'react-router-dom';

const EvolutionIntelligencePage: React.FC = () => {
  const { data, loading, error } = useReadinessDomain('evolution');
  const navigate = useNavigate();

  if (loading) {
    return (
      <div className="flex flex-col gap-6 max-w-[1400px] mx-auto w-full pb-16 px-4 animate-pulse">
        <div className="h-16 w-64 bg-slate-200/50 rounded-2xl" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="h-48 bg-slate-200/50 rounded-2xl" />
          <div className="h-48 bg-slate-200/50 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh]">
        <EmptyState size="lg" icon="alert" title="Evolution Unavailable" description="Could not load your growth journey." />
      </div>
    );
  }

  const intel = data as any as EvolutionIntelligenceNormalized;

  return (
    <div className="max-w-[1400px] mx-auto w-full pb-16 px-4 md:px-0">
      <WorkspaceHeader 
        domain="Evolution" 
        title="Evolution Intelligence" 
        coreQuestion="How far have I progressed toward my career goal?" 
        icon={<TrendingUp size={20} />} 
        accentColor="#F59E0B" 
      />

      <div className="flex flex-col lg:flex-row gap-6 mt-6">
        
        {/* LEFT COLUMN - Primary Journey */}
        <div className="flex-1 flex flex-col gap-6">
          
          {/* SEC 1: Current Stage */}
          <motion.div 
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className="rounded-3xl bg-white border border-slate-200/60 p-8 shadow-sm relative overflow-hidden"
          >
            <div className="absolute top-0 right-0 w-64 h-64 bg-amber-50 rounded-full blur-3xl -mr-20 -mt-20 opacity-50" />
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2 relative z-10">Current Stage</p>
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 relative z-10">
              <div>
                <h2 className="text-4xl md:text-5xl font-black text-slate-800 tracking-tight">
                  {intel.currentStage.stage}
                </h2>
              </div>
              <div className="text-right">
                <span className="text-3xl font-black text-amber-500">{intel.currentStage.progress}%</span>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mt-1">Roadmap Progress</p>
              </div>
            </div>
            
            <div className="w-full h-3 bg-slate-100 rounded-full mt-8 overflow-hidden relative z-10">
              <motion.div 
                initial={{ width: 0 }} 
                animate={{ width: `${intel.currentStage.progress}%` }}
                transition={{ delay: 0.3, duration: 1 }}
                className="h-full bg-gradient-to-r from-amber-400 to-amber-500 rounded-full" 
              />
            </div>
          </motion.div>

          {/* SEC 3: Evolution Summary & SEC 2: Next Milestone */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            
            <motion.div 
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
              className="rounded-2xl bg-gradient-to-br from-indigo-900 to-slate-900 p-6 text-white shadow-lg"
            >
              <div className="flex items-center gap-2 mb-4">
                <Zap size={16} className="text-indigo-400" />
                <h3 className="text-sm font-bold text-indigo-100">Evolution Summary</h3>
              </div>
              <div className="space-y-4">
                <div className="flex justify-between items-center border-b border-white/10 pb-3">
                  <span className="text-xs text-white/70 font-medium">Skills verified total</span>
                  <span className="text-lg font-bold">{intel.evolutionSummary.verifiedSkillsCount}</span>
                </div>
                <div className="flex justify-between items-center border-b border-white/10 pb-3">
                  <span className="text-xs text-white/70 font-medium">Skills mastered this month</span>
                  <span className="text-lg font-bold text-emerald-400">+{intel.evolutionSummary.skillsCompletedThisMonth}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-white/70 font-medium">Roadmap growth velocity</span>
                  <span className="text-lg font-bold text-emerald-400">+{intel.evolutionSummary.roadmapProgressChange}%</span>
                </div>
              </div>
            </motion.div>

            {intel.nextMilestone && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
                className="rounded-2xl bg-white border border-slate-200/60 p-6 shadow-sm"
              >
                <div className="flex items-center gap-2 mb-4">
                  <TrendingUp size={16} className="text-emerald-500" />
                  <h3 className="text-sm font-bold text-slate-800">Next Milestone</h3>
                </div>
                <h4 className="text-lg font-black text-slate-800 mb-1">{intel.nextMilestone.title}</h4>
                <p className="text-xs text-slate-500 font-medium mb-6">Target advancement goal</p>
                
                <div className="flex gap-4">
                  <div className="flex-1 bg-slate-50 rounded-xl p-3 border border-slate-100">
                    <div className="text-2xl font-black text-slate-800">{intel.nextMilestone.remainingSkills}</div>
                    <div className="text-[9px] font-bold text-slate-400 uppercase mt-1">Remaining Skills</div>
                  </div>
                  <div className="flex-1 bg-slate-50 rounded-xl p-3 border border-slate-100">
                    <div className="text-2xl font-black text-slate-800">{intel.nextMilestone.estimatedWeeks}</div>
                    <div className="text-[9px] font-bold text-slate-400 uppercase mt-1">Est. Weeks</div>
                  </div>
                </div>
              </motion.div>
            )}
          </div>

          {/* SEC 5: Biggest Blocker */}
          {intel.biggestBlocker && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
              className="rounded-2xl bg-rose-50/50 border border-rose-200/60 p-6 flex flex-col md:flex-row items-center justify-between gap-6"
            >
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-rose-100 flex items-center justify-center shrink-0">
                  <AlertTriangle size={18} className="text-rose-600" />
                </div>
                <div>
                  <h3 className="text-[10px] font-bold text-rose-500 uppercase tracking-wider mb-1">Primary Blocker</h3>
                  <div className="text-lg font-black text-rose-950 mb-1">Missing: {intel.biggestBlocker.skill}</div>
                  <p className="text-xs font-medium text-rose-800/80">{intel.biggestBlocker.reason}</p>
                </div>
              </div>
              <button 
                onClick={() => navigate('/readiness/roadmap')}
                className="shrink-0 px-6 py-3 bg-white border border-rose-200 hover:border-rose-300 rounded-xl text-sm font-bold text-rose-700 shadow-sm transition-all flex items-center gap-2"
              >
                View Roadmap <ArrowRight size={16} />
              </button>
            </motion.div>
          )}

        </div>

        {/* RIGHT COLUMN - Timeline & Activity */}
        <div className="w-full lg:w-[400px] flex flex-col gap-6">
          
          {/* SEC 6: Learning Activity */}
          <motion.div 
            initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.4 }}
            className="rounded-2xl bg-white border border-slate-200/60 p-5 shadow-sm flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-orange-50 flex items-center justify-center">
                <Activity size={18} className="text-orange-500" />
              </div>
              <div>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Activity Streak</p>
                <div className="text-xl font-black text-slate-800">{intel.activitySummary.streakDays} Days</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs font-bold text-slate-600">{intel.activitySummary.skillsCompleted} Skills</div>
              <div className="text-xs font-bold text-slate-400 mt-0.5">{intel.activitySummary.tasksCompleted} Tasks</div>
            </div>
          </motion.div>

          {/* SEC 4: Growth Timeline */}
          <motion.div 
            initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.5 }}
            className="rounded-2xl bg-white border border-slate-200/60 p-6 shadow-sm flex-1"
          >
            <div className="flex items-center gap-2 mb-8">
              <Calendar size={16} className="text-indigo-500" />
              <h3 className="text-sm font-bold text-slate-800">Growth Timeline</h3>
            </div>
            
            {intel.growthTimeline.length === 0 ? (
              <div className="text-center py-12">
                <div className="w-12 h-12 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-3">
                  <Activity size={20} className="text-slate-300" />
                </div>
                <p className="text-sm font-medium text-slate-500">Your journey starts here.</p>
                <p className="text-xs text-slate-400 mt-1">Complete roadmap skills to build your timeline.</p>
              </div>
            ) : (
              <div className="relative border-l-2 border-slate-100 ml-4 space-y-8 py-2">
                {intel.growthTimeline.map((item, idx) => (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.6 + idx * 0.1 }}
                    key={idx} 
                    className="relative pl-6"
                  >
                    <div className="absolute -left-[9px] top-1 w-4 h-4 rounded-full bg-white border-2 border-indigo-400 shadow-sm" />
                    <div className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider mb-1">
                      {new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </div>
                    <div className="text-sm font-bold text-slate-700">{item.event}</div>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        </div>
      </div>
    </div>
  );
};

export default EvolutionIntelligencePage;
