// src/modules/search/search.schema.ts
// Zod query validation schema for the unified search endpoint (GET /api/v2/search).

import { z } from 'zod';
import { PAGINATION } from '../../config/constants.js';

export const SEARCH_ENTITY_TYPES = ['all', 'dsa', 'profile', 'project'] as const;
export type SearchEntityTypeFilter = (typeof SEARCH_ENTITY_TYPES)[number];

export const MAX_SEARCH_QUERY_LENGTH = 100;
export const MAX_SEARCH_RESULT_HORIZON = 1000;

export const searchQuerySchema = z
  .object({
    q: z
      .string({ required_error: 'Search query is required' })
      .trim()
      .min(1, 'Search query cannot be empty')
      .max(MAX_SEARCH_QUERY_LENGTH, `Search query cannot exceed ${MAX_SEARCH_QUERY_LENGTH} characters`),
    type: z
      .enum(SEARCH_ENTITY_TYPES, {
        errorMap: () => ({
          message: `Entity type must be one of: ${SEARCH_ENTITY_TYPES.join(', ')}`,
        }),
      })
      .default('all'),
    page: z.coerce
      .number({ invalid_type_error: 'Page must be a number' })
      .int('Page must be an integer')
      .min(1, 'Page must be at least 1')
      .default(PAGINATION.DEFAULT_PAGE),
    limit: z.coerce
      .number({ invalid_type_error: 'Limit must be a number' })
      .int('Limit must be an integer')
      .min(1, 'Limit must be at least 1')
      .max(PAGINATION.MAX_PAGE_SIZE, `Limit cannot exceed ${PAGINATION.MAX_PAGE_SIZE}`)
      .default(PAGINATION.DEFAULT_PAGE_SIZE),
  })
  .superRefine((data, ctx) => {
    if (
      typeof data.page === 'number' &&
      !isNaN(data.page) &&
      typeof data.limit === 'number' &&
      !isNaN(data.limit) &&
      data.page * data.limit > MAX_SEARCH_RESULT_HORIZON
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Pagination horizon exceeded: page * limit (${data.page * data.limit}) cannot exceed ${MAX_SEARCH_RESULT_HORIZON}. Deep search beyond ${MAX_SEARCH_RESULT_HORIZON} results is unsupported.`,
        path: ['page'],
      });
    }
  });

export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
