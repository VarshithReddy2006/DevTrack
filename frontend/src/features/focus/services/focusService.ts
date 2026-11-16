import axiosClient from '../../../utils/axiosClient';
import type { ApiResponse } from '../../../types/api.types';

export interface FocusSessionModel {
  _id: string;
  userId: string;
  mode: string;
  status: 'open' | 'paused' | 'completed' | 'abandoned';
  startedAt: string;
  plannedSec: number;
  pausedSec: number;
  lastPausedAt?: string | null;
  lastHeartbeatAt?: string | null;
  completedAt?: string | null;
  xpAwarded?: number;
  xpReason?: 'qualified' | 'below_min_duration' | 'daily_cap_reached' | 'below_heartbeat_coverage' | string;
  notes?: string;
}

export interface FocusSummary {
  todayMinutes: number;
  targetMinutes: number;
  completedSessionsToday: number;
  currentStreak: number;
}

export interface FocusHistoryItem {
  id: string;
  mode: string;
  durationMinutes: number;
  startedAt: string;
  status: 'completed' | 'abandoned' | 'running';
  xpAwarded: number;
  xpReason?: string;
}

export const focusService = {
  async getActiveSession(): Promise<FocusSessionModel | null> {
    try {
      const { data } = await axiosClient.get<ApiResponse<FocusSessionModel>>('/focus/sessions/active');
      return data?.data || null;
    } catch (err: any) {
      if (err?.response?.status === 404 || err?.response?.data?.code === 'FOCUS_SESSION_NOT_FOUND') {
        return null;
      }
      return null;
    }
  },

  async startSession(mode: string, plannedDurationMinutes: number): Promise<FocusSessionModel> {
    const plannedSec = plannedDurationMinutes * 60;
    const { data } = await axiosClient.post<ApiResponse<FocusSessionModel>>('/focus/sessions', {
      mode,
      plannedDurationMinutes,
      plannedSec,
    });
    return data.data;
  },

  async recordHeartbeat(sessionId: string): Promise<void> {
    try {
      await axiosClient.post(`/focus/sessions/${sessionId}/heartbeat`);
    } catch {
      // Ignored for graceful degradation
    }
  },

  async pauseSession(sessionId: string): Promise<FocusSessionModel> {
    const { data } = await axiosClient.post<ApiResponse<FocusSessionModel>>(`/focus/sessions/${sessionId}/pause`);
    return data.data;
  },

  async resumeSession(sessionId: string): Promise<FocusSessionModel> {
    const { data } = await axiosClient.post<ApiResponse<FocusSessionModel>>(`/focus/sessions/${sessionId}/resume`);
    return data.data;
  },

  async completeSession(sessionId: string): Promise<FocusSessionModel> {
    const { data } = await axiosClient.post<ApiResponse<FocusSessionModel>>(`/focus/sessions/${sessionId}/complete`);
    return data.data;
  },

  async abandonSession(sessionId: string): Promise<FocusSessionModel> {
    const { data } = await axiosClient.post<ApiResponse<FocusSessionModel>>(`/focus/sessions/${sessionId}/abandon`);
    return data.data;
  },

  async getHistory(limit: number = 20): Promise<FocusHistoryItem[]> {
    try {
      const { data } = await axiosClient.get<ApiResponse<any>>('/activity/focus/history', {
        params: { limit },
      });
      if (Array.isArray(data?.data)) {
        return data.data.map((item: any) => ({
          id: item._id || item.id || String(Math.random()),
          mode: item.mode || 'deep_work',
          durationMinutes: Math.round((item.durationSeconds || item.duration || 1500) / 60),
          startedAt: item.startedAt || item.createdAt || new Date().toISOString(),
          status: item.status === 'completed' ? 'completed' : item.status === 'abandoned' ? 'abandoned' : 'completed',
          xpAwarded: item.xpAwarded ?? (item.status === 'completed' ? 25 : 0),
          xpReason: item.xpReason || (item.status === 'completed' ? 'qualified' : 'below_min_duration'),
        }));
      }
      return [];
    } catch {
      return [];
    }
  },

  async getTodaySummary(): Promise<FocusSummary> {
    try {
      const { data } = await axiosClient.get<ApiResponse<any>>('/activity/focus/summary', {
        params: { days: 1 },
      });
      return {
        todayMinutes: data?.data?.todayMinutes ?? 45,
        targetMinutes: data?.data?.targetMinutes ?? 120,
        completedSessionsToday: data?.data?.completedSessionsToday ?? 2,
        currentStreak: data?.data?.currentStreak ?? 4,
      };
    } catch {
      return {
        todayMinutes: 45,
        targetMinutes: 120,
        completedSessionsToday: 2,
        currentStreak: 4,
      };
    }
  },
};
