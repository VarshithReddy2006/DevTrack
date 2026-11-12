// src/modules/resume-intelligence/orchestration/ResumeProcessingOrchestrator.ts
import { artifactStorage } from '../upload/artifact-storage.js';
import type { Types } from 'mongoose';
import { ResumeSession, type ProcessingStage } from '../../../db/models/resumeSession.model.js';
import { DocumentParsingPipeline } from '../parsing/document-parsing-pipeline.js';
import { ATSCompatibilityEngine } from '../ats/ATSCompatibilityEngine.js';
import { logger } from '../../../shared/logger.js';
import { eventBus } from '../../../shared/sse/index.js';
import { EMBEDDING_VERSION } from '../../ai/embedding/embeddingScope.js';
import { RealEmbeddingPipeline } from '../../ai/embedding/RealEmbeddingPipeline.js';
import { SemanticSimilarityService } from '../../ai/retrieval/SemanticSimilarityService.js';
import { RecommendationIntelligenceService } from '../../recommendations/recommendation.service.js';
import { getOrCreateQueue } from '../../../shared/jobs/queueFactory.js';
import { QueueNames } from '../../../shared/jobs/types.js';
import { NonRetryableError, RetryableError } from '../../../infrastructure/queues/ErrorClassifier.js';
import { SemanticIntelligenceLayer } from '../ai/SemanticIntelligenceLayer.js';
import { SemanticAnalysis } from '../../../db/models/semanticAnalysis.model.js';
import { RuntimeReliabilityEnforcer } from '../../ai/reliability/RuntimeReliabilityEnforcer.js';
const stageQueues: Partial<Record<ProcessingStage, string>> = {
  ATS_ANALYZING: QueueNames.RESUME_ATS,
  EMBEDDING: QueueNames.RESUME_EMBEDDING,
  SEMANTIC_ANALYZING: QueueNames.RESUME_SEMANTIC,
  RECOMMENDING: QueueNames.RESUME_RECOMMENDATION,
};

type StreamStatus = 'pending' | 'running' | 'completed' | 'failed' | 'degraded';

const RUNTIME_STAGE_LABELS: Record<ProcessingStage, string> = {
  UPLOADED: 'UPLOADING',
  VALIDATING: 'UPLOADING',
  PARSING: 'PARSING',
  EXTRACTING: 'SECTION_EXTRACTION',
  ATS_ANALYZING: 'ATS_ANALYZING',
  EMBEDDING: 'EMBEDDING_GENERATION',
  SEMANTIC_ANALYZING: 'SEMANTIC_RETRIEVAL',
  RECOMMENDING: 'RECOMMENDATION_GENERATION',
  REPLAY_GENERATING: 'DOSSIER_GENERATION',
  REPORT_GENERATING: 'DOSSIER_GENERATION',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  DEGRADED: 'DEGRADED',
};

/**
 * ResumeProcessingOrchestrator
 * 
 * The runtime intelligence controller for resume processing.
 * Handles stage transitions, queue coordination, worker dispatch, retry handling,
 * degraded-state handling, failure propagation, and persistence updates.
 */
export class ResumeProcessingOrchestrator {
  private parsingPipeline: DocumentParsingPipeline;
  private atsEngine: ATSCompatibilityEngine;
  private embeddingPipeline = new RealEmbeddingPipeline();
  private semanticLayer = new SemanticIntelligenceLayer();
  private reliabilityEnforcer = new RuntimeReliabilityEnforcer();

  constructor(private readonly dispatchStages = false) {
    this.parsingPipeline = new DocumentParsingPipeline();
    this.atsEngine = new ATSCompatibilityEngine();
  }

  /**
   * Start processing for a resume session
   */
  async startProcessing(sessionId: string, finalHandoffAttempt = false): Promise<void> {
    logger.info(`[ProcessingOrchestrator] Starting processing for session: ${sessionId}`);

    const session = await ResumeSession.findOne({ sessionId });
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.failureState?.failed) {
      if (!this.dispatchStages && session.checkpointState?.stage) {
        await this.resumeFromCheckpoint(sessionId);
      }
      return;
    }

    if (this.dispatchStages && session.checkpointState?.stage) {
      if (['VALIDATING', 'PARSING', 'EXTRACTING'].includes(session.checkpointState.stage)) {
        await this.transitionToNextStage(sessionId, undefined, finalHandoffAttempt);
      }
      return;
    }

    // Update session state
    session.currentStage = 'VALIDATING';
    session.timestamps.startedProcessingAt = new Date();
    session.timestamps.lastUpdated = new Date();
    session.runtimeEvents = session.runtimeEvents || [];
    await session.save();

    // Stream initial state
    await this.streamProgress(session, 'running');

    // Actually execute the validation stage
    try {
      await this.executeValidation(session);
      // Add to processing history only after successful execution
      await this.addProcessingHistory(session, 'VALIDATING', 'success');
      await this.saveCheckpoint(session, 'VALIDATING');
    } catch (error) {
      logger.error(`[ProcessingOrchestrator] Validation failed for session: ${sessionId}`, error);
      await this.handleStageFailure(sessionId, 'VALIDATING', error);
      if (this.dispatchStages) {
        throw new NonRetryableError('Resume validation failed', error instanceof Error ? error : undefined);
      }
      return;
    }

    // Start stage transitions
    await this.transitionToNextStage(sessionId, undefined, finalHandoffAttempt);
  }

  /**
   * Transition to next processing stage
   */
  async processQueuedStage(sessionId: string, stage: ProcessingStage, generation: number, finalHandoffAttempt = false): Promise<void> {
    const session = await ResumeSession.findOne({ sessionId });
    if (!session || (session.failureState.retryCount ?? 0) !== generation) return;
    if (session.currentStage === 'COMPLETED' || session.currentStage === 'DEGRADED') {
      if (stage === 'RECOMMENDING' && session.uploadMetadata.uploadPath) {
        await artifactStorage.remove(session.uploadMetadata.uploadPath);
      }
      return;
    }
    if (session.currentStage === 'FAILED') return;

    const checkpoint = session.checkpointState?.stage;
    if (!checkpoint) return;
    if (this.getNextStage(checkpoint) !== stage && checkpoint !== stage
      && !(stage === 'RECOMMENDING' && checkpoint === 'REPLAY_GENERATING')) return;

    await this.transitionToNextStage(sessionId, stage, finalHandoffAttempt);
    if (stage === 'RECOMMENDING') {
      const finished = await ResumeSession.findOne({ sessionId });
      if (finished?.timestamps.completedAt && finished.uploadMetadata.uploadPath) {
        await artifactStorage.remove(finished.uploadMetadata.uploadPath);
      }
    }
  }

  private async transitionToNextStage(sessionId: string, workerStage?: ProcessingStage, finalHandoffAttempt = false): Promise<void> {
    const session = await ResumeSession.findOne({ sessionId });
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const currentStage = this.dispatchStages
      ? session.checkpointState?.stage ?? session.currentStage
      : session.currentStage;
    const nextStage = this.getNextStage(currentStage);

    if (!nextStage) {
      // Processing complete
      await this.completeProcessing(sessionId);
      return;
    }

    const queue = this.dispatchStages && stageQueues[nextStage];
    if (queue && nextStage !== workerStage) {
      const generation = session.failureState.retryCount ?? 0;
      // BullMQ custom IDs reserve colons.
      try {
        await getOrCreateQueue(queue).add('resume-stage', { sessionId, generation }, {
          jobId: `${sessionId}--${nextStage}--${generation}`,
        });
      } catch (error) {
        const cause = error instanceof Error ? error : undefined;
        const message = `Could not enqueue resume stage ${nextStage}`;
        if (!finalHandoffAttempt) throw new RetryableError(message, cause);
        await this.handleStageFailure(sessionId, nextStage, new Error(message));
        throw new NonRetryableError(message, cause);
      }
      return;
    }

    logger.info(`[ProcessingOrchestrator] Transitioning from ${currentStage} to ${nextStage}`);

    // Update stage
    session.currentStage = nextStage;
    session.timestamps.lastUpdated = new Date();
    await session.save();

    // Stream progress change
    await this.streamProgress(session, 'running');

    // Execute stage with retries and failover
    const startTime = Date.now();
    try {
      let attempt = 0;
      let success = false;
      
      while (attempt < 3 && !success) {
        try {
          await this.streamProgress(session, 'running', undefined, undefined, {
            attempt: attempt + 1,
            maxAttempts: 3,
          });
          await this.executeStage(session, nextStage);
          success = true;
        } catch (err) {
          attempt++;
          logger.warn(`[ProcessingOrchestrator] Execution attempt ${attempt} for stage ${nextStage} failed: ${err instanceof Error ? err.message : String(err)}`);
          if (attempt >= 3) throw err;
          await new Promise(resolve => setTimeout(resolve, 500 * attempt)); // retry backoff
        }
      }

      const durationMs = Date.now() - startTime;

      // Track real execution replay snapshot
      const updatedSession = await ResumeSession.findOne({ sessionId });
      if (updatedSession) {
        const reason = updatedSession.degradedState.degradedComponents?.includes(nextStage)
          ? updatedSession.degradedState.degradedReason : undefined;
        updatedSession.replayState.snapshots = updatedSession.replayState.snapshots || [];
        updatedSession.replayState.snapshots.push({
          stage: nextStage,
          timestamp: new Date(),
          status: reason ? 'degraded' : 'success',
          metrics: {
            durationMs,
            memoryUsage: process.memoryUsage().heapUsed,
          },
          stateSnapshot: {
            currentStage: nextStage,
            atsScore: updatedSession.atsState.atsScore,
            generatedEmbeddings: updatedSession.embeddingState.generated,
            semanticSimilarity: updatedSession.semanticState.semanticSimilarity,
            recommendationCount: updatedSession.recommendationState.recommendations?.length || 0,
          }
        });
        await this.addProcessingHistory(updatedSession, nextStage, reason ? 'degraded' : 'success', reason, false);
        await this.saveCheckpoint(updatedSession, nextStage);
        await this.streamProgress(updatedSession, updatedSession.degradedState.degraded ? 'degraded' : 'completed', undefined, undefined, {
          latencyMs: durationMs,
          attemptCount: attempt + 1,
        });
      }
    } catch (error) {
      logger.error(`[ProcessingOrchestrator] Stage ${nextStage} failed after all retries:`, error);
      await this.handleStageFailure(sessionId, nextStage, error);
      if (this.dispatchStages) {
        throw new NonRetryableError(`Resume stage ${nextStage} failed`, error instanceof Error ? error : undefined);
      }
      return;
    }

    // Retry a failed handoff from the committed checkpoint on job redelivery.
    await this.transitionToNextStage(sessionId, undefined, finalHandoffAttempt);
  }

  /** Restore the last committed stage and continue from the following stage. */
  async resumeFromCheckpoint(sessionId: string, finalHandoffAttempt = false): Promise<void> {
    const session = await ResumeSession.findOne({ sessionId });
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const checkpoint = session.checkpointState;
    if (!checkpoint?.stage) throw new Error(`No checkpoint available for session: ${sessionId}`);

    if (session.failureState.failed || !this.dispatchStages) {
      Object.assign(session, checkpoint.snapshot);
      session.currentStage = checkpoint.stage;
      session.failureState = { failed: false, retryCount: session.failureState.retryCount || 0 };
      session.timestamps.lastUpdated = new Date();
      await session.save();
    }

    await this.transitionToNextStage(sessionId, undefined, finalHandoffAttempt);
  }

  private async saveCheckpoint(session: typeof ResumeSession.prototype, stage: ProcessingStage): Promise<void> {
    session.checkpointState = {
      stage,
      savedAt: new Date(),
      snapshot: {
        parsedContent: session.parsedContent,
        atsState: session.atsState,
        embeddingState: session.embeddingState,
        semanticState: session.semanticState,
        recommendationState: session.recommendationState,
        replayState: session.replayState,
        reportState: session.reportState,
        degradedState: session.degradedState,
        evolutionSnapshots: session.evolutionSnapshots,
      },
    };
    await session.save();
  }

  /**
   * Execute a specific processing stage
   */
  private async executeStage(session: typeof ResumeSession.prototype, stage: ProcessingStage): Promise<void> {
    switch (stage) {
      case 'VALIDATING':
        await this.executeValidation(session);
        break;
      case 'PARSING':
        await this.executeParsing(session);
        break;
      case 'EXTRACTING':
        await this.executeExtraction(session);
        break;
      case 'ATS_ANALYZING':
        await this.executeATSAnalysis(session);
        break;
      case 'EMBEDDING':
        await this.executeEmbedding(session);
        break;
      case 'SEMANTIC_ANALYZING':
        await this.executeSemanticAnalysis(session);
        break;
      case 'RECOMMENDING':
        await this.executeRecommendation(session);
        break;
      case 'REPLAY_GENERATING':
        await this.executeReplayGeneration(session);
        break;
      default:
        throw new Error(`Unknown stage: ${stage}`);
    }
  }

  /**
   * Execute validation stage
   */
  private async executeValidation(session: typeof ResumeSession.prototype): Promise<void> {
    logger.info(`[ProcessingOrchestrator] Executing VALIDATION for session: ${session.sessionId}`);
    const warnings = session.parsedContent.parsingDiagnostics.warnings;
    if (session.uploadMetadata.fileSize > 10 * 1024 * 1024) {
      warnings.push('Upload exceeds configured 10MB processing limit.');
    }
    if (!['pdf', 'docx', 'txt', 'md'].includes(session.uploadMetadata.fileType)) {
      throw new Error(`Unsupported resume file type: ${session.uploadMetadata.fileType}`);
    }
    if (session.uploadMetadata.originalFilename.includes('..')) {
      throw new Error('Unsafe upload filename rejected.');
    }
    session.timestamps.lastUpdated = new Date();
    await session.save();
  }

  /**
   * Execute parsing stage
   */
  private async executeParsing(session: typeof ResumeSession.prototype): Promise<void> {
    logger.info(`[ProcessingOrchestrator] Executing PARSING for session: ${session.sessionId}`);

    const result = await this.parsingPipeline.parse(
      session.sessionId,
      await artifactStorage.readPath(session.uploadMetadata.uploadPath),
      session.uploadMetadata.originalFilename
    );

    if (!result.success || !result.document) {
      throw new Error(result.error || 'Parsing failed');
    }

    session.parsedContent = {
      text: result.document.text,
      sections: result.document.sections,
      headings: result.document.headings,
      bullets: result.document.bullets,
      links: result.document.links,
      metadata: result.document.metadata,
      parsingDiagnostics: result.document.parsingDiagnostics,
      extractedAt: result.document.extractedAt,
    };

    session.timestamps.lastUpdated = new Date();
    await session.save();
  }

  /**
   * Execute extraction stage
   */
  private async executeExtraction(session: typeof ResumeSession.prototype): Promise<void> {
    logger.info(`[ProcessingOrchestrator] Executing EXTRACTION for session: ${session.sessionId}`);
    
    if (!session.parsedContent || !session.parsedContent.text) {
      throw new Error('No text was extracted from the resume');
    }

    const { skills, provenance, degradedReason } = await this.semanticLayer.extractResumeSkills(
      session.parsedContent.text, session.userId?.toString() ?? session.sessionId,
    );
    session.parsedContent.metadata = { ...session.parsedContent.metadata, extractedSkills: skills, skillExtractionProvenance: provenance };
    if (degradedReason) this.markDegraded(session, 'EXTRACTING', degradedReason);
    await session.save();
  }

  /**
   * Execute ATS analysis stage
   */
  private async executeATSAnalysis(session: typeof ResumeSession.prototype): Promise<void> {
    logger.info(`[ProcessingOrchestrator] Executing ATS_ANALYZING for session: ${session.sessionId}`);

    const { ResumeProfile } = await import('../../../db/models/resumeProfile.model.js');
    let profile = session.userId ? await ResumeProfile.findOne({ userId: session.userId }) : null;
    if (!profile && session.userId) {
      profile = await ResumeProfile.create({ userId: session.userId });
    }

    const analysis = await this.atsEngine.analyze({
      userId: session.userId as Types.ObjectId,
      resumeProfileId: (profile?._id || session._id) as Types.ObjectId,
      content: session.parsedContent.text,
      targetKeywords: profile?.selectedSkills || [],
    });

    session.atsState = {
      analyzed: true,
      atsScore: analysis.atsScore,
      parserWarnings: analysis.parserWarnings,
      formattingWarnings: analysis.formattingWarnings,
      keywordCoverage: analysis.keywordCoverage,
      sectionIntegrity: analysis.sectionIntegrity,
      extractionConfidence: analysis.extractionConfidence,
      recommendations: analysis.recommendations,
      analyzedAt: new Date(),
    };

    session.timestamps.lastUpdated = new Date();
    await session.save();
  }

  /**
   * Execute embedding stage
   */
  private async executeEmbedding(session: typeof ResumeSession.prototype): Promise<void> {
    logger.info(`[ProcessingOrchestrator] Executing EMBEDDING for session: ${session.sessionId}`);

    const text = session.parsedContent.text || '';

    // Safety/Abuse checks
    if (text.length > 50000) {
      throw new Error('Security Abuse Protection: Payload size too large for embedding model.');
    }
    if (text.includes('system prompt') || text.includes('ignore previous instructions')) {
      logger.warn(`[ProcessingOrchestrator] Prompt injection marker detected in session: ${session.sessionId}`);
      session.parsedContent.parsingDiagnostics.warnings.push('Potential prompt injection wording detected in resume content.');
    }

    const scope = session.userId ? { scope: 'user' as const, userId: session.userId.toString() } : undefined;
    const embedding = scope
      ? await this.embeddingPipeline.processAndStore(session.sessionId, text, scope)
      : await this.embeddingPipeline.embedText(text);

    if (embedding.model === 'deterministic-fallback-v1') {
      this.markDegraded(session, 'EMBEDDING', 'No embedding provider configured');
    }
    session.embeddingState = {
      generated: true,
      vector: embedding.vector,
      provider: embedding.provider,
      dimensions: embedding.dimensions,
      embeddingVersion: EMBEDDING_VERSION,
      generatedAt: new Date(),
    };
    await session.save();
  }

  /**
   * Execute semantic analysis stage
   */
  private async executeSemanticAnalysis(session: typeof ResumeSession.prototype): Promise<void> {
    logger.info(`[ProcessingOrchestrator] Executing SEMANTIC_ANALYZING for session: ${session.sessionId}`);
    
    const intelligence = await this.semanticLayer.analyzeResume(
      session.parsedContent.text, session.userId?.toString() ?? session.sessionId,
    );
    if (intelligence.degradedReason) {
      this.markDegraded(session, 'SEMANTIC_ANALYZING', intelligence.degradedReason);
    } else if (intelligence.analysis) {
      await SemanticAnalysis.findOneAndUpdate({ sessionId: session.sessionId }, {
        ...intelligence.analysis, provenance: intelligence.provenance, sessionId: session.sessionId,
      }, { upsert: true, setDefaultsOnInsert: true });
    }
    await session.save();

    const scope = session.userId ? { scope: 'user' as const, userId: session.userId.toString() } : undefined;
    const resumeVector = session.embeddingState.embeddingVersion === EMBEDDING_VERSION
      ? session.embeddingState.vector
      : scope ? await this.embeddingPipeline.getEmbeddingForId(scope, session.sessionId) : null;
    if (resumeVector && !session.degradedState.degradedComponents?.includes('EMBEDDING')) {
      const similarityService = new SemanticSimilarityService();
      
      // Determine the target role based on the profile or filename fallback
      const { ResumeProfile } = await import('../../../db/models/resumeProfile.model.js');
      const profile = session.userId ? await ResumeProfile.findOne({ userId: session.userId }) : null;
      const targetRole = profile?.targetRole || (session.uploadMetadata.originalFilename.toLowerCase().includes('frontend') ? 'frontend engineer' : 'backend engineer');
      
      // Formulate a descriptive expectation prompt for the semantic search matching
      const roleExpectationsPrompt = `A professional software engineer specializing in ${targetRole} roles, possessing comprehensive expertise in typical stacks, architecture paradigms, infrastructure deployments, databases, and core problem-solving competencies aligned with ${targetRole} duties.`;
      
      const embeddingRes = await this.embeddingPipeline.embedText(roleExpectationsPrompt, scope);
      if (embeddingRes.dimensions !== resumeVector.length
        || (session.embeddingState.provider && embeddingRes.provider !== session.embeddingState.provider)) {
        throw new Error('Resume and expectation use different embedding models');
      }
      const expectationVector = embeddingRes.vector;

      const score = similarityService.calculate(resumeVector, expectationVector);
      
      session.semanticState = {
        analyzed: true,
        retrievalResults: [{ id: session.sessionId, score: parseFloat(score.toFixed(2)) }],
        semanticSimilarity: parseFloat(score.toFixed(2)),
        analyzedAt: new Date(),
      };
      await session.save();
    }
  }

  private markDegraded(session: typeof ResumeSession.prototype, stage: ProcessingStage, reason: string): void {
    if (session.degradedState.degradedComponents?.includes(stage)) return;
    session.degradedState = {
      degraded: true,
      degradedComponents: [...new Set([...(session.degradedState.degradedComponents ?? []), stage])],
      degradedReason: [session.degradedState.degradedReason, reason].filter(Boolean).join("; "),
      degradedAt: new Date(),
    };
  }

  /**
   * Execute recommendation stage
   */
  private async executeRecommendation(session: typeof ResumeSession.prototype): Promise<void> {
    logger.info(`[ProcessingOrchestrator] Executing RECOMMENDING for session: ${session.sessionId}`);

    const userId = session.userId;
    if (!userId) return;

    const targetRole = session.uploadMetadata.originalFilename.toLowerCase().includes('frontend') ? 'frontend engineer' : 'backend engineer';

    const currentIds = await RecommendationIntelligenceService.generateIntelligence(
      userId,
      session._id!,
      targetRole
    );

    const activeRecs = await RecommendationIntelligenceService.getActiveRecommendations(userId, session._id!, currentIds);
    const recTitles = activeRecs.map(r => r.title);

    let credibilityScore = 85;
    const semanticGaps = activeRecs.filter(r => r.category === 'semantic');
    if (semanticGaps.length > 0) {
      credibilityScore -= (semanticGaps.length * 15);
    }

    session.recommendationState = {
      generated: true,
      recommendations: recTitles,
      credibilityScore: Math.max(30, credibilityScore),
      generatedAt: new Date(),
    };
    await session.save();

    // Perform Cross-System Consistency Validation
    await this.runConsistencyValidation(session);
  }

  /**
   * Run consistency validations to find discrepancies
   */
  private async runConsistencyValidation(session: typeof ResumeSession.prototype): Promise<void> {
    const warnings: string[] = [];

    const hasStrongATS = session.atsState.atsScore && session.atsState.atsScore > 80;
    const hasWeakSemantic = session.semanticState.semanticSimilarity && session.semanticState.semanticSimilarity < 0.6;
    if (hasStrongATS && hasWeakSemantic) {
      warnings.push('Consistency Mismatch: Strong ATS structural match but low semantic alignment to target role expectations.');
    }

    const hasHighCredibility = session.recommendationState.credibilityScore && session.recommendationState.credibilityScore > 80;
    const hasLowATS = session.atsState.atsScore && session.atsState.atsScore < 50;
    if (hasHighCredibility && hasLowATS) {
      warnings.push('Consistency Mismatch: High credibility/infrastructure scores but degraded ATS formatting structure.');
    }

    if (warnings.length > 0) {
      session.parsedContent.parsingDiagnostics.warnings.push(...warnings);
      session.degradedState.degraded = true;
      session.degradedState.degradedComponents = session.degradedState.degradedComponents || [];
      if (!session.degradedState.degradedComponents.includes('ConsistencyValidator')) {
        session.degradedState.degradedComponents.push('ConsistencyValidator');
      }
      session.degradedState.degradedReason ??= 'System consistency check flagged engineering metric contradictions.';
      session.degradedState.degradedAt = new Date();
      await session.save();
      logger.warn(`[ProcessingOrchestrator] Consistency validations flagged contradictions for session: ${session.sessionId}`, { warnings });
      await this.streamProgress(session, 'degraded', undefined, warnings);
    }
  }

  /**
   * Execute replay generation stage
   */
  private async executeReplayGeneration(session: typeof ResumeSession.prototype): Promise<void> {
    logger.info(`[ProcessingOrchestrator] Executing REPLAY_GENERATING for session: ${session.sessionId}`);
    const timeline = [
      ...(session.runtimeEvents || []).map((event: any) => ({
        type: 'runtime_event',
        stage: event.emittedStage || event.stage,
        status: event.status,
        timestamp: event.timestamp,
        progress: event.progress,
        confidence: event.confidence,
        latencyMs: event.latencyMs,
        warnings: event.warnings || [],
        errors: event.errors || [],
        metadata: event.metadata || {},
      })),
      ...(session.replayState.snapshots || []).map((snapshot: any) => ({
        type: 'state_snapshot',
        ...snapshot,
      })),
    ].sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    session.replayState = {
      generated: true,
      snapshots: session.replayState.snapshots || [],
      replayHistory: session.replayState.replayHistory || [],
      timeline,
      generatedAt: new Date(),
    };
    await session.save();
  }

  /**
   * Complete processing
   */
  private async completeProcessing(sessionId: string): Promise<void> {
    const session = await ResumeSession.findOne({ sessionId });
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    logger.info(`[ProcessingOrchestrator] Processing complete for session: ${sessionId}`);

    if (session.timestamps.completedAt) return;
    const providerDegraded = session.degradedState.degradedComponents?.some(component =>
      component === 'EXTRACTING' || component === 'EMBEDDING' || component === 'SEMANTIC_ANALYZING',
    );
    session.currentStage = providerDegraded ? 'DEGRADED' : 'COMPLETED';
    session.timestamps.completedAt = new Date();
    session.timestamps.lastUpdated = new Date();
    await session.save();

    // Stream final progress event
    await this.streamProgress(session, providerDegraded ? 'degraded' : 'completed',
      providerDegraded && session.degradedState.degradedReason ? [session.degradedState.degradedReason] : undefined);

    // Add to processing history
    await this.addProcessingHistory(session, session.currentStage, providerDegraded ? 'degraded' : 'success');

    // Phase 2: Longitudinal Evolution Delta calculation
    // Phase 2: Longitudinal Evolution Delta calculation
    try {
      if (session.userId) {
        const previousSession = await ResumeSession.findOne({
          userId: session.userId,
          currentStage: 'COMPLETED',
          sessionId: { $ne: session.sessionId }
        }).sort({ 'timestamps.completedAt': -1 });

        if (previousSession) {
          const atsScoreDelta = (session.atsState.atsScore || 0) - (previousSession.atsState.atsScore || 0);
          const credibilityDelta = (session.recommendationState.credibilityScore || 0) - (previousSession.recommendationState.credibilityScore || 0);
          const semanticDelta = (session.semanticState.semanticSimilarity || 0) - (previousSession.semanticState.semanticSimilarity || 0);

          const improved = [
            atsScoreDelta > 0 ? 'atsScore' : '',
            credibilityDelta > 0 ? 'credibilityScore' : '',
            semanticDelta > 0 ? 'semanticSimilarity' : '',
          ].filter(Boolean);
          const regressed = [
            atsScoreDelta < 0 ? 'atsScore' : '',
            credibilityDelta < 0 ? 'credibilityScore' : '',
            semanticDelta < 0 ? 'semanticSimilarity' : '',
          ].filter(Boolean);
          const unchangedWeakSignals = [
            Math.abs(atsScoreDelta) < 1 && (session.atsState.atsScore || 0) < 70 ? 'atsScore' : '',
            Math.abs(semanticDelta) < 0.01 && (session.semanticState.semanticSimilarity || 0) < 0.65 ? 'semanticSimilarity' : '',
            Math.abs(credibilityDelta) < 1 && (session.recommendationState.credibilityScore || 0) < 70 ? 'credibilityScore' : '',
          ].filter(Boolean);

          const deltaSnapshot = {
            timestamp: new Date(),
            previousSessionId: previousSession.sessionId,
            deltas: {
              atsScore: atsScoreDelta,
              credibilityScore: credibilityDelta,
              semanticSimilarity: semanticDelta,
              recommendationCount: (session.recommendationState.recommendations?.length || 0) - (previousSession.recommendationState.recommendations?.length || 0),
              parserConfidence: (session.parsedContent.parsingDiagnostics.confidence || 0) - (previousSession.parsedContent.parsingDiagnostics.confidence || 0),
            },
            improved,
            regressed,
            unchangedWeakSignals,
          };

          session.replayState.replayHistory = session.replayState.replayHistory || [];
          session.replayState.replayHistory.push({ type: 'evolution_delta', ...deltaSnapshot });
          session.evolutionSnapshots = session.evolutionSnapshots || [];
          session.evolutionSnapshots.push(deltaSnapshot);
          await session.save();
          logger.info(`[ProcessingOrchestrator] Longitudinal evolution delta persisted for session: ${session.sessionId}`);
        }
      }
    } catch (e) {
      logger.warn(`[ProcessingOrchestrator] Longitudinal delta tracking failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Handle stage failure
   */
  private async handleStageFailure(sessionId: string, stage: ProcessingStage, error: unknown): Promise<void> {
    const session = await ResumeSession.findOne({ sessionId });
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    logger.error(`[ProcessingOrchestrator] Handling failure for stage ${stage}:`, error);

    const reason = error instanceof Error ? error.message : String(error);

    // Update failure state
    session.failureState = {
      failed: true,
      failureStage: stage,
      failureReason: reason,
      failureDetails: error instanceof Error ? { name: error.name, stack: error.stack } : undefined,
      failedAt: new Date(),
      retryCount: (session.failureState.retryCount || 0) + 1,
    };

    session.currentStage = 'FAILED';
    session.timestamps.lastUpdated = new Date();
    await this.addProcessingHistory(session, stage, 'failed', reason);
    await this.streamProgress(session, 'failed', [reason]);
  }

  /**
   * Get next stage in processing pipeline
   */
  private getNextStage(currentStage: ProcessingStage): ProcessingStage | null {
    const stageOrder: ProcessingStage[] = [
      'UPLOADED',
      'VALIDATING',
      'PARSING',
      'EXTRACTING',
      'ATS_ANALYZING',
      'EMBEDDING',
      'SEMANTIC_ANALYZING',
      'RECOMMENDING',
      'REPLAY_GENERATING',
    ];

    const currentIndex = stageOrder.indexOf(currentStage);
    if (currentIndex === -1 || currentIndex === stageOrder.length - 1) {
      return null;
    }

    return stageOrder[currentIndex + 1];
  }

  /**
   * Add entry to processing history
   */
  private async addProcessingHistory(
    session: typeof ResumeSession.prototype,
    stage: ProcessingStage,
    status: 'success' | 'failed' | 'degraded',
    error?: string,
    persist = true,
  ): Promise<void> {
    const historyEntry = {
      stage,
      startedAt: new Date(),
      completedAt: new Date(),
      duration: 0,
      status,
      error,
    };

    historyEntry.duration = historyEntry.completedAt.getTime() - historyEntry.startedAt.getTime();

    session.processingHistory.push(historyEntry);
    if (persist) await session.save();
  }

  /**
   * Calculate overall progress percentage
   */
  private calculateOverallProgress(session: typeof ResumeSession.prototype): number {
    const stageOrder: ProcessingStage[] = [
      'UPLOADED',
      'VALIDATING',
      'PARSING',
      'EXTRACTING',
      'ATS_ANALYZING',
      'EMBEDDING',
      'SEMANTIC_ANALYZING',
      'RECOMMENDING',
      'REPLAY_GENERATING',
      'COMPLETED',
    ];

    const currentIndex = stageOrder.indexOf(session.currentStage);
    const totalStages = stageOrder.length;

    if (session.currentStage === 'COMPLETED' || session.currentStage === 'DEGRADED') {
      return 100;
    }

    if (session.currentStage === 'FAILED') {
      return Math.floor((currentIndex / totalStages) * 100);
    }

    return Math.floor(((currentIndex + 1) / totalStages) * 100);
  }

  /**
   * Stream progress update event via SSE
   */
  private async streamProgress(
    session: typeof ResumeSession.prototype,
    status: StreamStatus,
    errors?: string[],
    warnings?: string[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const stageMessages: Record<ProcessingStage, string> = {
      UPLOADED: 'Uploading Resume...',
      VALIDATING: 'Uploading Resume...',
      PARSING: 'Parsing Structure...',
      EXTRACTING: 'Extracting Signals...',
      ATS_ANALYZING: 'Analyzing ATS Survivability...',
      EMBEDDING: 'Generating Embeddings...',
      SEMANTIC_ANALYZING: 'Running Semantic Retrieval...',
      RECOMMENDING: 'Generating Recommendations...',
      REPLAY_GENERATING: 'Building Replay...',
      REPORT_GENERATING: 'Generating Intelligence Dossier...',
      COMPLETED: 'Analysis Complete',
      FAILED: 'Processing failed',
      DEGRADED: 'Processing degraded',
    };

    const currentStage = session.currentStage as ProcessingStage;
    const progress = this.calculateOverallProgress(session);
    const emittedStage = RUNTIME_STAGE_LABELS[currentStage] || currentStage;
    const historyEntry = session.processingHistory?.findLast?.((entry: any) => entry.stage === currentStage);
    const latencyMs = Number(metadata?.latencyMs ?? historyEntry?.duration ?? 0);
    const confidence = this.calculateStageConfidence(session);
    const retryCount = session.failureState.retryCount || Number(metadata?.attempt ?? 1) - 1 || 0;
    const queueMetadata = {
      queueName: stageQueues[currentStage] ?? QueueNames.RESUME_UPLOAD,
      retryCount,
      attempt: metadata?.attempt,
      maxAttempts: metadata?.maxAttempts,
    };

    const eventPayload = {
      sessionId: session.sessionId,
      stage: emittedStage,
      internalStage: currentStage,
      progress,
      message: stageMessages[currentStage] || 'Processing...',
      status,
      timestamp: new Date().toISOString(),
      confidence,
      latencyMs,
      processingLatency: latencyMs,
      degradationWarnings: warnings || session.degradedState.degradedComponents || [],
      retryState: {
        retryCount,
        failed: session.failureState.failed,
        failureStage: session.failureState.failureStage,
      },
      queue: queueMetadata,
      errors,
      warnings,
      metadata: {
        ...metadata,
        parserConfidence: session.parsedContent.parsingDiagnostics.confidence,
        atsScore: session.atsState.atsScore,
        semanticSimilarity: session.semanticState.semanticSimilarity,
        credibilityScore: session.recommendationState.credibilityScore,
      },
    };

    session.runtimeEvents = session.runtimeEvents || [];
    session.runtimeEvents.push({
      stage: currentStage,
      emittedStage,
      status,
      timestamp: new Date(),
      progress,
      confidence,
      latencyMs,
      warnings: eventPayload.warnings || [],
      errors: eventPayload.errors || [],
      metadata: eventPayload.metadata,
    });
    if (session.runtimeEvents.length > 200) {
      session.runtimeEvents = session.runtimeEvents.slice(-200);
    }
    session.timestamps.lastUpdated = new Date();
    await session.save();

    if (session.userId) {
      try {
        await eventBus.publishEnvelope(
          session.userId.toString(),
          'resume_progression',
          eventPayload
        );
      } catch (err) {
        logger.warn(`[ProcessingOrchestrator] Failed to stream progress event: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private calculateStageConfidence(session: typeof ResumeSession.prototype): number {
    if (session.currentStage === 'PARSING' || session.currentStage === 'EXTRACTING') {
      return session.parsedContent.parsingDiagnostics.confidence || 0.5;
    }
    if (session.currentStage === 'ATS_ANALYZING') {
      return session.atsState.extractionConfidence || ((session.atsState.atsScore || 50) / 100);
    }
    if (session.currentStage === 'SEMANTIC_ANALYZING') {
      return session.semanticState.semanticSimilarity || 0.5;
    }
    if (session.currentStage === 'RECOMMENDING') {
      return (session.recommendationState.credibilityScore || 50) / 100;
    }
    if (session.currentStage === 'FAILED') return 0;
    return session.degradedState.degraded ? 0.6 : 0.85;
  }

  /**
   * Get session status
   */
  async getSessionStatus(sessionId: string): Promise<{
    sessionId: string;
    currentStage: ProcessingStage;
    progress: number;
    errors: string[];
    metadata: any;
  } | null> {
    const session = await ResumeSession.findOne({ sessionId });
    if (!session) {
      return null;
    }

    const progress = this.calculateOverallProgress(session);

    const errors = [
      ...session.parsedContent.parsingDiagnostics.errors,
      ...(session.failureState.failureReason ? [session.failureState.failureReason] : []),
    ];

    return {
      sessionId: session.sessionId,
      currentStage: session.currentStage,
      progress,
      errors,
      metadata: {
        uploadFilename: session.uploadMetadata.originalFilename,
        uploadedAt: session.timestamps.uploadedAt,
        startedProcessingAt: session.timestamps.startedProcessingAt,
        completedAt: session.timestamps.completedAt,
        parsingConfidence: session.parsedContent.parsingDiagnostics.confidence,
        atsScore: session.atsState.atsScore,
      },
    };
  }
}
