import axiosClient from '../utils/axiosClient';

export type ReviewRating = 'failed' | 'hard' | 'easy';

export interface RevisionCard {
  _id: string;
  problemKey: string;
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
  reviewSeq: number;
  repetitions: number;
  easeFactor: number;
  intervalDays: number;
  dueAt: string;
  lastReviewedAt?: string | null;
  createdAt?: string;
  notes?: string;
}

interface DueCardsResponse {
  success: boolean;
  count: number;
  data: RevisionCard[];
}

interface ReviewResponse {
  success: boolean;
  data: RevisionCard;
}

export interface RevisionPatternStat {
  pattern: string;
  totalCards: number;
  retentionPercentage: number;
  struggleRate: number;
}

export interface RevisionAnalytics {
  asOf: string;
  totalCards: number;
  cardsDueToday: number;
  retentionPercentage: number;
  mastery: { learning: number; reviewing: number; mastered: number };
  patterns: RevisionPatternStat[];
  forecast: Array<{ date: string; dueCards: number }>;
}

interface AnalyticsResponse {
  success: boolean;
  data: RevisionAnalytics;
}

/** The backend caps a single due-cards request at this many cards. */
export const MAX_DUE_CARDS = 50;

export async function fetchRevisionAnalytics(signal?: AbortSignal): Promise<RevisionAnalytics> {
  const { data } = await axiosClient.get<AnalyticsResponse>('/revision/analytics', { signal });
  return data.data;
}

export async function fetchDueCards(limit = 10, signal?: AbortSignal): Promise<RevisionCard[]> {
  const { data } = await axiosClient.get<DueCardsResponse>('/revision/due', {
    params: { limit },
    signal,
  });
  return data.data;
}

export async function submitRevisionReview(
  card: Pick<RevisionCard, '_id' | 'reviewSeq'>,
  rating: ReviewRating,
): Promise<RevisionCard> {
  const { data } = await axiosClient.post<ReviewResponse>(
    `/revision/cards/${encodeURIComponent(card._id)}/reviews`,
    { rating, reviewSeq: card.reviewSeq },
  );
  return data.data;
}
