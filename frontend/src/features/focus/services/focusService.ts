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
  completedSessionsToday: number;
  currentStreak: number;
}

export interface FocusHistoryItem {
  id: string;
  mode: string;
  durationMinutes: number;
  startedAt: string;
  status: 'active' | 'running' | 'paused' | 'completed' | 'abandoned' | 'expired';
  /** Null when the server never decided XP for this session. */
  xpAwarded: number | null;
  xpReason?: string;
}

/** `data` of GET /activity/focus/history. */
interface ApiFocusHistory {
  sessions: Array<{
    id: string;
    mode: string;
    status: FocusHistoryItem['status'];
    startedAt: string;
    actualDurationMinutes: number;
    activeDurationMs: number;
    xpAwarded: number | null;
    xpReason: string | null;
  }>;
}

/** The part of GET /activity/focus/summary the Today card shows. */
interface ApiFocusSummary {
  today: { completedSessions: number; totalDurationMinutes: number };
  currentStreak: number;
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
    const { data } = await axiosClient.get<ApiResponse<ApiFocusHistory>>('/activity/focus/history', {
      params: { limit },
    });
    return data.data.sessions.map((item) => ({
      id: item.id,
      mode: item.mode,
      // A session reaped as stale keeps only its tracked milliseconds.
      durationMinutes: item.actualDurationMinutes || Math.round(item.activeDurationMs / 60000),
      startedAt: item.startedAt,
      status: item.status,
      xpAwarded: item.xpAwarded,
      xpReason: item.xpReason ?? undefined,
    }));
  },

  async getTodaySummary(): Promise<FocusSummary> {
    const { data } = await axiosClient.get<ApiResponse<ApiFocusSummary>>('/activity/focus/summary', {
      params: { days: 1 },
    });
    return {
      todayMinutes: data.data.today.totalDurationMinutes,
      completedSessionsToday: data.data.today.completedSessions,
      currentStreak: data.data.currentStreak,
    };
  },
};
