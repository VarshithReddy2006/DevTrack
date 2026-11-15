import { z } from 'zod';
import { PositiveIntegerQuerySchema } from '../common/pagination.js';

export const ReviewSubmitRequestSchema = z.object({
  rating: z.enum(['failed', 'hard', 'easy']),
  reviewSeq: z.number().int().safe().nonnegative(),
}).strict();

export const RevisionDueQuerySchema = z.object({
  limit: PositiveIntegerQuerySchema.pipe(z.number().max(100)).default(10),
});

export type ReviewSubmitRequest = z.infer<typeof ReviewSubmitRequestSchema>;
export type RevisionDueQuery = z.infer<typeof RevisionDueQuerySchema>;
