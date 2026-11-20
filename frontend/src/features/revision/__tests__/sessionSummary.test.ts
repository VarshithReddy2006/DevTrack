import { describe, expect, it } from 'vitest';
import { summarizeSession, type SessionReview } from '../sessionSummary';
import type { RevisionCard } from '../../../services/revisionService';

const card: RevisionCard = {
  _id: 'one', problemKey: 'leetcode:one', title: 'One', difficulty: 'easy', tags: [],
  reviewSeq: 0, repetitions: 1, easeFactor: 2.5, intervalDays: 1,
  lastReviewedAt: '2026-11-19T12:00:00Z', dueAt: '2026-11-20T12:00:00Z',
};
const at = Date.parse('2026-11-20T12:00:00Z');
function review(rating: SessionReview['rating'], dueAt = '2026-11-21T12:00:00'): SessionReview {
  return { rating, before: card, after: { ...card, lastReviewedAt: new Date(at).toISOString(), dueAt, intervalDays: 6 }, reviewedAt: at };
}

describe('summarizeSession', () => {
  it('counts supported ratings and groups the returned schedule by local calendar day', () => {
    const summary = summarizeSession([review('failed'), review('hard'), review('easy', '2026-11-26T12:00:00')]);
    expect(summary.total).toBe(3);
    expect(summary.ratings).toEqual({ failed: 1, hard: 1, easy: 1 });
    expect(summary.retention).toEqual({ before: 37, after: 100 });
    expect(summary.expectedXp).toBe(15);
    expect(summary.forecast).toEqual([{ date: '2026-11-21', count: 2 }, { date: '2026-11-26', count: 1 }]);
  });

  it('uses creation time for new cards, matching the analytics estimate', () => {
    const entry = review('easy');
    entry.before = { ...card, lastReviewedAt: null, createdAt: card.lastReviewedAt! };
    expect(summarizeSession([entry]).retention).toEqual({ before: 37, after: 100 });
  });

  it('does not invent retention or schedule data when timestamps are missing or invalid', () => {
    const entry = review('easy', 'invalid');
    entry.before = { ...card, lastReviewedAt: undefined };
    expect(summarizeSession([entry]).retention).toBeNull();
    expect(summarizeSession([entry]).forecast).toEqual([]);
    expect(summarizeSession([])).toMatchObject({ total: 0, expectedXp: 0, retention: null, forecast: [] });
  });
});
