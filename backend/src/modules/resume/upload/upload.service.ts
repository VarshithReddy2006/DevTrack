// src/modules/resume/upload/upload.service.ts
import type { Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../../../shared/logger.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import { artifactStorage, type ArtifactStorage } from './artifact-storage.js';
import { getResumeUploadQueue } from '../../../shared/jobs/queueFactory.js';

export interface IUploadResult {
  sessionId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  status: 'UPLOADED' | 'VALIDATING' | 'PARSING' | 'EXTRACTING' | 'ATS_ANALYZING' | 'EMBEDDING' | 'SEMANTIC_ANALYZING' | 'RECOMMENDING' | 'REPLAY_GENERATING' | 'COMPLETED' | 'FAILED' | 'DEGRADED';
  uploadPath: string;
  createdAt: Date;
}

export interface ISessionStatus {
  sessionId: string;
  status: string;
  currentStage: string;
  progress: number;
  errors: string[];
  metadata: {
    [key: string]: any;
  };
}

/**
 * UploadService
 * 
 * Handles resume file uploads, validation, and session creation
 */
export class UploadService {
  constructor(private readonly storage: ArtifactStorage = artifactStorage) {}

  /**
   * Process uploaded file
   */
  async processUpload(file: Express.Multer.File, userId?: string): Promise<IUploadResult> {
    logger.info(`[UploadService] Processing upload: ${file.originalname}`);

    // Generate session ID
    const sessionId = this.generateSessionId();

    const safeOriginalName = this.sanitizeFilename(file.originalname);
    let uploadPath: string;
    try {
      uploadPath = await this.storage.store(file.path, `${sessionId}-${safeOriginalName}`);
    } catch (error) {
      await fs.unlink(file.path).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[UploadService] Failed to store uploaded file', error);
      throw new Error(`Failed to store uploaded file: ${message}`);
    }

    // Create upload result
    const result: IUploadResult = {
      sessionId,
      filename: file.filename,
      originalName: safeOriginalName,
      mimeType: file.mimetype,
      size: file.size,
      status: 'UPLOADED',
      uploadPath,
      createdAt: new Date(),
    };

    try {
      // Create initial ResumeSession in DB
      await ResumeSession.create({
        sessionId,
        userId,
        uploadMetadata: {
          originalFilename: safeOriginalName,
          fileType: safeOriginalName.split('.').pop() as 'pdf' | 'docx' | 'txt' | 'md',
          fileSize: file.size,
          mimeType: file.mimetype,
          uploadPath,
          uploadedAt: new Date(),
        },
        currentStage: 'UPLOADED',
        processingHistory: [],
        parsedContent: {
          text: '',
          sections: {},
          headings: [],
          bullets: [],
          links: [],
          metadata: {},
          parsingDiagnostics: {
            confidence: 0,
            warnings: [],
            errors: [],
          },
        },
        atsState: { analyzed: false },
        embeddingState: { generated: false },
        semanticState: { analyzed: false },
        recommendationState: { generated: false },
        replayState: { generated: false },
        failureState: { failed: false },
        degradedState: { degraded: false },
        timestamps: {
          uploadedAt: new Date(),
          lastUpdated: new Date(),
        },
      });
    } catch (err: any) {
      logger.error(`[UploadService] Database persistence failed for session: ${err.message}`);
      // Clean up raw stored file
      try {
        await this.storage.remove(uploadPath);
      } catch (unlinkErr) {
        // ignore
      }
      throw new Error(`Failed to initialize resume session: ${err.message}`);
    }

    try {
      const { getRedisHealth } = await import('../../../shared/redis/index.js');
      const redisHealth = getRedisHealth();

      if (redisHealth.status === 'connected') {
        // Kick off processing orchestration via BullMQ
        const queue = getResumeUploadQueue();
        await queue.add('process', {
          sessionId,
          userId,
          filePath: uploadPath,
          originalFilename: safeOriginalName,
        });
        logger.info(`[UploadService] Upload processed and queued to BullMQ: ${sessionId}`);
      } else {
        logger.error(`[UploadService] Redis offline. Cannot process resume asynchronously. Session: ${sessionId}`);
        throw new Error('Redis database services are offline. Asynchronous queue submissions are disabled.');
      }
    } catch (err: any) {
      logger.error(`[UploadService] Failed to queue job for session ${sessionId}: ${err.message}`);
      // Update session failure status in DB
      await ResumeSession.updateOne(
        { sessionId },
        {
          currentStage: 'FAILED',
          failureState: {
            failed: true,
            failureReason: `Failed to queue processing orchestration: ${err.message}`,
            failedAt: new Date(),
          },
        }
      ).catch((dbErr: unknown) => {
        logger.warn('[UploadService] Failed to update session failure state in DB', { sessionId, error: dbErr instanceof Error ? dbErr.message : String(dbErr) });
      });
      throw new Error(`Failed to queue processing orchestration: ${err.message}`);
    }

    return result;
  }

  /**
   * Get session by ID
   */
  async getSession(sessionId: string): Promise<any> {
    logger.info(`[UploadService] Getting session: ${sessionId}`);
    return await ResumeSession.findOne({ sessionId }).lean();
  }

  /**
   * Get session status directly from MongoDB ResumeSession model (KISS way)
   */
  async getSessionStatus(sessionId: string): Promise<ISessionStatus | null> {
    logger.info(`[UploadService] Getting session status from DB: ${sessionId}`);
    const session = await ResumeSession.findOne({ sessionId });
    if (!session) return null;

    // Map currentStage to deterministic progress metrics
    const stageProgress: Record<string, number> = {
      'UPLOADED': 10,
      'VALIDATING': 20,
      'PARSING': 30,
      'EXTRACTING': 45,
      'ATS_ANALYZING': 60,
      'EMBEDDING': 70,
      'SEMANTIC_ANALYZING': 80,
      'RECOMMENDING': 90,
      'COMPLETED': 100,
      'FAILED': 100,
      'DEGRADED': 100,
    };

    const progress = stageProgress[session.currentStage] || 50;

    return {
      sessionId: session.sessionId,
      status: session.currentStage,
      currentStage: session.currentStage,
      progress,
      errors: session.failureState?.failed ? [session.failureState.failureReason || 'Processing failed']
        : session.currentStage === 'DEGRADED' && session.degradedState?.degradedReason
          ? [session.degradedState.degradedReason] : [],
      metadata: {},
    };
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    return randomBytes(16).toString('hex');
  }

  private sanitizeFilename(filename: string): string {
    const basename = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeBasename = basename.replace(/^\.+/, '');
    return safeBasename || `resume-${Date.now()}.txt`;
  }

  /**
   * Validate file
   */
  async validateFile(file: Express.Multer.File): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Check file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      errors.push('File size exceeds 10MB limit');
    }

    // Check file size (min 1KB)
    if (file.size < 1024) {
      errors.push('File size is too small (minimum 1KB)');
    }

    // Check MIME type
    const allowedMimeTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'text/markdown',
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      errors.push(`Unsupported MIME type: ${file.mimetype}`);
    }

    // Check file extension
    const allowedExtensions = ['.pdf', '.docx', '.txt', '.md'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    
    if (!allowedExtensions.includes(fileExtension)) {
      errors.push(`Unsupported file extension: ${fileExtension}`);
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(file.originalname) || file.originalname.includes('..') || path.basename(file.originalname) !== file.originalname) {
      errors.push('Unsafe filename: contains invalid characters or traversal attempts');
    }

    if (file.mimetype === 'application/pdf') {
      let header = '';
      try {
        const fd = await fs.open(file.path, 'r');
        const { buffer } = await fd.read(Buffer.alloc(5), 0, 5, 0);
        await fd.close();
        header = buffer.toString('utf8');
      } catch (readErr) {
        logger.error(`[UploadService] Error reading PDF header: ${readErr}`);
      }
      if (!header.startsWith('%PDF-')) {
        errors.push('Invalid PDF header');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Move file to failed directory
   */
  async moveToFailed(filePath: string, reason: string): Promise<void> {
    const filename = path.basename(filePath);
    await this.storage.move(filePath, 'failed');
    logger.error(`[UploadService] Moved file to failed: ${filename} - ${reason}`);
  }

  /**
   * Move file to processed directory
   */
  async moveToProcessed(filePath: string): Promise<void> {
    const filename = path.basename(filePath);
    await this.storage.move(filePath, 'processed');
    logger.info(`[UploadService] Moved file to processed: ${filename}`);
  }
}
