import { useId } from 'react';
import type { InterviewRubricReport } from '../rubricReport';

export function RubricCriteriaBar({ label, dimension, unavailable = false }: {
  label: string;
  dimension: InterviewRubricReport['dimensions']['problemSolving'];
  unavailable?: boolean;
}) {
  const id = useId();
  const color = dimension.score >= 85 ? 'bg-emerald-600' : dimension.score >= 70 ? 'bg-violet-600' : 'bg-amber-600';
  return (
    <section className="min-w-0 space-y-2 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <h3 id={id} className="flex flex-wrap justify-between gap-2 font-semibold">
        <span className="min-w-0 break-words">{label}</span><span>{unavailable ? 'Not evaluated' : `${dimension.score} / 100`}</span>
      </h3>
      {!unavailable && <div role="progressbar" aria-labelledby={id} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={dimension.score} aria-describedby={`${id}-rationale`} title={`${label}: ${dimension.score} out of 100`}
        className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${dimension.score}%` }} />
      </div>}
      <p id={`${id}-rationale`} className="break-words text-sm text-slate-600 dark:text-slate-300">{dimension.rationale}</p>
      {dimension.citations.map((citation, index) => (
        <figure key={index} className="min-w-0 border-l-2 border-violet-400 pl-3 text-sm">
          <blockquote className="whitespace-pre-wrap break-words">{citation.quote}</blockquote>
          <figcaption className="mt-1 break-words text-slate-600 dark:text-slate-300">
            Turn {citation.turnIndex + 1} · {citation.source === 'code' ? 'Submitted code' : 'Candidate answer'}: {citation.explanation}
          </figcaption>
        </figure>
      ))}
    </section>
  );
}
