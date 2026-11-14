import { useState } from 'react';
import { CheckCircle2, Cpu, FileJson, Loader2, PlayCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { resumeUploadService } from '../../../services/resumeUploadService';
import { useSessionState } from '../state/useSessionState';
import type { ResumeSession } from '../types/resumeContracts';

const roles = [
  ['backend', 'Backend Engineer'],
  ['platform', 'Platform Engineer'],
  ['devops', 'DevOps Engineer'],
  ['ml', 'ML Engineer'],
  ['fullstack', 'Full Stack Engineer'],
] as const;

export function ATSReplayViewer() {
  const session = useSessionState((state) => state.currentSession);

  return (
    <section className="flex w-full flex-col gap-4" aria-label="ATS replay">
      <h2 className="flex items-center gap-2 text-sm font-bold text-dt-text">
        <PlayCircle size={16} className="text-dt-primary" aria-hidden="true" />
        Operational Replay Workspace
      </h2>
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        {session ? (
          <ReplayContent key={session.sessionId} session={session} />
        ) : (
          <p className="text-sm text-slate-600">Upload a resume to view its ATS replay.</p>
        )}
      </div>
    </section>
  );
}

function ReplayContent({ session }: { session: ResumeSession }) {
  const atsStage = session.stages.ats;
  const failed = atsStage.status === 'failed' || (session.status === 'failed' && atsStage.status !== 'success');
  if (failed) return <ReplayFailure session={session} />;

  const parsed = session.parsedContent;
  const characterCount = parsed?.text?.length;
  const sectionCount = parsed?.sections ? Object.keys(parsed.sections).length : undefined;
  const warnings = [...new Set([
    ...(parsed?.parsingDiagnostics?.warnings ?? []),
    ...(session.atsState?.parserWarnings ?? []).map((warning) => typeof warning === 'string' ? warning : warning.message),
  ])].filter(Boolean);
  const confidence = parsed?.parsingDiagnostics?.confidence ?? session.atsState?.extractionConfidence;
  const alignment = session.reportData?.roleAlignment;
  const roleScores = roles.flatMap(([key, label]) => {
    const score: unknown = alignment?.[key];
    return typeof score === 'number' && score > 0 ? [{ label, score }] : [];
  }).sort((a, b) => b.score - a.score);
  const topRoles = roleScores.filter(({ score }) => score === roleScores[0]?.score).map(({ label }) => label);
  const similarity = session.semanticState?.semanticSimilarity;
  const pending = atsStage.status === 'pending' || atsStage.status === 'processing';
  const semanticPending = session.status !== 'failed' && session.status !== 'completed' &&
    ['pending', 'processing'].includes(session.stages.intelligence.status);
  const steps = [
    {
      label: 'Text Extraction',
      icon: FileJson,
      detail: characterCount === undefined ? 'Character count unavailable' : `Parsed ${characterCount.toLocaleString()} characters`,
      waiting: pending && characterCount === undefined,
    },
    {
      label: 'Section Identification',
      icon: Cpu,
      detail: sectionCount === undefined ? 'Section count unavailable' : `Identified ${sectionCount} ${sectionCount === 1 ? 'section' : 'sections'}`,
      waiting: pending && sectionCount === undefined,
    },
    {
      label: 'Semantic Matching',
      icon: CheckCircle2,
      detail: topRoles.length ? `Best role alignment: ${topRoles.join(', ')}` :
        similarity === undefined ? 'Role alignment unavailable' : `Semantic similarity: ${Math.round(similarity * 100)}%`,
      waiting: semanticPending && !topRoles.length && similarity === undefined,
    },
  ];

  return (
    <div>
      {pending && (
        <p role="status" className="mb-4 flex items-center gap-2 text-sm text-slate-600">
          <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />
          {atsStage.status === 'pending' ? 'Waiting for ATS analysis' : 'ATS analysis in progress'}
        </p>
      )}
      <ol aria-label="ATS replay steps" className="flex flex-col gap-5">
        {steps.map(({ label, icon: Icon, detail, waiting }) => (
          <li key={label} className="flex items-start gap-3">
            <Icon size={18} className="mt-0.5 shrink-0 text-dt-primary" aria-hidden="true" />
            <div>
              <h3 className="text-sm font-bold text-dt-text">{label}</h3>
              <p className="text-sm text-slate-600">{waiting ? 'Awaiting results' : detail}</p>
            </div>
          </li>
        ))}
      </ol>
      {typeof confidence === 'number' && (
        <p className="mt-4 text-sm text-slate-600">Parsing confidence: {Math.round(confidence * 100)}%</p>
      )}
      {warnings.length > 0 && (
        <ul aria-label="Parser warnings" className="mt-4 list-disc space-y-1 pl-5 text-sm text-amber-800">
          {warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
    </div>
  );
}

function ReplayFailure({ session }: { session: ResumeSession }) {
  const atsStage = session.stages.ats;
  const [retry, setRetry] = useState<'idle' | 'sending' | 'queued' | 'failed'>('idle');

  async function retryAnalysis() {
    setRetry('sending');
    try {
      await resumeUploadService.resumeSession(session.sessionId);
      setRetry('queued');
    } catch {
      setRetry('failed');
    }
  }

  return (
    <div className="flex flex-col items-start gap-3 text-sm">
      <div role="alert">
        <h3 className="font-bold text-rose-700">ATS analysis failed</h3>
        <p className="text-slate-700">{atsStage.error || 'Processing stopped before ATS analysis could finish.'}</p>
      </div>
      {session.canResume ? (
        <button type="button" className="dt-btn dt-btn-primary dt-btn-md"
          onClick={() => void retryAnalysis()} disabled={retry === 'sending' || retry === 'queued'}>
          {retry === 'sending' ? 'Requesting retry…' : 'Retry analysis'}
        </button>
      ) : (
        <Link to="/resume" className="dt-btn dt-btn-primary dt-btn-md">Return to Upload</Link>
      )}
      {retry === 'queued' && <p role="status">Retry queued. Analysis will resume when a worker is available.</p>}
      {retry === 'failed' && <p role="alert">Could not queue a retry. Try again or return to Upload.</p>}
      {retry === 'failed' && <Link to="/resume" className="text-dt-primary underline">Return to Upload</Link>}
    </div>
  );
}
