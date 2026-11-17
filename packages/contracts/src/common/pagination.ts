import { z } from 'zod';

export const PositiveIntegerQuerySchema = z.union([
  z.number(),
  z.string().regex(/^\d+$/, 'Expected a positive integer').transform(Number),
]).pipe(z.number().int().safe().positive());

export const PaginationQuerySchema = z.object({
  page: PositiveIntegerQuerySchema.default(1),
  pageSize: PositiveIntegerQuerySchema.pipe(z.number().max(100)).default(20),
});

export const PaginationMetaSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;
