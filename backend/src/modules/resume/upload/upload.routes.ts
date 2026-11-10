// src/modules/resume-intelligence/upload/upload.routes.ts
import { Router } from 'express';
import { authMiddleware } from '../../../middleware/auth.js';
import { rateLimiters } from '../../../middleware/rateLimitAdvanced.js';
import { uploadSingle } from './multer.config.js';
import { validateUpload } from './upload.validation.js';
import * as controller from './upload.controller.js';

export function createResumeUploadRoutes(auth = authMiddleware): Router {
  const router = Router();

  // All routes require authentication
  router.use(auth);

  /**
   * POST /api/resume/upload
   * Upload a resume file (PDF, DOCX, TXT, MD)
   */
  router.post('/upload', rateLimiters.resume, uploadSingle, validateUpload, controller.uploadResume);

  /**
   * GET /api/resume/session/:id
   * Get resume session by ID
   */
  router.get('/session/:id', rateLimiters.resumeRead, controller.getSession);

  /**
   * GET /api/resume/session/:id/status
   * Get session processing status
   */
  router.get('/session/:id/status', rateLimiters.resumeRead, controller.getSessionStatus);

  return router;
}

export default createResumeUploadRoutes();
