// src/__tests__/modules/missions/mission-history.test.ts
// Unit tests for mission category filtering and history pagination

import { describe, it, expect, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { getUserMissions, getUserMissionHistory } from '../../../modules/missions/missionProgress.service.js';
import { Mission } from '../../../db/models/index.js';

describe('Mission History and Filtering', () => {
  const userId = new Types.ObjectId().toHexString();

  beforeEach(async () => {
    await Mission.deleteMany({ userId: new Types.ObjectId(userId) });
  });

  describe('getUserMissions with category filtering', () => {
    it('filters active missions by category', async () => {
      const future = new Date();
      future.setDate(future.getDate() + 3);

      await Mission.create([
        {
          userId: new Types.ObjectId(userId),
          title: 'DSA Mission 1',
          description: 'DSA task',
          type: 'daily',
          category: 'dsa',
          targetCount: 3,
          currentCount: 1,
          xpReward: 30,
          status: 'in_progress',
          expiresAt: future,
        },
        {
          userId: new Types.ObjectId(userId),
          title: 'Project Mission 1',
          description: 'Project task',
          type: 'weekly',
          category: 'project',
          targetCount: 5,
          currentCount: 0,
          xpReward: 100,
          status: 'pending',
          expiresAt: future,
        },
      ]);

      const all = await getUserMissions(userId);
      expect(all).toHaveLength(2);

      const dsaOnly = await getUserMissions(userId, 'dsa');
      expect(dsaOnly).toHaveLength(1);
      expect(dsaOnly[0].title).toBe('DSA Mission 1');

      const projectOnly = await getUserMissions(userId, 'project');
      expect(projectOnly).toHaveLength(1);
      expect(projectOnly[0].title).toBe('Project Mission 1');
    });
  });

  describe('getUserMissionHistory', () => {
    it('returns completed and expired missions with pagination', async () => {
      const past = new Date();
      past.setDate(past.getDate() - 1);

      await Mission.create([
        {
          userId: new Types.ObjectId(userId),
          title: 'Completed DSA Mission',
          description: 'Finished task',
          type: 'daily',
          category: 'dsa',
          targetCount: 2,
          currentCount: 2,
          xpReward: 50,
          status: 'completed',
          completedAt: new Date(),
          expiresAt: past,
        },
        {
          userId: new Types.ObjectId(userId),
          title: 'Expired Project Mission',
          description: 'Did not finish in time',
          type: 'weekly',
          category: 'project',
          targetCount: 5,
          currentCount: 1,
          xpReward: 80,
          status: 'expired',
          expiresAt: past,
        },
      ]);

      const history = await getUserMissionHistory(userId, { limit: 10, offset: 0 });
      expect(history.total).toBe(2);
      expect(history.missions).toHaveLength(2);

      const completedOnly = await getUserMissionHistory(userId, { status: 'completed' });
      expect(completedOnly.total).toBe(1);
      expect(completedOnly.missions[0].title).toBe('Completed DSA Mission');

      const categoryFiltered = await getUserMissionHistory(userId, { category: 'project' });
      expect(categoryFiltered.total).toBe(1);
      expect(categoryFiltered.missions[0].title).toBe('Expired Project Mission');
    });

    it('respects pagination limit and offset', async () => {
      const past = new Date();
      past.setDate(past.getDate() - 1);

      const items = Array.from({ length: 5 }).map((_, i) => ({
        userId: new Types.ObjectId(userId),
        title: `Completed Mission ${i + 1}`,
        description: `Description ${i + 1}`,
        type: 'daily',
        category: 'dsa',
        targetCount: 1,
        currentCount: 1,
        xpReward: 20,
        status: 'completed',
        completedAt: new Date(Date.now() - i * 1000),
        expiresAt: past,
      }));

      await Mission.create(items);

      const page1 = await getUserMissionHistory(userId, { limit: 2, offset: 0 });
      expect(page1.total).toBe(5);
      expect(page1.missions).toHaveLength(2);

      const page2 = await getUserMissionHistory(userId, { limit: 2, offset: 2 });
      expect(page2.total).toBe(5);
      expect(page2.missions).toHaveLength(2);
      expect(page2.missions[0].id).not.toBe(page1.missions[0].id);
    });
  });
});
