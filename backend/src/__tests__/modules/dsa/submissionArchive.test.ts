import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import {
  DsaSubmission,
  DsaSubmissionArchive,
} from '../../../db/models/index.js';
import { runSubmissionArchive, ARCHIVAL_AGE_DAYS, BATCH_SIZE } from '../../../modules/dsa/submissionArchive.worker.js';
import { getSubmissions } from '../../../modules/dsa/dsa.service.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

async function seedSubmission(overrides: {
  userId: Types.ObjectId;
  createdAt: Date;
  submittedAt?: Date;
  externalId?: string;
  status?: 'accepted' | 'wrong';
  platform?: 'leetcode' | 'codeforces';
}) {
  return DsaSubmission.create({
    userId: overrides.userId,
    problemId: new Types.ObjectId(),
    platform: overrides.platform ?? 'codeforces',
    externalId: overrides.externalId ?? `cf-${overrides.createdAt.getTime()}-${Math.random()}`,
    status: overrides.status ?? 'accepted',
    language: 'cpp',
    submittedAt: overrides.submittedAt ?? overrides.createdAt,
    createdAt: overrides.createdAt,
  });
}

describe('submissionArchive worker', () => {
  let userId: Types.ObjectId;

  beforeEach(() => {
    userId = new Types.ObjectId();
    vi.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('migrates submissions older than 180 days into the archive and removes them from hot', async () => {
    const old1 = await seedSubmission({ userId, createdAt: daysAgo(200), externalId: 'cf-old-1' });
    const old2 = await seedSubmission({ userId, createdAt: daysAgo(190), externalId: 'cf-old-2' });
    const recent = await seedSubmission({ userId, createdAt: daysAgo(5), externalId: 'cf-recent' });

    const { migrated, batches } = await runSubmissionArchive({ now: NOW });

    expect(migrated).toBe(2);
    expect(batches).toBe(1);

    const hot = await DsaSubmission.find({ userId }).lean();
    expect(hot.map((s) => s.externalId)).toEqual(expect.arrayContaining(['cf-recent']));
    expect(hot.map((s) => s.externalId)).not.toContain('cf-old-1');
    expect(hot.map((s) => s.externalId)).not.toContain('cf-old-2');

    const archived = await DsaSubmissionArchive.find({ userId }).lean();
    expect(archived.map((s) => s.externalId).sort()).toEqual(['cf-old-1', 'cf-old-2'].sort());
    for (const doc of archived) {
      expect(doc.archivedAt).toBeInstanceOf(Date);
    }
  });

  it('processes more than one batch when eligible records exceed batch size', async () => {
    const externalIds: string[] = [];
    const seedDocs = [];
    for (let i = 0; i < BATCH_SIZE + 10; i += 1) {
      externalIds.push(`cf-batch-${i}`);
      seedDocs.push({
        userId,
        problemId: new Types.ObjectId(),
        platform: 'codeforces' as const,
        externalId: `cf-batch-${i}`,
        status: 'accepted' as const,
        language: 'cpp',
        submittedAt: daysAgo(200),
        createdAt: daysAgo(200),
      });
    }
    await DsaSubmission.insertMany(seedDocs);

    const { migrated, batches } = await runSubmissionArchive({ now: NOW, batchSize: BATCH_SIZE });

    expect(migrated).toBe(BATCH_SIZE + 10);
    expect(batches).toBe(2);
    expect(await DsaSubmission.countDocuments({ userId })).toBe(0);
    expect(await DsaSubmissionArchive.countDocuments({ userId })).toBe(BATCH_SIZE + 10);
  });

  it('rolls back hot deletion when cold insertion fails (transactional)', async () => {
    await seedSubmission({ userId, createdAt: daysAgo(200), externalId: 'cf-rollback-1' });
    await seedSubmission({ userId, createdAt: daysAgo(200), externalId: 'cf-rollback-2' });

    const insertSpy = vi
      .spyOn(DsaSubmissionArchive, 'bulkWrite')
      .mockRejectedValueOnce(new Error('cold insert failed'));

    await expect(runSubmissionArchive({ now: NOW })).rejects.toThrow('cold insert failed');

    // Hot records must be untouched: nothing deleted.
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(await DsaSubmission.countDocuments({ userId })).toBe(2);
    expect(await DsaSubmissionArchive.countDocuments({ userId })).toBe(0);
  });

  it('migrates submissions based on submittedAt even when createdAt is recent (historical data import)', async () => {
    // Submission solved 200 days ago, but imported into DevTrack today (createdAt = NOW)
    await seedSubmission({
      userId,
      createdAt: NOW,
      submittedAt: daysAgo(200),
      externalId: 'cf-historical-old',
    });
    // Submission solved 5 days ago, created 200 days ago (should stay in hot based on submittedAt)
    await seedSubmission({
      userId,
      createdAt: daysAgo(200),
      submittedAt: daysAgo(5),
      externalId: 'cf-recent-solve',
    });

    const { migrated } = await runSubmissionArchive({ now: NOW });
    expect(migrated).toBe(1);

    const hot = await DsaSubmission.find({ userId }).lean();
    expect(hot.map((s) => s.externalId)).toEqual(['cf-recent-solve']);

    const archived = await DsaSubmissionArchive.find({ userId }).lean();
    expect(archived.map((s) => s.externalId)).toEqual(['cf-historical-old']);
  });

  it('idempotently handles candidate records that already exist in archive without throwing duplicate key error', async () => {
    const problemId = new Types.ObjectId();
    // Pre-insert an identical record into cold archive (simulating previous attempt or retry)
    await DsaSubmissionArchive.create({
      userId,
      problemId,
      platform: 'codeforces',
      externalId: 'cf-duplicate-conflict',
      status: 'accepted',
      language: 'cpp',
      submittedAt: daysAgo(200),
      createdAt: daysAgo(200),
      archivedAt: daysAgo(10),
    });

    // Hot record with same unique compound key (userId, platform, externalId)
    await DsaSubmission.create({
      userId,
      problemId,
      platform: 'codeforces',
      externalId: 'cf-duplicate-conflict',
      status: 'accepted',
      language: 'cpp',
      submittedAt: daysAgo(200),
      createdAt: daysAgo(200),
    });

    // Also a normal old submission
    await seedSubmission({ userId, createdAt: daysAgo(220), externalId: 'cf-normal-old' });

    const { migrated } = await runSubmissionArchive({ now: NOW });
    expect(migrated).toBe(2);

    // Both should be cleared from hot collection
    expect(await DsaSubmission.countDocuments({ userId })).toBe(0);
    // Cold collection should still have both without corruption
    const archived = await DsaSubmissionArchive.find({ userId }).lean();
    expect(archived.map((s) => s.externalId).sort()).toEqual(['cf-duplicate-conflict', 'cf-normal-old'].sort());
  });

  it('does not migrate recent submissions below the age threshold', async () => {
    await seedSubmission({ userId, createdAt: daysAgo(179), externalId: 'cf-edge-recent' });
    await seedSubmission({ userId, createdAt: daysAgo(181), externalId: 'cf-edge-old' });

    await runSubmissionArchive({ now: NOW });

    expect(await DsaSubmission.countDocuments({ userId })).toBe(1);
    expect(await DsaSubmissionArchive.countDocuments({ userId })).toBe(1);

    const hotExternal = (await DsaSubmission.findOne({ userId }))!.externalId;
    expect(hotExternal).toBe('cf-edge-recent');
    const archivedExternal = (await DsaSubmissionArchive.findOne({ userId }))!.externalId;
    expect(archivedExternal).toBe('cf-edge-old');
  });

  it('unified query returns archived records when includeArchived is true', async () => {
    const old = await seedSubmission({ userId, createdAt: daysAgo(200), externalId: 'cf-unified-old' });
    const recent = await seedSubmission({ userId, createdAt: daysAgo(5), externalId: 'cf-unified-recent' });

    await runSubmissionArchive({ now: NOW });

    const hotOnly = await getSubmissions(userId.toString(), {});
    expect(hotOnly.submissions.map((s) => s.problemName)).toEqual(['Unknown Problem']);
    expect(hotOnly.submissions.length).toBe(1);
    expect(hotOnly.pagination.totalItems).toBe(1);

    const unified = await getSubmissions(userId.toString(), { includeArchived: true });
    expect(unified.submissions.length).toBe(2);
    expect(unified.pagination.totalItems).toBe(2);

    // Archived entry is identifiable by its much older submittedAt.
    const oldSubmittedAt = new Date(daysAgo(200)).toISOString();
    const archivedEntry = unified.submissions.find((s) => s.submittedAt === oldSubmittedAt);
    expect(archivedEntry).toBeDefined();
  });
});

describe('submissionArchive constants', () => {
  it('uses a 180-day threshold and batch size of 500', () => {
    expect(ARCHIVAL_AGE_DAYS).toBe(180);
    expect(BATCH_SIZE).toBe(500);
  });
});
