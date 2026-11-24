// src/modules/resume-intelligence/routes/resume-intelligence.routes.ts
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { authMiddleware } from '../../../middleware/auth.js';
import { rateLimiters } from '../../../middleware/rateLimitAdvanced.js';
import { validateRequest } from '../../../middleware/validation.js';
import { isFlagEnabled } from '../../flags/flags.service.js';
import { ATS_LIVE_EDITOR_FLAG } from '../flags.js';
import * as controller from '../controllers/ResumeIntelligenceController.js';
import {
  UpdateResumeProfileSchema,
  GenerateVariantSchema,
  GenerateVariantRequestV2Schema,
  ExportResumeSchema,
  CompileTypstSchema,
  AnalyzeATSSchema,
  CreateEvidenceClaimSchema,
  GenerateReportSchema,
  DossierExportSchema,
} from '../dto/index.js';

// With ats-live-editor off the body is parsed by the v1 schema, which drops the v2 fields.
async function validateVariantBody(req: Request, res: Response, next: NextFunction): Promise<void> {
  let liveEditor = false;
  try {
    liveEditor = await isFlagEnabled(ATS_LIVE_EDITOR_FLAG, (req as any).user.id);
  } catch {
    // Flag store unavailable: behave as if the flag is off so the v1 path keeps working.
  }
  validateRequest({ body: liveEditor ? GenerateVariantRequestV2Schema : GenerateVariantSchema })(req, res, next);
}

export function createResumeIntelligenceRoutes(auth = authMiddleware): Router {
  const router = Router();

  // All routes require authentication
  router.use(auth);

  // All writes retain the processing budget. Credibility also reruns orchestration
  // despite using GET; the other reads only load saved state.
  router.use((req, res, next) => {
    const read = req.method === 'GET' || req.method === 'HEAD';
    return read && !/^\/credibility\/?$/i.test(req.path)
      ? rateLimiters.resumeRead(req, res, next)
      : rateLimiters.resume(req, res, next);
  });

  // Resume Profile routes
  router.get('/profile', controller.getProfile);
  router.put('/profile', validateRequest({ body: UpdateResumeProfileSchema }), controller.updateProfile);

  // Resume Generation
  router.post('/generate', controller.generateResume);

  // Variant routes
  router.post('/variants', validateVariantBody, controller.generateVariant);
  router.get('/variants', controller.getVariants);
  router.get('/variants/:variantId', controller.getVariant);

  // ATS Analysis routes
  router.post('/ats-analysis', validateRequest({ body: AnalyzeATSSchema }), controller.analyzeATS);
  router.get('/ats-analysis', controller.getATSAnalyses);

  // Evidence Claim routes
  router.post('/evidence-claims', validateRequest({ body: CreateEvidenceClaimSchema }), controller.createEvidenceClaim);
  router.get('/evidence-claims', controller.getEvidenceClaims);

  // Export routes
  router.post('/dossier-pdf', validateRequest({ body: DossierExportSchema }), controller.exportDossier);
  router.post('/export', validateRequest({ body: ExportResumeSchema }), controller.exportResume);
  router.post('/compile', validateRequest({ body: CompileTypstSchema }), controller.compileResumeTypst);
  router.get('/export-history', controller.getExportHistory);

  // Version History
  router.get('/versions', controller.getVersionHistory);

  // Credibility Analysis
  router.get('/credibility', controller.getCredibilityAnalysis);

  // Intelligence Report Dossier
  router.post('/report', validateRequest({ body: GenerateReportSchema }), controller.generateReport);
  router.get('/report/:sessionId', controller.getReport);

  // Projects and Skills
  router.get('/projects', controller.getProjects);
  router.get('/skills', controller.getSkills);

  return router;
}

export default createResumeIntelligenceRoutes();
