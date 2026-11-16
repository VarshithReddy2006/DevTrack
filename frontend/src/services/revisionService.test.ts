import { beforeEach, describe, expect, it, vi } from 'vitest';
import axiosClient from '../utils/axiosClient';
import { fetchDueCards, submitRevisionReview } from './revisionService';

vi.mock('../utils/axiosClient', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

beforeEach(() => {
  vi.mocked(axiosClient.get).mockReset();
  vi.mocked(axiosClient.post).mockReset();
});

describe('revisionService', () => {
  it('passes the selected daily limit to the due endpoint', async () => {
    vi.mocked(axiosClient.get).mockResolvedValue({ data: { success: true, count: 0, data: [] } });
    expect(await fetchDueCards(20)).toEqual([]);
    expect(axiosClient.get).toHaveBeenCalledWith('/revision/due', { params: { limit: 20 }, signal: undefined });
  });

  it('sends the SM-2 rating and exact review sequence', async () => {
    vi.mocked(axiosClient.post).mockResolvedValue({ data: { success: true, data: { _id: 'abc' } } });
    await submitRevisionReview({ _id: 'abc', reviewSeq: 4 }, 'hard');
    expect(axiosClient.post).toHaveBeenCalledWith('/revision/cards/abc/reviews', { rating: 'hard', reviewSeq: 4 });
  });
});
