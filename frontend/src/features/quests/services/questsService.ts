import axiosClient from '../../../utils/axiosClient';
import type { ApiResponse } from '../../../types/api.types';

export interface ApiQuest {
  questId: string;
  definitionId: string;
  periodKey: string;
  cadence: 'daily' | 'weekly';
  division: string;
  kind: 'dsa_solve' | 'focus_minutes' | 'revision_review';
  title: string;
  targetCount: number;
  currentCount: number;
  completed: boolean;
  claimed: boolean;
  completedAt: string | null;
  claimedAt: string | null;
  startsAt: string;
  expiresAt: string;
  xpReward: number;
  trophyReward: number;
}

export interface QuestsPayload {
  serverTime: string;
  leagueTrophies: number;
  quests: ApiQuest[];
}

export interface ClaimQuestResult {
  claimed: boolean;
  duplicate: boolean;
  questId: string;
  xpReward: number;
  trophyReward: number;
  totalXp: number;
  leagueTrophies: number;
}

export const questsService = {
  async list(signal?: AbortSignal): Promise<QuestsPayload> {
    const { data } = await axiosClient.get<ApiResponse<QuestsPayload>>('/v2/quests', { signal });
    if (!data.success) throw new Error('Failed to load quests');
    return data.data;
  },

  async claim(questId: string): Promise<ClaimQuestResult> {
    const { data } = await axiosClient.post<ApiResponse<ClaimQuestResult>>(`/v2/quests/${questId}/claim`, {});
    if (!data.success) throw new Error('Failed to claim quest');
    return data.data;
  },
};
