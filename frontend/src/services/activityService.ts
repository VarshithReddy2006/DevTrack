// src/services/activityService.ts — Activity & Focus API Service
import axiosClient from '../utils/axiosClient';
import type { ApiResponse } from '../types/api.types';

export interface FocusSessionState {
  isActive: boolean;
  status?: 'running' | 'paused' | 'completed' | 'abandoned';
  activeDurationMs?: number;
  lastResumedAt?: string | null;
  startedAt?: string;
  lastHeartbeat?: string;
  duration?: number;
  mode?: string;
}

export const activityService = {
  /**
   * Retrieves all activities including heatmap and feed.
   */
  async getAll(year?: number): Promise<ApiResponse<any>> {
    const params = year ? { year } : {};
    const { data } = await axiosClient.get<ApiResponse<any>>('/activity', { params });
    return data;
  },

  /**
   * Starts a focus session.
   */
  async startFocusSession(duration: number, mode: string): Promise<ApiResponse<FocusSessionState>> {
    const { data } = await axiosClient.post<ApiResponse<FocusSessionState>>('/activity/focus/start', { duration, mode });
    return data;
  },

  /**
   * Sends a heartbeat for the active focus session.
   */
  async heartbeatFocusSession(): Promise<ApiResponse<FocusSessionState>> {
    const { data } = await axiosClient.post<ApiResponse<FocusSessionState>>('/activity/focus/heartbeat');
    return data;
  },

  async pauseFocusSession(): Promise<ApiResponse<FocusSessionState>> {
    const { data } = await axiosClient.post<ApiResponse<FocusSessionState>>('/activity/focus/pause');
    return data;
  },

  async resumeFocusSession(): Promise<ApiResponse<FocusSessionState>> {
    const { data } = await axiosClient.post<ApiResponse<FocusSessionState>>('/activity/focus/resume');
    return data;
  },

  async cancelFocusSession(): Promise<ApiResponse<FocusSessionState>> {
    const { data } = await axiosClient.post<ApiResponse<FocusSessionState>>('/activity/focus/cancel');
    return data;
  },

  /**
   * Stops the active focus session and records it.
   */
  async stopFocusSession(): Promise<ApiResponse<FocusSessionState>> {
    const { data } = await axiosClient.post<ApiResponse<FocusSessionState>>('/activity/focus/stop');
    return data;
  },
};

export default activityService;
