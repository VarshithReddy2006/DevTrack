import { describe, expect, it, vi } from 'vitest';
import { CareerIntent } from '../../../../db/models/careerIntent.model.js';
import { CareerIntentService } from '../CareerIntentService.js';

describe('CareerIntentService Concurrency & Error Recovery', () => {
  it('recovers from E11000 duplicate key error during concurrent initial creations', async () => {
    const userId = 'concurrent-create-user';
    const input1 = {
      userId,
      dreamRole: 'Backend Engineer',
      targetPackage: '20 LPA',
      currentStrongestSkills: ['Node.js'],
    };
    const input2 = {
      userId,
      dreamRole: 'Full Stack Engineer',
      targetPackage: '25 LPA',
      currentStrongestSkills: ['React', 'Node.js'],
    };

    // Run both creations concurrently
    const [res1, res2] = await Promise.all([
      CareerIntentService.upsertCareerIntent(input1),
      CareerIntentService.upsertCareerIntent(input2),
    ]);

    expect(res1).toBeDefined();
    expect(res2).toBeDefined();

    const count = await CareerIntent.countDocuments({ userId });
    expect(count).toBe(1);

    const stored = await CareerIntent.findOne({ userId });
    expect(stored).not.toBeNull();
    expect(['Backend Engineer', 'Full Stack Engineer']).toContain(stored!.dreamRole);
  });

  it('retries and succeeds when VersionError is encountered during concurrent updates', async () => {
    const userId = 'version-conflict-user';
    await CareerIntentService.upsertCareerIntent({
      userId,
      dreamRole: 'Backend Engineer',
      targetPackage: '15 LPA',
      currentStrongestSkills: ['Java'],
    });

    // Simulate version conflict: spy on save to reject once with VersionError then restore
    const originalSave = CareerIntent.prototype.save;
    let failedOnce = false;

    vi.spyOn(CareerIntent.prototype, 'save').mockImplementation(async function (this: any, ...args: any[]) {
      if (!failedOnce && this.userId === userId) {
        failedOnce = true;
        const err = new Error('No matching document found for id version 0 modifiedPaths dreamRole');
        err.name = 'VersionError';
        throw err;
      }
      return originalSave.apply(this, args);
    });

    const result = await CareerIntentService.upsertCareerIntent({
      userId,
      dreamRole: 'Staff Backend Engineer',
      targetPackage: '50 LPA',
      currentStrongestSkills: ['Go', 'Kubernetes'],
    });

    expect(failedOnce).toBe(true);
    expect(result.dreamRole).toBe('Staff Backend Engineer');

    const updated = await CareerIntent.findOne({ userId });
    expect(updated?.dreamRole).toBe('Staff Backend Engineer');
    expect(updated?.targetPackage).toBe('50 LPA');

    vi.restoreAllMocks();
  });

  it('deduplicates identical history entries pushed within short intervals', async () => {
    const userId = 'history-dedup-user';
    await CareerIntentService.upsertCareerIntent({
      userId,
      dreamRole: 'Backend Engineer',
      targetPackage: '20 LPA',
    });

    // Change to frontend
    await CareerIntentService.upsertCareerIntent({
      userId,
      dreamRole: 'Frontend Engineer',
      targetPackage: '20 LPA',
    });

    // Immediately trigger another upsert with frontend and same package (e.g. retry or rapid submit)
    await CareerIntentService.upsertCareerIntent({
      userId,
      dreamRole: 'Frontend Engineer',
      targetPackage: '20 LPA',
      weeklyHours: 15,
    });

    const intent = await CareerIntent.findOne({ userId });
    expect(intent?.history).toHaveLength(1);
    expect(intent?.history[0].role).toBe('Backend Engineer');
  });
});
