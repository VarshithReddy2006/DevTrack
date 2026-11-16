// src/modules/resume-intelligence/validators/ResumeValidationPipeline.ts
import type { Types } from 'mongoose';
import { ResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { ATSAnalysis } from '../../../db/models/atsAnalysis.model.js';
import { ResumeEvidenceClaim, resumeClaimScope } from '../../../db/models/resumeEvidenceClaim.model.js';
import { logger } from '../../../shared/logger.js';

export interface IValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  score: number;
}

/**
 * ResumeValidationPipeline
 * 
 * Validates the entire resume state including schema integrity,
 * ATS safety, unsupported claims, and evidence consistency.
 */
export class ResumeValidationPipeline {
  /**
   * Validate full resume state for a user
   */
  async validate(userId: Types.ObjectId): Promise<IValidationResult> {
    logger.info(`[ResumeValidationPipeline] Starting validation for user ${userId}`);

    const errors: string[] = [];
    const warnings: string[] = [];
    let score = 100;

    const profile = await ResumeProfile.findOne({ userId });
    if (!profile) {
      return { isValid: false, errors: ['Resume profile not found'], warnings: [], score: 0 };
    }

    // 1. Schema Integrity & Profile Completeness
    if (!profile.targetRole) {
      errors.push('Target role is missing');
      score -= 20;
    }
    if (profile.selectedProjects.length === 0) {
      errors.push('No projects selected for resume');
      score -= 30;
    }
    if (profile.selectedSkills.length === 0) {
      warnings.push('No skills selected for resume');
      score -= 10;
    }

    // 2. ATS Safety
    const latestATS = await ATSAnalysis.findOne({ userId }).sort({ createdAt: -1 });
    if (!latestATS) {
      warnings.push('No ATS analysis found. Run ATS analysis for safety.');
    } else {
      if (latestATS.atsScore < 70) {
        warnings.push(`Low ATS score (${latestATS.atsScore}). Improve compatibility.`);
        score -= (70 - latestATS.atsScore) / 2;
      }
      latestATS.parserWarnings.filter(w => w.severity === 'critical').forEach(w => {
        errors.push(`Critical ATS Warning: ${w.message}`);
        score -= 15;
      });
    }

    // 3. Evidence & Unsupported Claims
    const claims = await ResumeEvidenceClaim.find({ userId, ...resumeClaimScope });
    const unverifiedClaims = claims.filter(c => c.verificationStatus === 'unverified');
    if (unverifiedClaims.length > 0) {
      warnings.push(`${unverifiedClaims.length} unsupported engineering claims detected.`);
      score -= unverifiedClaims.length * 5;
    }

    // 4. Engineering Credibility
    if (profile.credibilityScore < 50) {
      warnings.push('Low engineering credibility score. Add more verified evidence.');
      score -= (50 - profile.credibilityScore);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      score: Math.max(0, Math.min(100, Math.round(score))),
    };
  }
}
