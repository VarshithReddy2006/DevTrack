import axiosClient from '../utils/axiosClient';
import type { ApiResponse } from '../types/api.types';
import type { ContestPlatform, UpcomingContest } from '../features/contests/contestsUtils';

export async function getUpcomingContests(
  platform?: ContestPlatform,
  options?: { signal?: AbortSignal }
): Promise<UpcomingContest[]> {
  const { data } = await axiosClient.get<ApiResponse<UpcomingContest[]>>('/contests/upcoming', {
    params: platform ? { platform } : undefined,
    signal: options?.signal,
  });

  if (!data.success) {
    throw new Error(data.message || 'Unable to load upcoming contests');
  }

  return data.data;
}
