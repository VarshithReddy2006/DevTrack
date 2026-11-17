import { describe, expect, it } from 'vitest';
import type { EvidenceClaim } from '../../../services/evidenceService';
import { claimSubjectType, filterClaimsBySearch, safeSourceUrl } from './evidenceLedger';

const base = { verificationStatus: 'verified', confidence: 80, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as const;
const claims: EvidenceClaim[] = [
  { ...base, id: '1', subjectType: 'repo', subjectKey: 'repo:acme/api', source: 'github', claimText: 'Maintains the acme API in TypeScript' },
  { ...base, id: '2', subjectType: 'dsa_rating', subjectKey: 'leetcode:rating', source: 'leetcode', claimText: 'Contest rating 1850' },
  { ...base, id: '3', subjectType: null, source: 'user', claimText: 'Led a team of four' },
];

describe('filterClaimsBySearch', () => {
  it('returns everything for a blank search', () => {
    expect(filterClaimsBySearch(claims, '   ')).toHaveLength(3);
  });

  it('matches claim text case-insensitively', () => {
    expect(filterClaimsBySearch(claims, 'typescript').map((c) => c.id)).toEqual(['1']);
  });

  it('matches the source label and the category label', () => {
    expect(filterClaimsBySearch(claims, 'leetcode').map((c) => c.id)).toEqual(['2']);
    expect(filterClaimsBySearch(claims, 'dsa rating').map((c) => c.id)).toEqual(['2']);
  });

  it('requires every term to match', () => {
    expect(filterClaimsBySearch(claims, 'acme rating')).toEqual([]);
  });
});

describe('claimSubjectType', () => {
  it('treats a missing subject type as a resume claim, like the backend does', () => {
    expect(claimSubjectType(claims[2])).toBe('resume_claim');
    expect(filterClaimsBySearch(claims, 'resume claim').map((c) => c.id)).toEqual(['3']);
  });
});

describe('safeSourceUrl', () => {
  it('only lets http and https links through', () => {
    expect(safeSourceUrl('https://github.com/acme/api')).toBe('https://github.com/acme/api');
    expect(safeSourceUrl('javascript:alert(1)')).toBeNull();
    expect(safeSourceUrl('not a url')).toBeNull();
    expect(safeSourceUrl(undefined)).toBeNull();
  });
});
