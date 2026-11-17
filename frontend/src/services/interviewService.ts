import { z } from 'zod';
import type { ApiResponse } from '../types/api.types';
import axiosClient from '../utils/axiosClient';

export const interviewRoles = ['backend', 'distributed_systems', 'frontend_architect', 'fullstack'] as const;
const score = z.number().min(0).max(100);
const scorecard = z.object({
  scores: z.object({
    problemBreakdown: score,
    technicalTradeoffs: score,
    edgeCases: score,
    communication: score,
  }),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
});
const turn = z.object({
  question: z.object({ prompt: z.string() }),
  answer: z.string().nullish(),
  feedback: z.string().nullish(),
});
const session = z.object({
  id: z.string().min(1),
  role: z.enum(interviewRoles),
  status: z.enum(['in_progress', 'completed', 'abandoned', 'expired']),
  state: z.enum(['START', 'QUESTION_PENDING', 'SCORING', 'NEXT_QUESTION', 'FINAL_SCORECARD', 'COMPLETED']),
  stateVersion: z.number().int().nonnegative(),
  currentTurnIndex: z.number().int().min(0).max(4),
  turns: z.array(turn).max(5),
  scorecard: scorecard.nullish(),
  mode: z.enum(['ai', 'basic_mode']).optional(),
});

export type InterviewRole = typeof interviewRoles[number];
export type InterviewTurn = z.infer<typeof turn>;
export type InterviewSession = z.infer<typeof session>;
export type InterviewScorecard = z.infer<typeof scorecard>;

function read<T>(response: ApiResponse<unknown>, schema: z.ZodType<T>): T {
  if (!response.success) throw new Error(response.message || 'The interview request failed.');
  const result = schema.safeParse(response.data);
  if (!result.success) throw new Error('The server returned an unexpected interview response.');
  return result.data;
}

const basePath = '/interviews';
const sessionPath = (id: string) => `${basePath}/${encodeURIComponent(id)}`;

export async function getCurrentInterview(signal?: AbortSignal) {
  const { data } = await axiosClient.get<ApiResponse<unknown>>(`${basePath}/current`, { signal });
  return read(data, session.nullable());
}

export async function getInterview(id: string, signal?: AbortSignal) {
  const { data } = await axiosClient.get<ApiResponse<unknown>>(sessionPath(id), { signal });
  return read(data, session);
}

export async function startInterview(role: InterviewRole) {
  const { data } = await axiosClient.post<ApiResponse<unknown>>(basePath, { role });
  return read(data, session);
}

export async function submitInterviewAnswer(id: string, turnIndex: number, answer: string, stateVersion: number) {
  const { data } = await axiosClient.post<ApiResponse<unknown>>(
    `${sessionPath(id)}/turns/${turnIndex}/answer`, { answer, stateVersion },
  );
  return read(data, session);
}
