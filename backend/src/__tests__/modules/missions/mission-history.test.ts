// src/__tests__/modules/missions/mission-history.test.ts
// Unit and HTTP route tests for mission category filtering and history pagination

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { getUserMissions, getUserMissionHistory } from '../../../modules/missions/missionProgress.service.js';
import { Mission } from '../../../db/models/index.js';
import missionsRoutes from '../../../modules/missions/missions.routes.js';

vi.mock('../../../middleware/auth.js', async () => {
  const { commonErrors } = await import('../../../shared/response.js');
  return {
    authMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.get('authorization') !== 'Bearer test-owner') {
        commonErrors.unauthorized(res);
        return;
      }
      Object.assign(req, { user: { id: '000000000000000000000001' } });
      next();
    },
  };
});

describe('Mission History and Filtering', () => {
  const userId = '000000000000000000000001';
  const otherUserId = '000000000000000000000002';

  beforeEach(async () => {
    await Mission.deleteMany({});
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

    it('falls back to safe defaults for NaN pagination and rejects active status filters', async () => {
      const future = new Date(Date.now() + 86_400_000);
      const past = new Date(Date.now() - 86_400_000);

      await Mission.create([
        {
          userId: new Types.ObjectId(userId),
          title: 'Active Pending Mission',
          description: 'Still active',
          type: 'daily',
          category: 'dsa',
          targetCount: 1,
          currentCount: 0,
          xpReward: 10,
          status: 'pending',
          expiresAt: future,
        },
        {
          userId: new Types.ObjectId(userId),
          title: 'Completed History Mission',
          description: 'Done',
          type: 'daily',
          category: 'dsa',
          targetCount: 1,
          currentCount: 1,
          xpReward: 20,
          status: 'completed',
          completedAt: new Date(),
          expiresAt: past,
        },
      ]);

      const result = await getUserMissionHistory(userId, {
        limit: Number.NaN,
        offset: Number.NaN,
        status: 'pending' as any,
      });

      expect(result.limit).toBe(20);
      expect(result.offset).toBe(0);
      expect(result.total).toBe(1);
      expect(result.missions.map((m) => m.title)).toEqual(['Completed History Mission']);
    });
  });

  describe('HTTP routes (GET /api/missions & GET /api/missions/history)', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      const app = express();
      app.use('/api/missions', missionsRoutes);
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
      });
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/missions`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });

    async function seedMissions() {
      const future = new Date(Date.now() + 86_400_000);
      const past = new Date(Date.now() - 86_400_000);

      await Mission.create([
        {
          userId: new Types.ObjectId(userId),
          title: 'Owner Active DSA',
          description: 'Active DSA task',
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
          title: 'Owner Active Project',
          description: 'Active Project task',
          type: 'weekly',
          category: 'project',
          targetCount: 2,
          currentCount: 0,
          xpReward: 60,
          status: 'pending',
          expiresAt: future,
        },
        {
          userId: new Types.ObjectId(otherUserId),
          title: 'Other User Active DSA',
          description: 'Should stay isolated',
          type: 'daily',
          category: 'dsa',
          targetCount: 1,
          currentCount: 0,
          xpReward: 20,
          status: 'pending',
          expiresAt: future,
        },
        {
          userId: new Types.ObjectId(userId),
          title: 'Owner Completed DSA 1',
          description: 'Completed 1',
          type: 'daily',
          category: 'dsa',
          targetCount: 1,
          currentCount: 1,
          xpReward: 25,
          status: 'completed',
          completedAt: new Date(Date.now() - 1000),
          expiresAt: past,
        },
        {
          userId: new Types.ObjectId(userId),
          title: 'Owner Completed DSA 2',
          description: 'Completed 2',
          type: 'daily',
          category: 'dsa',
          targetCount: 1,
          currentCount: 1,
          xpReward: 25,
          status: 'completed',
          completedAt: new Date(Date.now() - 2000),
          expiresAt: past,
        },
        {
          userId: new Types.ObjectId(userId),
          title: 'Owner Expired Learning',
          description: 'Expired 1',
          type: 'weekly',
          category: 'learning',
          targetCount: 2,
          currentCount: 1,
          xpReward: 40,
          status: 'expired',
          expiresAt: past,
        },
        {
          userId: new Types.ObjectId(otherUserId),
          title: 'Other User Completed DSA',
          description: 'Foreign history',
          type: 'daily',
          category: 'dsa',
          targetCount: 1,
          currentCount: 1,
          xpReward: 25,
          status: 'completed',
          completedAt: new Date(),
          expiresAt: past,
        },
      ]);
    }

    it('requires authentication on active and history endpoints', async () => {
      const [activeRes, historyRes] = await Promise.all([
        fetch(baseUrl),
        fetch(`${baseUrl}/history`),
      ]);
      expect(activeRes.status).toBe(401);
      expect(historyRes.status).toBe(401);
    });

    it('filters active missions by category and isolates other users', async () => {
      await seedMissions();
      const response = await fetch(`${baseUrl}?category=dsa`, {
        headers: { Authorization: 'Bearer test-owner' },
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.map((m: { title: string }) => m.title)).toEqual(['Owner Active DSA']);
    });

    it('returns filtered & paginated history scoped to the authenticated user', async () => {
      await seedMissions();
      const response = await fetch(`${baseUrl}/history?status=completed&category=dsa&limit=1&offset=1`, {
        headers: { Authorization: 'Bearer test-owner' },
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.pagination).toEqual({ total: 2, limit: 1, offset: 1 });
      expect(body.data.map((m: { title: string }) => m.title)).toEqual(['Owner Completed DSA 2']);
    });

    it('handles non-numeric and out-of-range pagination safely', async () => {
      await seedMissions();

      const invalidNums = await fetch(`${baseUrl}/history?limit=abc&offset=xyz`, {
        headers: { Authorization: 'Bearer test-owner' },
      });
      const invalidBody = await invalidNums.json();
      expect(invalidNums.status).toBe(200);
      expect(invalidBody.pagination).toEqual({ total: 3, limit: 20, offset: 0 });

      const clamped = await fetch(`${baseUrl}/history?limit=500&offset=-10`, {
        headers: { Authorization: 'Bearer test-owner' },
      });
      const clampedBody = await clamped.json();
      expect(clamped.status).toBe(200);
      expect(clampedBody.pagination).toEqual({ total: 3, limit: 100, offset: 0 });
    });

    it('rejects invalid category or non-history status filters with 400', async () => {
      const [badCategory, badHistoryCategory, badStatus] = await Promise.all([
        fetch(`${baseUrl}?category=unknown`, { headers: { Authorization: 'Bearer test-owner' } }),
        fetch(`${baseUrl}/history?category=unknown`, { headers: { Authorization: 'Bearer test-owner' } }),
        fetch(`${baseUrl}/history?status=pending`, { headers: { Authorization: 'Bearer test-owner' } }),
      ]);

      expect(badCategory.status).toBe(400);
      expect(badHistoryCategory.status).toBe(400);
      expect(badStatus.status).toBe(400);
    });
  });
});
