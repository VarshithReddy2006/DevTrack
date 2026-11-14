import React from 'react';
import { useSessionState } from '../state/useSessionState';
import { ScanText, Loader2, CheckCircle2, ShieldAlert } from 'lucide-react';
import { GuidedTooltip } from '../context/GuidedIntelligenceMode';
import { motion } from 'framer-motion';

export const ATSIntelligenceWorkspace: React.FC = () => {
  const { currentSession } = useSessionState();

  const isProcessing = currentSession?.stages.ats.status === 'processing';
  const isPending = currentSession?.stages.ats.status === 'pending';

  if (isPending) return null;

  const atsData = currentSession?.atsState;
  const parsingDiagnostics = currentSession?.parsedContent?.parsingDiagnostics;
  const sections = currentSession?.parsedContent?.sections || {};
  const sectionNames = Object.keys(sections);

  const getFormatSurvivability = (confidence?: number) => {
    if (!confidence) return 'Pending';
    if (confidence > 0.8) return 'High';
    if (confidence > 0.5) return 'Medium';
    return 'Low';
  };

  const getNarrativeSummary = () => {
    if (parsingDiagnostics?.warnings && parsingDiagnostics.warnings.length > 0) {
      return parsingDiagnostics.warnings[0];
    }
    if (atsData?.parserWarnings && atsData.parserWarnings.length > 0) {
      const warning = atsData.parserWarnings[0];
      return typeof warning === 'string' ? warning : warning.message;
    }
    return "Your resume structure parses cleanly. The ATS has successfully identified your core technical identity and professional trajectory.";
  };

  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <ScanText size={16} className="text-slate-900" />
        <h2 className="text-[13px] font-black uppercase tracking-widest text-slate-900">ATS Interpretation</h2>
      </div>

      <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-slate-200 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.05)] p-5">
        {isProcessing ? (
          <div className="flex flex-col items-center justify-center py-6 gap-3">
            <Loader2 className="w-6 h-6 text-violet-600 animate-spin" />
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Parsing Structure...</p>
          </div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-6">
            
            {/* Narrative Intelligence Layer */}
            <div className="p-4 bg-slate-50/80 rounded-xl border border-slate-100">
              <p className="text-sm text-slate-700 leading-relaxed font-medium">
                {getNarrativeSummary()}
              </p>
            </div>

            {/* Confidence Scores */}
            <div className="grid grid-cols-2 gap-4">
              <GuidedTooltip content="How confident an average ATS parser is at extracting text cleanly from your layout.">
                <div className="p-4 bg-white rounded-xl border border-slate-200 flex flex-col gap-1 cursor-help hover:border-violet-300 hover:shadow-[0_4px_14px_-2px_rgba(139,92,246,0.08)] transition-all">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Parsing Confidence</span>
                  <div className="flex items-end gap-1">
                    <span className="text-2xl font-black text-slate-900 leading-none">
                      {Math.round((parsingDiagnostics?.confidence || 0) * 100)}
                    </span>
                    <span className="text-sm font-bold text-slate-400 mb-0.5">%</span>
                  </div>
                </div>
              </GuidedTooltip>
              <GuidedTooltip content="Likelihood your layout survives PDF to Text conversion without scrambling timelines or sections.">
                <div className="p-4 bg-emerald-50/50 rounded-xl border border-emerald-100 flex flex-col gap-1 cursor-help hover:border-emerald-300 hover:shadow-sm transition-all">
                  <span className="text-[10px] font-bold text-emerald-700/70 uppercase tracking-widest">Format Survivability</span>
                  <div className="flex items-end gap-1">
                    <span className="text-2xl font-black text-emerald-600 leading-none">
                      {getFormatSurvivability(atsData?.extractionConfidence)}
                    </span>
                  </div>
                </div>
              </GuidedTooltip>
            </div>

            {/* Section Extraction Status */}
            <div className="flex flex-col gap-3">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Section Extraction</span>
              <div className="flex flex-wrap gap-2">
                {sectionNames.length > 0 ? sectionNames.map(sec => (
                  <div key={sec} className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-md flex items-center gap-1.5 text-xs font-semibold text-slate-700 shadow-sm">
                    <CheckCircle2 size={12} className="text-emerald-500" /> {sec}
                  </div>
                )) : (
                  <p className="text-xs text-slate-500 font-medium italic">No sections detected yet</p>
                )}
                
                {atsData?.parserWarnings?.map((warning, idx) => (
                  <div key={idx} className="px-3 py-1.5 bg-rose-50 border border-rose-200 rounded-md flex items-center gap-1.5 text-xs font-semibold text-rose-700 shadow-sm">
                    <ShieldAlert size={12} className="text-rose-500" /> {typeof warning === 'string' ? warning : warning.message}
                  </div>
                ))}
              </div>
            </div>

          </motion.div>
        )}
      </div>
    </div>
  );
};
