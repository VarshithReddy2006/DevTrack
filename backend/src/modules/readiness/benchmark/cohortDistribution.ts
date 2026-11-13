import { createHash } from 'node:crypto';
import type { PipelineStage } from 'mongoose';
import { z } from 'zod';
import { CareerIntent, type ICareerIntent } from '../../../db/models/careerIntent.model.js';
import { ReadinessCore } from '../../../db/models/readinessCore.model.js';
import { ReadinessDsa } from '../../../db/models/readinessDsa.model.js';
import { ReadinessSkills } from '../../../db/models/readinessSkills.model.js';
import { ReadinessProjects } from '../../../db/models/readinessProjects.model.js';
import { getRedisClient } from '../../../shared/redis/index.js';

export const minCohortSize = 30;
const maxCohortSize = 2000;
const cacheTtlSeconds = 30 * 60;
const scoreValues = z.array(z.number().finite()).max(maxCohortSize);
const cohortSchema = z.object({
  sampleSize: z.number().int().min(0).max(maxCohortSize),
  sampledAt: z.string().datetime(),
  overallScore: scoreValues,
  totalSolves: scoreValues,
  hardProblemProgression: scoreValues,
  solveConsistency: scoreValues,
  overallEngineeringDepth: scoreValues,
  projectCredibilityScore: scoreValues,
  infrastructureSophistication: scoreValues,
  engineeringMaturity: scoreValues,
});

type CohortData = z.infer<typeof cohortSchema>;
type Criteria = Pick<ICareerIntent, 'dreamRole'> & Partial<Pick<ICareerIntent, 'targetCompanyTier' | 'experienceLevel'>>;
type Metric = Exclude<keyof CohortData, 'sampleSize' | 'sampledAt'>;
type ReadinessRow = Partial<Record<Metric, number>>;

const domainMetrics = [
  { model: ReadinessDsa, alias: 'dsa', fields: ['totalSolves', 'hardProblemProgression', 'solveConsistency'] },
  { model: ReadinessSkills, alias: 'skills', fields: ['overallEngineeringDepth'] },
  { model: ReadinessProjects, alias: 'projects', fields: ['projectCredibilityScore', 'infrastructureSophistication', 'engineeringMaturity'] },
] as const;

export function cohortCriteria(intent: Criteria): Criteria {
  return {
    dreamRole: intent.dreamRole,
    targetCompanyTier: intent.targetCompanyTier || undefined,
    experienceLevel: intent.experienceLevel || undefined,
  };
}

function lookup(from: string, as: string, fields: readonly Metric[]): PipelineStage.Lookup {
  return { $lookup: {
    from, as, localField: 'userId', foreignField: 'userId',
    pipeline: [{ $project: Object.fromEntries(fields.map(field => [field, 1])) }],
  } };
}

async function loadDistribution(criteria?: Criteria): Promise<CohortData> {
  const pipeline: PipelineStage[] = criteria
    ? [
      { $match: Object.fromEntries(Object.entries(criteria).filter(([, value]) => value !== undefined)) },
      lookup(ReadinessCore.collection.name, 'core', ['overallScore']),
      { $unwind: '$core' },
    ]
    : [];
  pipeline.push(
    // Use a stable sample independent of account creation order. Only these users need domain lookups.
    { $set: { sampleOrder: { $toHashedIndexKey: '$userId' } } },
    { $sort: { sampleOrder: 1, userId: 1 } },
    { $limit: maxCohortSize },
    ...domainMetrics.map(({ model, alias, fields }) => lookup(model.collection.name, alias, fields)),
    { $project: {
      _id: 0,
      overallScore: criteria ? '$core.overallScore' : '$overallScore',
      ...Object.fromEntries(domainMetrics.flatMap(({ alias, fields }) =>
        fields.map(field => [field, { $arrayElemAt: [`$${alias}.${field}`, 0] }]),
      )),
    } },
  );

  const rows = criteria
    ? await CareerIntent.aggregate<ReadinessRow>(pipeline)
    : await ReadinessCore.aggregate<ReadinessRow>(pipeline);
  const values = (metric: Metric) => rows.flatMap(row => {
    const value = row[metric];
    return typeof value === 'number' && Number.isFinite(value) ? [value] : [];
  }).sort((a, b) => a - b);

  return {
    sampleSize: rows.length,
    sampledAt: new Date().toISOString(),
    overallScore: values('overallScore'),
    totalSolves: values('totalSolves'),
    hardProblemProgression: values('hardProblemProgression'),
    solveConsistency: values('solveConsistency'),
    overallEngineeringDepth: values('overallEngineeringDepth'),
    projectCredibilityScore: values('projectCredibilityScore'),
    infrastructureSophistication: values('infrastructureSophistication'),
    engineeringMaturity: values('engineeringMaturity'),
  };
}

export async function getCohortDistribution(criteria?: Criteria) {
  const cohortId = criteria
    ? createHash('sha256').update(JSON.stringify([criteria.dreamRole, criteria.targetCompanyTier, criteria.experienceLevel])).digest('hex')
    : 'global';
  const key = `readiness:cohort:v1:${cohortId}`;
  try {
    const redis = getRedisClient();
    if (redis.status === 'ready') {
      const cached = await redis.get(key);
      if (cached) {
        const result = cohortSchema.safeParse(JSON.parse(cached));
        if (result.success) return { cohortId, data: result.data };
      }
    }
  } catch {
    // MongoDB remains the source of truth when Redis is unavailable.
  }

  const data = await loadDistribution(criteria);
  try {
    const redis = getRedisClient();
    if (redis.status === 'ready') await redis.set(key, JSON.stringify(data), 'EX', cacheTtlSeconds);
  } catch {
    // A failed cache write does not invalidate the computed distribution.
  }
  return { cohortId, data };
}
