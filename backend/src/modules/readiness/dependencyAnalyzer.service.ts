// src/modules/readiness/dependencyAnalyzer.service.ts: engineering maturity of a GitHub project.
//
// Reads the dependency manifests of a repository at a commit (package.json, requirements.txt,
// pyproject.toml, go.mod, Cargo.toml, pom.xml) with the existing manifestParsers, looks at the
// file tree for tests, CI and containers, and scores the project 0-100. Deprecated or known
// insecure packages from a curated list lower the score. The result is stored on the evidence
// claim as metadata.architecturalProfile.
//
// GitHub is read through githubJson (fixed api.github.com origin, no redirects, timeout, 1 MiB
// cap): one repository request, one tree request and one contents request per manifest.

import { z } from 'zod';
import { ResumeEvidenceClaim } from '../../db/models/resumeEvidenceClaim.model.js';
import { NonRetryableError, RetryableError } from '../../infrastructure/queues/ErrorClassifier.js';
import {
  MAX_MANIFEST_BYTES,
  baseName,
  isComposeFileName,
  isDockerfileName,
  normalizePath,
  parseCargoToml,
  parseGoMod,
  parsePackageJson,
  parsePomXml,
  parsePyproject,
  parseRequirementsTxt,
} from './intelligence/manifestParsers.js';
import { evidenceInputHash, evidenceProof, type VerifiableClaim } from './verification/evidenceProof.js';
import { GitHubResponseTooLargeError, githubJson, parseCommitReference } from './verification/githubVerifier.service.js';

export type Ecosystem = 'npm' | 'pypi' | 'go' | 'cargo' | 'maven';
export type FrameworkCategory = 'frontend' | 'backend' | 'fullstack';
export type FrameworkTier = FrameworkCategory | 'none';
export type DeprecationKind = 'deprecated' | 'unmaintained' | 'security';
type GetJson = (path: string) => Promise<unknown | null>;

export const PROFILE_VERSION = 1;
export const MAX_MANIFESTS = 8;
/** Root, apps/web, packages/api style paths: at most two directories deep. */
const MAX_MANIFEST_DEPTH = 3;

export const SCORE_WEIGHTS = {
  framework: 20,
  dataLayer: 15,
  testFramework: 20,
  /** The verification bonus: tests actually exist in the repository. */
  testFiles: 15,
  qualityTooling: 10,
  ci: 10,
  containerization: 10,
} as const;
export const DEPRECATED_PENALTY = 5;
export const MAX_DEPRECATED_PENALTY = 20;
const DRIVER_ONLY_POINTS = 10;

export interface ManifestFile {
  path: string;
  content: string;
}

export interface ManifestSummary {
  path: string;
  ecosystem: Ecosystem;
  dependencies: number;
  devDependencies: number;
  /** The file could not be read (invalid JSON, or larger than MAX_MANIFEST_BYTES). */
  malformed: boolean;
}

export interface DeprecatedDependency {
  name: string;
  ecosystem: Ecosystem;
  kind: DeprecationKind;
  note: string;
  replacement: string | null;
}

export interface ProjectAnalysis {
  score: number;
  breakdown: Record<keyof typeof SCORE_WEIGHTS | 'deprecatedPenalty', number>;
  frameworkTier: FrameworkTier;
  ecosystems: Ecosystem[];
  manifests: ManifestSummary[];
  frameworks: Array<{ name: string; ecosystem: Ecosystem; category: FrameworkCategory }>;
  dataLayer: Array<{ name: string; ecosystem: Ecosystem; kind: 'orm' | 'driver' }>;
  testing: { libraries: Array<{ name: string; ecosystem: Ecosystem }>; testFiles: number };
  qualityTooling: string[];
  ci: boolean;
  containerized: boolean;
  deprecated: DeprecatedDependency[];
  dependencyCount: { runtime: number; dev: number };
  treeTruncated: boolean;
}

export interface ArchitecturalProfile extends Partial<ProjectAnalysis> {
  version: number;
  status: 'analyzed' | 'unavailable';
  reason: string | null;
  /** Evidence input hash the profile was computed for; an edited claim gets a new profile. */
  inputHash: string;
  repository: { owner: string; repo: string; ref: string };
  analyzedAt: Date;
}

// --- Catalog ----------------------------------------------------------------------
// Keys are dependency names as the parsers return them: npm names, lower-cased PyPI names with
// "_" as "-", Go module paths (a /vN suffix also matches), crate names, Maven "group:artifact".
// A key ending in "/" matches every package under that scope.

type Catalog<T> = Partial<Record<Ecosystem, Record<string, T>>>;

const FRAMEWORKS: Catalog<FrameworkCategory> = {
  npm: {
    react: 'frontend', vue: 'frontend', svelte: 'frontend', '@angular/core': 'frontend', 'solid-js': 'frontend', astro: 'frontend',
    next: 'fullstack', nuxt: 'fullstack', '@sveltejs/kit': 'fullstack', '@remix-run/react': 'fullstack',
    express: 'backend', '@nestjs/core': 'backend', fastify: 'backend', koa: 'backend', hono: 'backend',
  },
  pypi: { fastapi: 'backend', django: 'backend', flask: 'backend', starlette: 'backend', tornado: 'backend' },
  go: {
    'github.com/gin-gonic/gin': 'backend', 'github.com/labstack/echo': 'backend', 'github.com/gofiber/fiber': 'backend',
    'github.com/go-chi/chi': 'backend', 'github.com/gorilla/mux': 'backend',
  },
  cargo: { 'actix-web': 'backend', axum: 'backend', rocket: 'backend', warp: 'backend', yew: 'frontend', leptos: 'fullstack' },
  maven: {
    'org.springframework.boot:spring-boot-starter-web': 'backend',
    'org.springframework.boot:spring-boot-starter-webflux': 'backend',
    'io.quarkus:quarkus-core': 'backend',
  },
};

const DATA_LAYER: Catalog<'orm' | 'driver'> = {
  npm: {
    prisma: 'orm', '@prisma/client': 'orm', mongoose: 'orm', typeorm: 'orm', sequelize: 'orm', 'drizzle-orm': 'orm',
    '@mikro-orm/core': 'orm', objection: 'orm', knex: 'orm',
    pg: 'driver', mysql2: 'driver', mongodb: 'driver', 'better-sqlite3': 'driver', sqlite3: 'driver',
  },
  pypi: {
    sqlalchemy: 'orm', django: 'orm', sqlmodel: 'orm', 'tortoise-orm': 'orm', peewee: 'orm', mongoengine: 'orm', beanie: 'orm',
    psycopg2: 'driver', 'psycopg2-binary': 'driver', psycopg: 'driver', asyncpg: 'driver', pymongo: 'driver', motor: 'driver', pymysql: 'driver',
  },
  go: {
    'gorm.io/gorm': 'orm', 'entgo.io/ent': 'orm',
    'github.com/jmoiron/sqlx': 'driver', 'go.mongodb.org/mongo-driver': 'driver', 'github.com/jackc/pgx': 'driver',
    'github.com/lib/pq': 'driver', 'github.com/go-sql-driver/mysql': 'driver',
  },
  cargo: { diesel: 'orm', 'sea-orm': 'orm', sqlx: 'driver', mongodb: 'driver', 'tokio-postgres': 'driver' },
  maven: {
    'org.springframework.boot:spring-boot-starter-data-jpa': 'orm', 'org.springframework.boot:spring-boot-starter-data-mongodb': 'orm',
    'org.hibernate:hibernate-core': 'orm', 'org.hibernate.orm:hibernate-core': 'orm',
    'org.postgresql:postgresql': 'driver', 'com.mysql:mysql-connector-j': 'driver', 'mysql:mysql-connector-java': 'driver',
  },
};

const TEST_LIBRARIES: Catalog<true> = {
  npm: {
    vitest: true, jest: true, mocha: true, ava: true, jasmine: true, '@playwright/test': true, playwright: true,
    cypress: true, '@testing-library/': true, supertest: true,
  },
  pypi: { pytest: true, nose2: true, hypothesis: true, 'pytest-cov': true, tox: true },
  go: { 'github.com/stretchr/testify': true, 'github.com/onsi/ginkgo': true, 'github.com/onsi/gomega': true },
  cargo: { proptest: true, rstest: true, mockall: true, insta: true },
  maven: {
    'org.junit.jupiter:junit-jupiter': true, 'org.junit.jupiter:junit-jupiter-api': true, 'junit:junit': true,
    'org.mockito:mockito-core': true, 'org.springframework.boot:spring-boot-starter-test': true, 'org.testng:testng': true,
  },
};

/** Ecosystems whose standard toolchain runs tests without a library (go test, cargo test, unittest). */
const BUILT_IN_TEST_RUNNERS = new Set<Ecosystem>(['go', 'cargo', 'pypi']);

const QUALITY_DEPENDENCIES: Catalog<string> = {
  npm: {
    typescript: 'typescript', eslint: 'eslint', prettier: 'prettier', '@biomejs/biome': 'biome', 'typescript-eslint': 'eslint',
  },
  pypi: { ruff: 'ruff', mypy: 'mypy', black: 'black', flake8: 'flake8', pylint: 'pylint', pyright: 'pyright' },
};

const QUALITY_CONFIG_FILES: Array<[RegExp, string]> = [
  [/^tsconfig(\.[\w-]+)?\.json$/i, 'typescript'],
  [/^(\.eslintrc(\.\w+)?|eslint\.config\.[cm]?[jt]s)$/i, 'eslint'],
  [/^(\.prettierrc(\.\w+)?|prettier\.config\.[cm]?js)$/i, 'prettier'],
  [/^biome\.jsonc?$/i, 'biome'],
  [/^\.?ruff\.toml$/i, 'ruff'],
  [/^mypy\.ini$/i, 'mypy'],
  [/^\.flake8$/i, 'flake8'],
  [/^\.pylintrc$/i, 'pylint'],
  [/^\.pre-commit-config\.ya?ml$/i, 'pre-commit'],
  [/^\.golangci\.(ya?ml|toml|json)$/i, 'golangci-lint'],
  [/^\.?rustfmt\.toml$/i, 'rustfmt'],
  [/^\.?clippy\.toml$/i, 'clippy'],
];

type DeprecationEntry = Omit<DeprecatedDependency, 'name' | 'ecosystem'>;
const entry = (kind: DeprecationKind, note: string, replacement: string | null = null): DeprecationEntry => ({ kind, note, replacement });

/** Curated: packages whose maintainers deprecated them, or that are abandoned with known vulnerabilities. */
const DEPRECATED: Catalog<DeprecationEntry> = {
  npm: {
    request: entry('deprecated', 'deprecated by its maintainers in 2020', 'fetch or undici'),
    'request-promise': entry('deprecated', 'deprecated together with request', 'fetch or undici'),
    'node-sass': entry('deprecated', 'LibSass and node-sass are deprecated', 'sass'),
    tslint: entry('deprecated', 'deprecated since 2019', 'eslint with typescript-eslint'),
    moment: entry('unmaintained', 'legacy project in maintenance mode', 'date-fns, luxon or dayjs'),
    'babel-eslint': entry('deprecated', 'renamed and deprecated', '@babel/eslint-parser'),
    '@babel/polyfill': entry('deprecated', 'deprecated since Babel 7.4', 'core-js/stable'),
    'react-scripts': entry('deprecated', 'Create React App was deprecated in 2025', 'vite or a React framework'),
    enzyme: entry('unmaintained', 'no adapter for React 18 or newer', '@testing-library/react'),
    'node-uuid': entry('deprecated', 'renamed', 'uuid'),
    istanbul: entry('deprecated', 'no longer maintained', 'nyc or c8'),
    querystring: entry('deprecated', 'legacy API', 'URLSearchParams'),
    crypto: entry('deprecated', 'the npm package is a stub for a Node built-in', 'node:crypto'),
    protractor: entry('deprecated', 'end of life since 2023', 'playwright or cypress'),
    bower: entry('deprecated', 'not recommended for new projects', 'npm with a bundler'),
  },
  pypi: {
    pycrypto: entry('security', 'unmaintained since 2013 with known CVEs', 'pycryptodome'),
    nose: entry('unmaintained', 'unmaintained, breaks on current Python', 'pytest'),
    sklearn: entry('deprecated', 'the sklearn package name is deprecated and no longer installs', 'scikit-learn'),
    'flask-script': entry('deprecated', 'no longer maintained', 'the built-in flask CLI'),
    'django-rest-swagger': entry('deprecated', 'no longer maintained', 'drf-spectacular'),
  },
  go: {
    'github.com/dgrijalva/jwt-go': entry('security', 'archived, CVE-2020-26160', 'github.com/golang-jwt/jwt'),
    'github.com/satori/go.uuid': entry('security', 'unmaintained, CVE-2021-3538', 'github.com/gofrs/uuid or github.com/google/uuid'),
    'github.com/golang/protobuf': entry('deprecated', 'superseded by the APIv2 module', 'google.golang.org/protobuf'),
    'github.com/pkg/errors': entry('unmaintained', 'archived', 'errors and fmt.Errorf with %w'),
  },
  cargo: {
    failure: entry('deprecated', 'deprecated (RUSTSEC-2020-0036)', 'anyhow or thiserror'),
    tempdir: entry('deprecated', 'merged into tempfile (RUSTSEC-2018-0017)', 'tempfile'),
    'rustc-serialize': entry('deprecated', 'deprecated (RUSTSEC-2022-0004)', 'serde'),
  },
  maven: {
    'log4j:log4j': entry('security', 'Log4j 1.x is end of life with known CVEs', 'org.apache.logging.log4j:log4j-core'),
    'commons-httpclient:commons-httpclient': entry('deprecated', 'end of life', 'org.apache.httpcomponents.client5:httpclient5'),
  },
};

function lookup<T>(catalog: Catalog<T>, ecosystem: Ecosystem, name: string): T | undefined {
  const table = catalog[ecosystem];
  if (!table) return undefined;
  const candidates = [name];
  if (ecosystem === 'go') candidates.push(name.replace(/\/v\d+$/, ''));
  for (const candidate of candidates) {
    if (Object.hasOwn(table, candidate)) return table[candidate];
  }
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/') + 1) : '';
  return scope && Object.hasOwn(table, scope) ? table[scope] : undefined;
}

// --- Manifests and tree signals ---------------------------------------------------

const MANIFEST_ECOSYSTEMS: Record<string, Ecosystem> = {
  'package.json': 'npm',
  'requirements.txt': 'pypi',
  'pyproject.toml': 'pypi',
  'go.mod': 'go',
  'cargo.toml': 'cargo',
  'pom.xml': 'maven',
};

/** Vendored, generated, example and fixture code says nothing about the project itself. */
const IGNORED_SEGMENTS = new Set([
  'node_modules', 'vendor', 'third_party', '.git', 'dist', 'build', 'target', 'out', 'coverage', '.venv', 'venv',
  'site-packages', 'examples', 'example', 'fixtures', '__fixtures__', 'testdata', 'docs',
]);

function isIgnored(path: string): boolean {
  return normalizePath(path).split('/').slice(0, -1).some(segment => IGNORED_SEGMENTS.has(segment.toLowerCase()));
}

export function manifestEcosystem(path: string): Ecosystem | undefined {
  const name = baseName(path).toLowerCase();
  return Object.hasOwn(MANIFEST_ECOSYSTEMS, name) ? MANIFEST_ECOSYSTEMS[name] : undefined;
}

/** Manifest paths worth fetching from a tree listing: shallow, not vendored, root first. */
export function selectManifestPaths(entries: Array<{ path: string; size?: number }>): string[] {
  return entries
    .map(item => ({ path: normalizePath(item.path), size: item.size }))
    .filter(item => manifestEcosystem(item.path) && !isIgnored(item.path)
      && item.path.split('/').length <= MAX_MANIFEST_DEPTH && (item.size ?? 0) <= MAX_MANIFEST_BYTES)
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
    .slice(0, MAX_MANIFESTS)
    .map(item => item.path);
}

const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|\/)__tests__\/.+\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.py$/i,
  /_test\.go$/,
  /(^|\/)tests\/[^/]+\.rs$/,
  /(^|\/)src\/test\/java\/.+\.java$/,
];

const CI_PATTERNS = [
  /^\.github\/workflows\/[^/]+\.ya?ml$/i,
  /^\.gitlab-ci\.ya?ml$/i,
  /^\.circleci\/config\.ya?ml$/i,
  /^azure-pipelines\.ya?ml$/i,
  /^\.travis\.ya?ml$/i,
  /^jenkinsfile$/i,
];

function parseManifest(file: ManifestFile): (ManifestSummary & { runtime: string[]; dev: string[] }) | null {
  const ecosystem = manifestEcosystem(file.path);
  if (!ecosystem) return null;
  const path = normalizePath(file.path);
  const tooLarge = typeof file.content !== 'string' || file.content.length > MAX_MANIFEST_BYTES;
  let runtime: string[] = [];
  let dev: string[] = [];
  let malformed = tooLarge;
  if (!tooLarge) {
    switch (baseName(path).toLowerCase()) {
      case 'package.json': {
        try {
          const parsed: unknown = JSON.parse(file.content);
          malformed = !parsed || typeof parsed !== 'object' || Array.isArray(parsed);
        } catch {
          malformed = true;
        }
        ({ dependencies: runtime, devDependencies: dev } = parsePackageJson(file.content));
        break;
      }
      case 'requirements.txt': runtime = parseRequirementsTxt(file.content); break;
      case 'pyproject.toml': runtime = parsePyproject(file.content); break;
      case 'go.mod': runtime = parseGoMod(file.content); break;
      case 'cargo.toml': runtime = parseCargoToml(file.content); break;
      case 'pom.xml': runtime = parsePomXml(file.content); break;
    }
  }
  const unique = (names: string[]) => [...new Set(names)];
  runtime = unique(runtime);
  dev = unique(dev).filter(name => !runtime.includes(name));
  return { path, ecosystem, dependencies: runtime.length, devDependencies: dev.length, malformed, runtime, dev };
}

function pushUnique<T extends { name: string; ecosystem: Ecosystem }>(list: T[], item: T): void {
  if (!list.some(existing => existing.name === item.name && existing.ecosystem === item.ecosystem)) list.push(item);
}

/** Pure analysis of fetched manifests plus the repository's file paths. */
export function analyzeProject(input: { manifests: ManifestFile[]; paths?: string[]; treeTruncated?: boolean }): ProjectAnalysis {
  const paths = (input.paths ?? []).map(normalizePath).filter(path => !isIgnored(path));
  const manifests = input.manifests.map(parseManifest).filter((manifest): manifest is NonNullable<typeof manifest> => manifest !== null);

  const frameworks: ProjectAnalysis['frameworks'] = [];
  const dataLayer: ProjectAnalysis['dataLayer'] = [];
  const libraries: ProjectAnalysis['testing']['libraries'] = [];
  const deprecated: DeprecatedDependency[] = [];
  const quality = new Set<string>();

  for (const manifest of manifests) {
    const { ecosystem } = manifest;
    for (const name of [...manifest.runtime, ...manifest.dev]) {
      const framework = lookup(FRAMEWORKS, ecosystem, name);
      if (framework) pushUnique(frameworks, { name, ecosystem, category: framework });
      const data = lookup(DATA_LAYER, ecosystem, name);
      if (data) pushUnique(dataLayer, { name, ecosystem, kind: data });
      if (lookup(TEST_LIBRARIES, ecosystem, name)) pushUnique(libraries, { name, ecosystem });
      const tool = lookup(QUALITY_DEPENDENCIES, ecosystem, name);
      if (tool) quality.add(tool);
      const deprecation = lookup(DEPRECATED, ecosystem, name);
      if (deprecation) pushUnique(deprecated, { name, ecosystem, ...deprecation });
    }
  }
  for (const path of paths) {
    const name = baseName(path);
    for (const [pattern, tool] of QUALITY_CONFIG_FILES) {
      if (pattern.test(name)) quality.add(tool);
    }
  }

  const ecosystems = [...new Set(manifests.map(manifest => manifest.ecosystem))];
  const testFiles = paths.filter(path => TEST_FILE_PATTERNS.some(pattern => pattern.test(path))).length;
  const ci = paths.some(path => CI_PATTERNS.some(pattern => pattern.test(path)));
  const containerized = paths.some(path => isDockerfileName(baseName(path)) || isComposeFileName(baseName(path)));
  const categories = new Set(frameworks.map(framework => framework.category));
  const frameworkTier: FrameworkTier = categories.has('fullstack') || (categories.has('frontend') && categories.has('backend'))
    ? 'fullstack'
    : categories.has('backend') ? 'backend' : categories.has('frontend') ? 'frontend' : 'none';
  const builtInTests = testFiles > 0 && ecosystems.some(ecosystem => BUILT_IN_TEST_RUNNERS.has(ecosystem));

  const breakdown: ProjectAnalysis['breakdown'] = {
    framework: frameworks.length > 0 ? SCORE_WEIGHTS.framework : 0,
    dataLayer: dataLayer.some(item => item.kind === 'orm') ? SCORE_WEIGHTS.dataLayer : dataLayer.length > 0 ? DRIVER_ONLY_POINTS : 0,
    testFramework: libraries.length > 0 || builtInTests ? SCORE_WEIGHTS.testFramework : 0,
    testFiles: testFiles > 0 ? SCORE_WEIGHTS.testFiles : 0,
    qualityTooling: quality.size > 0 ? SCORE_WEIGHTS.qualityTooling : 0,
    ci: ci ? SCORE_WEIGHTS.ci : 0,
    containerization: containerized ? SCORE_WEIGHTS.containerization : 0,
    deprecatedPenalty: 0 - Math.min(MAX_DEPRECATED_PENALTY, deprecated.length * DEPRECATED_PENALTY),
  };
  const score = Math.max(0, Math.min(100, Object.values(breakdown).reduce((sum, points) => sum + points, 0)));

  return {
    score,
    breakdown,
    frameworkTier,
    ecosystems,
    manifests: manifests.map(({ runtime: _runtime, dev: _dev, ...summary }) => summary),
    frameworks,
    dataLayer,
    testing: { libraries, testFiles },
    qualityTooling: [...quality].sort(),
    ci,
    containerized,
    deprecated,
    dependencyCount: {
      runtime: manifests.reduce((sum, manifest) => sum + manifest.dependencies, 0),
      dev: manifests.reduce((sum, manifest) => sum + manifest.devDependencies, 0),
    },
    treeTruncated: Boolean(input.treeTruncated),
  };
}

// --- GitHub --------------------------------------------------------------------------

const repositorySchema = z.object({ private: z.boolean(), default_branch: z.string().min(1) });
const treeSchema = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(z.object({ path: z.string(), type: z.string(), size: z.number().optional() })),
});
const contentSchema = z.object({ type: z.literal('file'), encoding: z.string(), content: z.string() });

export type RepositorySnapshot =
  | { status: 'ok'; ref: string; paths: string[]; manifests: ManifestFile[]; truncated: boolean }
  | { status: 'unavailable'; reason: string };

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Fetches the tree and the manifests of a public repository at `ref` (default branch when omitted). */
export async function fetchRepositorySnapshot(
  target: { owner: string; repo: string; ref?: string },
  getJson: GetJson = githubJson,
): Promise<RepositorySnapshot> {
  const prefix = '/repos/' + encodeURIComponent(target.owner) + '/' + encodeURIComponent(target.repo);
  const rawRepository = await getJson(prefix);
  if (rawRepository === null) return { status: 'unavailable', reason: 'public_repository_not_found' };
  const repository = repositorySchema.safeParse(rawRepository);
  if (!repository.success) throw new RetryableError('GitHub repository response malformed');
  if (repository.data.private) return { status: 'unavailable', reason: 'repository_not_public' };

  const ref = target.ref ?? repository.data.default_branch;
  const treePath = `${prefix}/git/trees/${encodeURIComponent(ref)}`;
  let truncated = false;
  let rawTree: unknown;
  try {
    rawTree = await getJson(`${treePath}?recursive=1`);
  } catch (error) {
    if (!(error instanceof GitHubResponseTooLargeError)) throw error;
    // Huge trees (vendored dependencies, datasets): fall back to the top level only.
    rawTree = await getJson(treePath);
    truncated = true;
  }
  if (rawTree === null) return { status: 'unavailable', reason: 'repository_ref_not_found' };
  const tree = treeSchema.safeParse(rawTree);
  if (!tree.success) throw new RetryableError('GitHub tree response malformed');
  truncated ||= Boolean(tree.data.truncated);

  const blobs = tree.data.tree.filter(item => item.type === 'blob');
  const manifests: ManifestFile[] = [];
  for (const path of selectManifestPaths(blobs)) {
    const raw = await getJson(`${prefix}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
    const file = contentSchema.safeParse(raw);
    if (!file.success || file.data.encoding !== 'base64') continue;
    manifests.push({ path, content: Buffer.from(file.data.content, 'base64').toString('utf8') });
  }
  return { status: 'ok', ref, paths: blobs.map(item => normalizePath(item.path)), manifests, truncated };
}

// --- Evidence claims ---------------------------------------------------------------

export type ProfileClaim = VerifiableClaim & {
  proofVerification?: { state: string; reason: string; inputHash?: string };
  metadata?: { flaggedReason?: string | null; architecturalProfile?: { inputHash?: string } | null };
};

/** A claim gets a profile once its GitHub commit proof is verified, and again after every edit. */
export function needsArchitecturalProfile(claim: ProfileClaim): boolean {
  const inputHash = claim.proofVerification?.inputHash;
  return claim.verificationStatus === 'verified'
    && claim.proofVerification?.state === 'verified'
    && inputHash === evidenceInputHash(claim)
    && evidenceProof(claim)?.kind === 'github_commit'
    && claim.metadata?.architecturalProfile?.inputHash !== inputHash;
}

export interface ArchitecturalProfileDeps {
  load: (userId: string, claimId: string) => Promise<ProfileClaim | null>;
  getJson: GetJson;
  save: (claim: ProfileClaim, inputHash: string, profile: ArchitecturalProfile) => Promise<boolean>;
  now: () => Date;
}

const defaultDeps: ArchitecturalProfileDeps = {
  load: (userId, claimId) => ResumeEvidenceClaim.findOne({ _id: claimId, userId }).lean() as Promise<ProfileClaim | null>,
  getJson: githubJson,
  async save(claim, inputHash, profile) {
    // Derived data, not an edit: leave updatedAt alone so a pending verification compare-and-set still matches.
    const result = await ResumeEvidenceClaim.updateOne(
      { _id: claim._id, userId: claim.userId, verificationStatus: 'verified', 'proofVerification.inputHash': inputHash },
      { $set: { 'metadata.architecturalProfile': profile } },
      { timestamps: false },
    );
    return result.matchedCount === 1;
  },
  now: () => new Date(),
};

const jobSchema = z.object({
  userId: z.string().regex(/^[a-f\d]{24}$/i),
  claimId: z.string().regex(/^[a-f\d]{24}$/i),
  inputHash: z.string().regex(/^[a-f\d]{64}$/),
});

/** Job handler: analyzes the repository of a verified commit claim and stores the profile on it. */
export async function processArchitecturalProfile(raw: unknown, overrides: Partial<ArchitecturalProfileDeps> = {}): Promise<ArchitecturalProfile | null> {
  const deps = { ...defaultDeps, ...overrides };
  const parsed = jobSchema.safeParse(raw);
  if (!parsed.success) throw new NonRetryableError('Malformed architectural profile job');
  const { userId, claimId, inputHash } = parsed.data;
  const claim = await deps.load(userId, claimId);
  if (!claim || evidenceInputHash(claim) !== inputHash || !needsArchitecturalProfile(claim)) return null;
  const proof = evidenceProof(claim);
  const commit = proof?.kind === 'github_commit' ? parseCommitReference(proof.reference) : undefined;
  if (!commit) return null;

  let snapshot: RepositorySnapshot;
  try {
    snapshot = await fetchRepositorySnapshot({ owner: commit.owner, repo: commit.repo, ref: commit.sha }, deps.getJson);
  } catch (error) {
    if (error instanceof RetryableError) throw error;
    throw new RetryableError('Repository manifests unavailable', error instanceof Error ? error : undefined);
  }

  const base = {
    version: PROFILE_VERSION,
    inputHash,
    repository: { owner: commit.owner, repo: commit.repo, ref: commit.sha },
    analyzedAt: deps.now(),
  };
  const profile: ArchitecturalProfile = snapshot.status === 'ok'
    ? { ...base, status: 'analyzed', reason: null, ...analyzeProject({ manifests: snapshot.manifests, paths: snapshot.paths, treeTruncated: snapshot.truncated }) }
    : { ...base, status: 'unavailable', reason: snapshot.reason };
  return await deps.save(claim, inputHash, profile) ? profile : null;
}
