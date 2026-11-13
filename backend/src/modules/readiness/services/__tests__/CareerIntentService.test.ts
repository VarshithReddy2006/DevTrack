import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { CareerIntent } from '../../../../db/models/careerIntent.model.js';
import type { AuthenticatedRequest } from '../../../../middleware/auth.js';
import { ReadinessController } from '../../readiness.controller.js';
import { CareerIntentService } from '../CareerIntentService.js';

const dayMs = 24 * 60 * 60 * 1000;
const input = {
  userId: 'career-intent-user',
  dreamRole: 'Backend Engineer',
  targetPackage: '20 LPA',
  currentStrongestSkills: ['PostgreSQL'],
  desiredSkills: ['Redis'],
  timelineGoals: '6 months',
};

describe('CareerIntentService', () => {
  it('uses relevant skills for a stable intent and omits points for unrelated skills', () => {
    expect(CareerIntentService.calculateConfidenceState(input)).toBe('high');
    expect(CareerIntentService.calculateConfidenceState({
      ...input,
      currentStrongestSkills: ['Photoshop'],
      desiredSkills: ['Illustrator'],
    })).toBe('medium');
  });

  it('decays stored confidence on read and restores it when the user reconfirms the same intent', async () => {
    const staleDate = new Date(Date.now() - 91 * dayMs);
    const stored = await CareerIntent.create({
      ...input, createdAt: staleDate, updatedAt: staleDate, confidenceState: 'high',
    });

    const staleIntent = await CareerIntentService.getCareerIntent(input.userId);
    expect(staleIntent?.confidenceState).toBe('medium');
    expect(staleIntent?.updatedAt).toEqual(staleDate);
    expect((await CareerIntent.findById(stored.id))?.confidenceState).toBe('high');

    const confirmed = await CareerIntentService.upsertCareerIntent(input);
    expect(confirmed.confidenceState).toBe('high');
    expect(confirmed.updatedAt.getTime()).toBeGreaterThan(staleDate.getTime());
    expect(confirmed.history).toHaveLength(0);
    expect((await CareerIntentService.getCareerIntent(input.userId))?.confidenceState).toBe('high');
  });

  it('dampens repeated role switches until they age out and ignores package-only changes and role aliases', async () => {
    await CareerIntentService.upsertCareerIntent({ ...input, dreamRole: 'Frontend Engineer' });
    await CareerIntentService.upsertCareerIntent({ ...input, dreamRole: 'DevOps Engineer' });
    await CareerIntentService.upsertCareerIntent({ ...input, dreamRole: 'Backend Engineer' });
    await CareerIntentService.upsertCareerIntent({ ...input, dreamRole: ' backend developer ', targetPackage: '21 LPA' });
    const stable = await CareerIntentService.upsertCareerIntent({ ...input, targetPackage: '22 LPA' });
    expect(stable.confidenceState).toBe('high');

    await CareerIntentService.upsertCareerIntent({ ...input, dreamRole: 'Frontend Engineer' });
    const volatile = await CareerIntentService.upsertCareerIntent(input);
    expect(volatile.confidenceState).toBe('medium');
    expect((await CareerIntentService.getCareerIntent(input.userId))?.confidenceState).toBe('medium');

    const agedHistory = volatile.history.map(entry => ({
      role: entry.role,
      package: entry.package,
      recordedAt: new Date(Date.now() - 31 * dayMs),
    }));
    await CareerIntent.updateOne({ userId: input.userId }, { history: agedHistory });
    expect((await CareerIntentService.getCareerIntent(input.userId))?.confidenceState).toBe('high');
  });

  it('tracks intent updates through the readiness controller', async () => {
    const json = vi.fn();
    const response = { json } as unknown as Response;
    const request = (body: object) => ({
      user: { id: input.userId },
      body,
    }) as AuthenticatedRequest;

    await ReadinessController.setCareerIntent(request({
      ...input,
      dreamRole: undefined,
      targetRole: 'Backend Developer',
      goal: 'First job',
      experienceLevel: 'Beginner',
      weeklyHours: '8',
    }), response);
    expect(json).toHaveBeenLastCalledWith({
      success: true,
      data: expect.objectContaining({
        dreamRole: 'Backend Developer', confidenceState: 'high', goal: 'First job',
        experienceLevel: 'Beginner', weeklyHours: 8,
      }),
    });

    await ReadinessController.setCareerIntent(request({
      ...input, dreamRole: 'Frontend Developer', currentStrongestSkills: ['React'], desiredSkills: ['CSS'],
    }), response);
    const intent = await CareerIntent.findOne({ userId: input.userId });
    expect(intent?.confidenceState).toBe('high');
    expect(intent?.history).toHaveLength(1);
    expect(intent?.history[0].role).toBe('Backend Developer');
  });
});
