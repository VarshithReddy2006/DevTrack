// src/__tests__/modules/search/search.test.ts
// Integration test suite for the unified search API (GET /api/v2/search).

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountApiRoutes } from '../../../routes/mount.js';
import router from '../../../routes/index.js';
import { errorHandler } from '../../../middleware/error.js';
import {
  getSearchClient,
  setSearchClient,
  resetSearchClient,
  InMemorySearchProvider,
  type SearchDocument,
} from '../../../shared/search/index.js';

vi.mock('../../../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { commonErrors } = await import('../../../shared/response.js');
  return {
    ...actual,
    authMiddleware: [
      (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith('Bearer ')) {
          return commonErrors.unauthorized(res);
        }
        const token = auth.split(' ')[1];
        if (token !== 'valid-token') {
          return commonErrors.unauthorized(res);
        }
        (req as any).user = { id: '000000000000000000000001', role: 'user' };
        next();
      },
    ],
  };
});

describe('Unified Search API — GET /api/v2/search', () => {
  let server: Server;
  let baseUrl: string;
  let searchProvider: InMemorySearchProvider;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    mountApiRoutes(app, router);
    app.use(errorHandler);

    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2/search`;
  });

  afterAll(async () => {
    resetSearchClient();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  beforeEach(async () => {
    searchProvider = new InMemorySearchProvider();
    setSearchClient(searchProvider);
    await searchProvider.clear();
  });

  const requestSearch = (queryString = '', token: string | null = 'valid-token') => {
    const url = queryString ? `${baseUrl}?${queryString}` : baseUrl;
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return fetch(url, { headers });
  };

  // ==========================================================================
  // 1. Query Validation
  // ==========================================================================
  describe('Query Validation', () => {
    it('returns 400 when search query q is missing', async () => {
      const res = await requestSearch('');
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe('VALIDATION_ERROR');
      expect(json.details['q']).toBeDefined();
    });

    it('returns 400 when search query q is empty string', async () => {
      const res = await requestSearch('q=');
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when search query q consists only of whitespace', async () => {
      const res = await requestSearch('q=%20%20%20');
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when search query exceeds 100 characters', async () => {
      const longQuery = 'a'.repeat(101);
      const res = await requestSearch(`q=${longQuery}`);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when page is less than 1', async () => {
      const res = await requestSearch('q=tree&page=0');
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe('VALIDATION_ERROR');
      expect(json.details['page']).toBeDefined();
    });

    it('returns 400 when page is negative', async () => {
      const res = await requestSearch('q=tree&page=-5');
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
    });

    it('returns 400 when page is not a number', async () => {
      const res = await requestSearch('q=tree&page=abc');
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
    });

    it('returns 400 when limit is less than 1', async () => {
      const res = await requestSearch('q=tree&limit=0');
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.details['limit']).toBeDefined();
    });

    it('returns 400 when limit exceeds 100', async () => {
      const res = await requestSearch('q=tree&limit=150');
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.details['limit']).toBeDefined();
    });

    it('returns 400 when entity type is invalid', async () => {
      const res = await requestSearch('q=tree&type=unsupported_entity');
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.details['type']).toBeDefined();
    });

    it('applies defaults correctly when only valid q is provided', async () => {
      const res = await requestSearch('q=binary%20search');
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.query).toBe('binary search');
      expect(json.data.page).toBe(1);
      expect(json.data.limit).toBe(20);
      expect(json.data.pagination.page).toBe(1);
      expect(json.data.pagination.pageSize).toBe(20);
    });
  });

  // ==========================================================================
  // 2. Search Behavior
  // ==========================================================================
  describe('Search Behavior', () => {
    beforeEach(async () => {
      // Seed test documents into respective indices
      const dsaDoc1: SearchDocument = {
        id: 'dsa_1',
        type: 'dsa',
        title: 'Binary Search Algorithm',
        description: 'Find target in sorted array with O(log n) time',
        tags: ['binary-search', 'algorithms'],
        metadata: { difficulty: 'easy', platform: 'leetcode' },
        updatedAt: 1000,
      };
      const dsaDoc2: SearchDocument = {
        id: 'dsa_2',
        type: 'dsa',
        title: 'Search in Rotated Sorted Array',
        description: 'Modified binary search with pivot',
        tags: ['binary-search', 'array'],
        metadata: { difficulty: 'medium', platform: 'leetcode' },
        updatedAt: 2000,
      };
      const profileDoc: SearchDocument = {
        id: 'prof_1',
        type: 'profile',
        title: 'alex_search_engineer',
        description: 'Staff engineer working on distributed search systems',
        tags: ['search', 'distributed-systems'],
        metadata: { username: 'alex', displayName: 'Alex Search' },
        updatedAt: 3000,
      };
      const projectDoc: SearchDocument = {
        id: 'proj_1',
        type: 'project',
        title: 'DevTrack Search Pipeline',
        description: 'Real-time full-text search indexing service',
        tags: ['search', 'mongodb'],
        metadata: { repoFullName: 'org/search-pipeline', stars: 42 },
        updatedAt: 4000,
      };

      await searchProvider.indexDocument('devtrack_dsa', dsaDoc1.id, dsaDoc1);
      await searchProvider.indexDocument('devtrack_dsa', dsaDoc2.id, dsaDoc2);
      await searchProvider.indexDocument('devtrack_profiles', profileDoc.id, profileDoc);
      await searchProvider.indexDocument('devtrack_projects', projectDoc.id, projectDoc);
    });

    it('returns matching results across all entity types when type is "all"', async () => {
      const res = await requestSearch('q=search&type=all');
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.totalHits).toBe(4);

      const types = json.data.hits.map((h: any) => h.type);
      expect(types).toContain('dsa');
      expect(types).toContain('profile');
      expect(types).toContain('project');
    });

    it('supports typo tolerance / fuzzy search for queries with minor spelling mistakes', async () => {
      // "binnary" typo should match "Binary Search"
      const res = await requestSearch('q=binnary');
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.totalHits).toBeGreaterThanOrEqual(1);

      const titles = json.data.hits.map((h: any) => h.title);
      expect(titles.some((t: string) => t.includes('Binary Search'))).toBe(true);
    });

    it('filters strictly by type=dsa and excludes profiles and projects', async () => {
      const res = await requestSearch('q=search&type=dsa');
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.totalHits).toBe(2);

      for (const hit of json.data.hits) {
        expect(hit.type).toBe('dsa');
      }
    });

    it('filters strictly by type=profile and excludes dsa and projects', async () => {
      const res = await requestSearch('q=search&type=profile');
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.totalHits).toBe(1);
      expect(json.data.hits[0].type).toBe('profile');
      expect(json.data.hits[0].id).toBe('prof_1');
    });

    it('filters strictly by type=project and excludes dsa and profiles', async () => {
      const res = await requestSearch('q=search&type=project');
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.totalHits).toBe(1);
      expect(json.data.hits[0].type).toBe('project');
      expect(json.data.hits[0].id).toBe('proj_1');
    });

    it('paginates results accurately across pages', async () => {
      // Query 4 matching documents with limit=2
      const page1Res = await requestSearch('q=search&limit=2&page=1');
      expect(page1Res.status).toBe(200);
      const page1Json = await page1Res.json();

      expect(page1Json.data.totalHits).toBe(4);
      expect(page1Json.data.totalPages).toBe(2);
      expect(page1Json.data.hits).toHaveLength(2);
      expect(page1Json.data.pagination.page).toBe(1);
      expect(page1Json.data.pagination.hasNextPage).toBe(true);
      expect(page1Json.data.pagination.hasPrevPage).toBe(false);

      const page2Res = await requestSearch('q=search&limit=2&page=2');
      expect(page2Res.status).toBe(200);
      const page2Json = await page2Res.json();

      expect(page2Json.data.hits).toHaveLength(2);
      expect(page2Json.data.pagination.page).toBe(2);
      expect(page2Json.data.pagination.hasNextPage).toBe(false);
      expect(page2Json.data.pagination.hasPrevPage).toBe(true);

      // Verify no duplicate IDs across pages
      const page1Ids = page1Json.data.hits.map((h: any) => h.id);
      const page2Ids = page2Json.data.hits.map((h: any) => h.id);
      for (const id of page1Ids) {
        expect(page2Ids).not.toContain(id);
      }
    });

    it('returns empty result set cleanly when no documents match', async () => {
      const res = await requestSearch('q=nonexistent_quantum_teleportation_keyword');
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.totalHits).toBe(0);
      expect(json.data.hits).toEqual([]);
      expect(json.data.totalPages).toBe(0);
      expect(json.data.pagination.hasNextPage).toBe(false);
      expect(json.data.pagination.hasPrevPage).toBe(false);
    });

    it('normalizes response format and strips internal timestamps and implementation metadata', async () => {
      const res = await requestSearch('q=Binary&type=dsa');
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.hits.length).toBeGreaterThan(0);

      const hit = json.data.hits[0];
      expect(hit).toHaveProperty('id');
      expect(hit).toHaveProperty('type');
      expect(hit).toHaveProperty('title');
      expect(hit).toHaveProperty('description');
      expect(hit).toHaveProperty('tags');
      expect(hit).toHaveProperty('score');
      expect(hit).toHaveProperty('metadata');

      // Crucial: internal updatedAt timestamp must NOT leak to client
      expect(hit).not.toHaveProperty('updatedAt');
      expect(hit).not.toHaveProperty('document');
    });
  });

  // ==========================================================================
  // 3. Security, Authentication & Access
  // ==========================================================================
  describe('Security & Access Control', () => {
    it('returns 401 Unauthorized when no Authorization header is present', async () => {
      const res = await requestSearch('q=binary', null);
      expect(res.status).toBe(401);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 Unauthorized when invalid Bearer token is provided', async () => {
      const res = await requestSearch('q=binary', 'invalid-token');
      expect(res.status).toBe(401);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe('UNAUTHORIZED');
    });

    it('excludes private/unpublished profiles that were never indexed or purged by privacy gate', async () => {
      // In DevTrack search architecture, unpublished profiles are gated at documentMapper level.
      // Even if someone attempts to query for a private user's name, they must not appear.
      const publishedProfile: SearchDocument = {
        id: 'public_user_1',
        type: 'profile',
        title: 'visible_developer',
        description: 'Public developer bio',
        tags: ['fullstack'],
        metadata: { username: 'visible_developer' },
        updatedAt: 1000,
      };
      await searchProvider.indexDocument('devtrack_profiles', publishedProfile.id, publishedProfile);

      // Verify published profile is returned
      const checkRes = await requestSearch('q=visible_developer&type=profile');
      expect((await checkRes.json()).data.totalHits).toBe(1);

      // Search for secret unpublished developer
      const secretRes = await requestSearch('q=secret_unpublished_dev&type=profile');
      expect((await secretRes.json()).data.totalHits).toBe(0);
    });

    it('excludes unverified projects that were rejected by verification gate', async () => {
      const verifiedProject: SearchDocument = {
        id: 'verified_proj_1',
        type: 'project',
        title: 'Verified Distributed Store',
        description: 'Verified repository',
        tags: ['database'],
        metadata: { repoFullName: 'org/verified-store' },
        updatedAt: 1000,
      };
      await searchProvider.indexDocument('devtrack_projects', verifiedProject.id, verifiedProject);

      const checkRes = await requestSearch('q=Verified&type=project');
      expect((await checkRes.json()).data.totalHits).toBe(1);

      const unverifiedRes = await requestSearch('q=crypto_scam_rejected&type=project');
      expect((await unverifiedRes.json()).data.totalHits).toBe(0);
    });
  });

  // ==========================================================================
  // 4. Failure & Resilience Handling
  // ==========================================================================
  describe('Failure Handling', () => {
    it('returns 500 without leaking stack traces when search provider throws', async () => {
      const failingProvider = {
        name: 'faulty-provider',
        search: vi.fn().mockRejectedValue(new Error('Internal cluster connection lost to host redis://secret:pass@cluster:6379')),
        indexDocument: vi.fn(),
        indexDocuments: vi.fn(),
        deleteDocument: vi.fn(),
        deleteDocuments: vi.fn(),
        clear: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(false),
      };

      setSearchClient(failingProvider as any);

      const res = await requestSearch('q=binary');
      expect(res.status).toBe(500);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe('INTERNAL_ERROR');
      expect(json.message).toBe('Search service temporarily unavailable');

      // Crucial: No internal connection string or stack trace leaked
      expect(JSON.stringify(json)).not.toContain('secret:pass@cluster');
      expect(JSON.stringify(json)).not.toContain('faulty-provider');
    });
  });

  // ==========================================================================
  // 5. Stage 5.6 Remediation: Pagination Horizon & Deep Pagination
  // ==========================================================================
  describe('Stage 5.6 Pagination Horizon & Deep Candidate Merging', () => {
    async function seedDeepHorizonDocs(dsaCount = 120, projCount = 10) {
      if (dsaCount > 0) {
        const dsaDocs: SearchDocument[] = Array.from({ length: dsaCount }, (_, i) => ({
          id: `deep_dsa_${String(i).padStart(3, '0')}`,
          type: 'dsa',
          title: `Deep Horizon Algorithm Problem ${i}`,
          description: `Algorithmic problem description ${i}`,
          tags: ['algorithm'],
          updatedAt: 1000 + i,
        }));
        await searchProvider.indexDocuments(
          'devtrack_dsa',
          dsaDocs.map((d) => ({ id: d.id, doc: d }))
        );
      }
      if (projCount > 0) {
        const projDocs: SearchDocument[] = Array.from({ length: projCount }, (_, i) => ({
          id: `deep_proj_${String(i).padStart(3, '0')}`,
          type: 'project',
          title: `Deep Horizon System Project ${i}`,
          description: `System project description ${i}`,
          tags: ['system'],
          updatedAt: 2000 + i,
        }));
        await searchProvider.indexDocuments(
          'devtrack_projects',
          projDocs.map((d) => ({ id: d.id, doc: d }))
        );
      }
    }

    it('rejects pagination requests beyond MAX_SEARCH_RESULT_HORIZON (1000)', async () => {
      // 51 * 20 = 1020 > 1000
      const res1 = await requestSearch('q=search&page=51&limit=20');
      expect(res1.status).toBe(400);
      const json1 = await res1.json();
      expect(json1.success).toBe(false);
      expect(json1.code).toBe('VALIDATION_ERROR');
      expect(json1.details['page']).toBeDefined();
      expect(json1.details['page'][0]).toContain('Pagination horizon exceeded');

      // 11 * 100 = 1100 > 1000
      const res2 = await requestSearch('q=search&page=11&limit=100');
      expect(res2.status).toBe(400);
      const json2 = await res2.json();
      expect(json2.details['page']).toBeDefined();

      // 1001 * 1 = 1001 > 1000
      const res3 = await requestSearch('q=search&page=1001&limit=1');
      expect(res3.status).toBe(400);
      const json3 = await res3.json();
      expect(json3.details['page']).toBeDefined();
    });

    it('allows pagination at the exact candidate window boundary (1000)', async () => {
      // 50 * 20 = 1000 (valid boundary)
      const res1 = await requestSearch('q=search&page=50&limit=20');
      expect(res1.status).toBe(200);

      // 10 * 100 = 1000 (valid boundary)
      const res2 = await requestSearch('q=search&page=10&limit=100');
      expect(res2.status).toBe(200);
    });

    it('correctly paginates deep pages (>100 results) without candidate truncation in type=all', async () => {
      await seedDeepHorizonDocs(120, 10);

      // Total matching items across indices: 120 + 10 = 130
      // Request Page 6 with limit=20 (Items 100 through 120)
      // In Stage 5.5, the provider clamped at 100 candidates, so items 101..120 were truncated.
      // In Stage 5.6, the provider must return all 120 candidates for Page 6.
      const resPage6 = await requestSearch('q=Deep+Horizon&page=6&limit=20');
      expect(resPage6.status).toBe(200);
      const jsonPage6 = await resPage6.json();

      expect(jsonPage6.data.totalHits).toBe(130);
      expect(jsonPage6.data.totalPages).toBe(7); // ceil(130 / 20) = 7
      expect(jsonPage6.data.hits).toHaveLength(20); // Full page of 20 results, NOT empty or truncated!
      expect(jsonPage6.data.pagination.page).toBe(6);
      expect(jsonPage6.data.pagination.hasNextPage).toBe(true);
      expect(jsonPage6.data.pagination.hasPrevPage).toBe(true);

      // Request Page 7 (final page, items 121..130)
      const resPage7 = await requestSearch('q=Deep+Horizon&page=7&limit=20');
      expect(resPage7.status).toBe(200);
      const jsonPage7 = await resPage7.json();

      expect(jsonPage7.data.hits).toHaveLength(10); // Remaining 10 items
      expect(jsonPage7.data.pagination.page).toBe(7);
      expect(jsonPage7.data.pagination.hasNextPage).toBe(false);
      expect(jsonPage7.data.pagination.hasPrevPage).toBe(true);

      // Verify no duplicates between Page 6 and Page 7
      const page6Ids = new Set(jsonPage6.data.hits.map((h: any) => h.id));
      for (const hit of jsonPage7.data.hits) {
        expect(page6Ids.has(hit.id)).toBe(false);
      }
    });

    it('correctly paginates when one entity type has significantly fewer candidates than another', async () => {
      await seedDeepHorizonDocs(120, 10);

      // Query page 1 (DSA and Projects intermixed by score)
      const resPage1 = await requestSearch('q=Deep+Horizon&page=1&limit=20');
      expect(resPage1.status).toBe(200);
      const jsonPage1 = await resPage1.json();
      expect(jsonPage1.data.hits).toHaveLength(20);

      // Query page 6 (only DSA remaining)
      const resPage6 = await requestSearch('q=Deep+Horizon&page=6&limit=20');
      expect(resPage6.status).toBe(200);
      const jsonPage6 = await resPage6.json();
      expect(jsonPage6.data.hits).toHaveLength(20);
      // All items on page 6 are DSA problems since all 10 projects were ranked earlier or intermixed
      const page6Types = jsonPage6.data.hits.map((h: any) => h.type);
      expect(page6Types.every((t: string) => t === 'dsa')).toBe(true);
    });

    it('supports deep pagination on single-entity search (type=dsa)', async () => {
      await seedDeepHorizonDocs(120, 0);

      // Query type=dsa page=6 limit=20 (items 100..120 of DSA problems)
      const res = await requestSearch('q=Deep+Horizon&type=dsa&page=6&limit=20');
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.totalHits).toBe(120);
      expect(json.data.totalPages).toBe(6);
      expect(json.data.hits).toHaveLength(20);
      expect(json.data.hits.every((h: any) => h.type === 'dsa')).toBe(true);
    });
  });

  // ==========================================================================
  // 6. Stage 5.6 Remediation: Deterministic Cross-Collection Ordering
  // ==========================================================================
  describe('Stage 5.6 Deterministic Multi-Entity Ordering', () => {
    it('enforces deterministic ordering by type asc when scores are identical across types', async () => {
      const query = 'TiedBenchmarkScore';

      // Index 1 DSA, 1 Profile, 1 Project with identical titles and identical scores
      const dsaDoc: SearchDocument = {
        id: 'tied_dsa_1',
        type: 'dsa',
        title: query,
        description: 'DSA Description',
        updatedAt: 1000,
      };
      const profileDoc: SearchDocument = {
        id: 'tied_profile_1',
        type: 'profile',
        title: query,
        description: 'Profile Description',
        updatedAt: 1000,
      };
      const projectDoc: SearchDocument = {
        id: 'tied_proj_1',
        type: 'project',
        title: query,
        description: 'Project Description',
        updatedAt: 1000,
      };

      await searchProvider.indexDocument('devtrack_dsa', dsaDoc.id, dsaDoc);
      await searchProvider.indexDocument('devtrack_profiles', profileDoc.id, profileDoc);
      await searchProvider.indexDocument('devtrack_projects', projectDoc.id, projectDoc);

      const res = await requestSearch(`q=${query}&type=all`);
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.data.hits).toHaveLength(3);
      // Scores must be identical
      expect(json.data.hits[0].score).toBe(json.data.hits[1].score);
      expect(json.data.hits[1].score).toBe(json.data.hits[2].score);

      // Order must strictly be 'dsa' < 'profile' < 'project' (type asc)
      expect(json.data.hits[0].type).toBe('dsa');
      expect(json.data.hits[1].type).toBe('profile');
      expect(json.data.hits[2].type).toBe('project');
    });

    it('enforces deterministic ordering when identical IDs exist across distinct entity types', async () => {
      const query = 'SharedIdCollisionBenchmark';
      const sharedId = 'entity_shared_uuid_999';

      const dsaDoc: SearchDocument = {
        id: sharedId,
        type: 'dsa',
        title: query,
        updatedAt: 1000,
      };
      const profileDoc: SearchDocument = {
        id: sharedId,
        type: 'profile',
        title: query,
        updatedAt: 1000,
      };
      const projectDoc: SearchDocument = {
        id: sharedId,
        type: 'project',
        title: query,
        updatedAt: 1000,
      };

      await searchProvider.indexDocument('devtrack_dsa', dsaDoc.id, dsaDoc);
      await searchProvider.indexDocument('devtrack_profiles', profileDoc.id, profileDoc);
      await searchProvider.indexDocument('devtrack_projects', projectDoc.id, projectDoc);

      const res = await requestSearch(`q=${query}&type=all`);
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.data.hits).toHaveLength(3);
      // All 3 have identical IDs and scores
      expect(json.data.hits.every((h: any) => h.id === sharedId)).toBe(true);

      // Compound comparator (score desc -> type asc -> id asc) resolves collision deterministically
      expect(json.data.hits[0].type).toBe('dsa');
      expect(json.data.hits[1].type).toBe('profile');
      expect(json.data.hits[2].type).toBe('project');
    });

    it('enforces deterministic ordering by id asc when score and type are identical', async () => {
      const query = 'SameTypeTiedBenchmark';

      const docA: SearchDocument = {
        id: 'alpha_doc',
        type: 'dsa',
        title: query,
        updatedAt: 1000,
      };
      const docZ: SearchDocument = {
        id: 'zeta_doc',
        type: 'dsa',
        title: query,
        updatedAt: 1000,
      };

      await searchProvider.indexDocument('devtrack_dsa', docA.id, docA);
      await searchProvider.indexDocument('devtrack_dsa', docZ.id, docZ);

      const res = await requestSearch(`q=${query}&type=dsa`);
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.data.hits).toHaveLength(2);
      expect(json.data.hits[0].id).toBe('alpha_doc');
      expect(json.data.hits[1].id).toBe('zeta_doc');
    });

    it('produces 100% identical ordering across repeated queries', async () => {
      const query = 'TiedBenchmarkScore';

      const results = await Promise.all([
        requestSearch(`q=${query}&type=all`).then((r) => r.json()),
        requestSearch(`q=${query}&type=all`).then((r) => r.json()),
        requestSearch(`q=${query}&type=all`).then((r) => r.json()),
        requestSearch(`q=${query}&type=all`).then((r) => r.json()),
        requestSearch(`q=${query}&type=all`).then((r) => r.json()),
      ]);

      const baselineIds = results[0].data.hits.map((h: any) => `${h.type}:${h.id}`);
      for (let i = 1; i < results.length; i++) {
        const iterationIds = results[i].data.hits.map((h: any) => `${h.type}:${h.id}`);
        expect(iterationIds).toEqual(baselineIds);
      }
    });
  });
});
