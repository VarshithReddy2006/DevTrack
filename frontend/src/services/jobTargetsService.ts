import { z } from 'zod';
import type { ApiResponse } from '../types/api.types';
import axiosClient from '../utils/axiosClient';

const status = z.enum(['submitted', 'parsing', 'scoring', 'ready', 'failed']);
const score = z.number().min(0).max(100);
const matchSchema = z.object({
  score,
  dimensions: z.object({
    hardRequirements: score.nullable(),
    techStack: score.nullable(),
    verifiedEvidence: score.nullable(),
    experience: score.nullable(),
  }),
});
const submission = z.object({ id: z.string().min(1), status });
const summary = submission.extend({
  role: z.string().nullish(),
  company: z.string().nullish(),
  createdAt: z.iso.datetime({ offset: true }),
  matchScore: score.nullish(),
});
const rewrite = z.object({
  id: z.string().min(1),
  originalText: z.string(),
  rewrittenText: z.string(),
  accepted: z.boolean().default(false),
});
const detail = summary.extend({
  match: matchSchema.nullish(),
  analysisMode: z.string().optional(),
  missingKeywords: z.array(z.object({ category: z.string(), keyword: z.string() })).default([]),
  gaps: z.array(z.object({ id: z.string(), description: z.string() })).default([]),
  rewriteSuggestions: z.array(rewrite).default([]),
  errorMessage: z.string().nullish(),
}).refine(target => target.status !== 'ready' || target.match != null);
const profile = z.object({ id: z.string().min(1) });

export type JobTargetStatus = z.infer<typeof status>;
export type MatchScore = z.infer<typeof matchSchema>;
export type JobTargetDetail = z.infer<typeof detail>;
export type RewriteSuggestion = z.infer<typeof rewrite>;
export type JobTargetInput = { resumeProfileId: string } & ({ jdText: string } | { jdUrl: string });

function read<T>(response: ApiResponse<unknown>, schema: z.ZodType<T>): T {
  if (!response.success) throw new Error(response.message || 'Request failed.');
  const parsed = schema.safeParse(response.data);
  if (!parsed.success) throw new Error('The server returned an unexpected response.');
  return parsed.data;
}

const path = '/job-targets';
const targetPath = (id: string) => `${path}/${encodeURIComponent(id)}`;

export async function listJobTargets(signal?: AbortSignal) {
  const { data } = await axiosClient.get<ApiResponse<unknown>>(path, { signal });
  return read(data, z.array(summary));
}

export async function getJobTarget(id: string, signal?: AbortSignal) {
  const { data } = await axiosClient.get<ApiResponse<unknown>>(targetPath(id), { signal });
  return read(data, detail);
}

export async function submitJobTarget(input: JobTargetInput) {
  const { data } = await axiosClient.post<ApiResponse<unknown>>(path, input);
  return read(data, submission);
}

export async function acceptJobTargetRewrite(id: string, rewriteId: string) {
  const { data } = await axiosClient.post<ApiResponse<unknown>>(`${targetPath(id)}/accept-rewrite`, { rewriteId });
  if (!data.success) throw new Error(data.message || 'Could not accept the rewrite.');
}

export async function getActiveResumeProfile(signal?: AbortSignal) {
  const { data } = await axiosClient.get<ApiResponse<unknown>>('/resume-intelligence/profile', { signal });
  return read(data, profile.nullable());
}
