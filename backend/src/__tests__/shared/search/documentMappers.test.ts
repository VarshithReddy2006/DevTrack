// src/__tests__/shared/search/documentMappers.test.ts
// Unit tests for search document mappers, eligibility gates, and adversarial privacy leakage.

import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import {
  extractDocumentId,
  isDsaProblemEligible,
  isPublicProfileEligible,
  isVerifiedProjectEligible,
  isDocumentEligible,
  mapDsaProblemToSearch,
  mapPublicProfileToSearch,
  mapVerifiedProjectToSearch,
  mapDocumentToSearch,
} from '../../../shared/search/documentMappers.js';

describe('Document Mappers & Privacy Gates', () => {
  // ==========================================================================
  // extractDocumentId
  // ==========================================================================
  describe('extractDocumentId', () => {
    it('extracts string from Mongoose ObjectId _id', () => {
      const oid = new Types.ObjectId();
      expect(extractDocumentId({ _id: oid })).toBe(oid.toString());
    });

    it('extracts string from string _id', () => {
      expect(extractDocumentId({ _id: 'custom-id-123' })).toBe('custom-id-123');
    });

    it('extracts string from string id if _id is missing', () => {
      expect(extractDocumentId({ id: 'id-456' })).toBe('id-456');
    });

    it('returns null for null, undefined, primitives, or empty objects', () => {
      expect(extractDocumentId(null)).toBeNull();
      expect(extractDocumentId(undefined)).toBeNull();
      expect(extractDocumentId('string')).toBeNull();
      expect(extractDocumentId(123)).toBeNull();
      expect(extractDocumentId({})).toBeNull();
      expect(extractDocumentId({ _id: '' })).toBeNull();
      expect(extractDocumentId({ id: '   ' })).toBeNull();
      expect(extractDocumentId({ _id: {} })).toBeNull();
    });
  });

  // ==========================================================================
  // DsaProblem Mapper & Eligibility
  // ==========================================================================
  describe('DsaProblem Mapper', () => {
    const validDsaDoc = {
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      externalId: 'leetcode-1',
      title: 'Two Sum',
      platform: 'LeetCode',
      difficulty: 'Easy',
      category: 'Arrays & Hashing',
      tags: ['Array', 'Hash-Table', 'array'],
      url: 'https://leetcode.com/problems/two-sum/',
      status: 'solved',
      notes: 'Private personal notes and solution code that must not leak',
      timeTaken: 15,
      submissionCount: 3,
      isFavorite: true,
      updatedAt: new Date('2026-01-15T12:00:00Z'),
    };

    it('successfully maps a valid canonical DsaProblem', () => {
      const result = mapDsaProblemToSearch(validDsaDoc);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(validDsaDoc._id.toString());
      expect(result!.type).toBe('dsa');
      expect(result!.title).toBe('Two Sum');
      expect(result!.description).toBe('Arrays & Hashing');
      expect(result!.tags).toEqual(['array', 'hash-table']); // Lowercased and deduplicated
      expect(result!.metadata.platform).toBe('leetcode'); // Lowercased
      expect(result!.metadata.difficulty).toBe('easy'); // Normalized
      expect(result!.metadata.category).toBe('Arrays & Hashing');
      expect(result!.metadata.submissionCount).toBe(3);
      expect(result!.metadata.url).toBe('https://leetcode.com/problems/two-sum/');
      expect(result!.metadata.isFavorite).toBe(true);
      expect(result!.updatedAt).toBe(new Date('2026-01-15T12:00:00Z').getTime());
    });

    it('handles missing optional fields with safe defaults', () => {
      const minimalDoc = {
        _id: new Types.ObjectId(),
        title: 'Binary Search',
      };
      const result = mapDsaProblemToSearch(minimalDoc);
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Binary Search');
      expect(result!.description).toBe('General');
      expect(result!.tags).toEqual([]);
      expect(result!.metadata.platform).toBe('custom');
      expect(result!.metadata.difficulty).toBe('medium');
      expect(result!.metadata.category).toBe('General');
      expect(result!.metadata.submissionCount).toBe(0);
      expect(result!.metadata.url).toBe('');
      expect(result!.metadata.isFavorite).toBe(false);
      expect(typeof result!.updatedAt).toBe('number');
    });

    it('rejects invalid or empty records as ineligible (returns null)', () => {
      expect(mapDsaProblemToSearch(null)).toBeNull();
      expect(mapDsaProblemToSearch({})).toBeNull();
      expect(mapDsaProblemToSearch({ _id: new Types.ObjectId(), title: '' })).toBeNull();
      expect(mapDsaProblemToSearch({ _id: new Types.ObjectId(), title: '   ' })).toBeNull();
      expect(mapDsaProblemToSearch({ title: 'No ID problem' })).toBeNull();
    });

    it('STRICT PRIVACY: never leaks userId, notes, or timeTaken into mapped document', () => {
      const result = mapDsaProblemToSearch(validDsaDoc)!;
      const json = JSON.stringify(result);

      // Verify explicit values do not appear anywhere in serialized output
      expect(json).not.toContain(validDsaDoc.userId.toString());
      expect(json).not.toContain('Private personal notes');
      expect(json).not.toContain('timeTaken');

      // Verify specific keys do not exist in metadata or root
      expect((result as any).userId).toBeUndefined();
      expect((result as any).notes).toBeUndefined();
      expect((result as any).timeTaken).toBeUndefined();
      expect((result.metadata as any).userId).toBeUndefined();
      expect((result.metadata as any).notes).toBeUndefined();
      expect((result.metadata as any).timeTaken).toBeUndefined();
    });

    it('is completely non-mutating on input object', () => {
      const frozenDoc = Object.freeze({
        _id: 'dsa-frozen-id',
        title: 'Frozen Problem',
        tags: Object.freeze(['frozen', 'tag']),
        category: 'Algorithms',
        updatedAt: 123456789,
      });

      expect(() => mapDsaProblemToSearch(frozenDoc)).not.toThrow();
    });

    it('produces deterministic output across repeated calls', () => {
      const first = mapDsaProblemToSearch(validDsaDoc);
      const second = mapDsaProblemToSearch(validDsaDoc);
      expect(first).toEqual(second);
    });
  });

  // ==========================================================================
  // PublicProfile Mapper & Eligibility Gate Matrix
  // ==========================================================================
  describe('PublicProfile Mapper & Eligibility Gate', () => {
    const validProfile = {
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      username: 'alice_dev',
      slug: 'alice_dev',
      visibility: 'public',
      isIndexable: true,
      published: true,
      settings: {
        theme: 'monokai-hacker',
      },
      snapshot: {
        identity: {
          displayName: 'Alice Engineer',
          avatarUrl: 'https://cdn.devtrack.io/avatars/alice.png',
          level: 42,
          levelName: 'Grandmaster',
        },
        github: {
          primaryLanguages: ['TypeScript', 'Rust', 'typescript'],
        },
      },
      // Sensitive fields that MUST NOT leak
      email: 'alice@example.com',
      passwordHash: 'secret-hash-12345',
      antiGaming: {
        suspicionScore: 0,
        flags: ['suspicious_speed'],
        isFlagged: false,
      },
      publication: {
        consentVersion: 'v1.0.0',
      },
      stats: {
        recruiterViews: 100,
        profileViews: 5000,
      },
      updatedAt: new Date('2026-02-01T08:00:00Z'),
    };

    // --- 8-Combination Eligibility Gate Matrix ---
    describe('8-Combination Eligibility Gate Matrix', () => {
      it('Combination 1: { published: true, visibility: "public", isIndexable: true } => ELIGIBLE', () => {
        const doc = { ...validProfile, published: true, visibility: 'public', isIndexable: true };
        expect(isPublicProfileEligible(doc)).toBe(true);
        expect(mapPublicProfileToSearch(doc)).not.toBeNull();
      });

      it('Combination 2: { published: false, visibility: "public", isIndexable: true } => INELIGIBLE', () => {
        const doc = { ...validProfile, published: false, visibility: 'public', isIndexable: true };
        expect(isPublicProfileEligible(doc)).toBe(false);
        expect(mapPublicProfileToSearch(doc)).toBeNull();
      });

      it('Combination 3: { published: true, visibility: "private", isIndexable: true } => INELIGIBLE', () => {
        const doc = { ...validProfile, published: true, visibility: 'private', isIndexable: true };
        expect(isPublicProfileEligible(doc)).toBe(false);
        expect(mapPublicProfileToSearch(doc)).toBeNull();
      });

      it('Combination 4: { published: true, visibility: "public", isIndexable: false } => INELIGIBLE', () => {
        const doc = { ...validProfile, published: true, visibility: 'public', isIndexable: false };
        expect(isPublicProfileEligible(doc)).toBe(false);
        expect(mapPublicProfileToSearch(doc)).toBeNull();
      });

      it('Combination 5: { published: false, visibility: "private", isIndexable: false } => INELIGIBLE', () => {
        const doc = { ...validProfile, published: false, visibility: 'private', isIndexable: false };
        expect(isPublicProfileEligible(doc)).toBe(false);
        expect(mapPublicProfileToSearch(doc)).toBeNull();
      });

      it('Combination 6: { published: missing, visibility: "public", isIndexable: true } => INELIGIBLE', () => {
        const doc = { ...validProfile, visibility: 'public', isIndexable: true };
        delete (doc as any).published;
        expect(isPublicProfileEligible(doc)).toBe(false);
        expect(mapPublicProfileToSearch(doc)).toBeNull();
      });

      it('Combination 7: { published: true, visibility: missing, isIndexable: true } => INELIGIBLE', () => {
        const doc = { ...validProfile, published: true, isIndexable: true };
        delete (doc as any).visibility;
        expect(isPublicProfileEligible(doc)).toBe(false);
        expect(mapPublicProfileToSearch(doc)).toBeNull();
      });

      it('Combination 8: { published: true, visibility: "public", isIndexable: missing } => INELIGIBLE', () => {
        const doc = { ...validProfile, published: true, visibility: 'public' };
        delete (doc as any).isIndexable;
        expect(isPublicProfileEligible(doc)).toBe(false);
        expect(mapPublicProfileToSearch(doc)).toBeNull();
      });
    });

    // --- Strict Type Coercion Defense ---
    describe('Type Coercion and Boundary Resistance', () => {
      it('rejects truthy non-boolean values for published (e.g. "true", 1)', () => {
        expect(mapPublicProfileToSearch({ ...validProfile, published: 'true' })).toBeNull();
        expect(mapPublicProfileToSearch({ ...validProfile, published: 1 })).toBeNull();
      });

      it('rejects truthy non-boolean values for isIndexable (e.g. "true", 1)', () => {
        expect(mapPublicProfileToSearch({ ...validProfile, isIndexable: 'true' })).toBeNull();
        expect(mapPublicProfileToSearch({ ...validProfile, isIndexable: 1 })).toBeNull();
      });

      it('rejects non-public visibility (e.g. "recruiter_only", "Public", "all")', () => {
        expect(mapPublicProfileToSearch({ ...validProfile, visibility: 'recruiter_only' })).toBeNull();
        expect(mapPublicProfileToSearch({ ...validProfile, visibility: 'Public' })).toBeNull();
        expect(mapPublicProfileToSearch({ ...validProfile, visibility: 'all' })).toBeNull();
      });

      it('rejects empty, whitespace, or missing usernames', () => {
        expect(mapPublicProfileToSearch({ ...validProfile, username: '' })).toBeNull();
        expect(mapPublicProfileToSearch({ ...validProfile, username: '   ' })).toBeNull();
        const noUser = { ...validProfile };
        delete (noUser as any).username;
        expect(mapPublicProfileToSearch(noUser)).toBeNull();
      });

      it('rejects null, undefined, and non-object inputs safely', () => {
        expect(mapPublicProfileToSearch(null)).toBeNull();
        expect(mapPublicProfileToSearch(undefined)).toBeNull();
        expect(mapPublicProfileToSearch('malformed')).toBeNull();
        expect(mapPublicProfileToSearch(999)).toBeNull();
        expect(mapPublicProfileToSearch([])).toBeNull();
      });
    });

    // --- Privacy Leakage Defense ---
    describe('Privacy & Leakage Defense', () => {
      it('STRICT PRIVACY: never leaks internal IDs, contact info, anti-gaming, or private metadata', () => {
        const result = mapPublicProfileToSearch(validProfile)!;
        expect(result).not.toBeNull();
        const json = JSON.stringify(result);

        // Assert sensitive strings are completely absent
        expect(json).not.toContain(validProfile.userId.toString());
        expect(json).not.toContain('alice@example.com');
        expect(json).not.toContain('secret-hash-12345');
        expect(json).not.toContain('suspicious_speed');
        expect(json).not.toContain('consentVersion');
        expect(json).not.toContain('recruiterViews');

        // Assert sensitive keys are undefined
        expect((result as any).userId).toBeUndefined();
        expect((result as any).email).toBeUndefined();
        expect((result as any).passwordHash).toBeUndefined();
        expect((result as any).antiGaming).toBeUndefined();
        expect((result as any).stats).toBeUndefined();
        expect((result.metadata as any).userId).toBeUndefined();
        expect((result.metadata as any).antiGaming).toBeUndefined();
      });

      it('correctly maps permitted public fields', () => {
        const result = mapPublicProfileToSearch(validProfile)!;
        expect(result.id).toBe(validProfile._id.toString());
        expect(result.type).toBe('profile');
        expect(result.title).toBe('alice_dev');
        expect(result.description).toBe('Alice Engineer');
        expect(result.tags).toEqual(['grandmaster', 'typescript', 'rust']);
        expect(result.metadata.username).toBe('alice_dev');
        expect(result.metadata.slug).toBe('alice_dev');
        expect(result.metadata.displayName).toBe('Alice Engineer');
        expect(result.metadata.avatarUrl).toBe('https://cdn.devtrack.io/avatars/alice.png');
        expect(result.metadata.level).toBe(42);
        expect(result.metadata.levelName).toBe('Grandmaster');
        expect(result.metadata.theme).toBe('monokai-hacker');
        expect(result.updatedAt).toBe(new Date('2026-02-01T08:00:00Z').getTime());
      });

      it('falls back safely when optional snapshot or identity fields are missing', () => {
        const minimalProfile = {
          _id: 'profile-id-123',
          username: 'bob_builder',
          published: true,
          visibility: 'public',
          isIndexable: true,
        };
        const result = mapPublicProfileToSearch(minimalProfile)!;
        expect(result).not.toBeNull();
        expect(result.title).toBe('bob_builder');
        expect(result.description).toBe('bob_builder');
        expect(result.metadata.displayName).toBe('bob_builder');
        expect(result.metadata.avatarUrl).toBeNull();
        expect(result.metadata.level).toBe(1);
        expect(result.metadata.levelName).toBe('Novice');
        expect(result.metadata.theme).toBe('modern-dark');
      });

      it('is completely non-mutating on input object', () => {
        const frozenProfile = Object.freeze({
          _id: 'frozen-profile-id',
          username: 'frozen_user',
          published: true,
          visibility: 'public',
          isIndexable: true,
          snapshot: Object.freeze({
            identity: Object.freeze({
              displayName: 'Frozen User',
            }),
          }),
        });

        expect(() => mapPublicProfileToSearch(frozenProfile)).not.toThrow();
      });
    });
  });

  // ==========================================================================
  // VerifiedProject Mapper & Verification Gate
  // ==========================================================================
  describe('VerifiedProject Mapper & Verification Gate', () => {
    const validProject = {
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      projectId: new Types.ObjectId(),
      githubRepoId: 'repo-12345',
      repoFullName: 'facebook/react',
      repoUrl: 'https://github.com/facebook/react',
      name: 'react',
      description: 'The library for web and native user interfaces',
      techStack: ['JavaScript', 'TypeScript', 'Flow', 'javascript'],
      verification: {
        status: 'verified',
        verifiedAt: new Date('2026-01-10T00:00:00Z'),
        rejectionReason: null,
        checks: {
          minCommits: true,
          minLocDelta: true,
          repoAge: true,
          notFork: true,
          notEmpty: true,
          notArchived: true,
          contributionConsistency: true,
          userIsContributor: true,
        },
      },
      metrics: {
        primaryLanguage: 'JavaScript',
        stars: 220000,
        forks: 45000,
        totalCommitCount: 16000,
        userCommitCount: 50,
      },
      antiGaming: {
        isCommitFarmed: false,
        hasEmptyCommits: false,
        suspicionScore: 0,
      },
      provenance: {
        source: 'github',
        checkedAccountId: 'gh-acc-999',
        contributorId: 'gh-user-888',
        files: ['secret_file.ts'],
      },
      updatedAt: new Date('2026-02-10T10:00:00Z'),
    };

    describe('Verification Status Gate', () => {
      it('accepts projects with verification.status === "verified"', () => {
        expect(isVerifiedProjectEligible(validProject)).toBe(true);
        expect(mapVerifiedProjectToSearch(validProject)).not.toBeNull();
      });

      it('rejects projects with verification.status === "pending"', () => {
        const doc = { ...validProject, verification: { ...validProject.verification, status: 'pending' } };
        expect(isVerifiedProjectEligible(doc)).toBe(false);
        expect(mapVerifiedProjectToSearch(doc)).toBeNull();
      });

      it('rejects projects with verification.status === "rejected"', () => {
        const doc = { ...validProject, verification: { ...validProject.verification, status: 'rejected' } };
        expect(isVerifiedProjectEligible(doc)).toBe(false);
        expect(mapVerifiedProjectToSearch(doc)).toBeNull();
      });

      it('rejects projects with verification.status === "needs_review"', () => {
        const doc = { ...validProject, verification: { ...validProject.verification, status: 'needs_review' } };
        expect(isVerifiedProjectEligible(doc)).toBe(false);
        expect(mapVerifiedProjectToSearch(doc)).toBeNull();
      });

      it('rejects projects with missing verification object or status', () => {
        expect(mapVerifiedProjectToSearch({ ...validProject, verification: undefined })).toBeNull();
        expect(mapVerifiedProjectToSearch({ ...validProject, verification: {} })).toBeNull();
        expect(mapVerifiedProjectToSearch({ ...validProject, verification: { status: undefined } })).toBeNull();
      });

      it('rejects projects with missing or empty repoFullName', () => {
        expect(mapVerifiedProjectToSearch({ ...validProject, repoFullName: '' })).toBeNull();
        expect(mapVerifiedProjectToSearch({ ...validProject, repoFullName: '   ' })).toBeNull();
        const noRepo = { ...validProject };
        delete (noRepo as any).repoFullName;
        expect(mapVerifiedProjectToSearch(noRepo)).toBeNull();
      });
    });

    describe('Privacy & Leakage Defense', () => {
      it('STRICT PRIVACY: never leaks userId, projectId, verification checks, antiGaming, or provenance', () => {
        const result = mapVerifiedProjectToSearch(validProject)!;
        expect(result).not.toBeNull();
        const json = JSON.stringify(result);

        // Verify sensitive strings are stripped
        expect(json).not.toContain(validProject.userId.toString());
        expect(json).not.toContain(validProject.projectId.toString());
        expect(json).not.toContain('gh-acc-999');
        expect(json).not.toContain('gh-user-888');
        expect(json).not.toContain('secret_file.ts');
        expect(json).not.toContain('minCommits');
        expect(json).not.toContain('isCommitFarmed');

        // Verify keys do not exist in metadata or root
        expect((result as any).userId).toBeUndefined();
        expect((result as any).projectId).toBeUndefined();
        expect((result as any).provenance).toBeUndefined();
        expect((result as any).antiGaming).toBeUndefined();
        expect((result.metadata as any).userId).toBeUndefined();
        expect((result.metadata as any).projectId).toBeUndefined();
        expect((result.metadata as any).provenance).toBeUndefined();
        expect((result.metadata as any).antiGaming).toBeUndefined();
      });

      it('correctly maps public fields for verified projects', () => {
        const result = mapVerifiedProjectToSearch(validProject)!;
        expect(result.id).toBe(validProject._id.toString());
        expect(result.type).toBe('project');
        expect(result.title).toBe('facebook/react');
        expect(result.description).toBe('The library for web and native user interfaces');
        expect(result.tags).toEqual(['javascript', 'typescript', 'flow']);
        expect(result.metadata.repoFullName).toBe('facebook/react');
        expect(result.metadata.repoUrl).toBe('https://github.com/facebook/react');
        expect(result.metadata.primaryLanguage).toBe('JavaScript');
        expect(result.metadata.stars).toBe(220000);
        expect(result.metadata.forks).toBe(45000);
        expect(result.metadata.totalCommitCount).toBe(16000);
        expect(result.metadata.techStack).toEqual(['javascript', 'typescript', 'flow']);
        expect(result.updatedAt).toBe(new Date('2026-02-10T10:00:00Z').getTime());
      });

      it('falls back safely when optional metrics or description are missing', () => {
        const minimalProject = {
          _id: 'proj-min-id',
          repoFullName: 'user/minimal-repo',
          verification: { status: 'verified' },
        };
        const result = mapVerifiedProjectToSearch(minimalProject)!;
        expect(result).not.toBeNull();
        expect(result.title).toBe('user/minimal-repo');
        expect(result.description).toBe('');
        expect(result.tags).toEqual([]);
        expect(result.metadata.primaryLanguage).toBe('Unknown');
        expect(result.metadata.stars).toBe(0);
        expect(result.metadata.forks).toBe(0);
        expect(result.metadata.totalCommitCount).toBe(0);
        expect(result.metadata.techStack).toEqual([]);
      });

      it('is completely non-mutating on input object', () => {
        const frozenProject = Object.freeze({
          _id: 'frozen-proj-id',
          repoFullName: 'org/frozen-repo',
          verification: Object.freeze({ status: 'verified' }),
          metrics: Object.freeze({ stars: 10 }),
        });

        expect(() => mapVerifiedProjectToSearch(frozenProject)).not.toThrow();
      });
    });
  });

  // ==========================================================================
  // Cross-Mapper & Universal Dispatcher Tests
  // ==========================================================================
  describe('Cross-Mapper & Universal Dispatcher', () => {
    it('dispatches mapDocumentToSearch correctly for each entity type', () => {
      const dsaDoc = { _id: 'd1', title: 'Two Sum' };
      const profileDoc = { _id: 'p1', username: 'alice', published: true, visibility: 'public', isIndexable: true };
      const projectDoc = { _id: 'pr1', repoFullName: 'org/repo', verification: { status: 'verified' } };

      const dsaRes = mapDocumentToSearch('dsa', dsaDoc);
      expect(dsaRes).not.toBeNull();
      expect(dsaRes!.type).toBe('dsa');

      const profileRes = mapDocumentToSearch('profile', profileDoc);
      expect(profileRes).not.toBeNull();
      expect(profileRes!.type).toBe('profile');

      const projectRes = mapDocumentToSearch('project', projectDoc);
      expect(projectRes).not.toBeNull();
      expect(projectRes!.type).toBe('project');
    });

    it('evaluates isDocumentEligible correctly for all entity types', () => {
      expect(isDocumentEligible('dsa', { _id: 'd1', title: 'Problem' })).toBe(true);
      expect(isDocumentEligible('dsa', { _id: 'd1' })).toBe(false);

      expect(isDocumentEligible('profile', { _id: 'p1', username: 'u', published: true, visibility: 'public', isIndexable: true })).toBe(true);
      expect(isDocumentEligible('profile', { _id: 'p1', username: 'u', published: false, visibility: 'public', isIndexable: true })).toBe(false);

      expect(isDocumentEligible('project', { _id: 'pr1', repoFullName: 'r', verification: { status: 'verified' } })).toBe(true);
      expect(isDocumentEligible('project', { _id: 'pr1', repoFullName: 'r', verification: { status: 'pending' } })).toBe(false);
    });

    it('returns null when dispatching for an invalid or unknown entity type', () => {
      expect(mapDocumentToSearch('unknown' as any, { _id: '1' })).toBeNull();
      expect(isDocumentEligible('unknown' as any, { _id: '1' })).toBe(false);
    });

    it('returns null consistently for ineligible records across all mappers', () => {
      expect(mapDocumentToSearch('dsa', {})).toBeNull();
      expect(mapDocumentToSearch('profile', {})).toBeNull();
      expect(mapDocumentToSearch('project', {})).toBeNull();
    });
  });
});
