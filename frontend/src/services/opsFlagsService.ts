// opsFlagsService.ts — admin feature flag endpoints (backend: modules/flags, admin role required).
import type { ApiResponse } from '../types/api.types';
import axiosClient from '../utils/axiosClient';

export interface AdminFeatureFlag {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  rolloutPercent: number;
  allowedUserIds: string[];
  version: number;
  updatedAt: string;
}

export type FlagSettingsChange = Partial<Pick<AdminFeatureFlag, 'name' | 'description' | 'enabled' | 'rolloutPercent' | 'allowedUserIds'>>;

export interface FlagAuditEntry {
  _id: string;
  flagKey: string;
  version: number;
  actorId: string;
  actorUsername: string;
  created: boolean;
  changes: Array<{ field: keyof FlagSettingsChange; from: unknown; to: unknown }>;
  createdAt: string;
}

function unwrap<T>(data: ApiResponse<T>, message: string): T {
  if (!data.success) throw new Error(data.message || message);
  return data.data;
}

/** GET /ops/flags — every stored flag with its version. */
export async function listAdminFlags(signal?: AbortSignal): Promise<AdminFeatureFlag[]> {
  const { data } = await axiosClient.get<ApiResponse<AdminFeatureFlag[]>>('/ops/flags', { signal });
  return unwrap(data, 'Could not load feature flags');
}

/** PATCH /ops/flags/:key — partial update; bumps the flag version and writes an audit entry. */
export async function updateAdminFlag(key: string, changes: FlagSettingsChange): Promise<AdminFeatureFlag> {
  const { data } = await axiosClient.patch<ApiResponse<AdminFeatureFlag>>(`/ops/flags/${encodeURIComponent(key)}`, changes);
  return unwrap(data, 'Could not update the feature flag');
}

/** GET /ops/flags/audit — newest changes first. */
export async function listFlagAudit(limit = 50, signal?: AbortSignal): Promise<FlagAuditEntry[]> {
  const { data } = await axiosClient.get<ApiResponse<FlagAuditEntry[]>>('/ops/flags/audit', { params: { limit }, signal });
  return unwrap(data, 'Could not load the flag audit log');
}
