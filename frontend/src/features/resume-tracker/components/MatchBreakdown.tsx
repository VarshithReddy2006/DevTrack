import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart } from 'recharts';
import type { MatchScore } from '../../../services/jobTargetsService';

const dimensions = [
  ['hardRequirements', 'Hard requirements', 'Requirements'],
  ['techStack', 'Tech stack keywords', 'Tech stack'],
  ['verifiedEvidence', 'Verified evidence', 'Evidence'],
  ['experience', 'Experience', 'Experience'],
] as const;

export function MatchBreakdown({ match }: { match: MatchScore }) {
  const points = dimensions.map(([key, , label]) => ({ label, score: match.dimensions[key] }));

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby="match-breakdown">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="match-breakdown" className="text-lg font-semibold">Match breakdown</h2>
        <p className="text-sm text-slate-600"><strong className="text-2xl text-violet-700">{match.score}%</strong> overall match</p>
      </div>
      <div className="mt-5 grid items-center gap-6 md:grid-cols-2">
        <dl className="grid grid-cols-2 gap-4">
          {dimensions.map(([key, label]) => {
            const value = match.dimensions[key];
            return (
              <div key={key} className="rounded-xl bg-slate-50 p-3">
                <dt className="text-sm font-medium text-slate-700">{label}</dt>
                <dd className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
                  {value !== null && (
                    <span aria-hidden="true" className="inline-grid size-7 shrink-0 place-items-center rounded-full"
                      style={{ background: `conic-gradient(#6d28d9 ${value}%, #e2e8f0 0)` }}>
                      <span className="size-5 rounded-full bg-slate-50" />
                    </span>
                  )}
                  {value === null ? 'Not applicable' : `${value}%`}
                </dd>
              </div>
            );
          })}
        </dl>
        {points.every(point => point.score !== null) && (
          <div aria-hidden="true" className="mx-auto w-full max-w-sm">
            <RadarChart responsive width="100%" height={235} data={points} outerRadius="58%" accessibilityLayer={false}>
              <PolarGrid stroke="#cbd5e1" />
              <PolarAngleAxis dataKey="label" tick={{ fill: '#475569', fontSize: 11 }} />
              <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
              <Radar dataKey="score" stroke="#6d28d9" fill="#8b5cf6" fillOpacity={0.24} isAnimationActive={false} />
            </RadarChart>
          </div>
        )}
      </div>
    </section>
  );
}
