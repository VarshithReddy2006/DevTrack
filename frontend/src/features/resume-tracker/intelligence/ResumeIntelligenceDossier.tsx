import React, { useEffect, useState } from 'react';
import { useSessionState } from '../state/useSessionState';
import { Shield, Download, AlertTriangle, Layers, Cpu, Award, FileText, CheckCircle, RefreshCw } from 'lucide-react';
import { motion } from 'framer-motion';
import api from '../../../utils/axiosClient.js';

export const ResumeIntelligenceDossier: React.FC = () => {
  const { currentSession } = useSessionState();
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const fetchReport = async () => {
    if (!currentSession?.sessionId) return;
    try {
      setLoading(true);
      setError(null);
      const res = await api.get(`/resume-intelligence/report/${currentSession.sessionId}`);
      if (res.data?.success) {
        setReport(res.data.data);
      } else {
        // Report might not be generated yet, let's trigger it automatically
        await handleGenerate();
      }
    } catch (err: any) {
      if (err.response?.status === 404) {
        // Auto trigger generation
        await handleGenerate();
      } else {
        setError('Failed to fetch the intelligence dossier.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!currentSession?.sessionId) return;
    try {
      setGenerating(true);
      setError(null);
      const res = await api.post('/resume-intelligence/report', {
        sessionId: currentSession.sessionId
      });
      if (res.data?.success) {
        setReport(res.data.data);
      } else {
        setError('Failed to generate report.');
      }
    } catch (err) {
      console.error(err);
      setError('An error occurred during report generation.');
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    fetchReport();
  }, [currentSession?.sessionId]);

  const handleExportPDF = async () => {
    if (!currentSession?.sessionId || exporting) return;
    try {
      setExporting(true);
      setExportError(null);
      const res = await api.post('/resume-intelligence/dossier-pdf', { sessionId: currentSession.sessionId }, { responseType: 'blob' });
      if (!(res.data instanceof Blob) || !res.data.size || !String(res.headers['content-type'] || '').toLowerCase().startsWith('application/pdf')) throw new Error('Invalid PDF response');
      const url = URL.createObjectURL(res.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'devtrack-dossier.pdf';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.error(err);
      setExportError('Could not download the dossier PDF. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  if (loading || generating) {
    return (
      <div className="w-full min-h-[400px] bg-slate-900 border border-slate-800 rounded-2xl flex flex-col items-center justify-center p-6 gap-3">
        <RefreshCw className="w-8 h-8 text-purple-500 animate-spin" />
        <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">
          {generating ? 'Compiling 14-Section Dossier Telemetry...' : 'Retrieving Engineering Signals...'}
        </p>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center text-slate-400">
        <AlertTriangle className="mx-auto text-amber-500 mb-2" />
        <h3 className="text-sm font-bold text-slate-200">Dossier Retrieval Gaps</h3>
        <p className="text-xs mt-1 mb-4">{error || 'Please trigger the initial assessment to parse repository models.'}</p>
        <button
          onClick={handleGenerate}
          className="px-4 py-2 bg-purple-600 hover:bg-purple-700 transition-colors text-xs font-black text-white rounded-xl shadow-lg"
        >
          GENERATE DOSSIER
        </button>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="w-full flex flex-col gap-6 text-slate-200">
      {/* Dossier Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-950/50 border border-purple-800/40 rounded-xl">
            <Shield size={20} className="text-purple-400" />
          </div>
          <div>
            <h2 className="text-sm font-black uppercase tracking-widest text-slate-100">ENGINEERING DOSSIER — SECURE LEVEL II AUDIT</h2>
            <p className="text-[10px] text-slate-500 font-bold uppercase mt-0.5">DEVTRACK VERIFIED RECRUITER-GRADE INTELLIGENCE PORTFOLIO</p>
          </div>
        </div>
        <button 
          onClick={handleExportPDF}
          disabled={exporting}
          className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 transition-all rounded-xl text-xs font-black text-white shadow-lg shrink-0"
        >
          <Download size={14} />
          {exporting ? 'EXPORTING…' : 'EXPORT DOSSIER → PDF'}
        </button>
      </div>
      {exportError && <p role="alert">{exportError}</p>}

      {/* Grid of Key Scores & Executive Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Award size={14} className="text-purple-400" />
              <h3 className="text-[11px] font-black tracking-widest text-slate-400 uppercase">1. Executive Dossier Summary</h3>
            </div>
            <p className="text-xs font-semibold text-slate-300 leading-relaxed italic border-l-2 border-purple-500 pl-3 bg-purple-950/10 py-3 rounded-r-xl">
              "{report.executiveSummary.narrative}"
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-2">
            <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
              <span className="text-[9px] text-slate-500 uppercase font-black block">Maturity Rank</span>
              <span className="text-xs font-black uppercase text-purple-400 mt-1 block">{report.executiveSummary.engineeringMaturity}</span>
            </div>
            <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
              <span className="text-[9px] text-slate-500 uppercase font-black block">ATS Survival</span>
              <span className="text-xs font-black uppercase text-emerald-400 mt-1 block">{report.executiveSummary.atsSurvivability}</span>
            </div>
            <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
              <span className="text-[9px] text-slate-500 uppercase font-black block">Recruiter Trust</span>
              <span className="text-xs font-black uppercase text-amber-400 mt-1 block">{report.executiveSummary.recruiterTrustLevel}</span>
            </div>
            <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
              <span className="text-[9px] text-slate-500 uppercase font-black block">Infra Score</span>
              <span className="text-xs font-black uppercase text-indigo-400 mt-1 block">{report.executiveSummary.infrastructureMaturity}</span>
            </div>
          </div>
        </div>

        {/* Operational Readiness Gauge */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col items-center justify-center gap-2">
          <h3 className="text-[11px] font-black tracking-widest text-slate-400 uppercase">Operational Readiness Score</h3>
          <div className="relative w-32 h-32 flex items-center justify-center mt-2">
            <svg className="w-full h-full transform -rotate-90">
              <circle cx="64" cy="64" r="50" stroke="#1E293B" strokeWidth="8" fill="transparent" />
              <circle cx="64" cy="64" r="50" stroke="url(#purpleGradient)" strokeWidth="8" fill="transparent"
                      strokeDasharray={2 * Math.PI * 50} strokeDashoffset={2 * Math.PI * 50 * (1 - report.executiveSummary.operationalReadiness / 100)}
                      strokeLinecap="round" />
              <defs>
                <linearGradient id="purpleGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#8B5CF6" />
                  <stop offset="100%" stopColor="#6366F1" />
                </linearGradient>
              </defs>
            </svg>
            <div className="absolute flex flex-col items-center">
              <span className="text-2xl font-black text-slate-100">{report.executiveSummary.operationalReadiness}%</span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-wider">DEPLOY READY</span>
            </div>
          </div>
        </div>
      </div>

      {/* ATS Analysis Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText size={14} className="text-emerald-400" />
              <h3 className="text-[11px] font-black tracking-widest text-slate-400 uppercase">2. ATS Analysis & Parsing Integrity</h3>
            </div>
            <span className="text-[10px] font-black text-emerald-400 bg-emerald-950/30 px-2 py-0.5 rounded border border-emerald-900/50">SCORE: {report.atsAnalysis.atsScore}/100</span>
          </div>

          <p className="text-xs text-slate-400 font-medium leading-relaxed bg-slate-950/40 p-3 rounded-xl border border-slate-850">
            {report.atsAnalysis.atsExplanation}
          </p>

          <div className="flex flex-col gap-2">
            <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Formatting & Structure Risks</span>
            {report.atsAnalysis.parserWarnings.map((w: any, idx: number) => (
              <div key={idx} className="p-3 bg-slate-950 border border-slate-850 rounded-xl flex items-start gap-3">
                <span className={`text-[8px] font-black px-1.5 py-0.5 rounded shrink-0 uppercase mt-0.5 ${
                  w.severity === 'critical' ? 'bg-rose-950/50 border border-rose-800/30 text-rose-400' :
                  w.severity === 'warning' ? 'bg-amber-950/50 border border-amber-800/30 text-amber-400' :
                  'bg-slate-800 border border-slate-700 text-slate-300'
                }`}>{w.severity}</span>
                <div>
                  <h4 className="text-xs font-bold text-slate-200">{w.message}</h4>
                  <p className="text-[10px] text-slate-500 font-medium mt-0.5">Suggestion: {w.suggestion}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Semantic Role Alignment */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Cpu size={14} className="text-indigo-400" />
            <h3 className="text-[11px] font-black tracking-widest text-slate-400 uppercase">3. Semantic Role Alignment Profile</h3>
          </div>

          <div className="flex flex-col gap-3">
            {[
              { label: 'Backend Engineer', val: report.roleAlignment.backend, color: 'from-emerald-600 to-teal-500' },
              { label: 'Platform Engineer', val: report.roleAlignment.platform, color: 'from-purple-600 to-indigo-500' },
              { label: 'DevOps Engineer', val: report.roleAlignment.devops, color: 'from-blue-600 to-indigo-500' },
              { label: 'ML Engineer', val: report.roleAlignment.ml, color: 'from-pink-600 to-rose-500' },
              { label: 'Full Stack Engineer', val: report.roleAlignment.fullstack, color: 'from-teal-600 to-cyan-500' }
            ].map(r => (
              <div key={r.label} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-xs font-bold text-slate-300">
                  <span>{r.label}</span>
                  <span>{r.val}%</span>
                </div>
                <div className="w-full h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                  <div className={`h-full bg-gradient-to-r ${r.color}`} style={{ width: `${r.val}%` }} />
                </div>
              </div>
            ))}
          </div>

          <p className="text-[11px] text-slate-400 leading-normal italic mt-2">
            <strong>Alignment Logic:</strong> {report.roleAlignment.alignmentExplanation}
          </p>
        </div>
      </div>

      {/* Engineering Credibility & Recruiter simulation */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Credibility Audit */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield size={14} className="text-amber-400" />
              <h3 className="text-[11px] font-black tracking-widest text-slate-400 uppercase">4. Engineering Credibility Analysis</h3>
            </div>
            <span className="text-[10px] font-black text-amber-400 bg-amber-950/30 px-2 py-0.5 rounded border border-amber-900/50">TRUST SCORE: {report.credibilityAnalysis.overallScore}/100</span>
          </div>

          <div className="flex flex-col gap-3">
            <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-widest">Platform-Verified Strengths</span>
            {report.credibilityAnalysis.verifiedClaims?.map((claim: string, idx: number) => (
              <div key={`v-${idx}`} className="p-3 bg-emerald-950/15 border border-emerald-900/30 rounded-xl flex gap-2.5 items-start">
                <CheckCircle size={14} className="text-emerald-500 shrink-0 mt-0.5" />
                <p className="text-xs font-semibold text-slate-300 leading-normal">{claim}</p>
              </div>
            ))}
            
            {(report.credibilityAnalysis.unsupportedClaims?.length > 0 || report.credibilityAnalysis.warnings?.length > 0) && (
              <span className="text-[9px] font-bold text-amber-400 uppercase tracking-widest mt-2">Detected Mismatches & Concerns</span>
            )}
            {report.credibilityAnalysis.unsupportedClaims?.map((claim: string, idx: number) => (
              <div key={`u-${idx}`} className="p-3 bg-slate-950 border border-slate-800 rounded-xl flex gap-2.5 items-start">
                <AlertTriangle size={14} className="text-slate-500 shrink-0 mt-0.5" />
                <p className="text-xs font-medium text-slate-400 leading-normal">{claim} (Needs Evidence)</p>
              </div>
            ))}
            {report.credibilityAnalysis.warnings?.map((w: string, idx: number) => (
              <div key={`w-${idx}`} className="p-3 bg-slate-950 border border-slate-850 rounded-xl flex gap-2 items-center">
                <div className="w-1.5 h-1.5 rounded-full bg-slate-600 shrink-0" />
                <span className="text-xs text-slate-400 font-medium">{w}</span>
              </div>
            ))}
            {(!report.credibilityAnalysis.unsupportedClaims?.length && !report.credibilityAnalysis.warnings?.length) && (
              <div className="p-3 bg-slate-900 border border-slate-800 rounded-xl flex gap-2 items-center opacity-70">
                <CheckCircle size={14} className="text-slate-500 shrink-0" />
                <span className="text-xs text-slate-400 font-semibold">No significant credibility mismatches detected.</span>
              </div>
            )}
          </div>
        </div>

        {/* Recruiter Simulator */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between gap-4">
          <div className="flex flex-col gap-3">
            <h3 className="text-[11px] font-black tracking-widest text-slate-400 uppercase">5. Recruiter Reality Projection</h3>
            <p className="text-xs text-slate-300 leading-relaxed font-semibold bg-slate-950/40 p-3 border border-slate-850 rounded-xl">
              "{report.recruiterProjection.narrative}"
            </p>

            <div className="flex flex-col gap-2 mt-1">
              <span className="text-[9px] font-bold text-rose-400 uppercase tracking-widest">Likely Rejection Triggers</span>
              {report.recruiterProjection.rejectionTriggers.map((t: string, idx: number) => (
                <div key={idx} className="text-xs text-slate-400 border-l-2 border-rose-500 pl-2 leading-relaxed italic">{t}</div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-widest">Verifiable Interview triggers</span>
            {report.recruiterProjection.interviewTriggers.map((t: string, idx: number) => (
              <div key={idx} className="text-xs text-slate-400 border-l-2 border-emerald-500 pl-2 leading-relaxed italic">{t}</div>
            ))}
          </div>
        </div>
      </div>

      {/* Infrastructure Telemetry */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Layers size={14} className="text-indigo-400" />
          <h3 className="text-[11px] font-black tracking-widest text-slate-400 uppercase">6. Infrastructure Maturity & Obs. Telemetry</h3>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="p-3 bg-slate-950/40 border border-slate-850 rounded-xl">
            <span className="text-[9px] text-slate-500 font-bold uppercase block">Deployment Stack</span>
            <span className="text-xs font-black text-slate-200 mt-1 capitalize block">{report.infrastructureMaturity.deploymentMaturity}</span>
          </div>
          <div className="p-3 bg-slate-950/40 border border-slate-850 rounded-xl">
            <span className="text-[9px] text-slate-500 font-bold uppercase block">CI/CD Pipelines</span>
            <span className="text-xs font-black text-slate-200 mt-1 block">{report.infrastructureMaturity.ciCdEvidence ? 'Verifiable GitHub logs' : 'None detected'}</span>
          </div>
          <div className="p-3 bg-slate-950/40 border border-slate-850 rounded-xl">
            <span className="text-[9px] text-slate-500 font-bold uppercase block">Centralized Observability</span>
            <span className="text-xs font-black text-slate-200 mt-1 block">{report.infrastructureMaturity.observabilityScore}/100</span>
          </div>
          <div className="p-3 bg-slate-950/40 border border-slate-850 rounded-xl">
            <span className="text-[9px] text-slate-500 font-bold uppercase block">Replication Strengths</span>
            <span className="text-xs font-black text-slate-200 mt-1 capitalize block">{report.infrastructureMaturity.persistenceStrength}</span>
          </div>
        </div>

        <div className="flex flex-col gap-2 mt-2">
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Detected Infra Core Modules</span>
          <div className="flex flex-wrap gap-2">
            {report.infrastructureMaturity.detectedTechnologies.map((tech: string, i: number) => (
              <span key={i} className="px-2.5 py-1 bg-slate-950 border border-slate-800 text-[10px] font-mono text-purple-400 rounded-md">{tech}</span>
            ))}
            {report.infrastructureMaturity.detectedTechnologies.length === 0 && (
              <span className="text-xs text-slate-500">No modern infrastructure (Docker, K8s, Grafana) found in project descriptions.</span>
            )}
          </div>
        </div>
      </div>

      {/* Project Rankings */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col gap-4">
        <h3 className="text-[11px] font-black tracking-widest text-slate-400 uppercase">7. Project Intelligence & Credibility Ranking</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-850 text-slate-500">
                <th className="py-2.5 font-bold uppercase tracking-wider">Project Name</th>
                <th className="py-2.5 font-bold uppercase tracking-wider text-center">Originality Rank</th>
                <th className="py-2.5 font-bold uppercase tracking-wider text-center">Infrastructure Depth</th>
                <th className="py-2.5 font-bold uppercase tracking-wider text-right">Authenticity Verdict</th>
              </tr>
            </thead>
            <tbody>
              {report.credibilityAnalysis.projectRankings.map((p: any, idx: number) => (
                <tr key={idx} className="border-b border-slate-850/50 hover:bg-slate-950/20">
                  <td className="py-3 font-bold text-slate-200">{p.name}</td>
                  <td className="py-3 text-center">
                    <span className={`font-mono text-xs px-2 py-0.5 rounded ${
                      p.originalityScore > 70 ? 'text-emerald-400 bg-emerald-950/20' : 'text-amber-400 bg-amber-950/20'
                    }`}>{p.originalityScore}%</span>
                  </td>
                  <td className="py-3 text-center">
                    <span className="font-mono text-slate-400">{p.infrastructureDepth}%</span>
                  </td>
                  <td className="py-3 text-right font-medium text-slate-400">{p.engineeringSignal}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recommendations & Actionable guidance */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col gap-4">
        <h3 className="text-[11px] font-black tracking-widest text-slate-400 uppercase">8. senior-engineering Recommendation Guidance</h3>
        <div className="flex flex-col gap-4">
          {report.recommendations.map((rec: any, idx: number) => (
            <div key={idx} className="p-4 bg-slate-950 border border-slate-850 rounded-xl flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-black text-purple-400 uppercase tracking-widest bg-purple-950/50 px-2 py-0.5 rounded border border-purple-900/40">{rec.category}</span>
                <span className="text-[10px] font-bold text-slate-500">Dependency: {rec.progressionDependency}</span>
              </div>
              <h4 className="text-xs font-black text-slate-200 leading-normal">{rec.suggestion}</h4>
              <div className="text-[10px] text-slate-500 font-medium">Traceability: "{rec.evidenceTraceability}"</div>
            </div>
          ))}
        </div>
      </div>

      {/* Risks & Longitudinal history */}
      {report.evolution && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col gap-4">
          <h3 className="text-[11px] font-black tracking-widest text-slate-400 uppercase">9. Longitudinal Evolution Track</h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-center">
              <span className="text-[9px] text-slate-500 font-bold block uppercase">ATS Growth</span>
              <span className="text-lg font-black text-emerald-400 mt-1 block">+{report.evolution.atsDelta} Score</span>
            </div>
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-center">
              <span className="text-[9px] text-slate-500 font-bold block uppercase">Trust Growth</span>
              <span className="text-lg font-black text-emerald-400 mt-1 block">+{report.evolution.credibilityDelta} Points</span>
            </div>
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-center">
              <span className="text-[9px] text-slate-500 font-bold block uppercase">Infra Modules added</span>
              <span className="text-lg font-black text-purple-400 mt-1 block">+{report.evolution.infraDelta} Modules</span>
            </div>
          </div>
          <div className="flex flex-col gap-1 mt-1">
            <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-widest">Growth Improvements verified</span>
            {report.evolution.improvements.map((imp: string, i: number) => (
              <div key={i} className="text-xs text-slate-400 border-l-2 border-emerald-500 pl-2 italic leading-relaxed">{imp}</div>
            ))}
          </div>
        </div>
      )}

      {/* Verdict Panel */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 border-l-4 border-l-purple-500">
        <div className="flex items-center gap-2 mb-2">
          <Award size={16} className="text-purple-400 animate-pulse" />
          <h3 className="text-[11px] font-black tracking-widest text-slate-100 uppercase">10. Secure Intelligence Verdict</h3>
        </div>
        <p className="text-xs font-semibold text-slate-300 leading-relaxed italic bg-purple-950/10 p-3 rounded-xl">
          "{report.finalVerdict}"
        </p>
      </div>
    </motion.div>
  );
};
