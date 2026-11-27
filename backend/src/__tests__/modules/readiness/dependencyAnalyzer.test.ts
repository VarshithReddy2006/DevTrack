// dependencyAnalyzer.test.ts: manifest analysis with fixture manifests; GitHub is never contacted.
import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResumeEvidenceClaim } from '../../../db/models/resumeEvidenceClaim.model.js';
import { NonRetryableError, RetryableError } from '../../../infrastructure/queues/ErrorClassifier.js';
import {
  analyzeProject,
  fetchRepositorySnapshot,
  needsArchitecturalProfile,
  processArchitecturalProfile,
  selectManifestPaths,
} from '../../../modules/readiness/dependencyAnalyzer.service.js';
import { evidenceInputHash } from '../../../modules/readiness/verification/evidenceProof.js';
import { GitHubResponseTooLargeError } from '../../../modules/readiness/verification/githubVerifier.service.js';
import {
  CARGO_TOML,
  GO_MOD,
  GO_MOD_ECHO,
  MALFORMED_PACKAGE_JSON,
  NODE_FULLSTACK_PACKAGE_JSON,
  NODE_LEGACY_PACKAGE_JSON,
  NODE_TOY_PACKAGE_JSON,
  POM_XML,
  PYPROJECT_TOML,
  PYTHON_REQUIREMENTS,
} from '../../fixtures/dependencyManifests.js';

const SHA = 'c'.repeat(40);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('analyzeProject', () => {
  it('gives a full-stack TypeScript project with tests, CI and Docker the full score', () => {
    const analysis = analyzeProject({
      manifests: [{ path: 'package.json', content: NODE_FULLSTACK_PACKAGE_JSON }],
      paths: ['package.json', 'src/server.ts', 'src/cart.test.ts', 'e2e/checkout.spec.ts', '.github/workflows/ci.yml', 'Dockerfile', 'tsconfig.json'],
    });

    expect(analysis.score).toBe(100);
    expect(analysis.breakdown).toEqual({
      framework: 20, dataLayer: 15, testFramework: 20, testFiles: 15, qualityTooling: 10, ci: 10, containerization: 10, deprecatedPenalty: 0,
    });
    expect(analysis.frameworkTier).toBe('fullstack');
    expect(analysis.frameworks).toEqual([
      { name: 'react', ecosystem: 'npm', category: 'frontend' },
      { name: 'express', ecosystem: 'npm', category: 'backend' },
    ]);
    expect(analysis.dataLayer).toEqual([
      { name: '@prisma/client', ecosystem: 'npm', kind: 'orm' },
      { name: 'prisma', ecosystem: 'npm', kind: 'orm' },
    ]);
    expect(analysis.testing).toEqual({
      libraries: [{ name: 'vitest', ecosystem: 'npm' }, { name: '@playwright/test', ecosystem: 'npm' }],
      testFiles: 2,
    });
    expect(analysis.qualityTooling).toEqual(['eslint', 'typescript']);
    expect(analysis.manifests).toEqual([{ path: 'package.json', ecosystem: 'npm', dependencies: 5, devDependencies: 5, malformed: false }]);
    expect(analysis.dependencyCount).toEqual({ runtime: 5, dev: 5 });
    expect(analysis.deprecated).toEqual([]);
  });

  it('scores a toy project with no framework, tests or tooling at zero', () => {
    const analysis = analyzeProject({ manifests: [{ path: 'package.json', content: NODE_TOY_PACKAGE_JSON }], paths: ['index.js', 'package.json'] });

    expect(analysis).toMatchObject({ score: 0, frameworkTier: 'none', frameworks: [], dataLayer: [], ci: false, containerized: false });
    expect(analysis.testing).toEqual({ libraries: [], testFiles: 0 });
  });

  it('flags deprecated and insecure packages and caps the penalty', () => {
    const analysis = analyzeProject({
      manifests: [
        { path: 'package.json', content: NODE_LEGACY_PACKAGE_JSON },
        { path: 'scripts/requirements.txt', content: PYTHON_REQUIREMENTS },
      ],
      paths: [],
    });

    expect(analysis.deprecated.map(item => [item.name, item.kind])).toEqual([
      ['request', 'deprecated'], ['node-sass', 'deprecated'], ['moment', 'unmaintained'], ['tslint', 'deprecated'], ['pycrypto', 'security'],
    ]);
    expect(analysis.deprecated.find(item => item.name === 'node-sass')).toMatchObject({ replacement: 'sass' });
    expect(analysis.breakdown.deprecatedPenalty).toBe(-20);
    // express + fastapi (20), mongoose and sqlalchemy (15), @testing-library and pytest (20), minus 20.
    expect(analysis.score).toBe(35);
  });

  it('reads Python, Go, Rust, Java and JavaScript manifests in one repository', () => {
    const analysis = analyzeProject({
      manifests: [
        { path: 'api/requirements.txt', content: PYTHON_REQUIREMENTS },
        { path: 'blog/pyproject.toml', content: PYPROJECT_TOML },
        { path: 'services/gateway/go.mod', content: GO_MOD },
        { path: 'worker/Cargo.toml', content: CARGO_TOML },
        { path: 'legacy/pom.xml', content: POM_XML },
        { path: 'web/package.json', content: NODE_FULLSTACK_PACKAGE_JSON },
      ],
      paths: ['services/gateway/main_test.go', 'api/tests/test_orders.py', 'ruff.toml'],
    });

    expect(analysis.ecosystems).toEqual(['pypi', 'go', 'cargo', 'maven', 'npm']);
    expect(analysis.frameworks.map(item => item.name)).toEqual([
      'fastapi', 'django', 'github.com/gin-gonic/gin', 'axum', 'org.springframework.boot:spring-boot-starter-web', 'react', 'express',
    ]);
    expect(analysis.dataLayer).toEqual(expect.arrayContaining([
      { name: 'gorm.io/gorm', ecosystem: 'go', kind: 'orm' },
      { name: 'sqlx', ecosystem: 'cargo', kind: 'driver' },
      { name: 'org.springframework.boot:spring-boot-starter-data-jpa', ecosystem: 'maven', kind: 'orm' },
      { name: 'psycopg', ecosystem: 'pypi', kind: 'driver' },
    ]));
    expect(analysis.testing.libraries.map(item => item.name)).toEqual(expect.arrayContaining([
      'pytest', 'github.com/stretchr/testify', 'proptest', 'org.springframework.boot:spring-boot-starter-test',
    ]));
    expect(analysis.deprecated.map(item => item.name)).toEqual(['pycrypto', 'github.com/dgrijalva/jwt-go', 'log4j:log4j']);
    // The indirect golang.org/x/sys requirement is not a direct dependency.
    expect(analysis.manifests.find(item => item.ecosystem === 'go')).toMatchObject({ path: 'services/gateway/go.mod', dependencies: 4 });
    expect(analysis.qualityTooling).toEqual(['eslint', 'ruff', 'typescript']);
    expect(analysis.testing.testFiles).toBe(2);
  });

  it('counts the Go toolchain test runner when _test.go files exist', () => {
    const analysis = analyzeProject({
      manifests: [{ path: 'go.mod', content: GO_MOD_ECHO }],
      paths: ['main.go', 'handlers/user_test.go'],
    });

    expect(analysis.frameworks).toEqual([{ name: 'github.com/labstack/echo/v4', ecosystem: 'go', category: 'backend' }]);
    expect(analysis.testing.libraries).toEqual([]);
    expect(analysis.breakdown).toMatchObject({ testFramework: 20, testFiles: 15 });
  });

  it('marks a malformed or oversized manifest and still analyzes the others', () => {
    const analysis = analyzeProject({
      manifests: [
        { path: 'package.json', content: MALFORMED_PACKAGE_JSON },
        { path: 'huge/package.json', content: `{"dependencies":{"react":"1"},"x":"${'a'.repeat(600 * 1024)}"}` },
        { path: 'requirements.txt', content: PYTHON_REQUIREMENTS },
        { path: 'README.md', content: '# not a manifest' },
      ],
    });

    expect(analysis.manifests).toEqual([
      { path: 'package.json', ecosystem: 'npm', dependencies: 0, devDependencies: 0, malformed: true },
      { path: 'huge/package.json', ecosystem: 'npm', dependencies: 0, devDependencies: 0, malformed: true },
      { path: 'requirements.txt', ecosystem: 'pypi', dependencies: 5, devDependencies: 0, malformed: false },
    ]);
    expect(analysis.frameworks.map(item => item.name)).toEqual(['fastapi']);
  });

  it('ignores vendored, example and fixture code when looking at the tree', () => {
    const analysis = analyzeProject({
      manifests: [],
      paths: ['node_modules/lib/test/index.test.js', 'examples/demo/Dockerfile', 'docs/.github/workflows/x.yml', 'vendor/pkg/a_test.go'],
    });

    expect(analysis).toMatchObject({ ci: false, containerized: false, testing: { testFiles: 0 }, score: 0 });
  });
});

describe('selectManifestPaths', () => {
  it('keeps shallow, non-vendored manifests, root first, and skips oversized files', () => {
    const paths = selectManifestPaths([
      { path: 'frontend/package.json', size: 900 },
      { path: 'package.json', size: 400 },
      { path: 'node_modules/react/package.json', size: 300 },
      { path: 'docs/requirements.txt', size: 50 },
      { path: 'apps/api/go.mod', size: 120 },
      { path: 'a/b/c/Cargo.toml', size: 80 },
      { path: 'big/package.json', size: 600 * 1024 },
      { path: 'src/index.ts', size: 2000 },
    ]);
    expect(paths).toEqual(['package.json', 'frontend/package.json', 'apps/api/go.mod']);
  });

  it('fetches at most eight manifests', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ path: `pkg${String(i).padStart(2, '0')}/package.json`, size: 10 }));
    expect(selectManifestPaths(entries)).toHaveLength(8);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const base64 = (text: string) => Buffer.from(text).toString('base64');

describe('fetchRepositorySnapshot', () => {
  it('reads the tree and base64 manifest contents through the GitHub REST API', async () => {
    const routes: Record<string, unknown> = {
      '/repos/alex/shop': { private: false, default_branch: 'main' },
      [`/repos/alex/shop/git/trees/${SHA}?recursive=1`]: {
        truncated: false,
        tree: [
          { path: 'package.json', type: 'blob', size: 300 },
          { path: 'server', type: 'tree' },
          { path: 'server/requirements.txt', type: 'blob', size: 120 },
          { path: 'server/test_app.py', type: 'blob', size: 900 },
          { path: 'node_modules/x/package.json', type: 'blob', size: 10 },
        ],
      },
      [`/repos/alex/shop/contents/package.json?ref=${SHA}`]: { type: 'file', encoding: 'base64', content: base64(NODE_FULLSTACK_PACKAGE_JSON) },
      [`/repos/alex/shop/contents/server/requirements.txt?ref=${SHA}`]: { type: 'file', encoding: 'base64', content: base64(PYTHON_REQUIREMENTS) },
    };
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const path = String(url).replace('https://api.github.com', '');
      return path in routes ? jsonResponse(routes[path]) : jsonResponse({ message: 'Not Found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await fetchRepositorySnapshot({ owner: 'alex', repo: 'shop', ref: SHA });

    expect(snapshot).toMatchObject({ status: 'ok', ref: SHA, truncated: false });
    if (snapshot.status !== 'ok') throw new Error('expected a snapshot');
    expect(snapshot.manifests).toEqual([
      { path: 'package.json', content: NODE_FULLSTACK_PACKAGE_JSON },
      { path: 'server/requirements.txt', content: PYTHON_REQUIREMENTS },
    ]);
    expect(snapshot.paths).toContain('server/test_app.py');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.github.com/repos/alex/shop',
      `https://api.github.com/repos/alex/shop/git/trees/${SHA}?recursive=1`,
      `https://api.github.com/repos/alex/shop/contents/package.json?ref=${SHA}`,
      `https://api.github.com/repos/alex/shop/contents/server/requirements.txt?ref=${SHA}`,
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });

  it('uses the default branch when no ref is given', async () => {
    const getJson = vi.fn(async (path: string) => path === '/repos/alex/shop'
      ? { private: false, default_branch: 'trunk' }
      : { tree: [] });

    expect(await fetchRepositorySnapshot({ owner: 'alex', repo: 'shop' }, getJson)).toMatchObject({ status: 'ok', ref: 'trunk' });
    expect(getJson).toHaveBeenCalledWith('/repos/alex/shop/git/trees/trunk?recursive=1');
  });

  it('reports missing, private and unknown-ref repositories as unavailable', async () => {
    expect(await fetchRepositorySnapshot({ owner: 'a', repo: 'b', ref: SHA }, async () => null))
      .toEqual({ status: 'unavailable', reason: 'public_repository_not_found' });
    expect(await fetchRepositorySnapshot({ owner: 'a', repo: 'b', ref: SHA }, async () => ({ private: true, default_branch: 'main' })))
      .toEqual({ status: 'unavailable', reason: 'repository_not_public' });
    expect(await fetchRepositorySnapshot({ owner: 'a', repo: 'b', ref: SHA }, async path => path === '/repos/a/b' ? { private: false, default_branch: 'main' } : null))
      .toEqual({ status: 'unavailable', reason: 'repository_ref_not_found' });
  });

  it('falls back to the top-level tree when the recursive listing is too large', async () => {
    const getJson = vi.fn(async (path: string) => {
      if (path === '/repos/a/b') return { private: false, default_branch: 'main' };
      if (path.endsWith('?recursive=1')) throw new GitHubResponseTooLargeError();
      if (path.includes('/git/trees/')) return { tree: [{ path: 'go.mod', type: 'blob', size: 100 }, { path: 'vendor', type: 'tree' }] };
      return { type: 'file', encoding: 'base64', content: base64(GO_MOD) };
    });

    const snapshot = await fetchRepositorySnapshot({ owner: 'a', repo: 'b', ref: SHA }, getJson);

    expect(snapshot).toMatchObject({ status: 'ok', truncated: true, paths: ['go.mod'] });
    expect(getJson).toHaveBeenCalledWith(`/repos/a/b/git/trees/${SHA}`);
  });
});

describe('processArchitecturalProfile', () => {
  const owner = new Types.ObjectId();
  let claims = 0;

  async function verifiedClaim(overrides: Record<string, unknown> = {}) {
    const claim = await ResumeEvidenceClaim.create({
      userId: owner, subjectType: 'repo', subjectKey: `github:alex/shop:${claims++}`, source: 'github',
      sourceUrl: `https://github.com/alex/shop/commit/${SHA}`, claimText: 'Built the checkout service',
    });
    const inputHash = evidenceInputHash(claim.toObject());
    await ResumeEvidenceClaim.updateOne({ _id: claim._id }, {
      $set: {
        verificationStatus: 'verified',
        proofVerification: { state: 'verified', inputHash, reason: 'signed_commit_authorship_verified', receipt: {}, notificationPending: false },
        ...overrides,
      },
    }, { timestamps: false });
    const saved = (await ResumeEvidenceClaim.findById(claim._id).lean())!;
    return { claim: saved, job: { userId: String(owner), claimId: String(claim._id), inputHash } };
  }

  function github(overrides: Record<string, unknown> = {}) {
    const routes: Record<string, unknown> = {
      '/repos/alex/shop': { private: false, default_branch: 'main' },
      [`/repos/alex/shop/git/trees/${SHA}?recursive=1`]: {
        tree: [
          { path: 'package.json', type: 'blob', size: 300 },
          { path: 'src/cart.test.ts', type: 'blob', size: 900 },
          { path: '.github/workflows/ci.yml', type: 'blob', size: 400 },
        ],
      },
      [`/repos/alex/shop/contents/package.json?ref=${SHA}`]: { type: 'file', encoding: 'base64', content: base64(NODE_FULLSTACK_PACKAGE_JSON) },
      ...overrides,
    };
    return vi.fn(async (path: string) => routes[path] ?? null);
  }

  // Real MongoDB load and save, fake GitHub.
  const run = (job: unknown, getJson: (path: string) => Promise<unknown>) =>
    processArchitecturalProfile(job, { getJson, now: () => new Date('2026-11-21T08:00:00Z') });

  it('stores the profile of the verified commit on the claim without bumping updatedAt', async () => {
    const { claim, job } = await verifiedClaim();
    expect(needsArchitecturalProfile(claim)).toBe(true);
    const getJson = github();

    const profile = await run(job, getJson);

    // framework, ORM, test library, test file, TypeScript/ESLint and CI; no Dockerfile.
    expect(profile).toMatchObject({ status: 'analyzed', score: 90, inputHash: job.inputHash, repository: { owner: 'alex', repo: 'shop', ref: SHA } });
    const saved = (await ResumeEvidenceClaim.findById(claim._id).lean())!;
    expect(saved.metadata.architecturalProfile).toMatchObject({
      version: 1, status: 'analyzed', reason: null, inputHash: job.inputHash, score: 90, frameworkTier: 'fullstack', ci: true,
      containerized: false, analyzedAt: new Date('2026-11-21T08:00:00Z'), testing: { testFiles: 1 },
    });
    expect(saved.updatedAt).toEqual(claim.updatedAt);
    expect(saved.verificationStatus).toBe('verified');
    expect(needsArchitecturalProfile(saved)).toBe(false);

    // Already profiled for this input: no further GitHub requests.
    getJson.mockClear();
    expect(await run(job, getJson)).toBeNull();
    expect(getJson).not.toHaveBeenCalled();
  });

  it('stores an unavailable profile when the repository is no longer public', async () => {
    const { claim, job } = await verifiedClaim();

    const profile = await run(job, github({ '/repos/alex/shop': { private: true, default_branch: 'main' } }));

    expect(profile).toMatchObject({ status: 'unavailable', reason: 'repository_not_public' });
    const saved = (await ResumeEvidenceClaim.findById(claim._id).lean())!;
    expect(saved.metadata.architecturalProfile).toMatchObject({ status: 'unavailable', reason: 'repository_not_public', inputHash: job.inputHash });
    expect(saved.metadata.architecturalProfile?.score).toBeUndefined();
    expect(needsArchitecturalProfile(saved)).toBe(false);
  });

  it('skips claims that are not verified or were edited since the job was queued', async () => {
    const unverified = await verifiedClaim({ verificationStatus: 'unverified' });
    const getJson = github();
    expect(await run(unverified.job, getJson)).toBeNull();

    const edited = await verifiedClaim();
    await ResumeEvidenceClaim.updateOne({ _id: edited.claim._id }, { $set: { claimText: 'Rewrote the claim' } });
    expect(await run(edited.job, getJson)).toBeNull();

    expect(getJson).not.toHaveBeenCalled();
    expect((await ResumeEvidenceClaim.findById(edited.claim._id).lean())!.metadata.architecturalProfile).toBeUndefined();
  });

  it('rejects malformed jobs and keeps GitHub failures retryable', async () => {
    await expect(run({ claimId: 'nope' }, github())).rejects.toBeInstanceOf(NonRetryableError);

    const { claim, job } = await verifiedClaim();
    await expect(run(job, async () => { throw new TypeError('fetch failed'); })).rejects.toBeInstanceOf(RetryableError);
    expect((await ResumeEvidenceClaim.findById(claim._id).lean())!.metadata.architecturalProfile).toBeUndefined();
  });
});
