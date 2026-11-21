import mongoose, { Types, type ClientSession } from 'mongoose';
import { DailyActivity, DsaProblem, DsaSubmission } from '../../db/models/index.js';
import { getStartOfDay } from '../../shared/date.js';
import { enqueueSubmissionEvaluation } from '../revision/cardGenerator.service.js';

/** Rebuild only source-derived fields. Manual problem metadata and other daily
 * activity buckets are deliberately preserved. Caller owns the transaction. */
export async function projectSubmission(
  userId: Types.ObjectId,
  problemId: Types.ObjectId,
  submittedAt: Date,
  session: ClientSession,
) {
  const problemFilter = { userId, problemId };
  const count = await DsaSubmission.countDocuments(problemFilter).session(session);
  const latest = await DsaSubmission.findOne(problemFilter).sort({ submittedAt: -1 }).session(session).lean();
  const accepted = await DsaSubmission.findOne({ ...problemFilter, status: 'accepted' })
    .sort({ submittedAt: 1 }).session(session).lean();
  const day = getStartOfDay(submittedAt);
  const end = new Date(day);
  end.setDate(end.getDate() + 1);
  const dailyCount = await DsaSubmission.countDocuments({
    userId, submittedAt: { $gte: day, $lt: end },
  }).session(session);

  await DsaProblem.updateOne({ _id: problemId, userId }, [{
    $set: {
      submissionCount: count,
      lastSubmittedAt: latest?.submittedAt ?? null,
      ...(accepted ? {
        status: 'solved',
        solvedAt: { $min: [{ $ifNull: ['$solvedAt', accepted.submittedAt] }, accepted.submittedAt] },
      } : {}),
    },
  }], { session });

  // Replace the imported-submission bucket, not the entire day. The update
  // pipeline preserves non-submission activity and unbucketed legacy counts.
  await DailyActivity.updateOne({ userId, date: day }, [
    { $set: {
      userId, date: day,
      count: { $add: [
        { $max: [0, { $subtract: [
          { $ifNull: ['$count', 0] },
          { $reduce: {
            input: { $filter: {
              input: { $ifNull: ['$activities', []] },
              as: 'activity', cond: { $eq: ['$$activity.type', 'submission'] },
            } },
            initialValue: 0, in: { $add: ['$$value', '$$this.count'] },
          } },
        ] }] },
        dailyCount,
      ] },
      activities: { $concatArrays: [
        { $filter: {
          input: { $ifNull: ['$activities', []] },
          as: 'activity', cond: { $ne: ['$$activity.type', 'submission'] },
        } },
        [{ type: 'submission', count: dailyCount }],
      ] },
    } },
  ], { session, upsert: true });
}

export interface RepairOptions {
  limit?: number;
  afterId?: string;
  platform?: 'leetcode' | 'codeforces';
  dryRun?: boolean;
}

/** Explicitly user-scoped and cursor bounded; defaults to a read-only preview. */
export async function repairSubmissionProjections(userId: string, options: RepairOptions = {}) {
  if (!Types.ObjectId.isValid(userId)) throw new Error('Invalid user ID');
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Limit must be 1–100');
  if (options.afterId && !Types.ObjectId.isValid(options.afterId)) throw new Error('Invalid cursor');
  if (options.platform && !['leetcode', 'codeforces'].includes(options.platform)) throw new Error('Invalid platform');
  const owner = new Types.ObjectId(userId);
  const rows = await DsaSubmission.find({
    userId: owner,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.afterId ? { _id: { $gt: new Types.ObjectId(options.afterId) } } : {}),
  }).sort({ _id: 1 }).limit(limit).select('_id problemId submittedAt revisionEvaluationQueued').lean();
  const result = {
    dryRun: options.dryRun !== false, scanned: rows.length, repaired: 0,
    failed: [] as { submissionId: string; error: string }[],
    nextCursor: rows.length === limit ? rows.at(-1)!._id.toString() : null,
    candidates: rows.map(row => ({
      submissionId: row._id.toString(), problemId: row.problemId.toString(),
      submittedAt: row.submittedAt.toISOString(),
    })),
  };
  if (result.dryRun) return result;
  for (const row of rows) {
    try {
      await mongoose.connection.transaction(async session => {
        const current = await DsaSubmission.findOne({ _id: row._id, userId: owner }).session(session).lean();
        if (!current) throw new Error('Submission no longer exists');
        const problem = await DsaProblem.exists({ _id: current.problemId, userId: owner }).session(session);
        if (!problem) throw new Error('Owned problem no longer exists');
        await projectSubmission(owner, new Types.ObjectId(current.problemId.toString()), current.submittedAt, session);
      });
      await enqueueSubmissionEvaluation(userId, row._id.toString());
      result.repaired++;
    } catch (error) {
      result.failed.push({ submissionId: row._id.toString(), error: error instanceof Error ? error.message : 'Repair failed' });
    }
  }
  return result;
}
