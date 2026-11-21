import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { DailyActivity, DsaProblem, DsaSubmission } from '../../../db/models/index.js';
import { persistSubmissions } from '../../../modules/platform-sync/sync.persistence.js';
import { repairSubmissionProjections } from '../../../modules/platform-sync/submission-projections.js';
import { getStartOfDay } from '../../../shared/date.js';
import type { PlatformSubmission } from '../../../modules/platform-sync/adapters/types.js';

const queue = vi.hoisted(() => ({ enqueue: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../modules/revision/cardGenerator.service.js', () => ({
  enqueueSubmissionEvaluation: queue.enqueue,
}));
vi.mock('../../../modules/daily-challenge/daily-challenge.service.js', () => ({
  checkChallengeCompletion: vi.fn().mockResolvedValue(undefined),
}));
const owner = new Types.ObjectId();
const date = new Date('2026-11-20T12:00:00Z');
const submission: PlatformSubmission = {
  externalId: 'attempt-1', problemExternalId: 'two-sum', platform: 'leetcode',
  title: 'Two sum', difficulty: 'easy', status: 'accepted', submittedAt: date,
  problemUrl: 'https://leetcode.com/problems/two-sum/',
};

beforeAll(async () => {
  await Promise.all([DsaProblem.init(), DsaSubmission.init(), DailyActivity.init()]);
});
beforeEach(() => { vi.restoreAllMocks(); queue.enqueue.mockReset().mockResolvedValue(undefined); });

describe('atomic submission projections', () => {
  it('rolls back source admission when daily projection fails, then retries once', async () => {
    vi.spyOn(DailyActivity, 'updateOne').mockRejectedValueOnce(new Error('injected daily failure'));
    await expect(persistSubmissions(owner.toString(), [submission])).rejects.toThrow('injected daily failure');
    expect(await DsaSubmission.countDocuments()).toBe(0);
    expect(await DsaProblem.countDocuments()).toBe(0);
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(await persistSubmissions(owner.toString(), [submission])).toBe(1);
    expect((await DsaProblem.findOne())?.submissionCount).toBe(1);
    expect((await DailyActivity.findOne())?.count).toBe(1);
  });

  it('repairs a legacy source record on replay and preserves manual activity/metadata', async () => {
    const problem = await DsaProblem.create({
      userId: owner, externalId: 'two-sum', platform: 'leetcode',
      title: 'My own title', difficulty: 'easy', url: submission.problemUrl,
      category: 'Arrays', notes: 'Keep my notes', isFavorite: true,
    });
    await DsaSubmission.create({
      userId: owner, problemId: problem._id, externalId: 'attempt-1',
      platform: 'leetcode', status: 'accepted', language: 'typescript', submittedAt: date,
    });
    await DailyActivity.create({
      userId: owner, date: getStartOfDay(date), count: 3,
      activities: [{ type: 'problem_solved', count: 3 }],
    });
    expect(await persistSubmissions(owner.toString(), [submission])).toBe(0);
    expect(await persistSubmissions(owner.toString(), [submission])).toBe(0);
    const updated = await DsaProblem.findById(problem._id).lean();
    expect(updated).toMatchObject({
      submissionCount: 1, status: 'solved', title: 'My own title',
      notes: 'Keep my notes', isFavorite: true,
    });
    expect(updated?.solvedAt).toEqual(date);
    const day = await DailyActivity.findOne({ userId: owner }).lean();
    expect(day?.count).toBe(4);
    expect(day?.activities.map(({ type, count }) => ({ type, count }))).toEqual([
      { type: 'problem_solved', count: 3 }, { type: 'submission', count: 1 },
    ]);
    expect(queue.enqueue).toHaveBeenCalled();
  });

  it('converges concurrent first imports without duplicate source or daily counts', async () => {
    const counts = await Promise.all([
      persistSubmissions(owner.toString(), [submission]),
      persistSubmissions(owner.toString(), [submission]),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await DsaSubmission.countDocuments()).toBe(1);
    expect((await DailyActivity.findOne())?.count).toBe(1);
  });

  it('counts multiple sources on the same day and leaves unrelated owners untouched', async () => {
    const other = new Types.ObjectId();
    await DailyActivity.create({ userId: other, date: getStartOfDay(date), count: 19 });
    await persistSubmissions(owner.toString(), [
      submission, { ...submission, externalId: 'attempt-2', status: 'wrong_answer' },
    ]);
    expect((await DailyActivity.findOne({ userId: owner }))?.count).toBe(2);
    expect((await DailyActivity.findOne({ userId: other }))?.count).toBe(19);
    expect((await DsaProblem.findOne())?.status).toBe('solved');
    expect((await DsaProblem.findOne())?.submissionCount).toBe(2);
  });

  it('defaults repair to dry run and uses an owned bounded cursor', async () => {
    await persistSubmissions(owner.toString(), [submission]);
    await DsaProblem.updateOne({ userId: owner }, { $set: { submissionCount: 0 } });
    const preview = await repairSubmissionProjections(owner.toString(), { limit: 1 });
    expect(preview).toMatchObject({ dryRun: true, scanned: 1, repaired: 0 });
    expect(preview.nextCursor).toBeTruthy();
    expect((await DsaProblem.findOne())?.submissionCount).toBe(0);
    const applied = await repairSubmissionProjections(owner.toString(), { dryRun: false });
    expect(applied).toMatchObject({ scanned: 1, repaired: 1, failed: [] });
    expect((await DsaProblem.findOne())?.submissionCount).toBe(1);
    expect((await repairSubmissionProjections(new Types.ObjectId().toString())).scanned).toBe(0);
    await expect(repairSubmissionProjections(owner.toString(), { limit: 101 })).rejects.toThrow('Limit');
  });

  it('repairs projections on replay after the revision outbox handoff fails', async () => {
    queue.enqueue.mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(persistSubmissions(owner.toString(), [submission])).rejects.toThrow('outbox unavailable');
    expect(await DsaSubmission.countDocuments()).toBe(1);
    expect(await persistSubmissions(owner.toString(), [submission])).toBe(0);
    expect((await DailyActivity.findOne())?.count).toBe(1);
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
  });
});
