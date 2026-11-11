// src/modules/resume-intelligence/controllers/ResumeIntelligenceController.ts
import type { Request, Response, NextFunction } from 'express';
import { ResumeIntelligenceService } from '../services/ResumeIntelligenceService.js';
import { successResponse, errorResponse } from '../../../shared/response.js';
import { logger } from '../../../shared/logger.js';
import type { Types } from 'mongoose';
import { ResumeIntelligenceReportEngine } from '../reports/ResumeIntelligenceReportEngine.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import { ResumeExportService } from '../export/ResumeExportService.js';

const service = new ResumeIntelligenceService();
const reportEngine = new ResumeIntelligenceReportEngine();
const dossierExport = new ResumeExportService();

export async function exportDossier(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const pdf = await dossierExport.generateDossierPDF(getUserId(req), req.body.sessionId);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="devtrack-dossier.pdf"', 'Cache-Control': 'private, no-store' });
    res.send(pdf);
  } catch (error) {
    next(error);
  }
}

/**
 * Extract and validate userId from request context safely
 */
function getUserId(req: Request): Types.ObjectId {
  const userId = (req as any).user?.id;
  if (!userId) {
    throw new Error('Authentication required.');
  }
  return userId as unknown as Types.ObjectId;
}


/**
 * Get or create resume profile
 */
export async function getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const profile = await service.getOrCreateProfile(userId);
    
    successResponse(res, profile);
  } catch (error) {
    logger.error('[ResumeController] Error getting profile:', error);
    next(error);
  }
}

/**
 * Update resume profile
 */
export async function updateProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const profile = await service.updateProfile(userId, req.body);
    
    successResponse(res, profile);
  } catch (error) {
    logger.error('[ResumeController] Error updating profile:', error);
    next(error);
  }
}

/**
 * Generate resume
 */
export async function generateResume(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const result = await service.generateResume(userId);
    
    successResponse(res, result);
  } catch (error) {
    logger.error('[ResumeController] Error generating resume:', error);
    next(error);
  }
}

/**
 * Generate variant
 */
export async function generateVariant(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const variant = await service.generateVariant(userId, req.body);
    
    successResponse(res, variant);
  } catch (error) {
    logger.error('[ResumeController] Error generating variant:', error);
    next(error);
  }
}

/**
 * Get all variants
 */
export async function getVariants(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const variants = await service.getVariants(userId);
    
    successResponse(res, variants);
  } catch (error) {
    logger.error('[ResumeController] Error getting variants:', error);
    next(error);
  }
}

/**
 * Get specific variant
 */
export async function getVariant(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const variantId = req.params.variantId as string;
    const variant = await service.getVariant(userId, variantId);
    
    if (!variant) {
      errorResponse(res, 'Variant not found', 'NOT_FOUND', 404);
      return;
    }
    
    successResponse(res, variant);
  } catch (error) {
    logger.error('[ResumeController] Error getting variant:', error);
    next(error);
  }
}

/**
 * Analyze ATS compatibility
 */
export async function analyzeATS(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const analysis = await service.analyzeATS(userId, req.body);
    
    successResponse(res, analysis);
  } catch (error) {
    logger.error('[ResumeController] Error analyzing ATS:', error);
    next(error);
  }
}

/**
 * Get ATS analyses
 */
export async function getATSAnalyses(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const analyses = await service.getATSAnalyses(userId);
    
    successResponse(res, analyses);
  } catch (error) {
    logger.error('[ResumeController] Error getting ATS analyses:', error);
    next(error);
  }
}

/**
 * Create evidence claim
 */
export async function createEvidenceClaim(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const claim = await service.createEvidenceClaim(userId, req.body);
    
    successResponse(res, claim);
  } catch (error) {
    logger.error('[ResumeController] Error creating evidence claim:', error);
    next(error);
  }
}

/**
 * Get evidence claims
 */
export async function getEvidenceClaims(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const claims = await service.getEvidenceClaims(userId);
    
    successResponse(res, claims);
  } catch (error) {
    logger.error('[ResumeController] Error getting evidence claims:', error);
    next(error);
  }
}

/**
 * Get selected projects
 */
export async function getProjects(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const projects = await service.getProjects(userId);
    
    successResponse(res, projects);
  } catch (error) {
    logger.error('[ResumeController] Error getting projects:', error);
    next(error);
  }
}

/**
 * Get selected skills
 */
export async function getSkills(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const skills = await service.getSkills(userId);
    
    successResponse(res, skills);
  } catch (error) {
    logger.error('[ResumeController] Error getting skills:', error);
    next(error);
  }
}

/**
 * Export resume
 */
export async function exportResume(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const exportRecord = await service.exportResume(userId, req.body);
    
    successResponse(res, exportRecord);
  } catch (error) {
    logger.error('[ResumeController] Error exporting resume:', error);
    next(error);
  }
}

/**
 * Get export history
 */
export async function getExportHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const history = await service.getExportHistory(userId);
    
    successResponse(res, history);
  } catch (error) {
    logger.error('[ResumeController] Error getting export history:', error);
    next(error);
  }
}

/**
 * Get version history
 */
export async function getVersionHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const history = await service.getVersionHistory(userId);
    
    successResponse(res, history);
  } catch (error) {
    logger.error('[ResumeController] Error getting version history:', error);
    next(error);
  }
}

/**
 * Get credibility analysis
 */
export async function getCredibilityAnalysis(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const analysis = await service.getCredibilityAnalysis(userId);
    
    successResponse(res, analysis);
  } catch (error) {
    logger.error('[ResumeController] Error getting credibility analysis:', error);
    next(error);
  }
}

/**
 * Generate Resume Intelligence Report Dossier
 */
export async function generateReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const { sessionId } = req.body;

    // Validate sessionId presence
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
      logger.error('[ResumeController] Missing or invalid sessionId in generateReport request');
      return errorResponse(res, 'sessionId is required', 'VALIDATION_ERROR', 400);
    }
    
    const session = await ResumeSession.findOne({ sessionId, userId });
    if (!session) {
      return errorResponse(res, 'Resume session not found', 'NOT_FOUND', 404);
    }
    
    const report = await reportEngine.generateReport(userId, sessionId);
    successResponse(res, report);
  } catch (error) {
    logger.error('[ResumeController] Error generating report:', error);
    // If the error is a known validation error, respond accordingly
    if (error instanceof Error && error.message.includes('validation')) {
      return errorResponse(res, error.message, 'VALIDATION_ERROR', 400);
    }
    // Generic server error
    errorResponse(res, 'Failed to generate report', 'INTERNAL_ERROR', 500);
  }
}

/**
 * Get Resume Intelligence Report Dossier
 */
export async function getReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const { sessionId } = req.params;

    const session = await ResumeSession.findOne({ sessionId, userId });
    if (!session) {
      return errorResponse(res, 'Resume session not found', 'NOT_FOUND', 404);
    }

    if (!session.reportState || !session.reportState.generated) {
      // Report not yet generated
      return successResponse(res, { generated: false, reportData: null });
    }

    successResponse(res, session.reportState.reportData);
  } catch (error) {
    logger.error('[ResumeController] Error getting report:', error);
    next(error);
  }
}
