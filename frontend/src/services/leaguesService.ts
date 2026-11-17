import axiosClient from '../utils/axiosClient';
import type { ApiResponse } from '../types/api.types';
import type { CohortStandings } from '../features/leagues/types';

export async function getCurrentStandings(options?: { signal?: AbortSignal }): Promise<CohortStandings> {
  const { data } = await axiosClient.get<ApiResponse<CohortStandings>>('/leagues/current', {
    signal: options?.signal,
  });
  if (!data.success) throw new Error(data.message || 'Unable to load league standings');
  return data.data;
}

export async function setLeagueParticipation(participate: boolean): Promise<{ participating: boolean }> {
  const { data } = await axiosClient.put<ApiResponse<{ participating: boolean }>>('/leagues/participation', {
    participate,
  });
  if (!data.success) throw new Error(data.message || 'Unable to update league participation');
  return data.data;
}
