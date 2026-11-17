// ============================================================================
// publicationService.ts - Public portfolio publication API
// ============================================================================
// GET / PUT / DELETE /profile/publication. HTTP-only.
// ============================================================================

import axiosClient from '../utils/axiosClient';
import type { ApiError, ApiResponse } from '../types/api.types';

const PUBLICATION_URL = '/profile/publication';

// Mirrors PUBLIC_PROFILE_SECTIONS in backend/src/db/models/publicProfile.model.ts
export const PUBLICATION_SECTIONS = ['streak', 'dsa', 'github', 'projects', 'activity'] as const;
export type PublicationSection = typeof PUBLICATION_SECTIONS[number];
export type PublicationSections = Record<PublicationSection, boolean>;

export interface PublicationStatus {
  published: boolean;
  /** The live handle. The API only returns it while the profile is published. */
  slug: string | null;
  sections: PublicationSections;
  publicationVersion: number;
  consentVersion: string | null;
  publishedAt: string | null;
}

export interface PublishInput {
  slug: string;
  sections: PublicationSections;
  consentVersion: string;
}

export async function fetchPublication(options?: { signal?: AbortSignal }): Promise<PublicationStatus> {
  const { data } = await axiosClient.get<ApiResponse<PublicationStatus>>(PUBLICATION_URL, { signal: options?.signal });
  return data.data;
}

/** Publishes, or updates the handle and sections of an already published profile. */
export async function publishProfile(input: PublishInput): Promise<PublicationStatus> {
  const { data } = await axiosClient.put<ApiResponse<PublicationStatus>>(PUBLICATION_URL, input);
  return data.data;
}

export async function unpublishProfile(): Promise<PublicationStatus> {
  const { data } = await axiosClient.delete<ApiResponse<PublicationStatus>>(PUBLICATION_URL);
  return data.data;
}

function statusCodeOf(error: unknown): number | undefined {
  return (error as Partial<ApiError> | null)?.statusCode;
}

/** A server without the publication API answers 404 for the route itself. */
export function isPublicationUnavailable(error: unknown): boolean {
  return statusCodeOf(error) === 404;
}

export type PublishFailure =
  | { kind: 'invalid'; message: string }
  | { kind: 'reserved'; message: string }
  | { kind: 'taken'; message: string }
  | { kind: 'other'; message: string };

/** Maps the 400 / 409 answers of PUT /profile/publication onto something the handle field can show. */
export function classifyPublishError(error: unknown): PublishFailure {
  const status = statusCodeOf(error);
  const message = (error as Partial<ApiError> | null)?.message || 'Something went wrong. Please try again.';
  if (status === 400) return { kind: 'invalid', message };
  if (status === 409) return { kind: /reserved/i.test(message) ? 'reserved' : 'taken', message };
  return { kind: 'other', message };
}
