// src/modules/interview/interview.routes.ts
// Express routes for Mock Interview Studio API and audio streaming chunk ingestion.

import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';
import { rateLimiters } from '../../middleware/rateLimitAdvanced.js';
import { asyncHandler } from '../../middleware/error.js';
import { successResponse } from '../../shared/response.js';
import {
  audioStreamingService,
  type AudioStreamingService,
  type AudioChunkMetadata,
} from './audioStreaming.service.js';
import { createInterviewController } from './interview.controller.js';

const chunkMetadataSchema = z.object({
  chunkIndex: z.coerce.number().int().min(0),
  isLast: z.preprocess((val) => {
    if (typeof val === 'string') {
      return val.toLowerCase() === 'true' || val === '1';
    }
    return Boolean(val);
  }, z.boolean()),
  durationMs: z.coerce.number().int().positive().optional(),
});

/**
 * Lightweight, zero-dependency multipart/form-data buffer parser.
 * Avoids Node 22+ concat-stream / readable-stream issues with legacy multer.
 */
export function parseMultipartFormData(buffer: Buffer, boundary: string): {
  fields: Record<string, string>;
  file?: { filename?: string; mimeType?: string; buffer: Buffer };
} {
  const fields: Record<string, string> = {};
  let file: { filename?: string; mimeType?: string; buffer: Buffer } | undefined;

  const cleanBoundary = boundary.replace(/^["']|["']$/g, '');
  const delimiter = Buffer.from(`--${cleanBoundary}`);
  let start = buffer.indexOf(delimiter);

  while (start !== -1) {
    const nextStart = buffer.indexOf(delimiter, start + delimiter.length);
    if (nextStart === -1) break;

    let part = buffer.subarray(start + delimiter.length, nextStart);
    if (part.length >= 2 && part[0] === 0x0d && part[1] === 0x0a) {
      part = part.subarray(2);
    }
    if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
      part = part.subarray(0, part.length - 2);
    }

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd !== -1) {
      const headerStr = part.subarray(0, headerEnd).toString('utf-8');
      const body = part.subarray(headerEnd + 4);

      const nameMatch = headerStr.match(/name="([^"]+)"/i);
      const filenameMatch = headerStr.match(/filename="([^"]+)"/i);
      const typeMatch = headerStr.match(/content-type:\s*([^\r\n]+)/i);

      if (nameMatch) {
        const name = nameMatch[1];
        if (filenameMatch || name === 'chunk' || name === 'file' || name === 'audio') {
          file = {
            filename: filenameMatch ? filenameMatch[1] : 'chunk.webm',
            mimeType: typeMatch ? typeMatch[1].trim() : 'audio/webm',
            buffer: body,
          };
        } else {
          fields[name] = body.toString('utf-8').trim();
        }
      }
    }

    start = nextStart;
  }

  return { fields, file };
}

export interface InterviewRouteDeps {
  audioService: AudioStreamingService;
  auth: (req: Request, res: Response, next: NextFunction) => void;
}

export function createInterviewRoutes(deps?: Partial<InterviewRouteDeps>): Router {
  const router = Router();
  const service = deps?.audioService ?? audioStreamingService;
  const auth = deps?.auth ?? authMiddleware;
  const controller = createInterviewController();
  const audioLimiter = rateLimiters?.interviewAudio ?? ((_req: Request, _res: Response, next: NextFunction) => next());
  const aiLimiter = rateLimiters?.ai ?? ((_req: Request, _res: Response, next: NextFunction) => next());

  // Middleware collecting raw binary buffer for multipart and raw audio streams
  const rawBodyParser = express.raw({
    type: ['multipart/form-data', 'audio/*', 'application/octet-stream'],
    limit: '5mb',
  });

  // Mock interview API endpoints
  // Static path first so "current" is never read as a session id.
  router.get('/current', auth, controller.current);

  /**
   * POST /api/v2/interview/:sessionId/audio/chunk
   * Ingests sequential audio slices (WebM chunks) with metadata { chunkIndex, isLast, durationMs }.
   */
  router.post(
    '/:sessionId/audio/chunk',
    audioLimiter,
    rawBodyParser,
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
      if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
        return res.status(400).json({
          success: false,
          error: { code: 'BAD_REQUEST', message: 'sessionId is required in URL parameter' },
        });
      }

      let chunkBuffer: Buffer | null = null;
      let rawMetadata: Record<string, any> = {
        chunkIndex: req.headers['x-chunk-index'],
        isLast: req.headers['x-is-last'],
        durationMs: req.headers['x-duration-ms'],
      };

      const contentType = req.headers['content-type'] || '';

      if (contentType.toLowerCase().includes('multipart/form-data') && Buffer.isBuffer(req.body)) {
        const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
        if (boundaryMatch) {
          const { fields, file } = parseMultipartFormData(req.body, boundaryMatch[1]);
          if (file) {
            chunkBuffer = file.buffer;
          }
          rawMetadata = {
            chunkIndex: fields.chunkIndex ?? rawMetadata.chunkIndex,
            isLast: fields.isLast ?? rawMetadata.isLast,
            durationMs: fields.durationMs ?? rawMetadata.durationMs,
          };
        }
      } else if (Buffer.isBuffer(req.body)) {
        // Direct binary stream
        chunkBuffer = req.body;
      } else if (typeof req.body?.chunk === 'string') {
        // Base64 JSON payload
        chunkBuffer = Buffer.from(req.body.chunk, 'base64');
        rawMetadata = {
          chunkIndex: req.body.chunkIndex ?? rawMetadata.chunkIndex,
          isLast: req.body.isLast ?? rawMetadata.isLast,
          durationMs: req.body.durationMs ?? rawMetadata.durationMs,
        };
      } else if (Buffer.isBuffer(req.body?.chunk)) {
        chunkBuffer = req.body.chunk;
        rawMetadata = {
          chunkIndex: req.body.chunkIndex ?? rawMetadata.chunkIndex,
          isLast: req.body.isLast ?? rawMetadata.isLast,
          durationMs: req.body.durationMs ?? rawMetadata.durationMs,
        };
      }

      if (!chunkBuffer || chunkBuffer.length === 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Audio chunk binary payload is missing or empty' },
        });
      }

      const parsedMeta = chunkMetadataSchema.safeParse(rawMetadata);
      if (!parsedMeta.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid chunk metadata',
            details: parsedMeta.error.flatten(),
          },
        });
      }

      const userId = (req as AuthenticatedRequest).user?.id;
      const metadata: AudioChunkMetadata = {
        chunkIndex: parsedMeta.data.chunkIndex,
        isLast: parsedMeta.data.isLast,
        durationMs: parsedMeta.data.durationMs,
      };
      const result = await service.ingestChunk(sessionId, metadata, chunkBuffer, userId);

      return successResponse(res, result);
    })
  );

  /**
   * GET /api/v2/interview/:sessionId/audio/status
   * Returns current buffer status and received chunk indices.
   */
  router.get(
    '/:sessionId/audio/status',
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ success: false, error: { message: 'sessionId is required' } });
      }

      const status = await service.getStatus(sessionId);
      return successResponse(res, status);
    })
  );

  /**
   * DELETE /api/v2/interview/:sessionId/audio
   * Cleans up temporary audio buffers if session disconnects or is abandoned.
   */
  router.delete(
    '/:sessionId/audio',
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ success: false, error: { message: 'sessionId is required' } });
      }

      await service.cleanSessionAudio(sessionId);
      return successResponse(res, { message: 'Audio buffer cleaned successfully' });
    })
  );

  // General session routes
  router.get('/:sessionId', auth, controller.get);
  router.post('/', auth, aiLimiter, controller.start);
  router.post('/:sessionId/turns/:turnIndex/answer', auth, aiLimiter, controller.answer);
  router.post('/:sessionId/turns/:turnIndex/hint', auth, controller.hint);
  router.post('/:sessionId/finish', auth, controller.finish);

  return router;
}

export const interviewRoutes = createInterviewRoutes();
export default interviewRoutes;
