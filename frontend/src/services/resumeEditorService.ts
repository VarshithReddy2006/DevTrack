import { z } from 'zod';
import type { BulletEdit } from '@devtrack/ats-core';
import type { ApiResponse } from '../types/api.types';
import api from '../utils/axiosClient';

export const ATS_LIVE_EDITOR_FLAG = 'ats-live-editor';
export const variantRoles = ['Backend', 'Full Stack', 'Frontend', 'Infrastructure', 'Startup', 'Product Engineering'] as const;
export type VariantRole = typeof variantRoles[number];
const id = z.string().min(1);
const identity = z.object({ id: id.optional(), _id: id.optional() });
const hasIdentity = (value: { id?: string; _id?: string }) => Boolean(value.id || value._id);
export const editorBulletSchema = z.object({ section: z.string().min(1).max(50), bulletIndex: z.number().int().min(0).max(999), originalText: z.string().max(1000), editedText: z.string().min(1).max(1000) });
const profile = identity.extend({ targetRole: z.string(), summary: z.string().default(''), selectedSkills: z.array(z.string()), activeVariant: z.string().nullable().optional() }).refine(hasIdentity);
export const editorVariantSchema = identity.extend({
  variantId: id, roleType: z.enum(variantRoles), prioritizedSkills: z.array(z.string()),
  bulletEdits: z.array(editorBulletSchema).max(200).optional(), jobTargetId: z.string().optional(),
  bulletRevisionVersion: z.number().int().nonnegative().optional(),
  atsScore: z.object({ score: z.number().min(0).max(100) }).optional(),
}).refine(hasIdentity);
export type EditorProfile = z.infer<typeof profile>;
export type EditorVariant = z.infer<typeof editorVariantSchema>;
export const variantKey = (value: EditorVariant) => value.id || value._id!;

function read<T>(response: ApiResponse<unknown>, schema: z.ZodType<T>): T {
  if (!response.success) throw new Error(response.message || 'The request failed.');
  const parsed = schema.safeParse(response.data);
  if (!parsed.success) throw new Error('The server returned an unexpected resume response.');
  return parsed.data;
}

export async function loadResumeEditor(signal?: AbortSignal) {
  const [p, v] = await Promise.all([
    api.get<ApiResponse<unknown>>('/resume-intelligence/profile', { signal }),
    api.get<ApiResponse<unknown>>('/resume-intelligence/variants', { signal }),
  ]);
  return { profile: read(p.data, profile), variants: read(v.data, z.array(editorVariantSchema)) };
}

export async function saveResumeVariant(input: { roleType: VariantRole; bulletEdits: BulletEdit[]; clientScore: number; jobTargetId?: string }) {
  const response = await api.post<ApiResponse<unknown>>('/resume-intelligence/variants', input);
  const saved = read(response.data, editorVariantSchema);
  // A disabled server flag intentionally strips v2 fields. Never call that a successful save.
  const content = (edits: readonly BulletEdit[]) => edits.map(edit => [edit.section.toLowerCase(), edit.bulletIndex, edit.editedText]);
  if (JSON.stringify(content(saved.bulletEdits ?? [])) !== JSON.stringify(content(input.bulletEdits))) {
    throw new Error('The server did not confirm the edited bullets. Your draft is still here; check that live editing is enabled before retrying.');
  }
  return saved;
}
