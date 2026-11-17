import type { Types } from 'mongoose';
import { ATSAnalysis } from '../../../db/models/atsAnalysis.model.js';
import { ResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { ResumeEvidenceClaim, resumeClaimScope } from '../../../db/models/resumeEvidenceClaim.model.js';
import { logger } from '../../../shared/logger.js';
import {
  calculateAtsScore, calculateExtractionConfidence, checkKeywordCoverage, countResumeWords,
  generateRecommendations, validateFormatting, validateParserSafety, validateSections,
} from '@devtrack/ats-core';

export interface IATSAnalysisInput {
  userId: Types.ObjectId;
  resumeProfileId: Types.ObjectId;
  variantId?: string;
  exportId?: Types.ObjectId;
  content: string;
  targetKeywords?: string[];
}

/**
 * ATSCompatibilityEngine
 * 
 * Responsibilities:
 * - Parser safety validation
 * - Section integrity validation
 * - Formatting safety
 * - Keyword integrity
 * - Heading normalization
 * - Extraction confidence scoring
 * - Recruiter/Credibility calibration
 */
export class ATSCompatibilityEngine {
  /**
   * Analyze ATS compatibility
   */
  async analyze(input: IATSAnalysisInput): Promise<typeof ATSAnalysis.prototype> {
    logger.info(`[ATSCompatibility] Analyzing ATS compatibility`);

    const parserWarnings = validateParserSafety(input.content);
    const formattingWarnings = validateFormatting(input.content);
    const keywordCoverage = checkKeywordCoverage(input.content, input.targetKeywords || []);
    const sectionIntegrity = validateSections(input.content);
    const extractionConfidence = calculateExtractionConfidence(
      parserWarnings,
      formattingWarnings,
      sectionIntegrity
    );

    // Fetch target role and credibility signals
    let targetRole = 'Full Stack Developer';
    let credibilityPenalty = 0;

    try {
      const profile = await ResumeProfile.findById(input.resumeProfileId);
      if (profile) {
        targetRole = profile.targetRole || 'Full Stack Developer';
      }

      // Check for unverified system / infrastructure claims
      const claims = await ResumeEvidenceClaim.find({ resumeProfileId: input.resumeProfileId, ...resumeClaimScope });
      let hasDistributedClaims = false;
      let unverifiedClaimsCount = 0;

      for (const claim of claims) {
        const text = claim.claimText.toLowerCase();
        if (
          text.includes('distributed') ||
          text.includes('microservices') ||
          text.includes('kafka') ||
          text.includes('rabbitmq') ||
          text.includes('redis') ||
          text.includes('kubernetes') ||
          text.includes('docker')
        ) {
          hasDistributedClaims = true;
          if (claim.verificationStatus === 'unverified' || claim.verificationStatus === 'flagged' || claim.provenance.length === 0) {
            unverifiedClaimsCount++;
          }
        }
      }

      if (hasDistributedClaims && unverifiedClaimsCount > 0) {
        credibilityPenalty = Math.min(15, unverifiedClaimsCount * 5);
        logger.info(`[ATSCompatibility] Flagged unverified infrastructure claims: deducted ${credibilityPenalty} from ATS core`);
      }
    } catch (e) {
      logger.warn('[ATSCompatibility] Failed to fetch profile/claims for calibration', { error: e });
    }

    const atsScore = calculateAtsScore({
      parserWarnings,
      formattingWarnings,
      keywordCoverage,
      sectionIntegrity,
      extractionConfidence,
      targetRole,
      credibilityPenalty,
    });
    const recommendations = generateRecommendations(
      parserWarnings,
      formattingWarnings,
      keywordCoverage,
      sectionIntegrity
    );

    const analysis = await ATSAnalysis.create({
      userId: input.userId,
      resumeProfileId: input.resumeProfileId,
      variantId: input.variantId || null,
      exportId: input.exportId || null,
      parserWarnings,
      formattingWarnings,
      keywordCoverage,
      sectionIntegrity,
      extractionConfidence,
      atsScore,
      recommendations,
      parsingMetadata: {
        parserVersion: '1.0.0',
        analysisDate: new Date(),
        documentFormat: 'text',
        pageCount: 1,
        wordCount: countResumeWords(input.content),
      },
    });

    logger.info(`[ATSCompatibility] ATS score: ${atsScore}`);

    return analysis;
  }

  /**
   * REAL ATS CONNECTIONS (Greenhouse, Workday, Lever, Taleo)
   * Strictly implemented inside existing class as per DevTrack KISS rule.
   */
  async syncGreenhouseCandidate(candidateData: any, accessToken: string): Promise<any> {
    logger.info('[ATSCompatibility] Syncing candidate with Greenhouse REST API');
    try {
      const response = await fetch('https://api.greenhouse.io/v1/candidates', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(candidateData)
      });
      if (!response.ok) throw new Error(`Greenhouse API responded with ${response.status}`);
      return await response.json();
    } catch (err: any) {
      logger.error('[ATSCompatibility] Greenhouse sync failed', err);
      throw err;
    }
  }

  async syncWorkdayCandidate(candidateData: any, sessionToken: string): Promise<any> {
    logger.info('[ATSCompatibility] Syncing candidate with Workday REST API');
    try {
      const response = await fetch('https://api.workday.com/v1/candidates', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(candidateData)
      });
      if (!response.ok) throw new Error(`Workday REST API responded with ${response.status}`);
      return await response.json();
    } catch (err: any) {
      logger.error('[ATSCompatibility] Workday sync failed', err);
      throw err;
    }
  }

  async syncLeverCandidate(candidateData: any, accessToken: string): Promise<any> {
    logger.info('[ATSCompatibility] Syncing candidate with Lever REST API');
    try {
      const response = await fetch('https://api.lever.co/v1/candidates', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(candidateData)
      });
      if (!response.ok) throw new Error(`Lever API responded with ${response.status}`);
      return await response.json();
    } catch (err: any) {
      logger.error('[ATSCompatibility] Lever sync failed', err);
      throw err;
    }
  }

  async syncTaleoCandidate(candidateData: any, sessionToken: string): Promise<any> {
    logger.info('[ATSCompatibility] Syncing candidate with Taleo REST API');
    try {
      const response = await fetch('https://tbe.taleo.net/tbe/api/v1/object/candidate', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(candidateData)
      });
      if (!response.ok) throw new Error(`Taleo REST API responded with ${response.status}`);
      return await response.json();
    } catch (err: any) {
      logger.error('[ATSCompatibility] Taleo sync failed', err);
      throw err;
    }
  }
}
