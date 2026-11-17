import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { 
  Shield, 
  Code2, 
  Target, 
  Lightbulb,
  Upload,
  FileSearch,
  Brain,
  BadgeCheck,
  ListChecks,
  FileBarChart
} from 'lucide-react';
import { IntelligenceDropzone } from '../upload/IntelligenceDropzone';
import { ATSScanTransition } from '../upload/ATSScanTransition';
import { useSessionState } from '../state/useSessionState';
import { useUIStore } from '../../../store/uiStore';
import { analyticsService } from '../../../services/analyticsService';
import { useFeatureFlags } from '../../flags/hooks/useFeatureFlags';
import { JOB_TARGET_FLAG } from '../jobTargets';

/* ────────────────────────────────────────────
   Intelligence Preview Cards Data
   ──────────────────────────────────────────── */
const INTELLIGENCE_CAPABILITIES = [
  {
    icon: Shield,
    title: 'ATS Compatibility Review',
    description: 'Evaluate keyword density, formatting compliance, and parser-readability against applicant tracking systems.',
    accent: 'rgba(124, 92, 252, 0.08)',
    iconColor: 'text-dt-primary',
  },
  {
    icon: Code2,
    title: 'Engineering Credibility Assessment',
    description: 'Verify technical depth through project evidence, contribution signals, and engineering vocabulary analysis.',
    accent: 'rgba(34, 197, 94, 0.07)',
    iconColor: 'text-emerald-600',
  },
  {
    icon: Target,
    title: 'Role Alignment Analysis',
    description: 'Semantic matching against target role requirements to surface gaps and alignment strengths.',
    accent: 'rgba(59, 130, 246, 0.07)',
    iconColor: 'text-blue-600',
  },
  {
    icon: Lightbulb,
    title: 'Actionable Hiring Recommendations',
    description: 'Concrete improvements ranked by impact — what to fix, what to emphasize, what to restructure.',
    accent: 'rgba(245, 158, 11, 0.07)',
    iconColor: 'text-amber-600',
  },
];

/* ────────────────────────────────────────────
   Pipeline Timeline Steps
   ──────────────────────────────────────────── */
const PIPELINE_STEPS = [
  { icon: Upload, label: 'Upload' },
  { icon: FileSearch, label: 'Parse' },
  { icon: Brain, label: 'Analyze' },
  { icon: BadgeCheck, label: 'Verify' },
  { icon: ListChecks, label: 'Recommend' },
  { icon: FileBarChart, label: 'Report' },
];

/* ────────────────────────────────────────────
   Main Component
   ──────────────────────────────────────────── */
export const ResumeEntryWorkspace: React.FC = () => {
  const [isScanning, setIsScanning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const navigate = useNavigate();
  const { isEnabled } = useFeatureFlags();
  const { currentSession } = useSessionState();
  const { addToast } = useUIStore();

  const handleFileSelect = (_file: File) => {
    // Analytics or pre-upload hooks here
  };

  const handleUploadComplete = (id: string) => {
    analyticsService.trackEvent('resume_upload_completed', { sessionId: id });
    setSessionId(id);
    setIsScanning(true);
  };
  const handleUploadError = (error: string) => {
    console.error(error);
    addToast({
      type: 'error',
      title: 'Resume Upload Failed',
      message: error || 'An error occurred while uploading your resume.',
      duration: 6000,
    });
  };

  const handleScanComplete = () => {
    if (sessionId) {
      navigate(`/resume/analysis/${sessionId}`);
    }
  };

  return (
    <div className="w-full min-h-[calc(100vh-64px)] bg-[#FAFAFC] flex flex-col text-slate-900 relative overflow-hidden overflow-y-auto">
      
      {/* ── Ambient Background ── */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#8B5CF60A_1px,transparent_1px),linear-gradient(to_bottom,#8B5CF60A_1px,transparent_1px)] bg-[size:24px_24px] pointer-events-none" />
      <div className="absolute -top-40 -right-40 w-[500px] h-[500px] bg-violet-500/[0.04] rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute -bottom-40 -left-40 w-[400px] h-[400px] bg-indigo-500/[0.03] rounded-full blur-[100px] pointer-events-none" />

      <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col px-6 lg:px-10 py-10 lg:py-14 relative z-10">
        {!isScanning ? (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
            className="flex flex-col w-full"
          >

            {/* ═══════════════════════════════════════════
                SECTION 1 — Compact Hero
                ═══════════════════════════════════════════ */}
            <motion.div 
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="mb-12 lg:mb-16"
            >
              <h1 className="text-2xl lg:text-[28px] font-bold tracking-tight text-dt-text leading-tight">
                Resume Intelligence
              </h1>
              <p className="text-[15px] text-dt-textSecondary font-medium mt-2 max-w-xl leading-relaxed">
                Upload your resume and receive a professional ATS, credibility and role-fit assessment.
              </p>
              {isEnabled(JOB_TARGET_FLAG) && (
                <Link to="/resume/targets" className="mt-4 inline-flex items-center gap-2 rounded-lg border border-violet-200 px-3 py-2 text-sm font-semibold text-violet-700 hover:bg-violet-50">
                  <Target aria-hidden="true" size={16} /> Job targets
                </Link>
              )}
            </motion.div>

            {/* ═══════════════════════════════════════════
                SECTION 2 — Split Layout
                ═══════════════════════════════════════════ */}
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-8 lg:gap-10 mb-20 lg:mb-24">

              {/* ── LEFT: Intelligence Preview Panel (60%) ── */}
              <div className="lg:col-span-3 flex flex-col gap-0">
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.1, duration: 0.4 }}
                  className="text-section-label mb-4"
                >
                  Intelligence Report Contains
                </motion.p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {INTELLIGENCE_CAPABILITIES.map((cap, idx) => (
                    <motion.div
                      key={cap.title}
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ 
                        delay: 0.1 + idx * 0.08, 
                        duration: 0.5, 
                        ease: [0.16, 1, 0.3, 1] 
                      }}
                      className="
                        group relative
                        bg-white rounded-2xl p-5
                        border border-[rgba(124,92,252,0.06)]
                        shadow-[0_2px_12px_rgba(0,0,0,0.02)]
                        hover:shadow-[0_8px_30px_rgba(124,92,252,0.08)]
                        hover:border-[rgba(124,92,252,0.14)]
                        hover:-translate-y-0.5
                        transition-all duration-300
                        cursor-default
                      "
                    >
                      {/* Icon */}
                      <div 
                        className="w-9 h-9 rounded-xl flex items-center justify-center mb-3.5 transition-transform duration-300 group-hover:scale-105"
                        style={{ backgroundColor: cap.accent }}
                      >
                        <cap.icon className={`w-[18px] h-[18px] ${cap.iconColor}`} />
                      </div>

                      {/* Text */}
                      <h4 className="text-[13.5px] font-semibold text-dt-text tracking-tight leading-snug mb-1.5">
                        {cap.title}
                      </h4>
                      <p className="text-[12.5px] text-dt-textMuted font-medium leading-relaxed">
                        {cap.description}
                      </p>
                    </motion.div>
                  ))}
                </div>
              </div>

              {/* ── RIGHT: Premium Upload Surface (40%) ── */}
              <div className="lg:col-span-2 flex flex-col gap-0">
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.1, duration: 0.4 }}
                  className="text-section-label mb-4"
                >
                  Get Started
                </motion.p>

                <IntelligenceDropzone 
                  onFileSelect={handleFileSelect}
                  onUploadComplete={handleUploadComplete}
                  onUploadError={handleUploadError}
                />
              </div>
            </div>

            {/* ═══════════════════════════════════════════
                SECTION 3 — Analysis Pipeline Timeline
                ═══════════════════════════════════════════ */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="mb-16 lg:mb-20"
            >
              <p className="text-section-label mb-6">
                How Analysis Works
              </p>

              <div className="
                bg-white rounded-2xl
                border border-[rgba(124,92,252,0.06)]
                shadow-[0_2px_12px_rgba(0,0,0,0.02)]
                px-6 lg:px-10 py-7
              ">
                {/* Desktop: horizontal timeline */}
                <div className="hidden sm:flex items-center justify-between gap-0 w-full">
                  {PIPELINE_STEPS.map((step, idx) => (
                    <React.Fragment key={step.label}>
                      <motion.div
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ 
                          delay: 0.5 + idx * 0.07, 
                          duration: 0.4, 
                          ease: [0.16, 1, 0.3, 1] 
                        }}
                        className="flex flex-col items-center gap-2.5 shrink-0"
                      >
                        <div className="
                          w-10 h-10 rounded-xl 
                          bg-[rgba(124,92,252,0.05)] 
                          border border-[rgba(124,92,252,0.08)]
                          flex items-center justify-center
                          transition-all duration-300
                          hover:bg-[rgba(124,92,252,0.09)]
                          hover:border-[rgba(124,92,252,0.16)]
                          hover:shadow-[0_4px_16px_rgba(124,92,252,0.08)]
                        ">
                          <step.icon className="w-[18px] h-[18px] text-dt-primary/70" />
                        </div>
                        <span className="text-[11px] font-semibold text-dt-textSecondary tracking-wide uppercase">
                          {step.label}
                        </span>
                      </motion.div>

                      {/* Connector line */}
                      {idx < PIPELINE_STEPS.length - 1 && (
                        <motion.div 
                          initial={{ scaleX: 0 }}
                          animate={{ scaleX: 1 }}
                          transition={{ 
                            delay: 0.55 + idx * 0.07, 
                            duration: 0.35, 
                            ease: [0.16, 1, 0.3, 1] 
                          }}
                          className="flex-1 h-px bg-gradient-to-r from-[rgba(124,92,252,0.12)] via-[rgba(124,92,252,0.08)] to-[rgba(124,92,252,0.12)] mx-1 origin-left" 
                        />
                      )}
                    </React.Fragment>
                  ))}
                </div>

                {/* Mobile: vertical compact list */}
                <div className="flex sm:hidden flex-wrap gap-3 justify-center">
                  {PIPELINE_STEPS.map((step, idx) => (
                    <div key={step.label} className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-[rgba(124,92,252,0.05)] border border-[rgba(124,92,252,0.08)] flex items-center justify-center">
                        <step.icon className="w-3.5 h-3.5 text-dt-primary/70" />
                      </div>
                      <span className="text-[11px] font-semibold text-dt-textSecondary uppercase tracking-wide">
                        {step.label}
                      </span>
                      {idx < PIPELINE_STEPS.length - 1 && (
                        <span className="text-dt-textMuted text-[10px] mx-1">→</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>

            {/* ═══════════════════════════════════════════
                SECTION 4 — Trust Layer
                ═══════════════════════════════════════════ */}
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.6, duration: 0.5 }}
              className="flex items-center gap-3 max-w-2xl"
            >
              <div className="w-1 h-8 rounded-full bg-gradient-to-b from-dt-primary/20 to-dt-primary/5 shrink-0" />
              <p className="text-[13px] font-medium text-dt-textMuted leading-relaxed">
                DevTrack combines ATS evaluation, engineering evidence verification and AI-assisted review to produce comprehensive intelligence reports.
              </p>
            </motion.div>

          </motion.div>
        ) : (
          <div className="w-full max-w-3xl mx-auto flex-1 flex items-center">
             <ATSScanTransition 
               sessionId={sessionId || currentSession?.sessionId || ''} 
               onComplete={handleScanComplete} 
             />
          </div>
        )}
      </div>
    </div>
  );
};
