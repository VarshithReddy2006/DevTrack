// src/shared/search/documentMappers.ts
// Canonical document mapping and privacy/eligibility gating for DevTrack search indexing.
// Maps raw Mongoose/MongoDB documents into vendor-neutral SearchDocument structures.

import type { SearchDocument, SearchEntityType } from './searchClient.types.js';

// ============================================================================
// Specialized Search Document Types
// ============================================================================

export interface DsaSearchMetadata {
  [key: string]: unknown;
  platform: string;
  difficulty: 'easy' | 'medium' | 'hard';
  category: string;
  tags: string[];
  submissionCount: number;
  url: string;
  isFavorite: boolean;
}

export interface DsaSearchDocument extends SearchDocument {
  type: 'dsa';
  metadata: DsaSearchMetadata;
}

export interface ProfileSearchMetadata {
  [key: string]: unknown;
  username: string;
  slug: string;
  displayName: string;
  avatarUrl: string | null;
  level: number;
  levelName: string;
  theme: string;
}

export interface ProfileSearchDocument extends SearchDocument {
  type: 'profile';
  metadata: ProfileSearchMetadata;
}

export interface ProjectSearchMetadata {
  [key: string]: unknown;
  repoFullName: string;
  repoUrl: string;
  primaryLanguage: string;
  stars: number;
  forks: number;
  totalCommitCount: number;
  techStack: string[];
}

export interface ProjectSearchDocument extends SearchDocument {
  type: 'project';
  metadata: ProjectSearchMetadata;
}

export type TypedSearchDocument =
  | DsaSearchDocument
  | ProfileSearchDocument
  | ProjectSearchDocument;

// ============================================================================
// Helper Utilities (Non-mutating, safe parsing)
// ============================================================================

/**
 * Safely extracts a deterministic string identifier from a MongoDB document or plain object.
 * Returns null if no valid, non-empty identifier is present.
 */
export function extractDocumentId(doc: unknown): string | null {
  if (!doc || typeof doc !== 'object') return null;
  const record = doc as Record<string, unknown>;

  if (record._id != null) {
    const idVal = record._id;
    if (typeof idVal === 'object' && idVal !== null && 'toString' in idVal && typeof idVal.toString === 'function') {
      const str = idVal.toString();
      if (typeof str === 'string' && str.trim().length > 0 && str !== '[object Object]') {
        return str.trim();
      }
    }
    const str = String(idVal).trim();
    if (str.length > 0 && str !== '[object Object]') return str;
  }

  if (typeof record.id === 'string' && record.id.trim().length > 0) {
    return record.id.trim();
  }

  return null;
}

/**
 * Safely parses and normalizes an updatedAt timestamp to a Unix epoch millisecond number.
 */
function parseUpdatedAt(val: unknown): number {
  if (val instanceof Date) {
    const time = val.getTime();
    return Number.isFinite(time) ? time : Date.now();
  }
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
    return Math.floor(val);
  }
  if (typeof val === 'string' && val.trim().length > 0) {
    const time = new Date(val).getTime();
    if (Number.isFinite(time)) return time;
  }
  return Date.now();
}

/**
 * Normalizes an array of string tags: filters non-strings, trims, lowercases, and deduplicates.
 */
function normalizeTags(rawTags: unknown): string[] {
  if (!Array.isArray(rawTags)) return [];
  const set = new Set<string>();
  for (const item of rawTags) {
    if (typeof item === 'string') {
      const trimmed = item.trim().toLowerCase();
      if (trimmed.length > 0) {
        set.add(trimmed);
      }
    }
  }
  return Array.from(set);
}

// ============================================================================
// Eligibility Gates
// ============================================================================

/**
 * Checks whether a DsaProblem record is eligible for search indexing.
 * Requires:
 * - Non-null object with a valid ID
 * - Valid non-empty string title
 */
export function isDsaProblemEligible(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const record = doc as Record<string, unknown>;

  const id = extractDocumentId(record);
  if (!id) return false;

  if (typeof record.title !== 'string' || record.title.trim().length === 0) {
    return false;
  }

  return true;
}

/**
 * Checks whether a PublicProfile record is eligible for search indexing.
 * STRICT PRIVACY GATE:
 * - published === true (explicit opt-in)
 * - visibility === 'public'
 * - isIndexable === true
 * - Non-empty username
 * - Valid document ID
 */
export function isPublicProfileEligible(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const record = doc as Record<string, unknown>;

  // Strict boolean and string checks - do not accept truthy coercions
  if (record.published !== true) return false;
  if (record.visibility !== 'public') return false;
  if (record.isIndexable !== true) return false;

  const id = extractDocumentId(record);
  if (!id) return false;

  if (typeof record.username !== 'string' || record.username.trim().length === 0) {
    return false;
  }

  return true;
}

/**
 * Checks whether a VerifiedProject record is eligible for search indexing.
 * STRICT VERIFICATION GATE:
 * - verification.status === 'verified'
 * - Non-empty repoFullName
 * - Valid document ID
 */
export function isVerifiedProjectEligible(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const record = doc as Record<string, unknown>;

  const verification = record.verification as Record<string, unknown> | undefined;
  if (!verification || typeof verification !== 'object') return false;
  if (verification.status !== 'verified') return false;

  const id = extractDocumentId(record);
  if (!id) return false;

  if (typeof record.repoFullName !== 'string' || record.repoFullName.trim().length === 0) {
    return false;
  }

  return true;
}

// ============================================================================
// Document Mappers
// ============================================================================

/**
 * Maps a canonical DsaProblem document to a DsaSearchDocument.
 * Returns null if the problem is ineligible.
 *
 * Privacy / Security Invariants:
 * - Strips `userId` (prevents linking problems to individual users in global search)
 * - Strips `notes` (prevents candidate personal scratchpad/notes from leaking)
 * - Strips `timeTaken` (private user telemetry)
 * - Explicit field mapping: never spreads raw input object
 */
export function mapDsaProblemToSearch(doc: unknown): DsaSearchDocument | null {
  if (!isDsaProblemEligible(doc)) return null;
  const record = doc as Record<string, unknown>;
  const id = extractDocumentId(record)!;

  const rawTitle = typeof record.title === 'string' ? record.title.trim() : '';
  const rawCategory = typeof record.category === 'string' && record.category.trim().length > 0
    ? record.category.trim()
    : 'General';

  const rawPlatform = typeof record.platform === 'string' && record.platform.trim().length > 0
    ? record.platform.trim().toLowerCase()
    : 'custom';

  const difficultyVal = typeof record.difficulty === 'string' ? record.difficulty.trim().toLowerCase() : '';
  const difficulty: 'easy' | 'medium' | 'hard' =
    difficultyVal === 'easy' || difficultyVal === 'medium' || difficultyVal === 'hard'
      ? difficultyVal
      : 'medium';

  const tags = normalizeTags(record.tags);
  const rawUrl = typeof record.url === 'string' ? record.url.trim() : '';
  const submissionCount = typeof record.submissionCount === 'number' && Number.isFinite(record.submissionCount) && record.submissionCount >= 0
    ? Math.floor(record.submissionCount)
    : 0;

  const isFavorite = record.isFavorite === true;
  const updatedAt = parseUpdatedAt(record.updatedAt);

  return {
    id,
    type: 'dsa',
    title: rawTitle,
    description: rawCategory,
    tags,
    metadata: {
      platform: rawPlatform,
      difficulty,
      category: rawCategory,
      tags,
      submissionCount,
      url: rawUrl,
      isFavorite,
    },
    updatedAt,
  };
}

/**
 * Maps a canonical PublicProfile document to a ProfileSearchDocument.
 * Returns null if the profile fails the strict privacy gate.
 *
 * Privacy / Security Invariants:
 * - Strict gating: published === true && visibility === 'public' && isIndexable === true
 * - Strips `userId` (internal MongoDB identifier)
 * - Strips `antiGaming` (fraud/suspicion scores, flags)
 * - Strips `publication.consentVersion`
 * - Strips `stats` (recruiterViews, internal metrics)
 * - Strips `sections` (internal UI flags)
 * - Explicit field mapping: never spreads raw input object
 */
export function mapPublicProfileToSearch(doc: unknown): ProfileSearchDocument | null {
  if (!isPublicProfileEligible(doc)) return null;
  const record = doc as Record<string, unknown>;
  const id = extractDocumentId(record)!;

  const username = (record.username as string).trim();
  const rawSlug = typeof record.slug === 'string' && record.slug.trim().length > 0
    ? record.slug.trim().toLowerCase()
    : username.toLowerCase();

  const snapshot = (record.snapshot && typeof record.snapshot === 'object' ? record.snapshot : {}) as Record<string, unknown>;
  const identity = (snapshot.identity && typeof snapshot.identity === 'object' ? snapshot.identity : {}) as Record<string, unknown>;
  const settings = (record.settings && typeof record.settings === 'object' ? record.settings : {}) as Record<string, unknown>;

  const displayName = typeof identity.displayName === 'string' && identity.displayName.trim().length > 0
    ? identity.displayName.trim()
    : username;

  const avatarUrl = typeof identity.avatarUrl === 'string' && identity.avatarUrl.trim().length > 0
    ? identity.avatarUrl.trim()
    : null;

  const level = typeof identity.level === 'number' && Number.isFinite(identity.level) && identity.level > 0
    ? Math.floor(identity.level)
    : 1;

  const levelName = typeof identity.levelName === 'string' && identity.levelName.trim().length > 0
    ? identity.levelName.trim()
    : 'Novice';

  const theme = typeof settings.theme === 'string' && settings.theme.trim().length > 0
    ? settings.theme.trim()
    : 'modern-dark';

  const tags: string[] = [];
  if (levelName) tags.push(levelName.toLowerCase());

  const github = (snapshot.github && typeof snapshot.github === 'object' ? snapshot.github : {}) as Record<string, unknown>;
  if (Array.isArray(github.primaryLanguages)) {
    for (const lang of github.primaryLanguages) {
      if (typeof lang === 'string' && lang.trim().length > 0) {
        const normalized = lang.trim().toLowerCase();
        if (!tags.includes(normalized)) {
          tags.push(normalized);
        }
      }
    }
  }

  const updatedAt = parseUpdatedAt(record.updatedAt);

  return {
    id,
    type: 'profile',
    title: username,
    description: displayName,
    tags,
    metadata: {
      username,
      slug: rawSlug,
      displayName,
      avatarUrl,
      level,
      levelName,
      theme,
    },
    updatedAt,
  };
}

/**
 * Maps a canonical VerifiedProject document to a ProjectSearchDocument.
 * Returns null if the project is not verified.
 *
 * Privacy / Security Invariants:
 * - Strict gating: verification.status === 'verified'
 * - Strips `userId` and `projectId` (internal IDs)
 * - Strips `verification.rejectionReason` and `verification.checks` (internal audit state)
 * - Strips `antiGaming` (suspicion scores, commit farming flags)
 * - Strips `provenance` (account IDs, internal file paths)
 * - Explicit field mapping: never spreads raw input object
 */
export function mapVerifiedProjectToSearch(doc: unknown): ProjectSearchDocument | null {
  if (!isVerifiedProjectEligible(doc)) return null;
  const record = doc as Record<string, unknown>;
  const id = extractDocumentId(record)!;

  const repoFullName = (record.repoFullName as string).trim();
  const repoUrl = typeof record.repoUrl === 'string' ? record.repoUrl.trim() : '';

  const metrics = (record.metrics && typeof record.metrics === 'object' ? record.metrics : {}) as Record<string, unknown>;
  const primaryLanguage = typeof metrics.primaryLanguage === 'string' && metrics.primaryLanguage.trim().length > 0
    ? metrics.primaryLanguage.trim()
    : 'Unknown';

  const stars = typeof metrics.stars === 'number' && Number.isFinite(metrics.stars) && metrics.stars >= 0
    ? Math.floor(metrics.stars)
    : 0;

  const forks = typeof metrics.forks === 'number' && Number.isFinite(metrics.forks) && metrics.forks >= 0
    ? Math.floor(metrics.forks)
    : 0;

  const totalCommitCount = typeof metrics.totalCommitCount === 'number' && Number.isFinite(metrics.totalCommitCount) && metrics.totalCommitCount >= 0
    ? Math.floor(metrics.totalCommitCount)
    : 0;

  const techStack = normalizeTags(record.techStack);

  const tags: string[] = [];
  if (primaryLanguage && primaryLanguage !== 'Unknown') {
    tags.push(primaryLanguage.toLowerCase());
  }
  for (const t of techStack) {
    if (!tags.includes(t)) {
      tags.push(t);
    }
  }

  const rawDescription = typeof record.description === 'string' && record.description.trim().length > 0
    ? record.description.trim()
    : (primaryLanguage !== 'Unknown' ? primaryLanguage : '');

  const updatedAt = parseUpdatedAt(record.updatedAt);

  return {
    id,
    type: 'project',
    title: repoFullName,
    description: rawDescription,
    tags,
    metadata: {
      repoFullName,
      repoUrl,
      primaryLanguage,
      stars,
      forks,
      totalCommitCount,
      techStack,
    },
    updatedAt,
  };
}

// ============================================================================
// Unified Document Mapping Dispatcher
// ============================================================================

/**
 * Universal dispatcher mapping a document of a known entity type to a SearchDocument.
 * Returns null if the entity is ineligible or unsupported.
 */
export function mapDocumentToSearch(
  type: SearchEntityType,
  doc: unknown,
): SearchDocument | null {
  switch (type) {
    case 'dsa':
      return mapDsaProblemToSearch(doc);
    case 'profile':
      return mapPublicProfileToSearch(doc);
    case 'project':
      return mapVerifiedProjectToSearch(doc);
    default: {
      const _exhaustiveCheck: never = type;
      return null;
    }
  }
}

/**
 * Universal dispatcher checking eligibility for a given entity type and document.
 */
export function isDocumentEligible(
  type: SearchEntityType,
  doc: unknown,
): boolean {
  switch (type) {
    case 'dsa':
      return isDsaProblemEligible(doc);
    case 'profile':
      return isPublicProfileEligible(doc);
    case 'project':
      return isVerifiedProjectEligible(doc);
    default:
      return false;
  }
}
