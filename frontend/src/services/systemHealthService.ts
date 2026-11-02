import axiosClient from '../utils/axiosClient';
import { envConfig } from '../utils/envCheck';
import type { ApiResponse } from '../types/api.types';

export interface ApiHealth { status: 'ok' | 'degraded'; degraded: boolean }
export interface PlatformSyncStatus {
  platformName: string;
  isConnected: boolean;
  syncStatus: string;
  lastSyncedAt: string | null;
}

export async function getApiHealth(): Promise<{ health: ApiHealth; latencyMs: number }> {
  const url = new URL('/health', new URL(envConfig.VITE_API_BASE_URL, window.location.origin));
  const started = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (!response.ok) throw new Error(`API health returned ${response.status}`);
  const health: ApiHealth = await response.json();
  if ((health.status !== 'ok' && health.status !== 'degraded') || typeof health.degraded !== 'boolean') {
    throw new Error('Invalid API health response');
  }
  return { health, latencyMs: Math.round(performance.now() - started) };
}

export async function getPlatformSyncStatuses(): Promise<PlatformSyncStatus[]> {
  const response = await axiosClient.get<ApiResponse<PlatformSyncStatus[]>>('/platforms/sync-status', { timeout: 8000 });
  if (!response.data.success || !Array.isArray(response.data.data)) throw new Error('Invalid platform sync response');
  return response.data.data;
}
