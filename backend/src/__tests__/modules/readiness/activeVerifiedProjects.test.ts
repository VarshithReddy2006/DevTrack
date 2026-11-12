import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifiedFind = vi.fn();
const projectFind = vi.fn();
const ingest = vi.fn();

const chain = (rows: unknown[]) => ({ lean: async () => rows, select: () => ({ lean: async () => rows }) });

vi.mock('../../../db/models/verifiedProject.model.js', () => ({
  VerifiedProject: { find: (...a: unknown[]) => chain(verifiedFind(...a)) },
}));
vi.mock('../../../db/models/project.model.js', () => ({
  Project: { find: (...a: unknown[]) => chain(projectFind(...a)) },
}));
vi.mock('../../../modules/readiness/services/VerifiedProjectIngestionService.js', () => ({
  VerifiedProjectIngestionService: { ingest: (...a: unknown[]) => ingest(...a) },
}));

import { getActiveVerifiedProjects } from '../../../modules/readiness/services/activeVerifiedProjects.js';

const record = (over: Record<string, unknown>) => ({
  userId: 'u1',
  projectId: 'p1',
  verification: { status: 'verified', checks: {} },
  metrics: { userCommitCount: 12, lastCommitAt: new Date('2026-01-01') },
  ...over,
});

describe('getActiveVerifiedProjects', () => {
  beforeEach(() => {
    verifiedFind.mockReset();
    projectFind.mockReset().mockReturnValue([]);
    ingest.mockReset().mockResolvedValue('c1');
  });

  it('queries verified records, not the legacy provenance-less filter', async () => {
    verifiedFind.mockReturnValue([]);
    await getActiveVerifiedProjects('u1');
    expect(verifiedFind).toHaveBeenCalledWith({ userId: 'u1', 'verification.status': 'verified' });
  });

  it('includes github-sourced records discovered by sync', async () => {
    verifiedFind.mockReturnValue([
      record({
        provenance: {
          source: 'github', contributorId: 'c1', discoveredBySync: true,
          files: ['README.md', 'src/a.ts'], fileCount: 2, hasTests: true,
        },
      }),
    ]);
    const [p] = await getActiveVerifiedProjects('u1');
    expect(p).toMatchObject({
      commitCount: 12, fileCount: 2, hasTests: true, hasDocumentation: true, isFork: false,
    });
  });

  it('keeps legacy records that have no provenance', async () => {
    verifiedFind.mockReturnValue([record({})]);
    const out = await getActiveVerifiedProjects('u1');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ files: [], fileCount: 0, hasTests: false, hasDocumentation: false });
  });

  it('drops records from another contributor', async () => {
    verifiedFind.mockReturnValue([
      record({ provenance: { source: 'github', contributorId: 'other', discoveredBySync: true } }),
    ]);
    expect(await getActiveVerifiedProjects('u1')).toEqual([]);
  });

  it('drops linked records whose repo link no longer matches', async () => {
    verifiedFind.mockReturnValue([
      record({ provenance: { source: 'github', contributorId: 'c1', linkedRepoUrl: 'https://github.com/a/old' } }),
    ]);
    projectFind.mockReturnValue([{ _id: 'p1', repoUrl: 'https://github.com/a/new' }]);
    expect(await getActiveVerifiedProjects('u1')).toEqual([]);
  });

  it('keeps linked records whose repo link still matches', async () => {
    verifiedFind.mockReturnValue([
      record({ provenance: { source: 'github', contributorId: 'c1', linkedRepoUrl: 'https://github.com/a/x' } }),
    ]);
    projectFind.mockReturnValue([{ _id: 'p1', repoUrl: 'https://github.com/a/x' }]);
    expect(await getActiveVerifiedProjects('u1')).toHaveLength(1);
  });

  it('drops everything when no contributor id is available', async () => {
    ingest.mockResolvedValue(null);
    verifiedFind.mockReturnValue([
      record({ provenance: { source: 'github', contributorId: 'c1', discoveredBySync: true } }),
    ]);
    expect(await getActiveVerifiedProjects('u1')).toEqual([]);
  });
});

describe('readiness engines share the helper', () => {
  it('no engine filters on provenance.source $exists any more', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of [
      'intelligence/SkillIntelligenceEngine.ts',
      'engine/SkillNodeVerificationEngine.ts',
      'intelligence/ProjectIntelligenceEngine.ts',
    ]) {
      const src = readFileSync(new URL(`../../../modules/readiness/${f}`, import.meta.url), 'utf8');
      expect(src).not.toContain("'provenance.source': { $exists");
      expect(src).toContain('getActiveVerifiedProjects');
    }
  });
});
