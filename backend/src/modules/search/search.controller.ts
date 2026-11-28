// src/modules/search/search.controller.ts
// Unified search controller coordinating full-text queries across DSA problems,
// public profiles, and verified projects using the search provider abstraction.

import type { Request, Response } from 'express';
import { performance } from 'node:perf_hooks';
import { getSearchClient } from '../../shared/search/searchClient.js';
import type {
  SearchDocument,
  SearchEntityType,
  SearchHit,
  SearchResult,
} from '../../shared/search/searchClient.types.js';
import { successResponse, errorResponse, commonErrors } from '../../shared/response.js';
import { logger } from '../../shared/logger.js';
import {
  searchQuerySchema,
  MAX_SEARCH_RESULT_HORIZON,
  type SearchQueryInput,
  type SearchEntityTypeFilter,
} from './search.schema.js';

export const ENTITY_INDEX_MAP: Record<Exclude<SearchEntityTypeFilter, 'all'>, string> = {
  dsa: 'devtrack_dsa',
  profile: 'devtrack_profiles',
  project: 'devtrack_projects',
};

export const ALL_SEARCH_INDICES = Object.values(ENTITY_INDEX_MAP);

/** Standard Reciprocal Rank Fusion damping constant. */
export const RRF_K = 60;

export interface SearchApiHit {
  id: string;
  type: SearchEntityType;
  title: string;
  description?: string;
  tags?: string[];
  score: number;
  metadata?: Record<string, unknown>;
  highlights?: Record<string, string>;
}

export interface SearchApiResponseData {
  query: string;
  totalHits: number;
  page: number;
  limit: number;
  totalPages: number;
  hits: SearchApiHit[];
  processingTimeMs: number;
  /** Indices that failed during a type=all search. Omitted when all of them answered. */
  degradedIndices?: string[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}

/**
 * Normalizes an internal SearchHit into a safe, client-facing SearchApiHit DTO,
 * stripping internal monotonic timestamps (updatedAt) and provider internals.
 */
export function sanitizeSearchHit(hit: SearchHit<SearchDocument>): SearchApiHit {
  return {
    id: hit.id,
    type: hit.type,
    title: hit.document?.title ?? '',
    description: hit.document?.description,
    tags: hit.document?.tags,
    score: Number(hit.score.toFixed(4)),
    metadata: hit.document?.metadata,
    highlights: hit.highlights,
  };
}

/**
 * Merges per-index result lists with Reciprocal Rank Fusion. Each list is already ordered
 * by its own index, so only the rank is compared and raw score scales never mix.
 * Equal ranks are ordered by entity type, then ID.
 */
export function fuseByReciprocalRank(
  rankedLists: SearchHit<SearchDocument>[][]
): SearchHit<SearchDocument>[] {
  return rankedLists
    .flatMap((hits) => hits.map((hit, rank) => ({ hit, fused: 1 / (RRF_K + rank + 1) })))
    .sort(
      (a, b) =>
        b.fused - a.fused ||
        a.hit.type.localeCompare(b.hit.type) ||
        a.hit.id.localeCompare(b.hit.id)
    )
    .map(({ hit }) => hit);
}

/**
 * Unified Search Endpoint Handler: GET /api/v2/search
 */
export async function searchHandler(req: Request, res: Response): Promise<void> {
  const startTime = performance.now();

  try {
    const { q, type, page, limit } = searchQuerySchema.parse(req.query);
    const offset = (page - 1) * limit;

    const searchClient = getSearchClient();

    let rawHits: SearchHit<SearchDocument>[] = [];
    let totalHits = 0;
    const degradedIndices: string[] = [];

    if (type !== 'all') {
      const index = ENTITY_INDEX_MAP[type];
      const result = await searchClient.search<SearchDocument>(index, q, {
        type,
        limit,
        offset,
      });
      rawHits = result.hits;
      totalHits = result.totalHits;
    } else {
      // Cross-index unified search: query all entity indices in parallel
      // Request sufficient candidates (offset + limit) up to the supported horizon
      const candidateLimit = Math.min(offset + limit, MAX_SEARCH_RESULT_HORIZON);
      const settled = await Promise.allSettled(
        ALL_SEARCH_INDICES.map(async (index) =>
          searchClient.search<SearchDocument>(index, q, {
            limit: candidateLimit,
            offset: 0,
          })
        )
      );

      const results: SearchResult<SearchDocument>[] = [];
      settled.forEach((outcome, i) => {
        if (outcome.status === 'fulfilled') {
          results.push(outcome.value);
          return;
        }
        const index = ALL_SEARCH_INDICES[i];
        degradedIndices.push(index);
        logger.warn('[search.controller] Search index failed during unified search', {
          event: 'search_index_degraded',
          index,
          errorName: outcome.reason instanceof Error ? outcome.reason.name : 'Error',
        });
      });

      if (results.length === 0) {
        logger.error('[search.controller] Every search index failed', undefined, {
          event: 'search_all_indices_failed',
          indices: degradedIndices,
        });
        errorResponse(res, 'Search service temporarily unavailable', 'SERVICE_UNAVAILABLE', 503);
        return;
      }

      totalHits = results.reduce((sum, r) => sum + r.totalHits, 0);
      rawHits = fuseByReciprocalRank(results.map((r) => r.hits)).slice(offset, offset + limit);
    }

    const hits = rawHits.map(sanitizeSearchHit);
    const maxSupportedPages = Math.floor(MAX_SEARCH_RESULT_HORIZON / limit);
    // totalHits counts every match; pagination only promises what fits inside the horizon
    const totalItems = Math.min(totalHits, maxSupportedPages * limit);
    const totalPages = Math.ceil(totalItems / limit);
    const processingTimeMs = Number((performance.now() - startTime).toFixed(2));

    const responseData: SearchApiResponseData = {
      query: q,
      totalHits,
      page,
      limit,
      totalPages,
      hits,
      processingTimeMs,
      ...(degradedIndices.length > 0 && { degradedIndices }),
      pagination: {
        page,
        pageSize: limit,
        totalItems,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };

    successResponse(res, responseData, 'Search results retrieved successfully');
  } catch (err) {
    logger.error('[search.controller] Unexpected search provider failure', err as Error);
    commonErrors.internalError(res, 'Search service temporarily unavailable');
  }
}
