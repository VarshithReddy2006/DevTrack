// submitReview must leave a revision.reviewed outbox row with or without transactions,
// and a failed inline XP award must be recovered from that row. Models are in-memory
// fakes, so no MongoDB or Redis is needed.
import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({ xp: vi.fn() }));
vi.mock('../../../modules/xp/processor.js', () => ({
  processXpEvent: fixtures.xp, processFocusSessionXp: vi.fn(), reconcileQuestReward: vi.fn(),
}));
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: { publish: vi.fn() } }));
vi.mock('../../../db/transaction.js', () => ({ runInTransaction: (work: (session: object) => unknown) => work({}) }));
vi.mock('../../../modules/quests/questEngine.service.js', async (importOriginal) => ({
  ...await importOriginal<object>(),
  generateUserQuests: vi.fn(),
  ensureQuestsForActivity: vi.fn(),
}));

import { OutboxEvent } from '../../../db/models/outboxEvent.model.js';
import { ProcessedEvent } from '../../../db/models/processedEvent.model.js';
import { RevisionCard } from '../../../db/models/revisionCard.model.js';
import { User } from '../../../db/models/user.model.js';
import { UserQuestProgress } from '../../../db/models/userQuestProgress.model.js';
import { trackQuestEvent } from '../../../modules/quests/questEvents.consumer.js';
import { RevisionService } from '../../../modules/revision/revision.service.js';
import { getConsumersForEvent, clearConsumerRegistry } from '../../../shared/events/consumerRegistry.js';
import { toEnvelope } from '../../../shared/events/outboxRelay.js';
import { runConsumer } from '../../../shared/events/runConsumer.js';
import { createDomainOutboxRelay } from '../../../workers/focus-completion.worker.js';

type Row = Record<string, any>;

const userId = '111111111111111111111111';
const cardId = new Types.ObjectId().toString();
const now = new Date('2026-11-18T12:00:00Z');
const noTransactions = 'Transaction numbers are only allowed on a replica set member or mongos';

let card: Row;
let outbox: Row[];
let quest: Row;

const review = (reviewSeq = 0) => RevisionService.submitReview({ userId, cardId, rating: 'easy', reviewSeq, now });

beforeEach(() => {
  vi.restoreAllMocks();
  clearConsumerRegistry();
  fixtures.xp.mockReset().mockResolvedValue({ awarded: true, xpAwarded: 5, duplicate: false });
  outbox = [];
  card = { _id: cardId, userId, reviewSeq: 0, repetitions: 0, easeFactor: 2.5, intervalDays: 1, dueAt: now };

  vi.spyOn(RevisionCard, 'findOne').mockImplementation((() => {
    const q = { session: () => q, exec: async () => ({ ...card }), lean: async () => ({ ...card }) };
    return q;
  }) as never);
  vi.spyOn(RevisionCard, 'findOneAndUpdate').mockImplementation((async (filter: Row, update: Row) => {
    if (filter.reviewSeq !== card.reviewSeq) return null;
    Object.assign(card, update.$set);
    return { ...card };
  }) as never);

  vi.spyOn(OutboxEvent, 'create').mockImplementation((async (docs: Row[]) => docs.map(doc => {
    const row = { schemaVersion: 1, createdAt: now, ...doc };
    outbox.push(row);
    return row;
  })) as never);
  vi.spyOn(OutboxEvent, 'updateOne').mockImplementation((async (filter: Row, update: Row) => {
    if (outbox.some(row => row.eventId === filter.eventId)) return;
    outbox.push({ createdAt: now, ...update.$setOnInsert });
  }) as never);
  vi.spyOn(OutboxEvent, 'findOne').mockImplementation(((filter: Row) => ({
    lean: async () => outbox.find(row => row.userId === filter.userId && row.type === filter.type
      && row.payload.cardId === filter['payload.cardId']
      && row.payload.reviewSeq === filter['payload.reviewSeq']) ?? null,
  })) as never);

  vi.spyOn(User, 'exists').mockResolvedValue({ _id: userId } as never);
  quest = { _id: new Types.ObjectId(), currentCount: 0, targetCount: 10, completed: false, save: async () => undefined };
  vi.spyOn(UserQuestProgress, 'find').mockReturnValue({ session: async () => [quest] } as never);
  const processed = new Set<string>();
  vi.spyOn(ProcessedEvent, 'exists').mockImplementation(((filter: Row) =>
    ({ session: async () => processed.has(filter.eventId) })) as never);
  vi.spyOn(ProcessedEvent, 'create').mockImplementation((async (docs: Row[]) => {
    for (const doc of docs) processed.add(doc.eventId);
  }) as never);
});

afterEach(() => { vi.restoreAllMocks(); });

/** The three ways submitReview can run against the database. */
function connection(mode: 'transactional' | 'standalone' | 'not connected') {
  vi.spyOn(RevisionCard.db, 'readyState', 'get').mockReturnValue(mode === 'not connected' ? 0 : 1);
  return vi.spyOn(RevisionCard.db, 'transaction').mockImplementation((async (work: (s: object) => unknown) => {
    if (mode === 'standalone') throw new Error(noTransactions);
    return work({ inTransaction: () => true });
  }) as never);
}

describe.each(['transactional', 'standalone', 'not connected'] as const)('revision.reviewed outbox (%s)', mode => {
  beforeEach(() => { connection(mode); });

  it('persists one pending event with the review proof', async () => {
    await review();

    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      type: 'revision.reviewed', aggregateType: 'RevisionCard', aggregateId: cardId, userId, status: 'pending',
      payload: { cardId, reviewSeq: 1, rating: 'easy', reviewedAt: now.toISOString() },
    });
  });

  it('gives quests.progress the proof it needs', async () => {
    await review();

    await trackQuestEvent(toEnvelope(outbox[0] as never), now);

    expect(quest.currentCount).toBe(1);
  });
});

describe('standalone writes', () => {
  beforeEach(() => { connection('standalone'); });

  it('derives the event id from the card and review sequence, usable as a BullMQ job id', async () => {
    await review(0);
    await review(1);

    expect(outbox.map(row => row.eventId)).toEqual([
      `revision-reviewed_${cardId}_1`, `revision-reviewed_${cardId}_2`,
    ]);
    expect(OutboxEvent.create).not.toHaveBeenCalled();
  });

  it('writes nothing for a stale submission', async () => {
    await expect(review(7)).rejects.toThrow('Stale review submission');
    expect(outbox).toEqual([]);
  });

  it('keeps the saved review and still awards XP when the event insert fails', async () => {
    vi.mocked(OutboxEvent.updateOne).mockRejectedValueOnce(new Error('disk full'));

    await expect(review()).resolves.toMatchObject({ reviewSeq: 1 });
    expect(fixtures.xp).toHaveBeenCalledTimes(1);
  });
});

describe('XP recovery from the outbox', () => {
  const xpConsumer = () => getConsumersForEvent('revision.reviewed').find(c => c.name === 'xp.revisionReviewed');

  beforeEach(() => {
    connection('transactional');
    createDomainOutboxRelay(async () => undefined);
  });

  it('registers the XP consumer on domain-readiness, after the existing consumers', () => {
    const consumers = getConsumersForEvent('revision.reviewed');
    expect(consumers.at(-1)).toMatchObject({ name: 'xp.revisionReviewed', queue: 'domain-readiness', dedup: 'natural' });
  });

  it('awards XP later under the same ledger key when the inline call failed', async () => {
    fixtures.xp.mockRejectedValueOnce(new Error('write conflict'));
    await expect(review()).resolves.toMatchObject({ reviewSeq: 1 });

    await runConsumer(xpConsumer()!, toEnvelope(outbox[0] as never));

    expect(fixtures.xp).toHaveBeenCalledTimes(2);
    const [inline, recovered] = fixtures.xp.mock.calls.map(call => call[0]);
    expect(recovered).toMatchObject({ userId, sourceType: 'revision_review', sourceId: `${cardId}:1` });
    expect(recovered.sourceId).toBe(inline.sourceId);
  });

  it('fails the job while XP is still failing so the queue retries it', async () => {
    await review();
    fixtures.xp.mockRejectedValueOnce(new Error('still down'));

    await expect(runConsumer(xpConsumer()!, toEnvelope(outbox[0] as never))).rejects.toThrow('still down');
  });

  it('does not award XP to an erased account', async () => {
    await review();
    vi.mocked(User.exists).mockResolvedValue(null as never);

    await runConsumer(xpConsumer()!, toEnvelope(outbox[0] as never));

    expect(fixtures.xp).toHaveBeenCalledTimes(1);
  });
});
