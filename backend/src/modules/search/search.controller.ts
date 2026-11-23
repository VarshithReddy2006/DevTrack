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
} from '../../shared/search/searchClient.types.js';
import { successResponse, commonErrors } from '../../shared/response.js';
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
      const results = await Promise.all(
        ALL_SEARCH_INDICES.map((index) =>
          searchClient.search<SearchDocument>(index, q, {
            limit: candidateLimit,
            offset: 0,
          })
        )
      );

      const mergedHits = results.flatMap((r) => r.hits);

      // Deterministic relevance sorting:
      // 1. Relevance score descending
      // 2. Entity type ascending (lexicographical: 'dsa' < 'profile' < 'project')
      // 3. Entity ID ascending
      mergedHits.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        if (a.type !== b.type) {
          return a.type.localeCompare(b.type);
        }
        return a.id.localeCompare(b.id);
      });

      totalHits = results.reduce((sum, r) => sum + r.totalHits, 0);
      rawHits = mergedHits.slice(offset, offset + limit);
    }

    const hits = rawHits.map(sanitizeSearchHit);
    const maxSupportedPages = Math.floor(MAX_SEARCH_RESULT_HORIZON / limit);
    const calculatedTotalPages = totalHits === 0 ? 0 : Math.ceil(totalHits / limit);
    const totalPages = Math.min(calculatedTotalPages, maxSupportedPages);
    const processingTimeMs = Number((performance.now() - startTime).toFixed(2));

    const responseData: SearchApiResponseData = {
      query: q,
      totalHits,
      page,
      limit,
      totalPages,
      hits,
      processingTimeMs,
      pagination: {
        page,
        pageSize: limit,
        totalItems: totalHits,
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
