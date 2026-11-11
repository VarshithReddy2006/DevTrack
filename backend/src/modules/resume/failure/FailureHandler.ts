// src/modules/resume-intelligence/failure/FailureHandler.ts
import { artifactStorage } from '../upload/artifact-storage.js';
import type { Types } from 'mongoose';
import { ResumeSession, type ProcessingStage } from '../../../db/models/resumeSession.model.js';
import { logger } from '../../../shared/logger.js';

export interface IFailureContext {
  sessionId: string;
  stage: ProcessingStage;
  error: Error;
  metadata?: {
    [key: string]: any;
  };
}

export interface IDegradedState {
  degraded: boolean;
  degradedComponents: string[];
  degradedReason: string;
  degradedAt: Date;
}

/**
 * FailureHandler
 * 
 * Handles malformed files, parser failures, embedding failures, and exposes
 * degraded states explicitly. NO silent degradation.
 */
export class FailureHandler {
  /**
   * Handle processing failure
   */
  async handleFailure(context: IFailureContext): Promise<void> {
    logger.error(`[FailureHandler] Handling failure at stage ${context.stage}:`, context.error);

    const session = await ResumeSession.findOne({ sessionId: context.sessionId });
    if (!session) {
      logger.error(`[FailureHandler] Session not found: ${context.sessionId}`);
      throw new Error(`Session not found: ${context.sessionId}`);
    }

    // Update failure state
    session.failureState = {
      failed: true,
      failureStage: context.stage,
      failureReason: context.error.message,
      failureDetails: {
        name: context.error.name,
        stack: context.error.stack,
        metadata: context.metadata,
      },
      failedAt: new Date(),
      retryCount: (session.failureState.retryCount || 0) + 1,
    };

    session.currentStage = 'FAILED';
    session.timestamps.lastUpdated = new Date();
    await session.save();

    // Add to processing history
    await this.addFailureToHistory(session, context.stage, context.error.message);

    logger.error(`[FailureHandler] Failure recorded for session: ${context.sessionId}`);
  }

  /**
   * Handle degraded state
   */
  async handleDegradedState(
    sessionId: string,
    component: string,
    reason: string,
    metadata?: { [key: string]: any }
  ): Promise<void> {
    logger.warn(`[FailureHandler] Handling degraded state for component ${component}: ${reason}`);

    const session = await ResumeSession.findOne({ sessionId });
    if (!session) {
      logger.error(`[FailureHandler] Session not found: ${sessionId}`);
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Update degraded state
    if (!session.degradedState.degraded) {
      session.degradedState = {
        degraded: true,
        degradedComponents: [component],
        degradedReason: reason,
        degradedAt: new Date(),
      };
    } else {
      const components = session.degradedState.degradedComponents || [];
      if (!components.includes(component)) {
        components.push(component);
      }
      session.degradedState.degradedComponents = components;
      session.degradedState.degradedReason = `${session.degradedState.degradedReason}; ${reason}`;
    }

    session.currentStage = 'DEGRADED';
    session.timestamps.lastUpdated = new Date();
    await session.save();

    logger.warn(`[FailureHandler] Degraded state recorded for session: ${sessionId}`);
  }

  /**
   * Validate file before processing
   */
  async validateFile(filePath: string, filename: string): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Check if file exists
      const fs = await import('fs/promises');
      await fs.access(filePath);

      // Check file size
      const stats = await fs.stat(filePath);
      const maxSize = 10 * 1024 * 1024; // 10MB
      const minSize = 1024; // 1KB

      if (stats.size === 0) {
        errors.push('File is empty');
      }

      if (stats.size < minSize) {
        errors.push('File is too small (minimum 1KB)');
      }

      if (stats.size > maxSize) {
        errors.push('File size exceeds 10MB limit');
      }

      // Check file extension
      const allowedExtensions = ['.pdf', '.docx', '.txt', '.md'];
      const fileExtension = filename.toLowerCase().substring(filename.lastIndexOf('.'));

      if (!allowedExtensions.includes(fileExtension)) {
        errors.push(`Unsupported file extension: ${fileExtension}`);
      }

      // Check for common corruption indicators
      if (stats.size < 100) {
        warnings.push('File is suspiciously small - may be corrupted');
      }

    } catch (error) {
      errors.push(`File validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Handle parser failure
   */
  async handleParserFailure(sessionId: string, error: Error, fileType: string): Promise<void> {
    logger.error(`[FailureHandler] Parser failure for ${fileType}:`, error);

    const session = await ResumeSession.findOne({ sessionId });
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Add parsing error to diagnostics
    session.parsedContent.parsingDiagnostics.errors.push(
      `Parser failure (${fileType}): ${error.message}`
    );

    // Update failure state
    session.failureState = {
      failed: true,
      failureStage: 'PARSING',
      failureReason: `Document parsing failed: ${error.message}`,
      failureDetails: {
        fileType,
        error: error.message,
        stack: error.stack,
      },
      failedAt: new Date(),
      retryCount: (session.failureState.retryCount || 0) + 1,
    };

    session.currentStage = 'FAILED';
    session.timestamps.lastUpdated = new Date();
    await session.save();

    // Move file to failed directory
    await this.moveToFailed(session.uploadMetadata.uploadPath, `Parser failure: ${error.message}`);
  }

  /**
   * Handle embedding failure
   */
  async handleEmbeddingFailure(sessionId: string, error: Error): Promise<void> {
    logger.error(`[FailureHandler] Embedding failure:`, error);

    const session = await ResumeSession.findOne({ sessionId });
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Update embedding state with error
    session.embeddingState = {
      generated: false,
      error: error.message,
    };

    // Mark as degraded since embedding is critical for semantic intelligence
    await this.handleDegradedState(
      sessionId,
      'semantic-intelligence',
      `Embedding generation failed: ${error.message}. Semantic retrieval is disabled.`
    );

    // Add error to session
    session.failureState = {
      failed: false, // Not a complete failure, just degraded
      failureStage: 'EMBEDDING',
      failureReason: error.message,
      failureDetails: {
        error: error.message,
        stack: error.stack,
      },
      failedAt: new Date(),
      retryCount: (session.failureState.retryCount || 0) + 1,
    };

    session.timestamps.lastUpdated = new Date();
    await session.save();
  }

  /**
   * Handle queue failure
   */
  async handleQueueFailure(sessionId: string, queueName: string, error: Error): Promise<void> {
    logger.error(`[FailureHandler] Queue failure for ${queueName}:`, error);

    const session = await ResumeSession.findOne({ sessionId });
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Mark as degraded
    await this.handleDegradedState(
      sessionId,
      `queue-${queueName}`,
      `Queue processing failed: ${error.message}`
    );

    session.timestamps.lastUpdated = new Date();
    await session.save();
  }

  /**
   * Move file to failed directory
   */
  private async moveToFailed(filePath: string, reason: string): Promise<void> {
    try {
      await artifactStorage.move(filePath, 'failed');
      logger.error(`[FailureHandler] Quarantined failed upload: ${reason}`);
    } catch (error) {
      logger.error('[FailureHandler] Error moving file to failed directory:', error);
    }
  }

  /**
   * Add failure to processing history
   */
  private async addFailureToHistory(
    session: typeof ResumeSession.prototype,
    stage: ProcessingStage,
    errorMessage: string
  ): Promise<void> {
    const historyEntry = {
      stage,
      startedAt: new Date(),
      completedAt: new Date(),
      duration: 0,
      status: 'failed' as const,
      error: errorMessage,
    };

    historyEntry.duration = historyEntry.completedAt.getTime() - historyEntry.startedAt.getTime();

    session.processingHistory.push(historyEntry);
    await session.save();
  }

  /**
   * Get failure summary for a session
   */
  async getFailureSummary(sessionId: string): Promise<{
    hasFailures: boolean;
    hasDegradedState: boolean;
    failures: string[];
    degradedComponents: string[];
    canRetry: boolean;
    retryCount: number;
  } | null> {
    const session = await ResumeSession.findOne({ sessionId });
    if (!session) {
      return null;
    }

    const failures: string[] = [];

    if (session.failureState.failed) {
      failures.push(session.failureState.failureReason || 'Unknown failure');
    }

    if (session.embeddingState.error) {
      failures.push(`Embedding: ${session.embeddingState.error}`);
    }

    if (session.semanticState.error) {
      failures.push(`Semantic: ${session.semanticState.error}`);
    }

    if (session.recommendationState.error) {
      failures.push(`Recommendation: ${session.recommendationState.error}`);
    }

    if (session.replayState.error) {
      failures.push(`Replay: ${session.replayState.error}`);
    }

    return {
      hasFailures: session.failureState.failed || failures.length > 0,
      hasDegradedState: session.degradedState.degraded,
      failures,
      degradedComponents: session.degradedState.degradedComponents || [],
      canRetry: (session.failureState.retryCount || 0) < 3,
      retryCount: session.failureState.retryCount || 0,
    };
  }

  /**
   * Retry failed processing
   */
  async retryProcessing(sessionId: string): Promise<void> {
    const summary = await this.getFailureSummary(sessionId);
    if (!summary) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (!summary.canRetry) {
      throw new Error(`Maximum retry attempts reached for session: ${sessionId}`);
    }

    logger.info(`[FailureHandler] Retrying processing for session: ${sessionId}`);

    const session = await ResumeSession.findOne({ sessionId });
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Capture the failed stage BEFORE resetting failure state
    const previousStage = session.failureState.failureStage || 'UPLOADED';

    // Reset failure state
    session.failureState = {
      failed: false,
      retryCount: summary.retryCount + 1,
    };

    // Reset to the stage that failed
    session.currentStage = previousStage;
    session.timestamps.lastUpdated = new Date();
    await session.save();

    // Re-start processing
    // This would typically trigger the orchestrator again
    logger.info(`[FailureHandler] Retry initiated for session: ${sessionId}, stage: ${previousStage}`);
  }
}
