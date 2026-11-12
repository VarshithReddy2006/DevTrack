import { Types } from 'mongoose';
import { ATSAnalysis } from '../../../db/models/atsAnalysis.model.js';
import { ReadinessCore } from '../../../db/models/readinessCore.model.js';
import { ReadinessDsa } from '../../../db/models/readinessDsa.model.js';
import { ReadinessProjects } from '../../../db/models/readinessProjects.model.js';
import { ResumeCredibility } from '../../../db/models/resumeCredibility.model.js';
import { ResumeEvidenceClaim } from '../../../db/models/resumeEvidenceClaim.model.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import { VerifiedProject } from '../../../db/models/verifiedProject.model.js';
import { EmbeddingProviderAdapter } from '../../ai/embedding/EmbeddingProviderAdapter.js';
import { CosineSimilarityEngine } from '../../ai/retrieval/CosineSimilarityEngine.js';
import { logger } from '../../../shared/logger.js';

export interface IMLRankingInput {
  atsScore: number;
  infraMaturity: number;
  projectQuality: number;
  engineeringDepth: number;
  roleAlignment: number;
}

export interface RoleMatchResult {
  score: number;
  usedFallback: boolean;
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in',
  'is', 'of', 'on', 'or', 'that', 'the', 'to', 'with', 'you', 'your']);

function termFrequencies(text: string): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of text.normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}]+(?:[.+#][\p{L}\p{N}]+|[+#]+)*/gu)) {
    const term = token[0];
    if (STOP_WORDS.has(term)) continue;
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  return frequencies;
}

/**
 * ResumeMLService
 * 
 * Foundation for ML-driven resume intelligence.
 * Includes ranking, recommendation optimization, and semantic matching.
 */
export class ResumeMLService {
  private readonly similarity = new CosineSimilarityEngine();

  constructor(private readonly embeddings: Pick<EmbeddingProviderAdapter, 'generateEmbeddingBatch'> = new EmbeddingProviderAdapter()) {}

  /**
   * Rank resume quality using structured ML signals (XGBoost/LightGBM)
   * In production, this would call a Python microservice or use a WASM/Node binding.
   */
  async rankResumeQuality(input: IMLRankingInput): Promise<number> {
    logger.info('[ResumeMLService] Ranking resume quality');
    
    // Placeholder for XGBoost/LightGBM model inference
    // Deterministic fallback for now
    const score = (
      input.atsScore * 0.3 +
      input.infraMaturity * 0.2 +
      input.projectQuality * 0.2 +
      input.engineeringDepth * 0.2 +
      input.roleAlignment * 0.1
    );

    return Math.round(score);
  }

  /** Prioritize actions backed by this user's latest available evidence. */
  async optimizeRecommendations(userId: string, currentReadiness?: number): Promise<string[]> {
    if (!Types.ObjectId.isValid(userId)) return [];
    const owner = new Types.ObjectId(userId);
    const ownerKey = owner.toHexString();
    const [ats, core, dsa, projects, unsupportedClaim, verifiedProject, session] = await Promise.all([
      ATSAnalysis.findOne({ userId: owner }).sort({ createdAt: -1, _id: -1 })
        .select('parserWarnings keywordCoverage recommendations').lean(),
      ReadinessCore.findOne({ userId: ownerKey }).select('overallScore targetRoleAlignment isDegraded').lean(),
      ReadinessDsa.findOne({ userId: ownerKey }).select('weakTopics neglectedTopics').lean(),
      ReadinessProjects.findOne({ userId: ownerKey }).select('evidenceCoverage deploymentEvidence').lean(),
      ResumeEvidenceClaim.exists({ userId: owner, verificationStatus: { $in: ['partial', 'unverified', 'flagged'] } }),
      VerifiedProject.findOne({ userId: owner, 'verification.status': 'verified' })
        .sort({ updatedAt: -1, _id: -1 }).select('name').lean(),
      ResumeSession.findOne({ userId: owner, 'timestamps.completedAt': { $ne: null } })
        .sort({ 'timestamps.completedAt': -1, _id: -1 }).select('sessionId').lean(),
    ]);
    const credibility = session
      ? await ResumeCredibility.findOne({ sessionId: session.sessionId }).select('suspiciousClaims').lean()
      : null;

    const actions: { priority: number; text: string }[] = [];
    if (unsupportedClaim || credibility?.suspiciousClaims?.length) {
      actions.push({
        priority: 100,
        text: 'Verify flagged or unsupported resume claims with a repository, project artifact, or measurable result before using them.',
      });
    }

    const parserFix = ats?.parserWarnings?.find(warning => warning.severity === 'critical' && warning.suggestion?.trim());
    if (parserFix) actions.push({ priority: 95, text: parserFix.suggestion.trim() });
    const missingKeywords = [...new Set(ats?.keywordCoverage
      ?.filter(entry => !entry.found && entry.keyword?.trim()).map(entry => entry.keyword.trim()) ?? [])].slice(0, 4);
    if (missingKeywords.length) {
      actions.push({
        priority: 85,
        text: `Add evidence-backed examples for missing ATS keywords where relevant: ${missingKeywords.join(', ')}.`,
      });
    }
    if (ats?.recommendations?.[0]?.trim()) {
      actions.push({ priority: 75, text: ats.recommendations[0].trim() });
    }

    const weakTopics = [...new Set([...(dsa?.weakTopics ?? []), ...(dsa?.neglectedTopics ?? [])]
      .map(topic => topic.trim()).filter(Boolean))].slice(0, 3);
    if (weakTopics.length) {
      const readiness = currentReadiness ?? core?.overallScore;
      actions.push({
        priority: readiness !== undefined && readiness < 50 ? 80 : 65,
        text: `Practice ${weakTopics.join(', ')} and save representative solutions that explain the tradeoffs.`,
      });
    }
    if (verifiedProject?.name) {
      actions.push({
        priority: core && !core.isDegraded && core.targetRoleAlignment < 50 ? 82 : 70,
        text: `Use ${verifiedProject.name} to show a contribution relevant to your target role and explain its measurable impact.`,
      });
    } else if (projects && projects.evidenceCoverage > 0 && projects.deploymentEvidence < 50) {
      actions.push({
        priority: 70,
        text: 'Add a deployment link or CI run to substantiate the delivery work described in your projects.',
      });
    }

    return [...new Set(actions.sort((left, right) => right.priority - left.priority).map(action => action.text))].slice(0, 3);
  }

  /** Compare transient resume and role text in one embedding batch. */
  async matchRoleSemantically(resumeContent: string, jobDescription: string): Promise<RoleMatchResult> {
    const resume = resumeContent.trim();
    const role = jobDescription.trim();
    if (!resume || !role) return { score: 0, usedFallback: true };

    try {
      // An unscoped batch uses the provider without caching either document.
      const [left, right] = await this.embeddings.generateEmbeddingBatch([resume, role]);
      if (left && right && left.model !== 'deterministic-fallback-v1' && left.model === right.model
          && left.provider === right.provider && left.dimensions === right.dimensions
          && [left, right].every(embedding => embedding.vector.length === embedding.dimensions
            && embedding.vector.every(Number.isFinite) && embedding.vector.some(value => value !== 0))) {
        const similarity = this.similarity.calculateSimilarity(left.vector, right.vector);
        if (Number.isFinite(similarity)) {
          return { score: Math.max(0, Math.min(1, similarity)), usedFallback: false };
        }
      }
    } catch {
      logger.warn('[ResumeMLService] Embedding unavailable, using lexical role matching');
    }

    const resumeTerms = termFrequencies(resume);
    const roleTerms = termFrequencies(role);
    const vocabulary = [...new Set([...resumeTerms.keys(), ...roleTerms.keys()])];
    const score = this.similarity.calculateSimilarity(
      vocabulary.map(term => Math.log1p(resumeTerms.get(term) ?? 0)),
      vocabulary.map(term => Math.log1p(roleTerms.get(term) ?? 0)),
    );
    return { score: Math.min(1, score), usedFallback: true };
  }
}
