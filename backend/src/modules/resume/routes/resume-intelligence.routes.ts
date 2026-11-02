// src/modules/resume-intelligence/routes/resume-intelligence.routes.ts
import { Router } from 'express';
import { authMiddleware } from '../../../middleware/auth.js';
import { rateLimiters } from '../../../middleware/rateLimitAdvanced.js';
import { validateRequest } from '../../../middleware/validation.js';
import * as controller from '../controllers/ResumeIntelligenceController.js';
import {
  UpdateResumeProfileSchema,
  GenerateVariantSchema,
  ExportResumeSchema,
  AnalyzeATSSchema,
  CreateEvidenceClaimSchema,
  GenerateReportSchema,
  DossierExportSchema,
} from '../dto/index.js';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

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
router.post('/variants', validateRequest({ body: GenerateVariantSchema }), controller.generateVariant);
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

export default router;
