export type AxisKey = 'structures' | 'algorithms' | 'architecture' | 'coreCs' | 'behavioral';
export interface PlacementRadarReport {
  version:string; generatedAt:string; coverage:number; caveat:string;
  axes:Array<{key:AxisKey;label:string;score:number|null;evidence:string[];gap:string}>;
  plan:Array<{day:number;axis:AxisKey|null;minutes:number;task:string}>;
  signals:{contestRatings:number[];retentionPercent:number|null;reviews7d:number;consistencyPercent:number|null};
}
// Explicit product practice goals, not measured company benchmarks or percentile data.
export const PRACTICE_GOALS = { foundation:50, intermediate:65, advanced:80 } as const;
export function radarReportText(report:PlacementRadarReport, goal:number):string {
  return [`Placement practice report — ${report.generatedAt}`, `Model: ${report.version}`, report.caveat,
    `Practice goal: ${goal}/100 (illustrative, not an employer cutoff)`,
    ...report.axes.map(a => `${a.label}: ${a.score === null ? 'Unknown' : a.score+'/100'}; ${a.gap}; ${a.evidence.join('; ')}`),
    `Contest ratings (platform scales differ): ${report.signals.contestRatings.join(', ') || 'Unknown'}`,
    `Review retention: ${report.signals.retentionPercent ?? 'Unknown'}%; reviews: ${report.signals.reviews7d}`,
    `Solve consistency: ${report.signals.consistencyPercent ?? 'Unknown'}%`,
    'Seven-day practice plan', ...report.plan.map(p => `Day ${p.day} (${p.minutes} min): ${p.task}`)].join('\n');
}
