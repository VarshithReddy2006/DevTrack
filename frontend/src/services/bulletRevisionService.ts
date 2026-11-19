import type { BulletEdit } from '@devtrack/ats-core';
import type { ApiResponse } from '../types/api.types';
import api from '../utils/axiosClient';
import { parseBulletHistory } from '../features/ats/revisionHistory';
import { editorVariantSchema, variantKey, type EditorVariant } from './resumeEditorService';

export type RestoredVariant = EditorVariant & { bulletEdits: BulletEdit[]; bulletRevisionVersion: number; atsScore: { score: number } };
const base = (resumeId: string) => {
  if (!/^[a-f\d]{24}$/i.test(resumeId)) throw new Error('This variant does not have a valid saved resume ID.');
  return `/resume/${encodeURIComponent(resumeId)}/revisions`;
};

export async function loadBulletHistory(resumeId: string, signal?: AbortSignal) {
  const { data } = await api.get<ApiResponse<unknown>>(base(resumeId), { signal });
  if (!data.success) throw new Error(data.message || 'Could not load revision history.');
  return parseBulletHistory(data.data, resumeId);
}

export async function restoreBulletRevision(resumeId: string, version: number, expectedVersion: number): Promise<RestoredVariant> {
  const route = base(resumeId);
  if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(expectedVersion) || expectedVersion < version || expectedVersion >= Number.MAX_SAFE_INTEGER) throw new Error('Choose a retained revision from the latest history.');
  const { data } = await api.post<ApiResponse<unknown>>(`${route}/${version}/restore`, { expectedVersion });
  const result = data.success ? editorVariantSchema.safeParse(data.data) : undefined;
  if (!result?.success || variantKey(result.data) !== resumeId || !result.data.bulletEdits || !result.data.atsScore || result.data.bulletRevisionVersion !== expectedVersion + 1) {
    throw new Error('Could not confirm the restored version. Your draft is still here; refresh history before retrying.');
  }
  return result.data as RestoredVariant;
}
