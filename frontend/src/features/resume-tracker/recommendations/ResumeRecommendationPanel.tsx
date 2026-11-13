import React, { useEffect, useState } from 'react';
import { useSessionState } from '../state/useSessionState';
import { Lightbulb, Loader2, ShieldAlert, Cpu, CheckCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { IIntelligenceRecommendation } from '../types/recommendation.types';
import api from '../../../utils/axiosClient.js';

export const ResumeRecommendationPanel: React.FC = () => {
  const { currentSession } = useSessionState();
  const [recommendations, setRecommendations] = useState<IIntelligenceRecommendation[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const isProcessing = currentSession?.stages.recommendations.status === 'processing';
  const isPending = currentSession?.stages.recommendations.status === 'pending';

  useEffect(() => {
    // Only fetch if session is active and we're not waiting for earlier stages
    if (!currentSession?.sessionId || isPending || isProcessing) return;

    const fetchIntelligence = async () => {
      try {
        setIsLoading(true);
        // Explicitly hitting the new recommendations endpoints
        const res = await api.get(`/recommendations/intelligence/${currentSession.sessionId}`);
        if (res.data?.success) {
          setRecommendations(res.data.data.filter((rec: IIntelligenceRecommendation) => rec.state !== 'completed'));
        }
      } catch (error) {
        console.error('Failed to fetch intelligence recommendations', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchIntelligence();
  }, [currentSession?.sessionId, isPending, isProcessing]);

  if (isPending) return null;

  const renderIcon = (category: string) => {
    switch (category) {
      case 'ats': return <ShieldAlert size={16} className="text-rose-500" />;
      case 'credibility': return <CheckCircle size={16} className="text-amber-500" />;
      case 'infrastructure':
      case 'semantic': return <Cpu size={16} className="text-indigo-500" />;
      default: return <Lightbulb size={16} className="text-violet-500" />;
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'ats': return 'bg-rose-50 border-rose-200 text-rose-700 shadow-sm';
      case 'credibility': return 'bg-amber-50 border-amber-200 text-amber-700 shadow-sm';
      case 'semantic':
      case 'infrastructure': return 'bg-indigo-50 border-indigo-200 text-indigo-700 shadow-sm';
      default: return 'bg-violet-50 border-violet-200 text-violet-700 shadow-sm';
    }
  };

  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Lightbulb size={16} className="text-violet-600" />
        <h2 className="text-[13px] font-black uppercase tracking-widest text-slate-900">Engineering Analysis Guidance</h2>
      </div>

      <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-slate-200 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.05)] p-6 min-h-[200px] relative overflow-hidden">
        {isProcessing || isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-5 relative group h-full">
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-fuchsia-50/50 to-transparent animate-pulse pointer-events-none" />
            <motion.div 
              animate={{ rotate: 360 }}
              transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
              className="relative z-10 w-16 h-16 rounded-2xl bg-gradient-to-br from-fuchsia-100 to-violet-100 border border-fuchsia-200 shadow-inner flex items-center justify-center"
            >
              <div className="absolute inset-0 rounded-2xl bg-gradient-to-r from-fuchsia-400 to-violet-400 opacity-20 blur-md" />
              <Loader2 className="w-8 h-8 text-fuchsia-600 relative z-10" />
            </motion.div>
            <div className="relative z-10 flex flex-col items-center gap-1.5 text-center">
              <p className="text-[11px] font-black uppercase tracking-widest bg-clip-text text-transparent bg-gradient-to-r from-fuchsia-600 to-violet-600">
                {isProcessing ? 'Synthesizing Intelligence...' : 'Retrieving Engineering Insights...'}
              </p>
            </div>
          </div>
        ) : recommendations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 h-full">
            <CheckCircle className="w-10 h-10 text-emerald-500 mb-3" />
            <p className="text-sm font-bold text-slate-900">No Actionable Gaps Detected</p>
            <p className="text-xs text-slate-500 mt-1 font-medium">Your profile meets structural and semantic engineering standards.</p>
          </div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <AnimatePresence>
              {recommendations.map((rec) => (
                <motion.div
                  key={rec.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  whileHover={{ y: -4 }}
                  className="flex flex-col gap-3 p-6 rounded-2xl bg-white/60 backdrop-blur-md border border-slate-200 shadow-[0_4px_14px_-2px_rgba(0,0,0,0.05)] relative overflow-hidden group cursor-default"
                >
                  <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-fuchsia-400 to-violet-400 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                  <div className="absolute -right-4 -top-4 w-24 h-24 bg-violet-400/5 rounded-full blur-xl group-hover:bg-violet-400/10 transition-colors duration-500" />

                  <div className="flex items-center justify-between relative z-10">
                    <div className="flex items-center gap-2">
                      {renderIcon(rec.category)}
                      <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${getCategoryColor(rec.category)}`}>
                        {rec.category.replace('_', ' ')}
                      </span>
                    </div>
                    {rec.impact.scoreImprovement > 0 && (
                      <span className="text-[10px] font-bold text-emerald-700 uppercase tracking-widest bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 shadow-sm">
                        +{rec.impact.scoreImprovement} Impact
                      </span>
                    )}
                  </div>

                  <h4 className="text-sm font-bold text-slate-900 mt-2 relative z-10">{rec.title}</h4>
                  <p className="text-[13px] font-medium text-slate-600 leading-relaxed relative z-10">
                    {rec.content}
                  </p>

                  {rec.evidenceReferences && rec.evidenceReferences.length > 0 && (
                    <div className="mt-3 text-[11px] font-mono text-slate-600 bg-slate-50 px-4 py-3 rounded-xl border border-slate-100 shadow-inner relative z-10">
                      <span className="text-slate-400 uppercase tracking-wider font-bold block mb-1">Evidence Trace</span>
                      <ul className="list-disc list-inside space-y-1.5">
                        {rec.evidenceReferences.map((evidence, i) => {
                          if (evidence.startsWith('similarity_score_')) {
                            const score = evidence.split('_').pop();
                            return <li key={i} className="text-indigo-600 font-semibold">Cosine Similarity: {score} (below 0.65 threshold)</li>;
                          }
                          return <li key={i}>{evidence}</li>;
                        })}
                      </ul>
                    </div>
                  )}

                  <div className="flex items-center justify-between mt-auto pt-4 border-t border-slate-100 relative z-10">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Confidence Score: <span className="text-violet-600">{rec.confidence}%</span></span>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </div>
    </div>
  );
};
