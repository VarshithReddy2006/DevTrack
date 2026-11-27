// src/__tests__/modules/privacy/dataExport.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import JSZip from 'jszip';
import {
  User,
  RevisionCard,
  Mission,
  LeagueStanding,
} from '../../../db/models/index.js';
import {
  generateDataExport,
  generateAndNotifyDataExport,
  getExportArchiveByToken,
  storeExportArchive,
  MAX_IN_MEMORY_EXPORTS,
} from '../../../modules/privacy/dataExport.service.js';
import { eventBus } from '../../../shared/sse/index.js';

describe('GDPR Privacy: Version-2 Collections in Data Portability Export', () => {
  let testUserId: string;
  let otherUserId: string;

  beforeEach(async () => {
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const user = await User.create({
      clerkId: `clerk_export_${suffix}`,
      email: `export_${suffix}@example.com`,
      username: `exp_${suffix}`,
      displayName: 'Export Test User',
      role: 'user',
    });
    testUserId = user._id.toString();

    const otherUser = await User.create({
      clerkId: `clerk_other_${suffix}`,
      email: `other_${suffix}@example.com`,
      username: `oth_${suffix}`,
      displayName: 'Other User',
      role: 'user',
    });
    otherUserId = otherUser._id.toString();
  });

  it('includes RevisionCard, Mission, and LeagueStanding records in the exported ZIP and metadata', async () => {
    const now = new Date('2026-11-25T10:00:00.000Z');
    const dueLater = new Date('2026-11-26T10:00:00.000Z');
    const expiresAt = new Date('2026-11-30T00:00:00.000Z');

    // Seed RevisionCards (2 for target user, 1 for another user)
    await RevisionCard.create([
      {
        userId: new Types.ObjectId(testUserId),
        problemKey: 'leetcode:two-sum',
        title: 'Two Sum',
        difficulty: 'easy',
        tags: ['array', 'hash-table'],
        repetitions: 3,
        easeFactor: 2.6,
        intervalDays: 6,
        dueAt: now,
        notes: 'Use complement map',
      },
      {
        userId: new Types.ObjectId(testUserId),
        problemKey: 'leetcode:lru-cache',
        title: 'LRU Cache',
        difficulty: 'medium',
        tags: ['design', 'linked-list'],
        repetitions: 1,
        easeFactor: 2.5,
        intervalDays: 1,
        dueAt: dueLater,
        notes: 'Doubly linked list + hashmap',
      },
      {
        userId: new Types.ObjectId(otherUserId),
        problemKey: 'leetcode:word-ladder',
        title: 'Word Ladder',
        difficulty: 'hard',
        dueAt: now,
      },
    ]);

    // Seed Missions (2 for target user, 1 for another user)
    await Mission.create([
      {
        userId: new Types.ObjectId(testUserId),
        title: 'Solve 3 Medium Problems',
        description: 'Complete 3 medium DSA problems today',
        type: 'daily',
        status: 'completed',
        targetCount: 3,
        currentCount: 3,
        xpReward: 150,
        category: 'dsa',
        expiresAt,
        completedAt: now,
        periodKey: '2026-11-25',
        templateKey: 'daily-dsa-3',
        generationCalibration: { averageProblemsPerDay: 2, level: 4 },
        completedByFocusSessionId: 'focus-session-secret-id',
      },
      {
        userId: new Types.ObjectId(testUserId),
        title: 'Weekly Consistency Streak',
        description: 'Maintain activity 5 days this week',
        type: 'weekly',
        status: 'in_progress',
        targetCount: 5,
        currentCount: 2,
        xpReward: 300,
        category: 'consistency',
        expiresAt,
      },
      {
        userId: new Types.ObjectId(otherUserId),
        title: 'Other User Mission',
        description: 'Should not leak into export',
        type: 'daily',
        status: 'pending',
        targetCount: 1,
        currentCount: 0,
        xpReward: 50,
        category: 'learning',
        expiresAt,
      },
    ]);

    // Seed LeagueStandings (2 weeks for target user, 1 for another user)
    await LeagueStanding.create([
      {
        weekKey: '2026-11-15',
        userId: new Types.ObjectId(testUserId),
        division: 'silver',
        cohortId: 'cohort-silver-01',
        status: 'finalized',
        joinedAt: new Date('2026-11-15T01:00:00.000Z'),
        points: 840,
        rank: 2,
        cohortSize: 25,
        outcome: 'promoted',
        nextDivision: 'gold',
        finalizedAt: new Date('2026-11-22T00:05:00.000Z'),
      },
      {
        weekKey: '2026-11-22',
        userId: new Types.ObjectId(testUserId),
        division: 'gold',
        cohortId: 'cohort-gold-04',
        status: 'active',
        joinedAt: new Date('2026-11-22T02:00:00.000Z'),
        points: 210,
      },
      {
        weekKey: '2026-11-22',
        userId: new Types.ObjectId(otherUserId),
        division: 'bronze',
        cohortId: 'cohort-bronze-99',
        status: 'active',
        joinedAt: new Date('2026-11-22T02:00:00.000Z'),
        points: 999,
      },
    ]);

    const { archiveBuffer, metadata } = await generateDataExport(testUserId);

    // Metadata counts must match exact user document counts
    expect(metadata.categories.revisionCards).toBe(2);
    expect(metadata.categories.missions).toBe(2);
    expect(metadata.categories.leagueStandings).toBe(2);
    expect(metadata.archiveBytes).toBe(archiveBuffer.length);

    const zip = await JSZip.loadAsync(archiveBuffer);
    const fileNames = Object.keys(zip.files);
    expect(fileNames).toContain('revision-cards.json');
    expect(fileNames).toContain('missions.json');
    expect(fileNames).toContain('leagues.json');

    // Verify metadata.json inside ZIP
    const zipMetadata = JSON.parse(await zip.file('metadata.json')!.async('string'));
    expect(zipMetadata.categories.revisionCards).toBe(2);
    expect(zipMetadata.categories.missions).toBe(2);
    expect(zipMetadata.categories.leagueStandings).toBe(2);

    // Verify revision-cards.json
    const exportedCards = JSON.parse(await zip.file('revision-cards.json')!.async('string'));
    expect(exportedCards).toHaveLength(2);
    expect(exportedCards.map((c: any) => c.problemKey)).toEqual([
      'leetcode:two-sum',
      'leetcode:lru-cache',
    ]);
    expect(exportedCards[0]).toMatchObject({
      title: 'Two Sum',
      difficulty: 'easy',
      intervalDays: 6,
      notes: 'Use complement map',
    });
    expect(exportedCards[0].__v).toBeUndefined();

    // Verify missions.json (sanitized of internal scheduling/calibration fields)
    const exportedMissions = JSON.parse(await zip.file('missions.json')!.async('string'));
    expect(exportedMissions).toHaveLength(2);
    const completedMission = exportedMissions.find((m: any) => m.title === 'Solve 3 Medium Problems');
    expect(completedMission).toMatchObject({
      type: 'daily',
      status: 'completed',
      xpReward: 150,
      category: 'dsa',
    });
    expect(completedMission.__v).toBeUndefined();
    expect(completedMission.periodKey).toBeUndefined();
    expect(completedMission.templateKey).toBeUndefined();
    expect(completedMission.generationCalibration).toBeUndefined();
    expect(completedMission.completedByFocusSessionId).toBeUndefined();

    // Verify leagues.json
    const exportedLeagues = JSON.parse(await zip.file('leagues.json')!.async('string'));
    expect(exportedLeagues).toHaveLength(2);
    expect(exportedLeagues.map((l: any) => l.weekKey)).toEqual(['2026-11-22', '2026-11-15']);
    const finalizedLeague = exportedLeagues.find((l: any) => l.weekKey === '2026-11-15');
    expect(finalizedLeague).toMatchObject({
      division: 'silver',
      points: 840,
      rank: 2,
      outcome: 'promoted',
      nextDivision: 'gold',
    });
    expect(finalizedLeague.__v).toBeUndefined();
  });

  it('produces empty arrays and zero counts when a user has no v2 records', async () => {
    const { archiveBuffer, metadata } = await generateDataExport(testUserId);

    expect(metadata.categories.revisionCards).toBe(0);
    expect(metadata.categories.missions).toBe(0);
    expect(metadata.categories.leagueStandings).toBe(0);

    const zip = await JSZip.loadAsync(archiveBuffer);
    expect(JSON.parse(await zip.file('revision-cards.json')!.async('string'))).toEqual([]);
    expect(JSON.parse(await zip.file('missions.json')!.async('string'))).toEqual([]);
    expect(JSON.parse(await zip.file('leagues.json')!.async('string'))).toEqual([]);
  });

  it('stores archive and notifies via SSE with updated v2 category counts', async () => {
    await RevisionCard.create({
      userId: new Types.ObjectId(testUserId),
      problemKey: 'leetcode:valid-parentheses',
      title: 'Valid Parentheses',
      difficulty: 'easy',
      dueAt: new Date(),
    });

    const publishSpy = vi.spyOn(eventBus, 'publishEnvelope').mockResolvedValue(undefined as any);

    const result = await generateAndNotifyDataExport(testUserId);
    expect(result.token).toBeDefined();
    expect(result.downloadUrl).toBe(`/api/v2/privacy/export/download/${result.token}`);

    const stored = await getExportArchiveByToken(result.token);
    expect(stored).not.toBeNull();
    const zip = await JSZip.loadAsync(stored!);
    const cards = JSON.parse(await zip.file('revision-cards.json')!.async('string'));
    expect(cards).toHaveLength(1);

    expect(publishSpy).toHaveBeenCalledWith(
      testUserId,
      'privacy.export_ready',
      expect.objectContaining({
        categories: expect.objectContaining({
          revisionCards: 1,
          missions: 0,
          leagueStandings: 0,
        }),
      })
    );

    publishSpy.mockRestore();
  });

  it('enforces userId ownership verification on getExportArchiveByToken', async () => {
    const { token } = await storeExportArchive(testUserId, Buffer.from('zip-bytes'));
    expect(await getExportArchiveByToken(token, testUserId)).toEqual(Buffer.from('zip-bytes'));
    expect(await getExportArchiveByToken(token, otherUserId)).toBeNull();
  });

  it('bounds in-memory export cache to MAX_IN_MEMORY_EXPORTS by evicting oldest entries', async () => {
    const first = await storeExportArchive(testUserId, Buffer.from('first'));
    for (let i = 0; i < MAX_IN_MEMORY_EXPORTS; i++) {
      await storeExportArchive(testUserId, Buffer.from(`entry-${i}`));
    }
    expect(await getExportArchiveByToken(first.token, testUserId)).toBeNull();
  });
});
