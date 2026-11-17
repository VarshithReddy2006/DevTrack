import { expect, it } from 'vitest';
import { RevisionDueQuerySchema, type RevisionDueQuery, UpcomingContestsResponseSchema } from '@devtrack/contracts';
import { z } from 'zod';

it('imports runtime contracts and inferred types alongside the frontend Zod dependency', () => {
  const query: RevisionDueQuery = RevisionDueQuerySchema.parse({ limit: '7' });
  expect(query.limit).toBe(7);
  expect(UpcomingContestsResponseSchema.parse({ contests: [] })).toEqual({ contests: [] });
  expect(z.number().parse(query.limit)).toBe(7);
});
