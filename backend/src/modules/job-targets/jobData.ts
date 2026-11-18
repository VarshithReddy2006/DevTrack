import { z } from 'zod';
import { NonRetryableError } from '../../infrastructure/queues/ErrorClassifier.js';

const JobTargetJobSchema = z.object({
  userId: z.string().min(1).max(128),
  jobTargetId: z.string().min(1).max(128),
  requestId: z.string().max(128).optional(),
});

/** A malformed job cannot be fixed by a retry, so it goes straight to the dead-letter queue. */
export function parseJobTargetJobData(raw: unknown): z.infer<typeof JobTargetJobSchema> {
  const parsed = JobTargetJobSchema.safeParse(raw);
  if (!parsed.success) throw new NonRetryableError('Malformed job target job data');
  return parsed.data;
}
