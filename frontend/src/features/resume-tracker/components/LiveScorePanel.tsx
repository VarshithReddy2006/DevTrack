import type { BulletScorePreview } from '../hooks/useLiveAtsScore';

export function LiveScorePanel({ score, pending, error }: { score: BulletScorePreview; pending: boolean; error: string | null }) {
  return <aside aria-labelledby="live-score-heading" aria-busy={pending} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
    <h2 id="live-score-heading" className="font-semibold">Live ATS preview</h2>
    {error ? <p className="text-sm text-slate-600">Fix the bullet format to see an updated preview.</p> : <>
      <p className="text-4xl font-semibold"><output aria-label="ATS score">{score.score}</output><span className="ml-1 text-base font-normal text-slate-500">/ 100</span></p>
      <p role="status" className="text-sm text-slate-600">{pending ? 'Updating preview…' : 'Preview up to date'}</p>
      <dl className="space-y-2 text-sm">
        {[
          ['Action verbs', `${score.activeVerbs} / ${score.total}`],
          ['Quantified impact', `${score.quantified} / ${score.total}`],
          ['Concise bullets (8–40 words)', `${score.concise} / ${score.total}`],
          ['Keywords matched', `${score.keywordsMatched} / ${score.keywordsTotal}`],
          ['Parser warnings', score.parserWarningCount], ['Formatting warnings', score.formattingWarningCount],
        ].map(([label, value]) => <div className="flex justify-between gap-3" key={label}><dt>{label}</dt><dd className="shrink-0 font-medium">{value}</dd></div>)}
      </dl>
      <p className="text-xs leading-relaxed text-slate-500">Writing checks help you revise individual bullets. Your ATS score also considers sections, formatting and the selected role’s keywords.</p>
    </>}
  </aside>;
}
