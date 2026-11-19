import { useId, useState } from 'react';
import { ArrowUpRight, CheckCircle2 } from 'lucide-react';
import { interviewRubricReportSchema, rubricDimensions, type InterviewRubricReport } from '../rubricReport';
import { RubricCriteriaBar } from './RubricCriteriaBar';
import { ModelAnswerDrawer } from './ModelAnswerDrawer';

export function InterviewRubricCard({ report }: { report: InterviewRubricReport }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const parsed = interviewRubricReportSchema.safeParse(report);
  if (!parsed.success) return <p role="alert">This rubric report is invalid. Please reload the interview report.</p>;
  const data = parsed.data;
  const unavailable = data.mode === 'basic_mode';
  const recommendation = data.overallScore >= 85 ? 'Strong Hire' : data.overallScore >= 70 ? 'Hire' : 'Lean No Hire';
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-5 rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 sm:p-6">
      <header className="space-y-2">
        <h2 id={id} className="text-xl font-semibold">Interview rubric</h2>
        {unavailable ? <p role="status">Not evaluated · Automated rubric evaluation is unavailable. No hiring recommendation was generated.</p> : <>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-3xl font-bold" aria-label={`Overall score: ${data.overallScore} out of 100`}>{data.overallScore} <span className="text-base font-normal">/ 100</span></p>
            <span className={`rounded-full px-3 py-1 text-sm font-semibold ${data.overallScore >= 85 ? 'bg-emerald-100 text-emerald-900' : data.overallScore >= 70 ? 'bg-violet-100 text-violet-900' : 'bg-amber-100 text-amber-900'}`}>{recommendation}</span>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-300">Practice recommendation derived from the rounded, equally weighted mean of four dimensions: Strong Hire ≥85, Hire ≥70, otherwise Lean No Hire. This is not an employer hiring decision.</p>
        </>}
      </header>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        {rubricDimensions.map(([key, label]) => <RubricCriteriaBar key={key} label={label} dimension={data.dimensions[key]} unavailable={unavailable} />)}
      </div>
      <div className="grid min-w-0 gap-5 sm:grid-cols-2">
        {(['strengths', 'improvements'] as const).map(group => <section key={group} className="min-w-0">
          <h3 className="mb-2 font-semibold">{group === 'strengths' ? 'Key Strengths' : 'Areas to Improve'}</h3>
          {data[group].length ? <ul className="space-y-2">{data[group].map((text, index) => <li key={index} className="flex items-start gap-2 text-sm">
            {group === 'strengths' ? <CheckCircle2 aria-hidden="true" size={18} className="shrink-0 text-emerald-600" /> : <ArrowUpRight aria-hidden="true" size={18} className="shrink-0 text-amber-600" />}
            <span className="min-w-0 break-words">{text}</span>
          </li>)}</ul> : <p className="text-sm text-slate-600 dark:text-slate-300">No feedback recorded.</p>}
        </section>)}
      </div>
      {!unavailable && <button type="button" onClick={() => setOpen(true)} className="rounded-lg bg-violet-700 px-4 py-2 font-semibold text-white hover:bg-violet-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500">View Model Answer</button>}
      {open && !unavailable && <ModelAnswerDrawer open onClose={() => setOpen(false)} modelAnswer={data.modelAnswer} optimalApproach={data.optimalApproach} />}
    </section>
  );
}
