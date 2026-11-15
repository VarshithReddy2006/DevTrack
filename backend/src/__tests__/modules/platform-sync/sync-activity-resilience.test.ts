import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { DsaContest, ActivityEvent } from '../../../db/models/index.js';
import { persistContests } from '../../../modules/platform-sync/sync.persistence.js';
import * as activityService from '../../../modules/activity/activity.service.js';

describe('Platform Sync Activity Resilience and Event Typing', () => {
  const userId = new Types.ObjectId().toString();

  beforeEach(async () => {
    vi.restoreAllMocks();
  });

  it('persistContests continues ingestion when createActivity encounters an error', async () => {
    const contests = [
      {
        title: 'Weekly Contest 1',
        participatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        rank: 100,
        totalParticipants: 5000,
        ratingBefore: 1500,
        ratingAfter: 1550,
        ratingChange: 50,
        url: 'https://leetcode.com/contest/weekly-1',
      },
      {
        title: 'Weekly Contest 2',
        participatedAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
        rank: 50,
        totalParticipants: 6000,
        ratingBefore: 1550,
        ratingAfter: 1620,
        ratingChange: 70,
        url: 'https://leetcode.com/contest/weekly-2',
      },
    ];

    let calls = 0;
    vi.spyOn(activityService, 'createActivity').mockImplementation(async (uid, data) => {
      calls++;
      if (calls === 1) {
        throw new Error('Database temporary connection failure');
      }
      return { _id: new Types.ObjectId(), ...data } as any;
    });

    const ingested = await persistContests(userId, 'leetcode', contests);
    expect(ingested).toBe(2);

    // Both contests must be persisted in DsaContest despite first activity failing
    const savedContests = await DsaContest.find({ userId: new Types.ObjectId(userId) });
    expect(savedContests).toHaveLength(2);
  });

  it('persistContests creates missing contest activity events idempotently on re-sync', async () => {
    const contest = {
      title: 'Biweekly Contest 99',
      participatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      rank: 200,
      totalParticipants: 8000,
      ratingBefore: 1600,
      ratingAfter: 1630,
      ratingChange: 30,
      url: 'https://leetcode.com/contest/biweekly-99',
    };

    // First run: contest is inserted in DsaContest, but activity creation fails
    vi.spyOn(activityService, 'createActivity').mockRejectedValueOnce(new Error('Transient error'));
    const firstRun = await persistContests(userId, 'leetcode', [contest]);
    expect(firstRun).toBe(1);

    // Confirm contest exists in DsaContest
    const doc = await DsaContest.findOne({ userId: new Types.ObjectId(userId), contestName: contest.title });
    expect(doc).not.toBeNull();

    // Re-sync: upsertedCount will be 0 because document already exists, but activity event should now be created
    vi.restoreAllMocks();

    const secondRun = await persistContests(userId, 'leetcode', [contest]);
    expect(secondRun).toBe(0); // Already existed in DsaContest

    // Activity event must be created on re-sync
    const activity = await ActivityEvent.findOne({
      userId: new Types.ObjectId(userId),
      type: 'contest_participated',
      'metadata.contestName': contest.title,
    });
    expect(activity).not.toBeNull();
    expect(activity!.type).toBe('contest_participated');

    // Third run: neither duplicate contest nor duplicate activity event should be created
    const thirdRun = await persistContests(userId, 'leetcode', [contest]);
    expect(thirdRun).toBe(0);
    const totalActivities = await ActivityEvent.countDocuments({
      userId: new Types.ObjectId(userId),
      type: 'contest_participated',
      'metadata.contestName': contest.title,
    });
    expect(totalActivities).toBe(1);
  });

  it('allows github_sync_completed in ActivityEvent model and routes', async () => {
    const event = await ActivityEvent.create({
      userId: new Types.ObjectId(userId),
      type: 'github_sync_completed',
      title: 'Platform Sync',
      description: 'Synced 1 platform(s) successfully',
      platform: 'devtrack',
      url: null,
      tags: ['sync'],
      occurredAt: new Date(),
    });

    expect(event).toBeDefined();
    expect(event.type).toBe('github_sync_completed');

    const found = await ActivityEvent.findById(event._id);
    expect(found?.type).toBe('github_sync_completed');
  });
});
