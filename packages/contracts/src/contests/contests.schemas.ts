import { z } from 'zod';
import { IsoDateTimeSchema } from '../common/ids.js';
import { PaginationMetaSchema, PaginationQuerySchema } from '../common/pagination.js';

export const ContestPlatformSchema = z.enum(['codeforces', 'leetcode', 'atcoder', 'codechef']);
export const ContestPhaseSchema = z.enum([
  'UPCOMING', 'ONGOING', 'BEFORE', 'CODING', 'PENDING_SYSTEM_TEST', 'SYSTEM_TEST', 'FINISHED',
]);

export const UpcomingContestSchema = z.object({
  platform: ContestPlatformSchema,
  externalId: z.string().min(1),
  contestName: z.string().min(1),
  startTime: IsoDateTimeSchema,
  endTime: IsoDateTimeSchema,
  durationSeconds: z.number().int().positive(),
  url: z.string().url().regex(/^https?:\/\//i, 'Expected an HTTP URL'),
  phase: ContestPhaseSchema,
  kind: z.literal('scheduled'),
  stale: z.boolean().optional(),
  fetchedAt: IsoDateTimeSchema.nullable().optional(),
}).refine(contest => Date.parse(contest.endTime) > Date.parse(contest.startTime), {
  path: ['endTime'], message: 'End time must follow start time',
});

export const UpcomingContestsQuerySchema = PaginationQuerySchema.extend({
  platform: ContestPlatformSchema.optional(),
});

export const UpcomingContestsResponseSchema = z.object({
  contests: z.array(UpcomingContestSchema),
  pagination: PaginationMetaSchema.optional(),
});

export type UpcomingContestsQuery = z.infer<typeof UpcomingContestsQuerySchema>;
export type UpcomingContestsResponse = z.infer<typeof UpcomingContestsResponseSchema>;
