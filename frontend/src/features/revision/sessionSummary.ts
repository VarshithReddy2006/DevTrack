import type { ReviewRating, RevisionCard } from '../../services/revisionService';

export interface SessionReview {
  rating: ReviewRating;
  before: RevisionCard;
  after: RevisionCard;
  reviewedAt: number;
}

// Use the same interval-based estimate as revision analytics. Compare each card
// immediately before/after its review, rather than counting session duration as decay.
function retention(card: RevisionCard, at: number): number | null {
  const reviewed = Date.parse(card.lastReviewedAt || card.createdAt || '');
  if (!Number.isFinite(reviewed) || !Number.isFinite(card.intervalDays)) return null;
  return 100 * Math.exp(-Math.max(0, (at - reviewed) / 86_400_000) / Math.max(1, card.intervalDays));
}

export function summarizeSession(reviews: SessionReview[]) {
  const ratings: Record<ReviewRating, number> = { failed: 0, hard: 0, easy: 0 };
  const forecast = new Map<string, number>();
  let beforeTotal = 0;
  let afterTotal = 0;
  let hasRetention = reviews.length > 0;
  for (const review of reviews) {
    ratings[review.rating] += 1;
    const before = retention(review.before, review.reviewedAt);
    const after = retention(review.after, review.reviewedAt);
    if (before === null || after === null) hasRetention = false;
    beforeTotal += before ?? 0;
    afterTotal += after ?? 0;
    const due = new Date(review.after.dueAt);
    if (Number.isFinite(due.getTime())) {
      // Local calendar days match the user's review schedule, including DST.
      const key = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
      forecast.set(key, (forecast.get(key) ?? 0) + 1);
    }
  }
  return {
    total: reviews.length,
    ratings,
    retention: hasRetention ? { before: Math.round(beforeTotal / reviews.length), after: Math.round(afterTotal / reviews.length) } : null,
    // The review response does not confirm ledger awards; do not report these as earned.
    expectedXp: reviews.length * 5,
    forecast: [...forecast].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
  };
}

export type SessionSummary = ReturnType<typeof summarizeSession>;
