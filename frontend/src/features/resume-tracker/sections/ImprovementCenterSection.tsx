import React, { useEffect, useState } from 'react';
import { useSessionState } from '../state/useSessionState';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, CheckCircle, Zap, ChevronDown, ChevronUp, GitCommit, TrendingUp, ArrowRight } from 'lucide-react';
import type { IIntelligenceRecommendation } from '../types/recommendation.types';
import api from '../../../utils/axiosClient.js';

export const ImprovementCenterSection: React.FC = () => {
  const { currentSession } = useSessionState();
  const [recommendations, setRecommendations] = useState<IIntelligenceRecommendation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const report = currentSession?.reportData;
  const evolution = report?.evolution;
  const atsScore = report?.atsAnalysis?.atsScore ?? 0;

  const isProcessing = currentSession?.stages.recommendations.status === 'processing';
  const isPending = currentSession?.stages.recommendations.status === 'pending';

  useEffect(() => {
    if (!currentSession?.sessionId || isPending || isProcessing) return;

    const fetchIntelligence = async () => {
      try {
        setIsLoading(true);
        const res = await api.get(`/recommendations/intelligence/${currentSession.sessionId}`);
        if (res.data?.success) {
          setRecommendations(res.data.data);
        }
      } catch (error) {
        console.error('Failed to fetch intelligence recommendations', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchIntelligence();
  }, [currentSession?.sessionId, isPending, isProcessing]);

  const updateRecommendation = async (id: string, action: 'accept' | 'complete' | 'dismiss') => {
    setPendingAction(id);
    setActionError(null);
    try {
      const { data } = await api.post<{ data: IIntelligenceRecommendation }>(`/recommendations/intelligence/${id}/${action}`);
      setRecommendations(rows => action === 'dismiss'
        ? rows.filter(row => row.id !== id)
        : rows.map(row => row.id === id ? { ...row, state: data.data.state } : row));
    } catch {
      setActionError('Could not update the recommendation. Try again.');
    } finally {
      setPendingAction(null);
    }
  };

  const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
  const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'ats': return 'bg-rose-50 text-rose-600 border-rose-100';
      case 'credibility': return 'bg-amber-50 text-amber-600 border-amber-100';
      case 'semantic':
      case 'infrastructure': return 'bg-indigo-50 text-indigo-600 border-indigo-100';
      case 'role_alignment': return 'bg-blue-50 text-blue-600 border-blue-100';
      default: return 'bg-violet-50 text-violet-600 border-violet-100';
    }
  };

  const getDifficultyLabel = (confidence: number) => {
    if (confidence >= 80) return { label: 'Easy', color: 'text-emerald-600 bg-emerald-50 border-emerald-100' };
    if (confidence >= 50) return { label: 'Medium', color: 'text-amber-600 bg-amber-50 border-amber-100' };
    return { label: 'Hard', color: 'text-rose-600 bg-rose-50 border-rose-100' };
  };

  const Card = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
    <motion.div variants={fadeUp} className={`bg-white rounded-2xl border border-[rgba(124,92,252,0.08)] shadow-[0_2px_12px_rgba(0,0,0,0.02)] p-6 ${className}`}>
      {children}
    </motion.div>
  );

  if (isPending) return null;

  if (isProcessing || isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <Loader2 className="w-8 h-8 text-dt-primary animate-spin" />
        <p className="text-[13px] font-semibold text-dt-textMuted">
          {isProcessing ? 'Synthesizing improvements...' : 'Loading improvement center...'}
        </p>
      </div>
    );
  }

  // Report-level recommendations (for before/after rewrites)
  const reportRecs = report?.recommendations || [];

  // Completed vs active
  const activeRecs = recommendations.filter(r => r.state !== 'completed');
  const completedRecs = recommendations.filter(r => r.state === 'completed');

  // Total potential gain
  const totalGain = recommendations.reduce((sum, rec) => sum + (rec.impact?.scoreImprovement ?? 0), 0);

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="flex flex-col gap-5">

      {/* Summary bar */}
      {recommendations.length > 0 && (
        <Card className="!p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-semibold text-dt-textMuted">Active</span>
              <span className="text-[14px] font-bold text-dt-text">{activeRecs.length}</span>
            </div>
            <div className="w-px h-4 bg-[rgba(124,92,252,0.1)]" />
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-semibold text-dt-textMuted">Completed</span>
              <span className="text-[14px] font-bold text-emerald-600">{completedRecs.length}</span>
            </div>
            <div className="w-px h-4 bg-[rgba(124,92,252,0.1)]" />
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-semibold text-dt-textMuted">Potential Gain</span>
              <span className="text-[14px] font-bold text-dt-primary flex items-center gap-1">
                <Zap className="w-3.5 h-3.5" /> +{totalGain} pts
              </span>
            </div>
          </div>
        </Card>
      )}

      {/* Improvement Queue */}
      {recommendations.length > 0 ? (
        <Card>
          <p className="text-section-label mb-4">Improvement Queue</p>
          <div className="flex flex-col gap-2">
            {recommendations.map((rec, idx) => {
              const gain = rec.impact?.scoreImprovement ?? 0;
              const difficulty = getDifficultyLabel(rec.confidence);
              return (
                <div key={rec.id || idx} className="flex items-center gap-3 p-3 rounded-xl bg-[rgba(124,92,252,0.02)] border border-[rgba(124,92,252,0.05)]">
                  <div className="w-5 h-5 rounded-md border border-[rgba(124,92,252,0.15)] flex items-center justify-center shrink-0">
                    {rec.state === 'completed' ? (
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <span className="w-2 h-2 rounded-sm bg-[rgba(124,92,252,0.15)]" />
                    )}
                  </div>
                  <span className={`text-[13px] font-medium flex-1 ${rec.state === 'completed' ? 'text-dt-textMuted line-through' : 'text-dt-text'}`}>
                    {rec.title}
                  </span>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md border shrink-0 ${difficulty.color}`}>
                    {difficulty.label}
                  </span>
                  {gain > 0 && (
                    <span className="text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-100 whitespace-nowrap shrink-0 flex items-center gap-1">
                      <Zap className="w-3 h-3" /> +{gain}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      ) : (
        <Card className="flex flex-col items-center gap-3 !py-10">
          <CheckCircle className="w-10 h-10 text-emerald-500" />
          <p className="text-[14px] font-semibold text-dt-text">No Actionable Gaps Detected</p>
          <p className="text-[13px] text-dt-textMuted font-medium text-center max-w-md">
            Your profile meets structural and semantic engineering standards.
          </p>
        </Card>
      )}

      {/* Recommendation Cards — Expanded details */}
      {recommendations.length > 0 && (
        <div>
          <p className="text-section-label mb-4">Recommendations</p>
          {actionError && <p role="alert" className="mb-3 text-sm text-rose-700">{actionError}</p>}
          <div className="flex flex-col gap-3">
            <AnimatePresence>
              {recommendations.map((rec) => {
                const gain = rec.impact?.scoreImprovement ?? 0;
                const isExpanded = expandedId === rec.id;
                const difficulty = getDifficultyLabel(rec.confidence);

                return (
                  <motion.div
                    key={rec.id}
                    layout
                    className="bg-white rounded-2xl border border-[rgba(124,92,252,0.08)] shadow-[0_2px_12px_rgba(0,0,0,0.02)] overflow-hidden"
                  >
                    <button
                      onClick={() => {
                        setExpandedId(isExpanded ? null : rec.id);
                        if (!isExpanded && rec.state !== 'completed') {
                          void api.post(`/recommendations/intelligence/${rec.id}/view`).catch(() => {});
                        }
                      }}
                      className="w-full flex items-center justify-between p-5 text-left hover:bg-[rgba(124,92,252,0.01)] transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md border shrink-0 ${getCategoryColor(rec.category)}`}>
                          {rec.category.replace('_', ' ')}
                        </span>
                        <span className="text-[13px] font-semibold text-dt-text truncate">{rec.title}</span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-3">
                        {gain > 0 && (
                          <span className="text-[11px] font-bold text-emerald-600 whitespace-nowrap">+{gain} pts</span>
                        )}
                        {isExpanded ? <ChevronUp className="w-4 h-4 text-dt-textMuted" /> : <ChevronDown className="w-4 h-4 text-dt-textMuted" />}
                      </div>
                    </button>

                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                          className="overflow-hidden"
                        >
                          <div className="px-5 pb-5 flex flex-col gap-4 border-t border-[rgba(124,92,252,0.05)]">
                            {/* Issue */}
                            <div className="pt-4">
                              <p className="text-[12px] font-semibold text-dt-textMuted uppercase tracking-wider mb-1">Suggested Improvement</p>
                              <p className="text-[13px] text-dt-textSecondary leading-relaxed font-medium">{rec.content}</p>
                            </div>

                            {/* Metrics row */}
                            <div className="flex flex-wrap gap-4">
                              {gain > 0 && (
                                <div>
                                  <p className="text-[11px] font-semibold text-dt-textMuted uppercase tracking-wider mb-1">ATS Gain</p>
                                  <p className="text-[14px] font-bold text-emerald-600">+{gain} Points</p>
                                </div>
                              )}
                              <div>
                                <p className="text-[11px] font-semibold text-dt-textMuted uppercase tracking-wider mb-1">Difficulty</p>
                                <span className={`text-[12px] font-bold px-2 py-0.5 rounded-md border ${difficulty.color}`}>
                                  {difficulty.label}
                                </span>
                              </div>
                              <div>
                                <p className="text-[11px] font-semibold text-dt-textMuted uppercase tracking-wider mb-1">Confidence</p>
                                <p className="text-[14px] font-bold text-dt-primary">{rec.confidence}%</p>
                              </div>
                            </div>

                            {/* Evidence */}
                            {rec.evidenceReferences && rec.evidenceReferences.length > 0 && (
                              <div className="p-3 bg-slate-50/80 rounded-xl border border-slate-100">
                                <p className="text-[11px] font-bold text-dt-textMuted uppercase tracking-wider mb-2">Evidence</p>
                                <ul className="flex flex-col gap-1.5">
                                  {rec.evidenceReferences.map((evidence, i) => (
                                    <li key={i} className="text-[12px] text-dt-textSecondary font-medium leading-relaxed">
                                      • {evidence.startsWith('similarity_score_')
                                        ? `Cosine Similarity: ${evidence.split('_').pop()} (below threshold)`
                                        : evidence
                                      }
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                          {rec.state !== 'completed' && (
                            <div className="mt-4 flex flex-wrap items-center gap-3">
                              {rec.state === 'active' && (
                                <button type="button" disabled={pendingAction !== null}
                                  onClick={() => void updateRecommendation(rec.id, 'accept')}
                                  className="text-sm font-semibold text-dt-primary disabled:opacity-50">
                                  Accept
                                </button>
                              )}
                              <button type="button" disabled={pendingAction !== null}
                                onClick={() => void updateRecommendation(rec.id, 'complete')}
                                className="text-sm font-semibold text-emerald-700 disabled:opacity-50">
                                Mark complete
                              </button>
                              <button type="button" disabled={pendingAction !== null}
                                onClick={() => void updateRecommendation(rec.id, 'dismiss')}
                                className="text-sm font-semibold text-dt-textMuted disabled:opacity-50">
                                Dismiss
                              </button>
                              {rec.state === 'accepted' && <span className="text-sm text-dt-textMuted">Accepted</span>}
                            </div>
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </div>
      )}

      {/* Before/After Rewrites from report recommendations */}
      {reportRecs.some((r: any) => r.beforeText || r.afterText || r.suggestion) && (
        <Card>
          <p className="text-section-label mb-4">Suggested Rewrites</p>
          <div className="flex flex-col gap-4">
            {reportRecs.filter((r: any) => r.suggestion).slice(0, 5).map((rec: any, idx: number) => (
              <div key={idx} className="p-4 rounded-xl bg-[rgba(124,92,252,0.02)] border border-[rgba(124,92,252,0.05)]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-dt-primary bg-[rgba(124,92,252,0.06)] px-2 py-0.5 rounded-md border border-[rgba(124,92,252,0.1)]">
                    {rec.category || 'general'}
                  </span>
                  {rec.progressionDependency && (
                    <span className="text-[10px] font-medium text-dt-textMuted">Depends on: {rec.progressionDependency}</span>
                  )}
                </div>
                <p className="text-[13px] font-medium text-dt-text leading-relaxed">{rec.suggestion}</p>
                {rec.evidenceTraceability && (
                  <p className="text-[11px] text-dt-textMuted mt-2 italic">Source: {rec.evidenceTraceability}</p>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Version Evolution */}
      <Card>
        <p className="text-section-label mb-5">Version Evolution</p>
        <div className="flex flex-col gap-0 relative">
          <div className="absolute left-[11px] top-3 bottom-3 w-px bg-[rgba(124,92,252,0.1)]" />

          {/* Current version */}
          <div className="flex items-start gap-4 relative z-10">
            <div className="w-6 h-6 rounded-full bg-dt-primary/10 border-2 border-dt-primary/30 flex items-center justify-center shrink-0 mt-0.5">
              <GitCommit className="w-3 h-3 text-dt-primary" />
            </div>
            <div className="pb-6">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-dt-text">Current Version</span>
                <span className="text-[10px] font-bold text-dt-primary bg-dt-primary/8 px-2 py-0.5 rounded-md border border-dt-primary/15">
                  ATS {atsScore}
                </span>
              </div>
              <p className="text-[12px] text-dt-textMuted font-medium mt-1 max-w-md">
                {report?.finalVerdict?.slice(0, 120)}{(report?.finalVerdict?.length ?? 0) > 120 ? '...' : ''}
              </p>
            </div>
          </div>

          {/* Evolution delta */}
          {evolution ? (
            <div className="flex items-start gap-4 relative z-10">
              <div className="w-6 h-6 rounded-full bg-emerald-50 border-2 border-emerald-200 flex items-center justify-center shrink-0 mt-0.5">
                <TrendingUp className="w-3 h-3 text-emerald-500" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-dt-text">Growth Profile</span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                    evolution.atsDelta >= 0
                      ? 'text-emerald-600 bg-emerald-50 border-emerald-100'
                      : 'text-rose-600 bg-rose-50 border-rose-100'
                  }`}>
                    {evolution.atsDelta >= 0 ? '+' : ''}{evolution.atsDelta} ATS
                  </span>
                </div>
                {evolution.improvements?.length > 0 && (
                  <div className="flex flex-col gap-1 mt-2">
                    {evolution.improvements.map((imp: string, idx: number) => (
                      <p key={idx} className="text-[12px] text-dt-textMuted font-medium italic leading-relaxed">• {imp}</p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-4 relative z-10">
              <div className="w-6 h-6 rounded-full bg-slate-50 border-2 border-slate-200 flex items-center justify-center shrink-0 mt-0.5">
                <GitCommit className="w-3 h-3 text-slate-400" />
              </div>
              <div>
                <span className="text-[13px] font-medium text-dt-textMuted">Baseline Established</span>
                <p className="text-[12px] text-dt-textMuted/70 mt-0.5">First snapshot recorded. Upload an improved resume to track progress.</p>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Historical Improvements — Score evolution metrics */}
      {evolution && (
        <Card>
          <p className="text-section-label mb-4">Improvement History</p>
          <div className="flex items-center gap-4 mb-4">
            <div className="flex flex-col items-center">
              <span className="text-2xl font-bold text-dt-textMuted">{Math.max(0, atsScore - evolution.atsDelta)}</span>
              <span className="text-[10px] font-semibold text-dt-textMuted uppercase mt-1">Previous</span>
            </div>
            <ArrowRight className="w-5 h-5 text-dt-textMuted" />
            <div className="flex flex-col items-center">
              <span className="text-2xl font-bold text-dt-text">{atsScore}</span>
              <span className="text-[10px] font-semibold text-dt-textMuted uppercase mt-1">Current</span>
            </div>
            <div className="flex flex-col items-center ml-4 p-3 rounded-xl bg-emerald-50 border border-emerald-100">
              <span className="text-xl font-bold text-emerald-600">+{evolution.atsDelta}</span>
              <span className="text-[10px] font-semibold text-emerald-600/70 uppercase">Growth</span>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="p-3 rounded-xl bg-[rgba(124,92,252,0.02)] border border-[rgba(124,92,252,0.05)] text-center">
              <p className="text-[11px] font-semibold text-dt-textMuted uppercase tracking-wider mb-1">ATS Score</p>
              <p className="text-lg font-bold text-emerald-600">+{evolution.atsDelta}</p>
            </div>
            {evolution.credibilityDelta != null && (
              <div className="p-3 rounded-xl bg-[rgba(124,92,252,0.02)] border border-[rgba(124,92,252,0.05)] text-center">
                <p className="text-[11px] font-semibold text-dt-textMuted uppercase tracking-wider mb-1">Credibility</p>
                <p className="text-lg font-bold text-emerald-600">+{evolution.credibilityDelta}</p>
              </div>
            )}
            {evolution.infraDelta != null && evolution.infraDelta > 0 && (
              <div className="p-3 rounded-xl bg-[rgba(124,92,252,0.02)] border border-[rgba(124,92,252,0.05)] text-center">
                <p className="text-[11px] font-semibold text-dt-textMuted uppercase tracking-wider mb-1">Infra Modules</p>
                <p className="text-lg font-bold text-dt-primary">+{evolution.infraDelta}</p>
              </div>
            )}
          </div>
        </Card>
      )}
    </motion.div>
  );
};
