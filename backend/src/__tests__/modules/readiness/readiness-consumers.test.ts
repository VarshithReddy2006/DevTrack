// Readiness domain consumers: focus / revision / job target events through the inbox runner.
// Uses the replica-set Mongo from vitest.setup.ts, so runConsumer takes its transactional path.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { ProcessedEvent } from '../../../db/models/processedEvent.model.js';
import { ReadinessInput } from '../../../db/models/readinessInput.model.js';
import { ResumeEvidenceClaim } from '../../../db/models/resumeEvidenceClaim.model.js';
import {
  clearConsumerRegistry,
  getQueuesForEvent,
  registerConsumer,
} from '../../../shared/events/consumerRegistry.js';
import {
  createDomainEvent,
  type FocusSessionCompletedPayload,
  type JobTargetParsedPayload,
  type RevisionReviewedPayload,
} from '../../../shared/events/eventContract.js';
import { executeInboxNonTransactional, runConsumer } from '../../../shared/events/runConsumer.js';
import {
  focusSessionCompletedConsumer,
  handleFocusSessionCompleted,
  handleJobTargetParsed,
  handleRevisionReviewed,
  jobTargetParsedConsumer,
  registerReadinessConsumers,
  revisionReviewedConsumer,
} from '../../../modules/readiness/consumers/index.js';
import { summarizeInputs } from '../../../modules/readiness/consumers/readinessInputs.js';
import { processDomainReadinessJob } from '../../../modules/readiness/workers/domainReadiness.worker.js';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const userId = new Types.ObjectId().toString();
const userObjectId = new Types.ObjectId(userId);

const focusEvent = (over: Partial<FocusSessionCompletedPayload> = {}, at = NOW.toISOString()) =>
  createDomainEvent('focus.session.completed', {
    sessionId: new Types.ObjectId().toString(),
    plannedDurationMinutes: 25,
    activeDurationMs: 25 * 60_000,
    coveredHeartbeatIntervals: 25,
    completedAt: at,
    ...over,
  }, { userId });

const reviewEvent = (rating: RevisionReviewedPayload['rating'] = 'easy', at = NOW.toISOString()) =>
  createDomainEvent('revision.reviewed', {
    cardId: new Types.ObjectId().toString(),
    reviewSeq: 1,
    rating,
    reviewedAt: at,
  }, { userId });

const jobEvent = (over: Partial<JobTargetParsedPayload> = {}, timestamp?: string) => {
  const event = createDomainEvent('jobtarget.parsed', {
    jobTargetId: 'jt-1',
    targetRole: 'Backend Engineer',
    company: 'Acme',
    requiredSkills: ['Node.js', 'MongoDB', 'node.js'],
    analysisMode: 'taxonomy_only' as const,
    ...over,
  }, { userId });
  return timestamp ? { ...event, timestamp } : event;
};

const inputs = async () => summarizeInputs(await ReadinessInput.findOne({ userId: userObjectId }), new Date());
const claim = (subjectKey: string) => ResumeEvidenceClaim.findOne({ userId: userObjectId, subjectKey }).lean();

beforeAll(async () => {
  await Promise.all([ProcessedEvent.init(), ReadinessInput.init(), ResumeEvidenceClaim.init()]);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  clearConsumerRegistry();
});

describe('focus.session.completed consumer', () => {
  it('counts a qualified session and upserts the focus:consistency claim', async () => {
    const result = await runConsumer(focusSessionCompletedConsumer, focusEvent());
    expect(result.reason).toBe('executed');

    expect((await inputs()).focus).toEqual({
      qualifiedSessions7d: 1, focusMinutes7d: 25, activeDays7d: 1, consistencyTier: 'emerging',
    });
    const saved = await claim('focus:consistency');
    expect(saved).toMatchObject({
      subjectType: 'focus_consistency',
      source: 'devtrack_focus',
      verificationStatus: 'partial',
      generatedBy: 'deterministic',
    });
    expect(saved?.claimText).toContain('1 qualified focus session (25 min) on 1 of the last 7 days');
    expect(saved?.confidence).toBe(14);
  });

  it('does not double count a redelivered event', async () => {
    const event = focusEvent();
    const first = await runConsumer(focusSessionCompletedConsumer, event);
    const second = await runConsumer(focusSessionCompletedConsumer, event);
    expect([first.reason, second.reason]).toEqual(['executed', 'duplicate_inbox']);

    expect((await inputs()).focus.qualifiedSessions7d).toBe(1);
    expect(await ResumeEvidenceClaim.countDocuments({ userId: userObjectId, subjectKey: 'focus:consistency' })).toBe(1);
  });

  it('also dedups on the standalone (non-transactional) inbox path', async () => {
    const event = focusEvent();
    await executeInboxNonTransactional(focusSessionCompletedConsumer, event);
    const again = await executeInboxNonTransactional(focusSessionCompletedConsumer, event);
    expect(again.reason).toBe('duplicate_inbox');
    expect((await inputs()).focus.qualifiedSessions7d).toBe(1);
  });

  it('counts a session that misses the XP qualification rules but does not qualify it', async () => {
    await runConsumer(focusSessionCompletedConsumer, focusEvent({ plannedDurationMinutes: 10, activeDurationMs: 10 * 60_000 }));
    await runConsumer(focusSessionCompletedConsumer, focusEvent({ coveredHeartbeatIntervals: 3 }));

    const doc = await ReadinessInput.findOne({ userId: userObjectId });
    expect(doc?.focusDays.get('2026-11-17')).toMatchObject({ sessions: 2, qualifiedSessions: 0, qualifiedMinutes: 0 });
    expect((await inputs()).focus.consistencyTier).toBe('none');
    expect(await claim('focus:consistency')).toBeNull();
  });

  it('moves the tier with the number of active days and updates the same claim', async () => {
    for (const age of [0, 1, 2]) await runConsumer(focusSessionCompletedConsumer, focusEvent({}, daysAgo(age)));
    // two sessions on one day are one active day
    await runConsumer(focusSessionCompletedConsumer, focusEvent({}, daysAgo(2)));

    expect((await inputs()).focus).toEqual({
      qualifiedSessions7d: 4, focusMinutes7d: 100, activeDays7d: 3, consistencyTier: 'steady',
    });
    const saved = await claim('focus:consistency');
    expect(saved).toMatchObject({ verificationStatus: 'verified', confidence: 43 });
    expect(await ResumeEvidenceClaim.countDocuments({ userId: userObjectId, subjectType: 'focus_consistency' })).toBe(1);

    for (const age of [3, 4]) await runConsumer(focusSessionCompletedConsumer, focusEvent({}, daysAgo(age)));
    expect((await inputs()).focus.consistencyTier).toBe('strong');
  });

  it('ignores sessions completed before the 7 day window and prunes buckets that aged out', async () => {
    await ReadinessInput.collection.insertOne({
      userId: userObjectId,
      focusDays: { '2026-11-01': { sessions: 3, qualifiedSessions: 3, qualifiedMinutes: 75 } },
      revisionDays: { '2026-11-02': { reviews: 4, lapses: 1 } },
    });

    await runConsumer(focusSessionCompletedConsumer, focusEvent({}, daysAgo(9)));
    expect((await ReadinessInput.findOne({ userId: userObjectId }))?.focusDays.has(daysAgo(9).slice(0, 10))).toBe(false);

    await runConsumer(focusSessionCompletedConsumer, focusEvent());
    const doc = await ReadinessInput.findOne({ userId: userObjectId });
    expect([...doc!.focusDays.keys()]).toEqual(['2026-11-17']);
    expect([...doc!.revisionDays.keys()]).toEqual([]);
  });

  it('drops malformed events without writing anything', async () => {
    await runConsumer(focusSessionCompletedConsumer, focusEvent({ activeDurationMs: Number.NaN }));
    await runConsumer(focusSessionCompletedConsumer, { ...focusEvent(), userId: 'not-an-object-id' });
    expect(await ReadinessInput.countDocuments()).toBe(0);
    expect(await ResumeEvidenceClaim.countDocuments()).toBe(0);
  });

  it('keeps every increment when several events for one user run at the same time', async () => {
    const events = Array.from({ length: 5 }, () => focusEvent());
    await Promise.all(events.map(event => runConsumer(focusSessionCompletedConsumer, event)));
    expect((await inputs()).focus.qualifiedSessions7d).toBe(5);
    expect(await ReadinessInput.countDocuments({ userId: userObjectId })).toBe(1);
  });
});

describe('revision.reviewed consumer', () => {
  it('counts reviews and lapses and upserts the revision:retention claim', async () => {
    await runConsumer(revisionReviewedConsumer, reviewEvent('easy'));
    await runConsumer(revisionReviewedConsumer, reviewEvent('hard'));
    await runConsumer(revisionReviewedConsumer, reviewEvent('failed'));

    expect((await inputs()).revision).toMatchObject({ cardsReviewed7d: 3, lapses7d: 1 });
    const saved = await claim('revision:retention');
    expect(saved).toMatchObject({
      subjectType: 'revision_retention', source: 'devtrack_revision', verificationStatus: 'partial',
    });
    expect(saved?.claimText).toBe('Reviewed 3 spaced repetition cards in the last 7 days with 67% recalled.');
    expect(saved?.confidence).toBe(20);
  });

  it('becomes verified at ten reviews', async () => {
    for (let i = 0; i < 10; i++) await runConsumer(revisionReviewedConsumer, reviewEvent('easy'));
    expect(await claim('revision:retention')).toMatchObject({ verificationStatus: 'verified', confidence: 100 });
  });

  it('does not double count a redelivered event', async () => {
    const event = reviewEvent('failed');
    await runConsumer(revisionReviewedConsumer, event);
    const second = await runConsumer(revisionReviewedConsumer, event);
    expect(second.reason).toBe('duplicate_inbox');
    expect((await inputs()).revision).toMatchObject({ cardsReviewed7d: 1, lapses7d: 1 });
  });

  it('ignores reviews outside the window and unknown ratings', async () => {
    await runConsumer(revisionReviewedConsumer, reviewEvent('easy', daysAgo(8)));
    await runConsumer(revisionReviewedConsumer, reviewEvent('perfect' as never));
    expect(await ReadinessInput.countDocuments()).toBe(0);
    expect(await ResumeEvidenceClaim.countDocuments()).toBe(0);
  });
});

describe('jobtarget.parsed consumer', () => {
  it('records the target and its requirements as readiness context', async () => {
    await runConsumer(jobTargetParsedConsumer, jobEvent());
    const view = await inputs();
    expect(view.jobTargets.activeTargetsCount).toBe(1);
    expect(view.jobTargets.latestTarget).toMatchObject({
      jobTargetId: 'jt-1',
      targetRole: 'Backend Engineer',
      company: 'Acme',
      requiredSkills: ['Node.js', 'MongoDB', 'node.js'],
      analysisMode: 'taxonomy_only',
    });
  });

  it('counts distinct targets once, even when a target is parsed again', async () => {
    await runConsumer(jobTargetParsedConsumer, jobEvent({ jobTargetId: 'jt-1' }));
    await runConsumer(jobTargetParsedConsumer, jobEvent({ jobTargetId: 'jt-1', targetRole: 'Platform Engineer' }));
    await runConsumer(jobTargetParsedConsumer, jobEvent({ jobTargetId: 'jt-2' }));
    const view = await inputs();
    expect(view.jobTargets.activeTargetsCount).toBe(2);
    expect(view.jobTargets.latestTarget?.jobTargetId).toBe('jt-2');
  });

  it('does not let an older parse replace newer context', async () => {
    await runConsumer(jobTargetParsedConsumer, jobEvent({ jobTargetId: 'new', targetRole: 'Staff Engineer' }, daysAgo(0)));
    await runConsumer(jobTargetParsedConsumer, jobEvent({ jobTargetId: 'old', targetRole: 'Intern' }, daysAgo(3)));
    const view = await inputs();
    expect(view.jobTargets.activeTargetsCount).toBe(2);
    expect(view.jobTargets.latestTarget).toMatchObject({ jobTargetId: 'new', targetRole: 'Staff Engineer' });
  });

  it('does not double count a redelivered event', async () => {
    const event = jobEvent();
    await runConsumer(jobTargetParsedConsumer, event);
    expect((await runConsumer(jobTargetParsedConsumer, event)).reason).toBe('duplicate_inbox');
    expect((await inputs()).jobTargets.activeTargetsCount).toBe(1);
  });

  it('drops an event without a job target id', async () => {
    await runConsumer(jobTargetParsedConsumer, jobEvent({ jobTargetId: '' }));
    expect(await ReadinessInput.countDocuments()).toBe(0);
  });
});

describe('registration and the domain-readiness worker', () => {
  it('registers the three consumers on domain-readiness in the xp pool with inbox dedup', () => {
    registerReadinessConsumers();
    registerReadinessConsumers(); // idempotent
    for (const type of ['focus.session.completed', 'revision.reviewed', 'jobtarget.parsed']) {
      expect(getQueuesForEvent(type)).toEqual(['domain-readiness']);
    }
    expect(getQueuesForEvent('xp.awarded')).toEqual([]);
    for (const consumer of [focusSessionCompletedConsumer, revisionReviewedConsumer, jobTargetParsedConsumer]) {
      expect(consumer).toMatchObject({ pool: 'xp', queue: 'domain-readiness', dedup: 'inbox' });
    }
  });

  it('runs only the consumers owned by its queue and stays idempotent on a replayed job', async () => {
    registerReadinessConsumers();
    const otherQueue = vi.fn().mockResolvedValue(undefined);
    registerConsumer('focus.session.completed', { name: 'other', queue: 'something-else', dedup: 'natural', handle: otherQueue });

    const event = focusEvent();
    const first = await processDomainReadinessJob(event);
    const replay = await processDomainReadinessJob(event);

    expect(first.map(r => [r.consumerName, r.reason])).toEqual([['readiness.focusSessionCompleted', 'executed']]);
    expect(replay.map(r => r.reason)).toEqual(['duplicate_inbox']);
    expect(otherQueue).not.toHaveBeenCalled();
    expect((await inputs()).focus.qualifiedSessions7d).toBe(1);
  });

  it('exposes the event handlers for direct use', async () => {
    await handleFocusSessionCompleted(focusEvent());
    await handleRevisionReviewed(reviewEvent());
    await handleJobTargetParsed(jobEvent());
    const view = await inputs();
    expect([view.focus.qualifiedSessions7d, view.revision.cardsReviewed7d, view.jobTargets.activeTargetsCount]).toEqual([1, 1, 1]);
  });
});
