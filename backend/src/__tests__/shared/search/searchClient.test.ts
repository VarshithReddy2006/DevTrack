// backend/src/__tests__/shared/search/searchClient.test.ts
// Unit and behavioral verification suite for search provider abstraction and In-Memory engine.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemorySearchProvider,
  getSearchClient,
  setSearchClient,
  resetSearchClient,
  type SearchDocument,
  levenshteinDistance,
} from '../../../shared/search/index.js';

describe('Search Provider Abstraction & InMemorySearchProvider', () => {
  let provider: InMemorySearchProvider;
  const TEST_INDEX = 'test_dsa';

  beforeEach(async () => {
    resetSearchClient();
    provider = new InMemorySearchProvider();
    await provider.clear();
  });

  // 1. Empty index
  it('returns zero hits when searching an empty index', async () => {
    const res = await provider.search(TEST_INDEX, 'binary search');
    expect(res.totalHits).toBe(0);
    expect(res.hits).toEqual([]);
    expect(res.query).toBe('binary search');
    expect(res.processingTimeMs).toBeGreaterThanOrEqual(0);
    expect(res.limit).toBe(20);
    expect(res.offset).toBe(0);
  });

  // 2. Single document indexing
  it('indexes a single document and retrieves it via search', async () => {
    const doc: SearchDocument = {
      id: 'doc_1',
      type: 'dsa',
      title: 'Invert Binary Tree',
      description: 'Given the root of a binary tree, invert the tree, and return its root.',
      tags: ['tree', 'binary-tree', 'recursion'],
      metadata: { difficulty: 'easy', platform: 'leetcode' },
      updatedAt: 1000,
    };

    await provider.indexDocument(TEST_INDEX, doc.id, doc);
    const res = await provider.search(TEST_INDEX, 'Invert Binary Tree');

    expect(res.totalHits).toBe(1);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].id).toBe('doc_1');
    expect(res.hits[0].type).toBe('dsa');
    expect(res.hits[0].score).toBeGreaterThan(0);
    expect(res.hits[0].document.title).toBe('Invert Binary Tree');
  });

  // 3. Multiple document indexing
  it('indexes multiple documents in batch and retrieves them accurately', async () => {
    const docs: SearchDocument[] = [
      {
        id: 'dsa_1',
        type: 'dsa',
        title: 'Two Sum',
        description: 'Find two numbers that add up to target',
        tags: ['array', 'hash-table'],
        updatedAt: 1000,
      },
      {
        id: 'dsa_2',
        type: 'dsa',
        title: 'Three Sum',
        description: 'Find all unique triplets in the array which gives the sum of zero',
        tags: ['array', 'two-pointers', 'sorting'],
        updatedAt: 2000,
      },
      {
        id: 'dsa_3',
        type: 'dsa',
        title: 'Binary Search',
        description: 'Search target in sorted array in O(log n)',
        tags: ['binary-search', 'array'],
        updatedAt: 3000,
      },
    ];

    await provider.indexDocuments(
      TEST_INDEX,
      docs.map((d) => ({ id: d.id, doc: d }))
    );

    const res = await provider.search(TEST_INDEX, 'Sum');
    expect(res.totalHits).toBe(2);
    const ids = res.hits.map((h) => h.id);
    expect(ids).toContain('dsa_1');
    expect(ids).toContain('dsa_2');
    expect(ids).not.toContain('dsa_3');
  });

  // 4. Document update
  it('correctly updates and replaces document content when re-indexed with same ID', async () => {
    const initialDoc: SearchDocument = {
      id: 'profile_subodh',
      type: 'profile',
      title: 'Subodh Junior',
      description: 'Junior Software Engineer',
      tags: ['nodejs'],
      updatedAt: 1000,
    };

    await provider.indexDocument(TEST_INDEX, initialDoc.id, initialDoc);

    const check1 = await provider.search(TEST_INDEX, 'Junior');
    expect(check1.totalHits).toBe(1);
    expect(check1.hits[0].document.title).toBe('Subodh Junior');

    // Update document with same ID
    const updatedDoc: SearchDocument = {
      id: 'profile_subodh',
      type: 'profile',
      title: 'Subodh Staff Engineer',
      description: 'Distributed Systems & Database Architect',
      tags: ['nodejs', 'distributed-systems'],
      updatedAt: 2000,
    };

    await provider.indexDocument(TEST_INDEX, updatedDoc.id, updatedDoc);

    // Old title should no longer match
    const check2 = await provider.search(TEST_INDEX, 'Junior');
    expect(check2.totalHits).toBe(0);

    // New title matches
    const check3 = await provider.search(TEST_INDEX, 'Staff');
    expect(check3.totalHits).toBe(1);
    expect(check3.hits[0].document.title).toBe('Subodh Staff Engineer');
    expect(check3.hits[0].document.description).toBe('Distributed Systems & Database Architect');
  });

  // 5. Duplicate document identifier semantics
  it('enforces idempotent upsert semantics on duplicate IDs without creating duplicate entries', async () => {
    const doc: SearchDocument = {
      id: 'duplicate_check',
      type: 'project',
      title: 'DevTrack Platform',
      description: 'Engineering tracker',
      updatedAt: 1000,
    };

    await provider.indexDocument(TEST_INDEX, doc.id, doc);
    await provider.indexDocument(TEST_INDEX, doc.id, doc);
    await provider.indexDocument(TEST_INDEX, doc.id, doc);

    const res = await provider.search(TEST_INDEX, 'DevTrack');
    expect(res.totalHits).toBe(1);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].id).toBe('duplicate_check');
  });

  // 6. Document deletion
  it('deletes a document and handles non-existent deletions idempotently', async () => {
    const doc: SearchDocument = {
      id: 'to_delete',
      type: 'dsa',
      title: 'Merge Intervals',
      description: 'Merge all overlapping intervals',
      tags: ['intervals', 'sorting'],
      updatedAt: 1000,
    };

    await provider.indexDocument(TEST_INDEX, doc.id, doc);
    expect((await provider.search(TEST_INDEX, 'Merge')).totalHits).toBe(1);

    await provider.deleteDocument(TEST_INDEX, 'to_delete');
    expect((await provider.search(TEST_INDEX, 'Merge')).totalHits).toBe(0);

    // Deleting again should be safe and idempotent
    await expect(provider.deleteDocument(TEST_INDEX, 'to_delete')).resolves.not.toThrow();
    await expect(provider.deleteDocument(TEST_INDEX, 'non_existent_key')).resolves.not.toThrow();

    // Batch deletion
    await provider.indexDocument(TEST_INDEX, 'batch_del_1', { ...doc, id: 'batch_del_1' });
    await provider.indexDocument(TEST_INDEX, 'batch_del_2', { ...doc, id: 'batch_del_2' });
    await provider.deleteDocuments(TEST_INDEX, ['batch_del_1', 'batch_del_2']);
    expect((await provider.search(TEST_INDEX, 'Merge')).totalHits).toBe(0);
  });

  // 7. Search matching & Relevance scoring
  it('ranks title matches higher than description matches', async () => {
    const docTitleMatch: SearchDocument = {
      id: 'doc_title',
      type: 'dsa',
      title: 'Dynamic Programming Patterns',
      description: 'A study guide for recursion and memoization',
      updatedAt: 1000,
    };

    const docDescMatch: SearchDocument = {
      id: 'doc_desc',
      type: 'dsa',
      title: 'Fibonacci Series',
      description: 'Solved using dynamic programming table',
      updatedAt: 1000,
    };

    await provider.indexDocument(TEST_INDEX, docTitleMatch.id, docTitleMatch);
    await provider.indexDocument(TEST_INDEX, docDescMatch.id, docDescMatch);

    const res = await provider.search(TEST_INDEX, 'Dynamic Programming');
    expect(res.totalHits).toBe(2);
    // doc_title should be first hit due to title match weight
    expect(res.hits[0].id).toBe('doc_title');
    expect(res.hits[1].id).toBe('doc_desc');
    expect(res.hits[0].score).toBeGreaterThan(res.hits[1].score);
  });

  // 8. Case-insensitive matching
  it('executes case-insensitive matching across query and document terms', async () => {
    const doc: SearchDocument = {
      id: 'case_doc',
      type: 'dsa',
      title: 'QUICKSORT ALGORITHM',
      description: 'Divide and Conquer Partitioning',
      tags: ['DIVIDE-AND-CONQUER'],
      updatedAt: 1000,
    };

    await provider.indexDocument(TEST_INDEX, doc.id, doc);

    // Lowercase query matches uppercase document
    const res1 = await provider.search(TEST_INDEX, 'quicksort');
    expect(res1.totalHits).toBe(1);

    // Mixed case query matches lowercase tag
    const res2 = await provider.search(TEST_INDEX, 'Divide-And-Conquer');
    expect(res2.totalHits).toBe(1);
  });

  // 9. No-match behavior
  it('returns clean empty results when query matches no documents', async () => {
    const doc: SearchDocument = {
      id: 'doc_dsa',
      type: 'dsa',
      title: 'Dijkstra Shortest Path',
      description: 'Greedy graph algorithm',
      updatedAt: 1000,
    };

    await provider.indexDocument(TEST_INDEX, doc.id, doc);
    const res = await provider.search(TEST_INDEX, 'quantum cryptography entanglement');
    expect(res.totalHits).toBe(0);
    expect(res.hits).toEqual([]);
  });

  // 10. Deterministic ordering
  it('ensures deterministic tie-breaking by updatedAt desc then id asc', async () => {
    // 3 documents with identical scores
    const docA: SearchDocument = {
      id: 'item_a',
      type: 'dsa',
      title: 'Graph Traversal',
      updatedAt: 1000,
    };
    const docB: SearchDocument = {
      id: 'item_b',
      type: 'dsa',
      title: 'Graph Traversal',
      updatedAt: 2000, // Newer updatedAt
    };
    const docC: SearchDocument = {
      id: 'item_c',
      type: 'dsa',
      title: 'Graph Traversal',
      updatedAt: 1000, // Tied with A on time, but id is 'item_c' vs 'item_a'
    };

    await provider.indexDocument(TEST_INDEX, docA.id, docA);
    await provider.indexDocument(TEST_INDEX, docB.id, docB);
    await provider.indexDocument(TEST_INDEX, docC.id, docC);

    const res = await provider.search(TEST_INDEX, 'Graph Traversal');
    expect(res.totalHits).toBe(3);

    // 1st should be docB (highest updatedAt: 2000)
    expect(res.hits[0].id).toBe('item_b');
    // 2nd should be docA (updatedAt 1000, id 'item_a' < 'item_c')
    expect(res.hits[1].id).toBe('item_a');
    // 3rd should be docC (updatedAt 1000, id 'item_c')
    expect(res.hits[2].id).toBe('item_c');
  });

  // 11. Pagination & result limits
  it('applies pagination limit and offset accurately', async () => {
    const docs: SearchDocument[] = Array.from({ length: 25 }, (_, i) => ({
      id: `paged_doc_${String(i).padStart(2, '0')}`,
      type: 'dsa',
      title: `Problem Number ${i}`,
      description: 'Common algorithmic practice problem',
      updatedAt: 1000 + i,
    }));

    await provider.indexDocuments(
      TEST_INDEX,
      docs.map((d) => ({ id: d.id, doc: d }))
    );

    // Page 1: limit 10, offset 0
    const page1 = await provider.search(TEST_INDEX, 'Problem', { limit: 10, offset: 0 });
    expect(page1.totalHits).toBe(25);
    expect(page1.hits).toHaveLength(10);
    expect(page1.limit).toBe(10);
    expect(page1.offset).toBe(0);

    // Page 2: limit 10, offset 10
    const page2 = await provider.search(TEST_INDEX, 'Problem', { limit: 10, offset: 10 });
    expect(page2.totalHits).toBe(25);
    expect(page2.hits).toHaveLength(10);
    expect(page2.offset).toBe(10);

    // Assert disjoint sets between page 1 and page 2
    const ids1 = page1.hits.map((h) => h.id);
    const ids2 = page2.hits.map((h) => h.id);
    for (const id of ids1) {
      expect(ids2).not.toContain(id);
    }

    // Page 3: limit 10, offset 20 (only 5 items remain)
    const page3 = await provider.search(TEST_INDEX, 'Problem', { limit: 10, offset: 20 });
    expect(page3.totalHits).toBe(25);
    expect(page3.hits).toHaveLength(5);
  });

  // 12. Invalid query and malformed input handling
  it('safely handles empty queries, whitespace, and malformed inputs', async () => {
    const doc: SearchDocument = {
      id: 'doc_valid',
      type: 'dsa',
      title: 'Valid Problem',
      updatedAt: 1000,
    };
    await provider.indexDocument(TEST_INDEX, doc.id, doc);

    // Empty string without filters returns 0
    const resEmpty = await provider.search(TEST_INDEX, '');
    expect(resEmpty.totalHits).toBe(0);
    expect(resEmpty.hits).toEqual([]);

    // Whitespace only
    const resWhitespace = await provider.search(TEST_INDEX, '    ');
    expect(resWhitespace.totalHits).toBe(0);

    // Empty query WITH type filter returns all documents of that type
    const resTypeFilter = await provider.search(TEST_INDEX, '', { type: 'dsa' });
    expect(resTypeFilter.totalHits).toBe(1);
    expect(resTypeFilter.hits[0].id).toBe('doc_valid');

    // Validation rejection on invalid indexDocument inputs
    await expect(provider.indexDocument('', 'id', doc)).rejects.toThrow();
    await expect(provider.indexDocument(TEST_INDEX, '', doc)).rejects.toThrow();
    await expect(provider.indexDocument(TEST_INDEX, 'id', null as any)).rejects.toThrow();
  });

  // 13. Repeated operations & Clear
  it('supports clearing an index and re-populating cleanly', async () => {
    await provider.indexDocument(TEST_INDEX, 'doc_1', {
      id: 'doc_1',
      type: 'dsa',
      title: 'Kruskal Algorithm',
      updatedAt: 1000,
    });
    expect((await provider.search(TEST_INDEX, 'Kruskal')).totalHits).toBe(1);

    await provider.clear(TEST_INDEX);
    expect((await provider.search(TEST_INDEX, 'Kruskal')).totalHits).toBe(0);

    // Re-index
    await provider.indexDocument(TEST_INDEX, 'doc_1', {
      id: 'doc_1',
      type: 'dsa',
      title: 'Kruskal Algorithm',
      updatedAt: 2000,
    });
    expect((await provider.search(TEST_INDEX, 'Kruskal')).totalHits).toBe(1);
  });

  // 14. Typo-tolerance (Levenshtein distance)
  it('correctly matches queries with typographical errors using Levenshtein distance', async () => {
    const doc: SearchDocument = {
      id: 'typo_target',
      type: 'dsa',
      title: 'Binary Search Algorithm',
      description: 'Efficient divide and conquer searching',
      tags: ['binary-search'],
      updatedAt: 1000,
    };

    await provider.indexDocument(TEST_INDEX, doc.id, doc);

    // 1 typo: "binnary" -> "binary" (dist 1)
    const res1 = await provider.search(TEST_INDEX, 'binnary');
    expect(res1.totalHits).toBe(1);
    expect(res1.hits[0].id).toBe('typo_target');

    // 2 typos in long word: "algoritm" -> "algorithm" (dist 1)
    const res2 = await provider.search(TEST_INDEX, 'algoritm');
    expect(res2.totalHits).toBe(1);
    expect(res2.hits[0].id).toBe('typo_target');
  });

  // 15. Levenshtein utility verification
  it('verifies Levenshtein distance edge cases', () => {
    expect(levenshteinDistance('', '')).toBe(0);
    expect(levenshteinDistance('a', '')).toBe(1);
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('search', 'serach')).toBe(2);
    expect(levenshteinDistance('binary', 'binnary')).toBe(1);
  });

  // 16. Search Client Singleton Factory
  it('resolves and resets the global search client singleton', async () => {
    const client1 = getSearchClient();
    expect(client1.name).toBe('in-memory');
    expect(await client1.healthCheck()).toBe(true);

    const client2 = getSearchClient();
    expect(client1).toBe(client2); // Same singleton instance

    // Test custom override
    const customProvider = new InMemorySearchProvider();
    setSearchClient(customProvider);
    expect(getSearchClient()).toBe(customProvider);

    resetSearchClient();
    const clientFresh = getSearchClient();
    expect(clientFresh).not.toBe(customProvider);
  });

  // 17. Multi-index isolation
  it('isolates data between distinct index names', async () => {
    const docDsa: SearchDocument = {
      id: 'shared_id',
      type: 'dsa',
      title: 'Dynamic Programming',
      updatedAt: 1000,
    };
    const docProfile: SearchDocument = {
      id: 'shared_id',
      type: 'profile',
      title: 'Alex Developer',
      updatedAt: 2000,
    };

    await provider.indexDocument('index_dsa', docDsa.id, docDsa);
    await provider.indexDocument('index_profiles', docProfile.id, docProfile);

    const resDsa = await provider.search('index_dsa', 'Dynamic');
    expect(resDsa.totalHits).toBe(1);
    expect(resDsa.hits[0].document.title).toBe('Dynamic Programming');

    const resProf = await provider.search('index_profiles', 'Alex');
    expect(resProf.totalHits).toBe(1);
    expect(resProf.hits[0].document.title).toBe('Alex Developer');

    // Searching wrong index returns zero
    expect((await provider.search('index_dsa', 'Alex')).totalHits).toBe(0);
    expect((await provider.search('index_profiles', 'Dynamic')).totalHits).toBe(0);
  });

  // 18. SEC-03: Monotonic updatedAt & Deletion Tombstone Protection
  describe('SEC-03: Stale Write & Deletion Tombstone Protection', () => {
    it('rejects stale updates when existing document has a strictly newer updatedAt timestamp', async () => {
      const newerDoc: SearchDocument = {
        id: 'stale_test_1',
        type: 'dsa',
        title: 'Newest Problem Title',
        description: 'Updated state',
        updatedAt: 5000,
      };

      await provider.indexDocument(TEST_INDEX, newerDoc.id, newerDoc);

      // Attempt to overwrite with older timestamp
      const olderDoc: SearchDocument = {
        id: 'stale_test_1',
        type: 'dsa',
        title: 'Old Stale Title',
        description: 'Stale state',
        updatedAt: 3000,
      };

      await provider.indexDocument(TEST_INDEX, olderDoc.id, olderDoc);

      // Should retain newerDoc
      const res = await provider.search(TEST_INDEX, 'Title');
      expect(res.totalHits).toBe(1);
      expect(res.hits[0].document.title).toBe('Newest Problem Title');
      expect(res.hits[0].document.updatedAt).toBe(5000);
    });

    it('accepts updates when incoming document has equal or newer updatedAt timestamp', async () => {
      const docV1: SearchDocument = {
        id: 'update_test_1',
        type: 'dsa',
        title: 'Initial Version',
        updatedAt: 1000,
      };
      await provider.indexDocument(TEST_INDEX, docV1.id, docV1);

      const docV2: SearchDocument = {
        id: 'update_test_1',
        type: 'dsa',
        title: 'Updated Version',
        updatedAt: 1000, // same timestamp replaces
      };
      await provider.indexDocument(TEST_INDEX, docV2.id, docV2);

      const res = await provider.search(TEST_INDEX, 'Version');
      expect(res.totalHits).toBe(1);
      expect(res.hits[0].document.title).toBe('Updated Version');
    });

    it('rejects re-indexing when document updatedAt is older than or equal to deletion tombstone', async () => {
      const doc: SearchDocument = {
        id: 'tombstone_doc',
        type: 'dsa',
        title: 'Tombstone Problem',
        updatedAt: 2000,
      };
      await provider.indexDocument(TEST_INDEX, doc.id, doc);
      expect((await provider.search(TEST_INDEX, 'Tombstone')).totalHits).toBe(1);

      // Delete with timestamp 4000
      await provider.deleteDocument(TEST_INDEX, 'tombstone_doc', 4000);
      expect((await provider.search(TEST_INDEX, 'Tombstone')).totalHits).toBe(0);

      // Attempt stale replay: event from before deletion (updatedAt = 3000)
      const staleReplayDoc: SearchDocument = {
        id: 'tombstone_doc',
        type: 'dsa',
        title: 'Tombstone Problem Stale Replay',
        updatedAt: 3000,
      };
      await provider.indexDocument(TEST_INDEX, staleReplayDoc.id, staleReplayDoc);

      // Document should NOT be restored
      expect((await provider.search(TEST_INDEX, 'Tombstone')).totalHits).toBe(0);

      // Attempt replay with equal timestamp (updatedAt = 4000)
      await provider.indexDocument(TEST_INDEX, staleReplayDoc.id, { ...staleReplayDoc, updatedAt: 4000 });
      expect((await provider.search(TEST_INDEX, 'Tombstone')).totalHits).toBe(0);
    });

    it('allows re-indexing when document updatedAt is strictly newer than deletion tombstone and clears tombstone', async () => {
      // Delete document with timestamp 5000
      await provider.deleteDocument(TEST_INDEX, 'resurrected_doc', 5000);

      // New event created after deletion (updatedAt = 6000)
      const freshDoc: SearchDocument = {
        id: 'resurrected_doc',
        type: 'dsa',
        title: 'Resurrected Problem',
        updatedAt: 6000,
      };
      await provider.indexDocument(TEST_INDEX, freshDoc.id, freshDoc);

      const res = await provider.search(TEST_INDEX, 'Resurrected');
      expect(res.totalHits).toBe(1);
      expect(res.hits[0].id).toBe('resurrected_doc');
      expect(res.hits[0].document.updatedAt).toBe(6000);
    });

    it('records tombstones via batch deleteDocuments with deletedAt objects', async () => {
      await provider.indexDocument(TEST_INDEX, 'batch_tomb_1', {
        id: 'batch_tomb_1',
        type: 'dsa',
        title: 'Batch Tombstone 1',
        updatedAt: 1000,
      });

      await provider.deleteDocuments(TEST_INDEX, [
        { id: 'batch_tomb_1', deletedAt: 3000 },
      ]);

      // Replay with updatedAt 2000 should be rejected
      await provider.indexDocument(TEST_INDEX, 'batch_tomb_1', {
        id: 'batch_tomb_1',
        type: 'dsa',
        title: 'Batch Tombstone 1',
        updatedAt: 2000,
      });

      expect((await provider.search(TEST_INDEX, 'Batch Tombstone')).totalHits).toBe(0);
    });

    it('clears tombstones when provider.clear() is called', async () => {
      await provider.deleteDocument(TEST_INDEX, 'clear_tomb_test', 5000);
      await provider.clear(TEST_INDEX);

      // Now re-indexing with updatedAt 2000 succeeds because tombstone was cleared
      await provider.indexDocument(TEST_INDEX, 'clear_tomb_test', {
        id: 'clear_tomb_test',
        type: 'dsa',
        title: 'Clear Tombstone Success',
        updatedAt: 2000,
      });

      expect((await provider.search(TEST_INDEX, 'Clear Tombstone')).totalHits).toBe(1);
    });
  });

  // ==========================================================================
  // 17. Stage 5.6 Remediation: Candidate Window & Compound Deterministic Tie-Breaking
  // ==========================================================================
  describe('Stage 5.6 Candidate Window & Compound Tie-Breaking', () => {
    it('supports candidate limit > 100 without truncating at 100', async () => {
      const docs: SearchDocument[] = Array.from({ length: 150 }, (_, i) => ({
        id: `candidate_doc_${String(i).padStart(3, '0')}`,
        type: 'dsa',
        title: 'High Candidate Capacity Search Document',
        updatedAt: 1000 + i,
      }));

      await provider.indexDocuments(
        TEST_INDEX,
        docs.map((d) => ({ id: d.id, doc: d }))
      );

      // Request 120 candidates
      const res = await provider.search(TEST_INDEX, 'High Candidate Capacity', {
        limit: 120,
        offset: 0,
      });

      expect(res.totalHits).toBe(150);
      expect(res.hits).toHaveLength(120);
      expect(res.limit).toBe(120);
    });

    it('clamps limit to DEFAULT_MAX_CANDIDATE_LIMIT (1000) when limit exceeds 1000', async () => {
      const res = await provider.search(TEST_INDEX, 'High Candidate Capacity', {
        limit: 2000,
        offset: 0,
      });

      expect(res.limit).toBe(1000);
    });

    it('enforces compound tie-breaking with type asc when score and updatedAt are equal', async () => {
      const docProfile: SearchDocument = {
        id: 'tied_collision_id',
        type: 'profile',
        title: 'Identical Compound Benchmark',
        updatedAt: 3000,
      };
      const docDsa: SearchDocument = {
        id: 'tied_collision_id',
        type: 'dsa',
        title: 'Identical Compound Benchmark',
        updatedAt: 3000,
      };

      await provider.indexDocument(TEST_INDEX, 'profile_key', docProfile);
      await provider.indexDocument(TEST_INDEX, 'dsa_key', docDsa);

      const res = await provider.search(TEST_INDEX, 'Identical Compound Benchmark');
      expect(res.totalHits).toBe(2);

      // Equal score, equal updatedAt, identical document id:
      // Compound tie-breaker must order 'dsa' before 'profile' (type asc)
      expect(res.hits[0].type).toBe('dsa');
      expect(res.hits[1].type).toBe('profile');
    });
  });
});
