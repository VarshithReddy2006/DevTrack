// Delayed quest events must count toward the day and week the activity happened in.
// Models are small in-memory fakes with fixed dates, so no MongoDB or Redis is needed.
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/redis/client.js', () => ({ isRedisConfigured: () => false, getRedisClient: vi.fn() }));
vi.mock('../../../db/transaction.js', () => ({ runInTransaction: (work: (session: object) => unknown) => work({}) }));
vi.mock('../../../shared/events/outbox.js', () => ({ writeOutboxEvent: vi.fn() }));

import { FocusSession } from '../../../db/models/focusSession.model.js';
import { LeagueStanding } from '../../../db/models/leagueStanding.model.js';
import { ProcessedEvent } from '../../../db/models/processedEvent.model.js';
import { Quest } from '../../../db/models/quest.model.js';
import { User } from '../../../db/models/user.model.js';
import { UserQuestProgress } from '../../../db/models/userQuestProgress.model.js';
import { generateUserQuests, questDefinitions, questPeriods } from '../../../modules/quests/questEngine.service.js';
import { trackQuestEvent } from '../../../modules/quests/questEvents.consumer.js';

type Row = Record<string, any>;

const userId = '111111111111111111111111';
let progress: Row[];
let standings: Row[];
let completedAt: Date;

/** Supports the operators the quest queries use: equality, $in, $lte and $gt. */
const matches = (row: Row, filter: Row) => Object.entries(filter).every(([key, expected]) => {
  const value = row[key];
  if (expected?.$in) return expected.$in.includes(value);
  if (expected?.$lte) return value <= expected.$lte;
  if (expected?.$gt) return value > expected.$gt;
  return String(value) === String(expected);
});

beforeEach(() => {
  vi.restoreAllMocks();
  progress = [];
  standings = [];

  vi.spyOn(User, 'exists').mockResolvedValue({ _id: userId } as never);
  vi.spyOn(FocusSession, 'findOne').mockImplementation(((filter: Row) => ({
    lean: async () => ({
      _id: filter._id, completedAt, plannedDurationMinutes: 30,
      activeDurationMs: 30 * 60_000, coveredHeartbeatIntervals: 30,
    }),
  })) as never);

  const byWeek = (a: Row, b: Row) => b.weekKey.localeCompare(a.weekKey);
  vi.spyOn(LeagueStanding, 'findOne').mockImplementation(((filter: Row) => {
    const found = () => standings.filter(row => matches(row, filter)).sort(byWeek)[0] ?? null;
    return { lean: async () => found(), sort: () => ({ lean: async () => found() }) };
  }) as never);
  vi.spyOn(LeagueStanding, 'exists').mockImplementation(
    (async (filter: Row) => standings.find(row => matches(row, filter)) ?? null) as never,
  );

  vi.spyOn(Quest, 'findOneAndUpdate').mockImplementation(((filter: Row, update: Row) => ({
    lean: async () => ({ _id: new Types.ObjectId(), ...update.$setOnInsert, key: filter.key }),
  })) as never);

  vi.spyOn(UserQuestProgress, 'find').mockImplementation(((filter: Row) => {
    const rows = async () => progress.filter(row => matches(row, filter));
    return { sort: () => ({ lean: rows }), session: rows };
  }) as never);
  vi.spyOn(UserQuestProgress, 'updateOne').mockImplementation((async (filter: Row, update: Row) => {
    if (progress.some(row => matches(row, filter))) return;
    progress.push({
      _id: new Types.ObjectId(), ...update.$setOnInsert, userId, currentCount: 0, completed: false,
      save: async () => undefined,
    });
  }) as never);

  const processed = new Set<string>();
  vi.spyOn(ProcessedEvent, 'exists').mockImplementation(((filter: Row) =>
    ({ session: async () => processed.has(filter.eventId) })) as never);
  vi.spyOn(ProcessedEvent, 'create').mockImplementation((async (docs: Row[]) => {
    for (const doc of docs) processed.add(doc.eventId);
  }) as never);
});

afterEach(() => { vi.restoreAllMocks(); });

function standing(weekKey: string, division: string, status: 'active' | 'finalized' = 'active') {
  standings.push({ userId, weekKey, division, status, nextDivision: status === 'finalized' ? division : null });
}

/** Inserts the quest rows of the periods containing `at`, as the scheduled sweep would have. */
function allocated(at: Date) {
  const periods = questPeriods(at);
  for (const definition of questDefinitions('bronze')) {
    progress.push({
      _id: new Types.ObjectId(), ...definition, ...periods[definition.cadence], userId,
      currentCount: 0, completed: false, save: async () => undefined,
    });
  }
}

function focusDone(at: string, processedAt: string) {
  completedAt = new Date(at);
  return trackQuestEvent({
    id: randomUUID(), type: 'focus.session.completed', schemaVersion: 1, userId, timestamp: at,
    correlationId: randomUUID(), causationId: randomUUID(), payload: { sessionId: new Types.ObjectId().toString() },
  }, new Date(processedAt));
}

const focusCounts = () => Object.fromEntries(
  progress.filter(row => row.kind === 'focus_minutes').map(row => [row.periodKey, row.currentCount]),
);
const periodKeys = () => [...new Set(progress.map(row => row.periodKey))].sort();

describe('quest events processed after their period', () => {
  it('credits the previous day for a 23:59:50 activity processed 15 seconds later', async () => {
    await focusDone('2026-11-18T23:59:50Z', '2026-11-19T00:00:05Z');

    expect(focusCounts()).toEqual({ 'daily:2026-11-18': 30, 'weekly:2026-11-15': 30 });
    expect(periodKeys()).toEqual(['daily:2026-11-18', 'weekly:2026-11-15']);
  });

  it('credits Sunday for a delayed activity handled early on Monday', async () => {
    await focusDone('2026-11-22T23:59:55Z', '2026-11-23T00:00:05Z');

    expect(focusCounts()).toEqual({ 'daily:2026-11-22': 30, 'weekly:2026-11-22': 30 });
  });

  it('credits the finished week, in its own division, while its rollover is pending', async () => {
    standing('2026-11-15', 'silver');

    await focusDone('2026-11-21T23:59:50Z', '2026-11-22T00:00:05Z');

    expect(focusCounts()).toEqual({ 'daily:2026-11-21': 30, 'weekly:2026-11-15': 30 });
    expect(progress.every(row => row.division === 'silver')).toBe(true);
  });

  it('does not block an earlier week on an older week that never rolled over', async () => {
    standing('2026-11-08', 'silver');

    await expect(focusDone('2026-11-21T23:59:50Z', '2026-11-22T00:00:05Z')).resolves.toBeUndefined();
    expect(focusCounts()).toEqual({ 'daily:2026-11-21': 30, 'weekly:2026-11-15': 30 });
  });

  it('still asks for a retry when the activity belongs to the week awaiting rollover', async () => {
    standing('2026-11-15', 'silver');

    await expect(focusDone('2026-11-22T00:00:01Z', '2026-11-22T00:00:05Z'))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(progress).toEqual([]);
  });

  it('keeps the 503 for direct generation of the pending week', async () => {
    standing('2026-11-15', 'silver');

    await expect(generateUserQuests(userId, new Date('2026-11-22T00:00:05Z')))
      .rejects.toMatchObject({ statusCode: 503 });
  });

  it('credits existing rows of an old week without a rollover error or new rows', async () => {
    standing('2026-11-15', 'silver');
    allocated(new Date('2026-11-10T12:00:00Z'));

    await focusDone('2026-11-10T12:00:00Z', '2026-11-22T00:00:05Z');

    expect(focusCounts()).toEqual({ 'daily:2026-11-10': 30, 'weekly:2026-11-08': 30 });
    expect(progress).toHaveLength(5);
  });

  it('creates nothing for a period that closed longer than the grace window ago', async () => {
    standing('2026-11-15', 'silver');

    await expect(focusDone('2026-11-10T12:00:00Z', '2026-11-22T00:00:05Z')).resolves.toBeUndefined();
    expect(progress).toEqual([]);
  });

  it('creates only the weekly set once the day is past the grace window', async () => {
    await focusDone('2026-11-17T12:00:00Z', '2026-11-19T00:00:00Z');

    expect(periodKeys()).toEqual(['weekly:2026-11-15']);
    expect(focusCounts()).toEqual({ 'weekly:2026-11-15': 30 });
  });

  it('still creates the day just inside the grace window', async () => {
    await focusDone('2026-11-17T12:00:00Z', '2026-11-18T23:59:59.999Z');

    expect(focusCounts()).toEqual({ 'daily:2026-11-17': 30, 'weekly:2026-11-15': 30 });
  });
});
