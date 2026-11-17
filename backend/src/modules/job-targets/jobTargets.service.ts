// src/modules/job-targets/jobTargets.service.ts — submit and delete job targets.
// The API process never fetches the URL. It stores the target and writes a
// `jobtarget.submitted` outbox event in the same transaction; the worker does the fetch.
import { z } from 'zod';
import { Types } from 'mongoose';
import { JobTarget, type IJobTarget } from '../../db/models/jobTarget.model.js';
import { runInTransaction } from '../../db/transaction.js';
import { writeOutboxEvent } from '../../shared/events/outbox.js';

export const JOB_TARGET_LIMIT = 50;
export const JOB_TEXT_MAX_CHARS = 50_000;

export class JobTargetLimitError extends Error {
  readonly code = 'JOB_TARGET_LIMIT_REACHED';
  readonly status = 409;
  constructor() {
    super(`You can keep at most ${JOB_TARGET_LIMIT} job targets. Delete one to add another.`);
    this.name = 'JobTargetLimitError';
  }
}

export class JobTargetValidationError extends Error {
  readonly code = 'INVALID_JOB_TARGET';
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'JobTargetValidationError';
  }
}

export class JobTargetNotFoundError extends Error {
  readonly code = 'JOB_TARGET_NOT_FOUND';
  readonly status = 404;
  constructor() {
    super('Job target not found');
    this.name = 'JobTargetNotFoundError';
  }
}

// Syntax only. Where the URL points is checked later by safeFetch, in the worker.
const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'URL must start with http:// or https://');

export const submitJobTargetSchema = z
  .object({
    text: z.string().trim().min(1).max(JOB_TEXT_MAX_CHARS).optional(),
    url: httpUrl.optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .refine((v) => Boolean(v.text) !== Boolean(v.url), 'Provide either text or url, not both');

export type SubmitJobTargetInput = z.input<typeof submitJobTargetSchema>;

export async function submitJobTarget(userId: string, input: SubmitJobTargetInput): Promise<IJobTarget> {
  const parsed = submitJobTargetSchema.safeParse(input);
  if (!parsed.success) throw new JobTargetValidationError(parsed.error.issues.map((i) => i.message).join('; '));
  const { text, url, title } = parsed.data;
  const owner = new Types.ObjectId(userId);

  return runInTransaction(async (session) => {
    // Counted inside the transaction so two quick submissions cannot both slip under the cap.
    const count = await JobTarget.countDocuments({ userId: owner }).session(session);
    if (count >= JOB_TARGET_LIMIT) throw new JobTargetLimitError();

    const [target] = await JobTarget.create(
      [{ userId: owner, text: text ?? null, url: url ?? null, title: title ?? null, status: 'submitted' }],
      { session },
    );
    await writeOutboxEvent(session, {
      type: 'jobtarget.submitted',
      aggregateType: 'JobTarget',
      aggregateId: String(target._id),
      userId,
      payload: { jobTargetId: String(target._id), source: url ? 'url' : 'text' },
    });
    return target;
  });
}

/** Deletes one of the user's targets; its embeddings go with it via the model cascade. */
export async function deleteJobTarget(userId: string, jobTargetId: string): Promise<void> {
  if (!Types.ObjectId.isValid(jobTargetId)) throw new JobTargetNotFoundError();
  const removed = await JobTarget.findOneAndDelete({ _id: jobTargetId, userId: new Types.ObjectId(userId) });
  if (!removed) throw new JobTargetNotFoundError();
}
