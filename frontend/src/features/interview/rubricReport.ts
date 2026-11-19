import { z } from 'zod';

export const rubricDimensions = [
  ['problemSolving', 'Problem Solving'],
  ['communication', 'Technical Communication'],
  ['codeCorrectness', 'Code Quality'],
  ['complexity', 'Complexity Optimization'],
] as const;

const text = z.string().trim().min(1).max(1200);
const citation = z.object({
  turnIndex: z.number().int().min(0).max(5),
  source: z.enum(['answer', 'code']),
  quote: z.string().min(1).max(1000).refine(value => value.trim().length > 0),
  explanation: text,
});
const dimension = z.object({
  score: z.number().int().min(0).max(100),
  rationale: text,
  citations: z.array(citation).max(6),
});

// Mirrors the persisted interview-rubric-v1 report; the older session scorecard
// measures different dimensions and must not be passed off as this report.
export const interviewRubricReportSchema = z.object({
  dimensions: z.object({
    problemSolving: dimension, communication: dimension,
    codeCorrectness: dimension, complexity: dimension,
  }),
  overallScore: z.number().int().min(0).max(100),
  strengths: z.array(text).max(5),
  improvements: z.array(text).min(1).max(5),
  modelAnswer: z.string().trim().min(1).max(8000),
  optimalApproach: z.string().trim().min(1).max(8000),
  mode: z.enum(['ai', 'basic_mode']),
  fallbackReason: z.enum(['session_basic_mode', 'ai_unavailable', 'invalid_report', 'no_answers']).optional(),
  model: z.string().min(1).max(200),
  version: z.literal('interview-rubric-v1'),
}).refine(report => {
  const dimensions = rubricDimensions.map(([key]) => report.dimensions[key]);
  if (report.overallScore !== Math.round(dimensions.reduce((sum, item) => sum + item.score, 0) / 4)) return false;
  return report.mode === 'ai'
    ? !report.fallbackReason && dimensions.every(item => item.citations.length > 0)
    : !!report.fallbackReason && dimensions.every(item => item.score === 0 && item.citations.length === 0);
}, 'Inconsistent rubric report');

export type InterviewRubricReport = z.infer<typeof interviewRubricReportSchema>;
