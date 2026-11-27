// src/modules/readiness/roadmapGenerator.service.ts — turns a user's skill gaps for a target
// role into a sequenced roadmap of 2-week milestones, and tracks task completion.
//
// The milestone structure (which skills land in which block) is always computed here. The
// model only writes the content of each block, through LLMGateway, and its reply is checked
// against a strict schema. Without a provider, or when the reply is unusable, a rule-based
// template fills the same structure.
import { z } from 'zod';
import { Types } from 'mongoose';
import { CareerRoadmap, type ICareerRoadmap, type ICareerRoadmapMilestone, type ICareerRoadmapTask, type RoadmapDegradedReason, type RoadmapSource, type RoadmapTargetSource } from '../../db/models/careerRoadmap.model.js';
import { Project } from '../../db/models/project.model.js';
import { ReadinessInput } from '../../db/models/readinessInput.model.js';
import { ReadinessCore } from '../../db/models/readinessCore.model.js';
import { ResumeProfile } from '../../db/models/resumeProfile.model.js';
import { UserSkillProgress } from '../../db/models/userSkillProgress.model.js';
import { VerifiedProject } from '../../db/models/verifiedProject.model.js';
import { llmGateway } from '../ai/provider/LLMGateway.js';
import { AIQuotaExceededError } from '../ai/quota.service.js';
import { boundedText, parseModelOutput } from '../job-targets/prompts/modelOutput.js';
import { ANTI_HIJACK_RULES, wrapUntrusted } from '../job-targets/prompts/untrustedText.js';
import { logger } from '../../shared/logger.js';
import { ROLE_SKILL_MATRIX, normalizeSkill } from './role/roleSkills.js';

export const ROADMAP_BLOCK_WEEKS = 2;
export const ROADMAP_MIN_WEEKS = 2;
export const ROADMAP_MAX_WEEKS = 52;
export const MAX_SKILLS_PER_MILESTONE = 3;
export const ROADMAP_LLM_FEATURE = 'roadmap';
export const ROADMAP_LLM_TIMEOUT_MS = 45_000;

export class RoadmapError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'RoadmapError';
  }
}

export const generateRoadmapSchema = z.object({
  targetRoleId: z.string().trim().min(1).max(100),
  targetDeadlineWeeks: z.number().int().min(ROADMAP_MIN_WEEKS).max(ROADMAP_MAX_WEEKS).optional(),
});

export type GenerateRoadmapInput = z.infer<typeof generateRoadmapSchema>;

/** URL-safe id for a catalogue role, e.g. "Backend Developer" -> "backend-developer". */
export function roleSlug(role: string): string {
  return role.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

interface ResolvedTarget {
  /** Canonical id: the job target id, or the catalogue role's slug. */
  targetRoleId: string;
  targetRole: string;
  targetSource: RoadmapTargetSource;
  requiredSkills: string[];
}

/**
 * A target is either the user's latest parsed job target (by job target id) or a role from
 * the role catalogue (by slug or name). Only the latest parse keeps its required skills.
 */
async function resolveTarget(userId: string, targetRoleId: string): Promise<ResolvedTarget> {
  const input = await ReadinessInput.findOne({ userId: new Types.ObjectId(userId) }, { 'jobTargets.latest': 1 }).lean();
  const latest = input?.jobTargets?.latest;
  if (latest && latest.jobTargetId === targetRoleId && latest.requiredSkills.length > 0) {
    return {
      targetRoleId, targetRole: latest.targetRole || 'Job target', targetSource: 'job_target', requiredSkills: latest.requiredSkills,
    };
  }
  const slug = roleSlug(targetRoleId);
  const role = slug ? Object.keys(ROLE_SKILL_MATRIX).find(name => roleSlug(name) === slug) : undefined;
  if (role) return { targetRoleId: slug, targetRole: role, targetSource: 'role_catalog', requiredSkills: ROLE_SKILL_MATRIX[role] };
  throw new RoadmapError('Target role not found', 'TARGET_ROLE_NOT_FOUND', 404);
}

/** Required skills the user has on resume, verified projects, or marked complete, in priority order. */
async function findMissingSkills(userId: string, requiredSkills: string[]): Promise<string[]> {
  const [profile, progress, verifiedProjects, projects] = await Promise.all([
    ResumeProfile.findOne({ userId }, { selectedSkills: 1 }).lean(),
    UserSkillProgress.find({ userId, completed: true }, { skill: 1 }).lean(),
    VerifiedProject.find({ userId, 'verification.status': 'verified' }, { techStack: 1, 'metrics.primaryLanguage': 1, 'metrics.languages': 1 }).lean(),
    Project.find({ userId }, { techStack: 1 }).lean(),
  ]);
  const projectTechs = [
    ...verifiedProjects.flatMap(vp => [
      ...(vp.techStack ?? []),
      ...(vp.metrics?.primaryLanguage ? [vp.metrics.primaryLanguage] : []),
      ...Object.keys(vp.metrics?.languages ?? {}),
    ]),
    ...projects.flatMap(p => p.techStack ?? []),
  ];
  const owned = new Set([
    ...(profile?.selectedSkills ?? []),
    ...progress.map(p => p.skill),
    ...projectTechs,
  ].map(normalizeSkill));
  const seen = new Set<string>();
  return requiredSkills.filter(skill => {
    const key = normalizeSkill(skill);
    if (!key || owned.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface MilestonePlan {
  sequence: number;
  startWeek: number;
  endWeek: number;
  skills: string[];
}

/** Splits skills evenly into 2-week blocks, keeping their order. Skills past the deadline are deferred. */
export function planMilestones(missingSkills: string[], deadlineWeeks: number): { plans: MilestonePlan[]; deferredSkills: string[] } {
  const blocks = Math.ceil(deadlineWeeks / ROADMAP_BLOCK_WEEKS);
  const planned = missingSkills.slice(0, blocks * MAX_SKILLS_PER_MILESTONE);
  const count = Math.min(blocks, planned.length);
  const plans: MilestonePlan[] = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    const size = Math.floor(planned.length / count) + (index < planned.length % count ? 1 : 0);
    plans.push({
      sequence: index + 1,
      startWeek: index * ROADMAP_BLOCK_WEEKS + 1,
      endWeek: Math.min((index + 1) * ROADMAP_BLOCK_WEEKS, deadlineWeeks),
      skills: planned.slice(offset, offset + size),
    });
    offset += size;
  }
  return { plans, deferredSkills: missingSkills.slice(planned.length) };
}

type MilestoneContent = Pick<ICareerRoadmapMilestone, 'objective' | 'projectArchitecture' | 'keyConcepts' | 'dsaPatterns' | 'verificationCriteria'>;

interface SkillTemplate {
  architecture: string;
  concepts: string[];
  dsa: string[];
  verification: string;
}

const SKILL_TEMPLATES: Record<string, SkillTemplate> = {
  redis: {
    architecture: 'REST API with a Redis cache-aside layer backed by a primary and one replica',
    concepts: ['Cache-aside and write-through caching', 'TTLs and eviction policies', 'Replication and failover'],
    dsa: ['Hash maps', 'LRU cache design'],
    verification: 'Deploy Redis with replication, stop the primary, and measure failover time and cache hit ratio',
  },
  caching: {
    architecture: 'Read-heavy API with HTTP caching headers and an in-process LRU cache in front of the database',
    concepts: ['Cache invalidation strategies', 'Cache stampede protection', 'HTTP cache headers'],
    dsa: ['LRU cache design', 'Hash maps'],
    verification: 'Load test the API before and after caching and report the p95 latency change',
  },
  docker: {
    architecture: 'Multi-container app (API, database, cache) defined with Docker Compose and multi-stage images',
    concepts: ['Image layers and multi-stage builds', 'Container networking and volumes', 'Health checks'],
    dsa: ['Graphs (dependency ordering)'],
    verification: 'Start the full stack with one command on a clean machine and keep the API image under 200 MB',
  },
  kubernetes: {
    architecture: 'Service deployed to a local Kubernetes cluster with a Deployment, Service, ConfigMap and HPA',
    concepts: ['Pods, Deployments and Services', 'Readiness and liveness probes', 'Horizontal pod autoscaling'],
    dsa: ['Heaps / priority queue (scheduling)'],
    verification: 'Roll out a new version with zero failed requests and show the HPA scaling under load',
  },
  sql: {
    architecture: 'Relational schema for an orders service with migrations, indexes and transactional writes',
    concepts: ['Normalisation and indexing', 'Transactions and isolation levels', 'Query plans'],
    dsa: ['Binary search (B-tree intuition)', 'Sorting and merging'],
    verification: 'Show EXPLAIN plans before and after indexing for the three slowest queries',
  },
  mongodb: {
    architecture: 'Document-model API with compound indexes, an aggregation pipeline and a transaction',
    concepts: ['Document modelling and embedding vs referencing', 'Compound indexes', 'Aggregation pipelines'],
    dsa: ['Hash maps', 'Sorting'],
    verification: 'Seed 100k documents and keep every listed query on an index scan (no COLLSCAN)',
  },
  'node.js': {
    architecture: 'Node.js service with a worker queue for background jobs and graceful shutdown',
    concepts: ['Event loop and async I/O', 'Streams and backpressure', 'Error handling in async code'],
    dsa: ['Queues', 'Heaps / priority queue'],
    verification: 'Process 10k background jobs without memory growth and shut down without losing a job',
  },
  express: {
    architecture: 'Express REST API with validation, centralised error handling and pagination',
    concepts: ['Middleware ordering', 'Input validation', 'Pagination and error contracts'],
    dsa: ['Two pointers', 'Arrays and hashing'],
    verification: 'Publish an OpenAPI spec and pass contract tests for every endpoint, including error cases',
  },
  authentication: {
    architecture: 'Auth service with password hashing, short-lived access tokens, refresh token rotation and RBAC',
    concepts: ['Password hashing', 'Token expiry and rotation', 'Role-based access control'],
    dsa: ['Hash maps', 'Tries (permission paths)'],
    verification: 'Demonstrate refresh-token reuse detection and an automated test for every role boundary',
  },
  testing: {
    architecture: 'Existing project extended with unit, integration and end-to-end test suites in CI',
    concepts: ['Test pyramid', 'Test doubles and fixtures', 'Coverage of failure paths'],
    dsa: ['Recursion', 'Backtracking (input generation)'],
    verification: 'Reach 80% line coverage with at least one integration test per external dependency',
  },
  'ci/cd': {
    architecture: 'Pipeline that lints, tests, builds an image and deploys to a staging environment on merge',
    concepts: ['Pipeline stages and caching', 'Environment promotion', 'Rollback strategies'],
    dsa: ['Graphs (topological sort)'],
    verification: 'Merge a change that deploys automatically and roll it back in under five minutes',
  },
  'system design': {
    architecture: 'URL shortener or rate limiter designed for 10k requests per second, with a written design document',
    concepts: ['Horizontal scaling and load balancing', 'Consistency vs availability trade-offs', 'Back-of-the-envelope estimates'],
    dsa: ['Consistent hashing', 'Sliding window'],
    verification: 'Load test the design to its target throughput and document the bottleneck you hit first',
  },
  react: {
    architecture: 'React app with routed pages, server-state caching and an accessible form flow',
    concepts: ['Component state vs server state', 'Rendering performance', 'Accessible forms'],
    dsa: ['Trees (DOM / component trees)', 'Memoisation'],
    verification: 'Ship the app with a Lighthouse accessibility score of at least 90 and component tests for each page',
  },
  typescript: {
    architecture: 'Typed API client and shared domain types used by both a server and a client package',
    concepts: ['Generics and narrowing', 'Discriminated unions', 'Strict compiler settings'],
    dsa: ['Trees (type recursion)'],
    verification: 'Compile with strict mode and no any in the shared package',
  },
};

const ROTATING_DSA_PATTERNS = [
  'Arrays and hashing', 'Two pointers', 'Sliding window', 'Binary search', 'Trees (DFS/BFS)',
  'Graphs', 'Heaps / priority queue', 'Intervals', 'Backtracking', 'Dynamic programming',
];

function genericTemplate(skill: string): SkillTemplate {
  return {
    architecture: `Small service that uses ${skill} for one real feature, with tests and a README`,
    concepts: [`${skill} fundamentals`, `${skill} failure modes and debugging`],
    dsa: [],
    verification: `Ship a working ${skill} feature with automated tests and publish the repository`,
  };
}

function scopeFor(score: number | null): string {
  if (score === null || score < 40) return 'Start with a focused, single-service build';
  if (score < 70) return 'Build an end-to-end feature';
  return 'Build a production-grade component';
}

const unique = (values: string[], max: number) => [...new Set(values)].slice(0, max);

/** Rule-based content for one milestone. Used whenever the model is unavailable or rejected. */
export function templateMilestone(plan: MilestonePlan, targetRole: string, readinessScore: number | null): MilestoneContent {
  const templates = plan.skills.map(skill => SKILL_TEMPLATES[normalizeSkill(skill)] ?? genericTemplate(skill));
  const rotating = ROTATING_DSA_PATTERNS[(plan.sequence - 1) % ROTATING_DSA_PATTERNS.length];
  return {
    objective: `Close the ${plan.skills.join(', ')} gap for ${targetRole} with a project you can demonstrate`,
    projectArchitecture: `${scopeFor(readinessScore)}: ${templates.map(t => t.architecture).join('; ')}`,
    keyConcepts: unique(templates.flatMap(t => t.concepts), 8),
    dsaPatterns: unique([...templates.flatMap(t => t.dsa), rotating], 4),
    verificationCriteria: unique(templates.map(t => t.verification), 5),
  };
}

const aiMilestoneSchema = z.object({
  objective: boundedText(240),
  projectArchitecture: boundedText(500),
  keyConcepts: z.array(boundedText(120)).min(1).max(8),
  dsaPatterns: z.array(boundedText(80)).min(1).max(4),
  verificationCriteria: z.array(boundedText(240)).min(1).max(5),
}).strict();

const aiRoadmapSchema = z.object({ milestones: z.array(aiMilestoneSchema).min(1).max(26) }).strict();

const SYSTEM_PROMPT = `You write learning roadmaps for software engineers preparing for a target role.
You receive the target role and a fixed list of 2-week milestones, each with the skills it must cover.
For every milestone, in the same order, write:
- objective: one sentence naming what the engineer will be able to do.
- projectArchitecture: the concrete project to build and its main components.
- keyConcepts: the concepts to master for those skills.
- dsaPatterns: data structure and algorithm patterns to practise that relate to the work.
- verificationCriteria: measurable checks that prove the skill, e.g. "Deploy a Redis cluster with replication and measure failover".
Rules:
${ANTI_HIJACK_RULES}
Schema:
{"milestones": [{"objective": string, "projectArchitecture": string, "keyConcepts": string[1-8], "dsaPatterns": string[1-4], "verificationCriteria": string[1-5]}]}
Return exactly one entry per milestone you were given.`;

function buildPrompt(targetRole: string, plans: MilestonePlan[], readinessScore: number | null): string {
  const data = JSON.stringify({
    targetRole,
    milestones: plans.map(p => ({ milestone: p.sequence, weeks: `${p.startWeek}-${p.endWeek}`, skills: p.skills })),
  });
  return [
    `Current readiness score (0-100): ${readinessScore ?? 'unknown'}.`,
    `Write content for exactly ${plans.length} milestone(s).`,
    wrapUntrusted('roadmap_untrusted_text', data, 8000),
  ].join('\n');
}

const isAiConfigured = () => Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);

async function aiMilestones(
  userId: string, targetRole: string, plans: MilestonePlan[], readinessScore: number | null,
): Promise<{ content: MilestoneContent[] } | { degradedReason: RoadmapDegradedReason }> {
  if (!isAiConfigured()) return { degradedReason: 'ai_unconfigured' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      llmGateway.generateCompletion({
        userId,
        systemPrompt: SYSTEM_PROMPT,
        prompt: buildPrompt(targetRole, plans, readinessScore),
        feature: ROADMAP_LLM_FEATURE,
        temperature: 0.2,
        maxTokens: 4000,
        // The gateway's default heuristic reply is prose; an empty reply can never pass for JSON.
        heuristicFallback: () => '',
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Roadmap model call timed out after ${ROADMAP_LLM_TIMEOUT_MS}ms`)), ROADMAP_LLM_TIMEOUT_MS);
      }),
    ]);
    if (response.provider === 'heuristic' || !response.content) return { degradedReason: 'llm_failed' };
    const parsed = parseModelOutput(aiRoadmapSchema, response.content);
    if (!parsed.ok || parsed.data.milestones.length !== plans.length) {
      logger.warn('[roadmap] Rejected model roadmap output', { userId, issues: parsed.ok ? ['milestone count mismatch'] : parsed.issues });
      return { degradedReason: 'invalid_output' };
    }
    return { content: parsed.data.milestones };
  } catch (err) {
    if (err instanceof AIQuotaExceededError) return { degradedReason: 'quota_exceeded' };
    logger.warn('[roadmap] Model roadmap generation failed', { userId, error: err instanceof Error ? err.message : String(err) });
    return { degradedReason: 'llm_failed' };
  } finally {
    clearTimeout(timer);
  }
}

function tasksFor(milestoneId: string, content: MilestoneContent): ICareerRoadmapTask[] {
  const drafts: Array<Pick<ICareerRoadmapTask, 'kind' | 'title'>> = [
    ...content.keyConcepts.map(concept => ({ kind: 'learn' as const, title: `Learn: ${concept}` })),
    { kind: 'build', title: `Build: ${content.projectArchitecture}` },
    { kind: 'practice', title: `Practise DSA: ${content.dsaPatterns.join(', ')}` },
    ...content.verificationCriteria.map(criterion => ({ kind: 'verify' as const, title: `Verify: ${criterion}` })),
  ];
  return drafts.map((draft, index) => ({ ...draft, taskId: `${milestoneId}-t${index + 1}`, completed: false, completedAt: null }));
}

export interface RoadmapView {
  id: string;
  targetRoleId: string;
  targetRole: string;
  targetSource: RoadmapTargetSource;
  targetDeadlineWeeks: number;
  baselineReadinessScore: number | null;
  missingSkills: string[];
  deferredSkills: string[];
  source: RoadmapSource;
  degradedReason: RoadmapDegradedReason | null;
  generatedAt: Date;
  progress: number;
  milestones: Array<ICareerRoadmapMilestone & { completed: boolean; completedAt: Date | null; progress: number }>;
}

type RoadmapRecord = Pick<ICareerRoadmap, 'targetRoleId' | 'targetRole' | 'targetSource' | 'targetDeadlineWeeks'
  | 'baselineReadinessScore' | 'missingSkills' | 'deferredSkills' | 'source' | 'degradedReason' | 'milestones' | 'generatedAt'>
  & { _id: unknown };

const percent = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0);

/** API shape. Milestone completion is derived from its tasks so it can never disagree with them. */
export function toRoadmapView(doc: RoadmapRecord): RoadmapView {
  let done = 0;
  let total = 0;
  const milestones = doc.milestones.map(milestone => {
    const tasks = milestone.tasks.map(task => ({
      taskId: task.taskId, kind: task.kind, title: task.title, completed: task.completed, completedAt: task.completedAt ?? null,
    }));
    const finished = tasks.filter(task => task.completed);
    done += finished.length;
    total += tasks.length;
    const completed = tasks.length > 0 && finished.length === tasks.length;
    const completedAt = completed
      ? new Date(Math.max(...finished.map(task => task.completedAt?.getTime() ?? 0)))
      : null;
    return {
      milestoneId: milestone.milestoneId,
      sequence: milestone.sequence,
      startWeek: milestone.startWeek,
      endWeek: milestone.endWeek,
      skills: milestone.skills,
      objective: milestone.objective,
      projectArchitecture: milestone.projectArchitecture,
      keyConcepts: milestone.keyConcepts,
      dsaPatterns: milestone.dsaPatterns,
      verificationCriteria: milestone.verificationCriteria,
      tasks,
      completed,
      completedAt,
      progress: percent(finished.length, tasks.length),
    };
  });
  return {
    id: String(doc._id),
    targetRoleId: doc.targetRoleId,
    targetRole: doc.targetRole,
    targetSource: doc.targetSource,
    targetDeadlineWeeks: doc.targetDeadlineWeeks,
    baselineReadinessScore: doc.baselineReadinessScore ?? null,
    missingSkills: doc.missingSkills,
    deferredSkills: doc.deferredSkills,
    source: doc.source,
    degradedReason: doc.degradedReason ?? null,
    generatedAt: doc.generatedAt,
    progress: percent(done, total),
    milestones,
  };
}

/** Generates a roadmap for the target and replaces the user's previous one. */
export async function generateRoadmap(userId: string, input: GenerateRoadmapInput): Promise<RoadmapView> {
  const target = await resolveTarget(userId, input.targetRoleId);
  const [missingSkills, core] = await Promise.all([
    findMissingSkills(userId, target.requiredSkills),
    ReadinessCore.findOne({ userId }, { overallScore: 1 }).lean(),
  ]);
  if (missingSkills.length === 0) {
    throw new RoadmapError('You already cover every required skill for this target role', 'NO_SKILL_GAPS', 409);
  }

  const readinessScore = typeof core?.overallScore === 'number' ? core.overallScore : null;
  const deadlineWeeks = input.targetDeadlineWeeks
    ?? Math.min(ROADMAP_MAX_WEEKS, Math.max(ROADMAP_MIN_WEEKS, missingSkills.length * ROADMAP_BLOCK_WEEKS));
  const { plans, deferredSkills } = planMilestones(missingSkills, deadlineWeeks);

  const ai = await aiMilestones(userId, target.targetRole, plans, readinessScore);
  const source: RoadmapSource = 'content' in ai ? 'ai' : 'template';
  const milestones: ICareerRoadmapMilestone[] = plans.map((plan, index) => {
    const milestoneId = `m${plan.sequence}`;
    const content = 'content' in ai ? ai.content[index] : templateMilestone(plan, target.targetRole, readinessScore);
    return { milestoneId, ...plan, ...content, tasks: tasksFor(milestoneId, content) };
  });

  const saved = await CareerRoadmap.findOneAndUpdate(
    { userId },
    {
      $set: {
        targetRoleId: target.targetRoleId,
        targetRole: target.targetRole,
        targetSource: target.targetSource,
        targetDeadlineWeeks: deadlineWeeks,
        baselineReadinessScore: readinessScore,
        missingSkills,
        deferredSkills,
        source,
        degradedReason: 'degradedReason' in ai ? ai.degradedReason : null,
        milestones,
        generatedAt: new Date(),
      },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean();
  return toRoadmapView(saved!);
}

export async function getRoadmap(userId: string): Promise<RoadmapView> {
  const roadmap = await CareerRoadmap.findOne({ userId }).lean();
  if (!roadmap) throw new RoadmapError('No roadmap generated yet', 'ROADMAP_NOT_FOUND', 404);
  return toRoadmapView(roadmap);
}

/**
 * Marks one task complete or incomplete. Only a task in the opposite state is written, so
 * repeating a request is a no-op and keeps the original completion time.
 */
export async function setTaskCompletion(userId: string, milestoneId: string, taskId: string, completed: boolean): Promise<RoadmapView> {
  const updated = await CareerRoadmap.findOneAndUpdate(
    { userId, milestones: { $elemMatch: { milestoneId, tasks: { $elemMatch: { taskId, completed: !completed } } } } },
    {
      $set: {
        'milestones.$[m].tasks.$[t].completed': completed,
        'milestones.$[m].tasks.$[t].completedAt': completed ? new Date() : null,
      },
    },
    { arrayFilters: [{ 'm.milestoneId': milestoneId }, { 't.taskId': taskId }], new: true },
  ).lean();
  if (updated) return toRoadmapView(updated);

  const current = await CareerRoadmap.findOne({
    userId,
    milestones: { $elemMatch: { milestoneId, 'tasks.taskId': taskId } },
  }).lean();
  if (!current) throw new RoadmapError('Roadmap task not found', 'ROADMAP_TASK_NOT_FOUND', 404);
  return toRoadmapView(current);
}
