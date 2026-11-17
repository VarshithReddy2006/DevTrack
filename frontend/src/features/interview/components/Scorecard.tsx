import type { InterviewScorecard } from '../../../services/interviewService';

const labels = [
  ['problemBreakdown', 'Problem breakdown and scoping'],
  ['technicalTradeoffs', 'Technical trade-offs and architecture'],
  ['edgeCases', 'Edge cases and reliability'],
  ['communication', 'Technical communication'],
] as const;

export function Scorecard({ scorecard, basicMode }: { scorecard: InterviewScorecard; basicMode: boolean }) {
  return (
    <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6" aria-labelledby="interview-scorecard">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="interview-scorecard" className="text-lg font-semibold">Scorecard</h2>
        {basicMode && <p className="text-sm text-slate-600">Basic mode · Checklist scoring</p>}
      </div>
      <dl className="grid gap-3 sm:grid-cols-2">
        {labels.map(([key, label]) => (
          <div key={key} className="rounded-xl bg-violet-50 p-4">
            <dt className="text-sm font-medium text-slate-700">{label}</dt>
            <dd className="mt-1 text-xl font-semibold text-violet-900">{scorecard.scores[key]} / 100</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-5 sm:grid-cols-2">
        {(['strengths', 'improvements'] as const).map(group => (
          <div key={group}>
            <h3 className="mb-2 font-semibold">{group === 'strengths' ? 'Strengths' : 'Areas for improvement'}</h3>
            {scorecard[group].length ? (
              <ul className="space-y-1.5 pl-5 text-sm text-slate-700 list-disc">
                {scorecard[group].map((text, index) => <li key={index} className="break-words">{text}</li>)}
              </ul>
            ) : <p className="text-sm text-slate-600">No feedback recorded.</p>}
          </div>
        ))}
      </div>
    </section>
  );
}
