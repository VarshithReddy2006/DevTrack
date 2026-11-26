// src/modules/interview/interview.routes.ts
// Express routes for Mock Interview Studio API and audio streaming chunk ingestion.
// Includes WebRTC signaling route (Milestone 7) for zero-latency audio signaling.

import express, { Router, type Request, type Response, type NextFunction } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { InterviewSession } from '../../db/models/interviewSession.model.js';
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
import { webrtcSignalingGateway, type SignalResponse } from './webrtcSignaling.gateway.js';

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
  isSessionOwner: (sessionId: string, userId: string) => Promise<boolean>;
}

export function createInterviewRoutes(deps?: Partial<InterviewRouteDeps>): Router {
  const router = Router();
  const service = deps?.audioService ?? audioStreamingService;
  const auth = deps?.auth ?? authMiddleware;
  const isSessionOwner = deps?.isSessionOwner ?? (async (sessionId, userId) => {
    if (!mongoose.isValidObjectId(sessionId)) return false;
    return Boolean(await InterviewSession.exists({ _id: sessionId, userId }));
  });
  const controller = createInterviewController();
  const audioLimiter = rateLimiters?.interviewAudio ?? ((_req: Request, _res: Response, next: NextFunction) => next());
  const aiLimiter = rateLimiters?.ai ?? ((_req: Request, _res: Response, next: NextFunction) => next());
  const requireSessionOwner = async (req: Request, res: Response, sessionId: string): Promise<string | null> => {
    const userId = (req as AuthenticatedRequest).user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' });
      return null;
    }
    if (!(await isSessionOwner(sessionId, userId))) {
      res.status(403).json({ success: false, message: 'Forbidden', code: 'FORBIDDEN' });
      return null;
    }
    return userId;
  };

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
    auth,
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
      const userId = await requireSessionOwner(req, res, sessionId);
      if (!userId) return;

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
    auth,
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ success: false, error: { message: 'sessionId is required' } });
      }
      if (!(await requireSessionOwner(req, res, sessionId))) return;

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
    auth,
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ success: false, error: { message: 'sessionId is required' } });
      }
      if (!(await requireSessionOwner(req, res, sessionId))) return;

      await service.cleanSessionAudio(sessionId);
      return successResponse(res, { message: 'Audio buffer cleaned successfully' });
    })
  );

  /**
   * POST /api/v2/interview/:sessionId/webrtc/signal
   *
   * Exchanges WebRTC signaling messages for the interview audio session:
   *   - Client sends offer SDP  -> server returns answer SDP + TURN credentials
   *   - Client sends ICE candidate -> server echoes back a server candidate
   *   - Client sends bye          -> tears down the signaling session
   *
   * ICE negotiation that stalls past 10s falls back to HTTP audio chunk ingestion.
   */
  router.post(
    '/:sessionId/webrtc/signal',
    auth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(req.params);
      const userId = await requireSessionOwner(req, res, sessionId);
      if (!userId) return;

      const response: SignalResponse = await webrtcSignalingGateway.handleSignal(
        sessionId,
        userId,
        req.body,
      );

      if (response.type === 'error') {
        const status = response.code === 'NOT_FOUND' ? 404
          : response.code === 'GONE' ? 410
            : response.code === 'FORBIDDEN' ? 403
              : 400;
        return res.status(status).json({
          success: false,
          message: response.message,
          code: response.code,
          timestamp: new Date().toISOString(),
        });
      }

      if (response.type === 'fallback') {
        return successResponse(res, { fallbackUrl: response.fallbackUrl, type: 'fallback' }, 'ICE timed out; use HTTP chunk fallback', 200);
      }

      successResponse(res, response, 'Signaling message processed');
    }),
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
