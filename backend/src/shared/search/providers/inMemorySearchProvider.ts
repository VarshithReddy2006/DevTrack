// src/shared/search/providers/inMemorySearchProvider.ts
// Deterministic in-memory full-text search provider with typo tolerance,
// relevance scoring, deterministic tie-breaking, and pagination.

import type {
  ISearchProvider,
  SearchDocument,
  SearchHit,
  SearchOptions,
  SearchResult,
} from '../searchClient.types.js';

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const aLen = a.length;
  const bLen = b.length;

  // Single-row space optimization
  let row = Array.from({ length: aLen + 1 }, (_, i) => i);

  for (let i = 1; i <= bLen; i++) {
    const nextRow = [i];
    for (let j = 1; j <= aLen; j++) {
      const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
      nextRow[j] = Math.min(
        row[j] + 1,        // deletion
        nextRow[j - 1] + 1, // insertion
        row[j - 1] + cost   // substitution
      );
    }
    row = nextRow;
  }

  return row[aLen];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const DEFAULT_MAX_CANDIDATE_LIMIT = 1000;

export class InMemorySearchProvider implements ISearchProvider {
  readonly name = 'in-memory';

  // indexName -> (documentId -> SearchDocument)
  private indices = new Map<string, Map<string, SearchDocument>>();

  // indexName -> (documentId -> deletedAt timestamp tombstone)
  private tombstones = new Map<string, Map<string, number>>();

  private getIndexMap(index: string): Map<string, SearchDocument> {
    let map = this.indices.get(index);
    if (!map) {
      map = new Map<string, SearchDocument>();
      this.indices.set(index, map);
    }
    return map;
  }

  private getTombstoneMap(index: string): Map<string, number> {
    let map = this.tombstones.get(index);
    if (!map) {
      map = new Map<string, number>();
      this.tombstones.set(index, map);
    }
    return map;
  }

  async indexDocument(index: string, id: string, doc: SearchDocument): Promise<void> {
    if (!index || typeof index !== 'string') {
      throw new Error('Index name must be a non-empty string');
    }
    if (!id || typeof id !== 'string') {
      throw new Error('Document ID must be a non-empty string');
    }
    if (!doc || typeof doc !== 'object') {
      throw new Error('Document must be a valid object');
    }

    const normalizedId = String(id).trim();
    const map = this.getIndexMap(index);
    const tombstoneMap = this.getTombstoneMap(index);

    const docUpdatedAt = typeof doc.updatedAt === 'number' && Number.isFinite(doc.updatedAt)
      ? doc.updatedAt
      : Date.now();

    // 1. Guard against stale updates: reject if existing document has a strictly newer timestamp
    const existing = map.get(normalizedId);
    if (existing && typeof existing.updatedAt === 'number' && docUpdatedAt < existing.updatedAt) {
      return; // Stale write skipped
    }

    // 2. Guard against stale replay after deletion: reject if updatedAt <= deletion tombstone
    const tombstoneTime = tombstoneMap.get(normalizedId);
    if (tombstoneTime !== undefined && docUpdatedAt <= tombstoneTime) {
      return; // Event occurred before or at deletion; skip restoring deleted document
    }

    // Document is newer than tombstone: clear tombstone and proceed with upsert
    if (tombstoneTime !== undefined && docUpdatedAt > tombstoneTime) {
      tombstoneMap.delete(normalizedId);
    }

    // Deep-clone to prevent in-place mutation by caller
    map.set(normalizedId, {
      ...doc,
      id: normalizedId,
      updatedAt: docUpdatedAt,
    });
  }

  async indexDocuments(index: string, docs: Array<{ id: string; doc: SearchDocument }>): Promise<void> {
    if (!Array.isArray(docs)) {
      throw new Error('docs must be an array');
    }
    for (const item of docs) {
      await this.indexDocument(index, item.id, item.doc);
    }
  }

  async deleteDocument(index: string, id: string, deletedAt?: number): Promise<void> {
    if (!index || !id) return;
    const normalizedId = String(id).trim();
    const map = this.getIndexMap(index);
    if (map) {
      map.delete(normalizedId);
    }

    const tombstoneMap = this.getTombstoneMap(index);
    const tombstoneTime = typeof deletedAt === 'number' && Number.isFinite(deletedAt)
      ? deletedAt
      : Date.now();
    tombstoneMap.set(normalizedId, tombstoneTime);
  }

  async deleteDocuments(index: string, ids: Array<string | { id: string; deletedAt?: number }>): Promise<void> {
    if (!index || !Array.isArray(ids)) return;
    for (const item of ids) {
      if (typeof item === 'string') {
        await this.deleteDocument(index, item);
      } else if (item && typeof item.id === 'string') {
        await this.deleteDocument(index, item.id, item.deletedAt);
      }
    }
  }

  async search<T = SearchDocument>(
    index: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResult<T>> {
    const startTime = performance.now();
    const map = this.indices.get(index);

    const limit = Math.max(1, Math.min(options.limit ?? 20, DEFAULT_MAX_CANDIDATE_LIMIT));
    const offset = Math.max(0, options.offset ?? 0);
    const targetType = options.type;
    const exactFilters = options.filters;

    if (!map || map.size === 0) {
      return {
        query: query ?? '',
        totalHits: 0,
        hits: [],
        processingTimeMs: Number((performance.now() - startTime).toFixed(2)),
        limit,
        offset,
      };
    }

    const rawQuery = typeof query === 'string' ? query.trim() : '';

    // Handle empty query: if type filter specified, return type-matched docs sorted by updatedAt desc, type asc, id asc
    if (!rawQuery) {
      if (targetType && targetType !== 'all') {
        const matched: SearchHit<T>[] = [];
        for (const doc of map.values()) {
          if (doc.type === targetType) {
            matched.push({
              id: doc.id,
              type: doc.type,
              score: 1.0,
              document: { ...doc } as unknown as T,
            });
          }
        }

        // Deterministic sort: updatedAt desc, type asc, id asc
        matched.sort((a, b) => {
          const aTime = a.document && typeof (a.document as any).updatedAt === 'number' ? (a.document as any).updatedAt : 0;
          const bTime = b.document && typeof (b.document as any).updatedAt === 'number' ? (b.document as any).updatedAt : 0;
          if (bTime !== aTime) return bTime - aTime;
          if (a.type !== b.type) return a.type.localeCompare(b.type);
          return a.id.localeCompare(b.id);
        });

        const totalHits = matched.length;
        const hits = matched.slice(offset, offset + limit);
        return {
          query: '',
          totalHits,
          hits,
          processingTimeMs: Number((performance.now() - startTime).toFixed(2)),
          limit,
          offset,
        };
      }

      return {
        query: '',
        totalHits: 0,
        hits: [],
        processingTimeMs: Number((performance.now() - startTime).toFixed(2)),
        limit,
        offset,
      };
    }

    const queryLower = rawQuery.toLowerCase();
    const queryTokens = queryLower.split(/\s+/).filter(Boolean);

    const scoredHits: SearchHit<T>[] = [];

    for (const doc of map.values()) {
      // 1. Entity type filtering
      if (targetType && targetType !== 'all' && doc.type !== targetType) {
        continue;
      }

      // 2. Exact attribute filter checking (metadata facets)
      if (exactFilters && typeof exactFilters === 'object') {
        let match = true;
        for (const [fKey, fVal] of Object.entries(exactFilters)) {
          if (doc.metadata?.[fKey] !== fVal) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }

      const title = doc.title || '';
      const titleLower = title.toLowerCase();
      const desc = doc.description || '';
      const descLower = desc.toLowerCase();
      const tags = Array.isArray(doc.tags) ? doc.tags : [];
      const tagsLower = tags.map(t => String(t).toLowerCase());

      let score = 0;
      const matchedTokens: string[] = [];

      // A. Exact whole query match in title
      if (titleLower === queryLower) {
        score += 25.0;
        matchedTokens.push(rawQuery);
      } else if (titleLower.includes(queryLower)) {
        score += 15.0;
        matchedTokens.push(rawQuery);
      }

      // B. Exact whole query match in description
      if (descLower.includes(queryLower)) {
        score += 6.0;
        matchedTokens.push(rawQuery);
      }

      // C. Exact match in tags
      if (tagsLower.includes(queryLower)) {
        score += 12.0;
        matchedTokens.push(rawQuery);
      }

      // D. Token-by-token evaluation across fields
      const titleWords = titleLower.split(/\W+/).filter(Boolean);
      const descWords = descLower.split(/\W+/).filter(Boolean);

      for (const token of queryTokens) {
        let tokenMatched = false;

        // Title word exact match
        if (titleWords.includes(token)) {
          score += 8.0;
          tokenMatched = true;
          matchedTokens.push(token);
        } else if (titleLower.includes(token)) {
          // Substring match in title
          score += 4.0;
          tokenMatched = true;
          matchedTokens.push(token);
        }

        // Tag exact match
        if (tagsLower.includes(token)) {
          score += 7.0;
          tokenMatched = true;
          matchedTokens.push(token);
        }

        // Description word exact match
        if (descWords.includes(token)) {
          score += 3.0;
          tokenMatched = true;
          matchedTokens.push(token);
        } else if (descLower.includes(token)) {
          score += 1.5;
          tokenMatched = true;
          matchedTokens.push(token);
        }

        // E. Typo-tolerance (Levenshtein distance)
        // For tokens of length >= 4, allow edit distance 1 (length 4..7) or 2 (length >= 8)
        if (!tokenMatched && token.length >= 4) {
          const maxDistance = token.length >= 8 ? 2 : 1;
          let bestDist = Infinity;
          let bestMatchedWord = '';

          for (const word of titleWords) {
            if (Math.abs(word.length - token.length) <= maxDistance) {
              const d = levenshteinDistance(token, word);
              if (d < bestDist && d <= maxDistance) {
                bestDist = d;
                bestMatchedWord = word;
              }
            }
          }

          if (bestDist <= maxDistance) {
            const fuzzyScore = (1.0 - bestDist / Math.max(token.length, bestMatchedWord.length)) * 5.0;
            score += fuzzyScore;
            matchedTokens.push(bestMatchedWord);
          } else {
            // Check tags for typo tolerance
            for (const tag of tagsLower) {
              if (Math.abs(tag.length - token.length) <= maxDistance) {
                const d = levenshteinDistance(token, tag);
                if (d <= maxDistance) {
                  score += (1.0 - d / Math.max(token.length, tag.length)) * 4.0;
                  matchedTokens.push(tag);
                  break;
                }
              }
            }
          }
        }
      }

      if (score > 0) {
        // Build highlight for title if matches exist
        let highlightedTitle = title;
        if (matchedTokens.length > 0) {
          const uniqueTerms = Array.from(new Set(matchedTokens.filter(t => t.length > 1)));
          for (const term of uniqueTerms) {
            const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
            highlightedTitle = highlightedTitle.replace(regex, '<em>$1</em>');
          }
        }

        // Normalize score between 0.01 and 1.0
        const normalizedScore = Number(Math.min(1.0, Math.max(0.01, score / 30.0)).toFixed(4));

        scoredHits.push({
          id: doc.id,
          type: doc.type,
          score: normalizedScore,
          document: { ...doc } as unknown as T,
          highlights: highlightedTitle !== title ? { title: highlightedTitle } : undefined,
        });
      }
    }

    // Deterministic Sorting:
    // 1. score descending (highest relevance first)
    // 2. updatedAt descending (most recent first)
    // 3. type ascending
    // 4. id ascending (lexicographical tie-breaker for 100% determinism)
    scoredHits.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const aTime = (a.document as any)?.updatedAt ?? 0;
      const bTime = (b.document as any)?.updatedAt ?? 0;
      if (bTime !== aTime) {
        return bTime - aTime;
      }
      if (a.type !== b.type) {
        return a.type.localeCompare(b.type);
      }
      return a.id.localeCompare(b.id);
    });

    const totalHits = scoredHits.length;
    const paginatedHits = scoredHits.slice(offset, offset + limit);

    return {
      query: rawQuery,
      totalHits,
      hits: paginatedHits,
      processingTimeMs: Number((performance.now() - startTime).toFixed(2)),
      limit,
      offset,
    };
  }

  async clear(index?: string): Promise<void> {
    if (index) {
      this.indices.delete(index);
      this.tombstones.delete(index);
    } else {
      this.indices.clear();
      this.tombstones.clear();
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
