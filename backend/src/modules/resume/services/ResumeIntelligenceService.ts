// src/modules/resume-intelligence/services/ResumeIntelligenceService.ts
import type { Types } from 'mongoose';
import { ResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { ResumeVariant, type RoleType } from '../../../db/models/resumeVariant.model.js';
import { ResumeEvidenceClaim } from '../../../db/models/resumeEvidenceClaim.model.js';
import { ATSAnalysis } from '../../../db/models/atsAnalysis.model.js';
import { ResumeExport } from '../../../db/models/resumeExport.model.js';
import { ResumeVersion } from '../../../db/models/resumeVersion.model.js';
import { Project } from '../../../db/models/project.model.js';
import { ResumeOrchestrationEngine } from '../orchestration/ResumeOrchestrationEngine.js';
import { ResumeVariantEngine } from '../engines/ResumeVariantEngine.js';
import { ATSCompatibilityEngine } from '../ats/ATSCompatibilityEngine.js';
import { ResumeExportService } from '../export/ResumeExportService.js';
import { ResumeMLService } from '../ai/ResumeMLService.js';
import type { CreateResumeProfileDTO, UpdateResumeProfileDTO, GenerateVariantDTO, ExportResumeDTO, AnalyzeATSDTO, CreateEvidenceClaimDTO } from '../dto/index.js';
import { logger } from '../../../shared/logger.js';
import { randomBytes } from 'crypto';

/**
 * ResumeIntelligenceService
 * 
 * Main service orchestrating all resume intelligence operations
 */
export class ResumeIntelligenceService {
  private orchestrationEngine: ResumeOrchestrationEngine;
  private variantEngine: ResumeVariantEngine;
  private atsEngine: ATSCompatibilityEngine;
  private exportService: ResumeExportService;
  private mlService: ResumeMLService;

  constructor() {
    this.orchestrationEngine = new ResumeOrchestrationEngine();
    this.variantEngine = new ResumeVariantEngine();
    this.atsEngine = new ATSCompatibilityEngine();
    this.exportService = new ResumeExportService();
    this.mlService = new ResumeMLService();
  }

  /**
   * Get or create resume profile
   */
  async getOrCreateProfile(userId: Types.ObjectId): Promise<typeof ResumeProfile.prototype> {
    let profile = await ResumeProfile.findOne({ userId });
    
    if (!profile) {
      profile = await ResumeProfile.create({ userId });
      logger.info(`[ResumeIntelligence] Created new profile for user ${userId}`);
    }

    return profile;
  }

  /**
   * Update resume profile
   */
  async updateProfile(
    userId: Types.ObjectId,
    data: UpdateResumeProfileDTO
  ): Promise<typeof ResumeProfile.prototype> {
    const profile = await this.getOrCreateProfile(userId);

    if (data.targetRole !== undefined) profile.targetRole = data.targetRole;
    if (data.summary !== undefined) profile.summary = data.summary;
    if (data.selectedProjects !== undefined) {
      profile.selectedProjects = data.selectedProjects.map(id => id as unknown as Types.ObjectId);
    }
    if (data.selectedSkills !== undefined) profile.selectedSkills = data.selectedSkills;
    if (data.activeVariant !== undefined) profile.activeVariant = data.activeVariant;

    await profile.save();

    logger.info(`[ResumeIntelligence] Updated profile for user ${userId}`);

    return profile;
  }

  /**
   * Generate resume using orchestration engine
   */
  async generateResume(userId: Types.ObjectId): Promise<{
    profile: typeof ResumeProfile.prototype;
    recommendations: string[];
  }> {
    logger.info(`[ResumeIntelligence] Generating resume for user ${userId}`);

    const result = await this.orchestrationEngine.orchestrate(userId);
    const recommendations = await this.mlService.optimizeRecommendations(userId.toString()).catch(() => {
      logger.warn('[ResumeIntelligence] Personalized recommendations unavailable');
      return [];
    });

    return {
      profile: result.resumeProfile,
      recommendations: [...new Set([...recommendations, ...result.recommendations])],
    };
  }

  /**
   * Generate role-specific variant
   */
  async generateVariant(
    userId: Types.ObjectId,
    data: GenerateVariantDTO
  ): Promise<typeof ResumeVariant.prototype> {
    logger.info(`[ResumeIntelligence] Generating ${data.roleType} variant for user ${userId}`);

    const variant = await this.variantEngine.generateVariant(
      userId,
      data.roleType,
      data.customWeights
    );

    return variant;
  }

  /**
   * Get all variants for user
   */
  async getVariants(userId: Types.ObjectId): Promise<typeof ResumeVariant.prototype[]> {
    return await ResumeVariant.find({ userId }).sort({ createdAt: -1 });
  }

  /**
   * Get specific variant
   */
  async getVariant(userId: Types.ObjectId, variantId: string): Promise<typeof ResumeVariant.prototype | null> {
    return await ResumeVariant.findOne({ userId, variantId });
  }

  /**
   * Analyze ATS compatibility
   */
  async analyzeATS(
    userId: Types.ObjectId,
    data: AnalyzeATSDTO
  ): Promise<typeof ATSAnalysis.prototype> {
    logger.info(`[ResumeIntelligence] Analyzing ATS compatibility for user ${userId}`);

    const profile = await this.getOrCreateProfile(userId);

    // Generate content for analysis (simplified)
    const content = this.generateResumeContent(profile);

    const analysis = await this.atsEngine.analyze({
      userId,
      resumeProfileId: profile._id as Types.ObjectId,
      variantId: data.variantId,
      content,
      targetKeywords: data.targetKeywords,
    });

    // Update profile ATS score
    profile.atsScore = analysis.atsScore;
    await profile.save();

    return analysis;
  }

  /**
   * Get ATS analyses for user
   */
  async getATSAnalyses(userId: Types.ObjectId): Promise<typeof ATSAnalysis.prototype[]> {
    return await ATSAnalysis.find({ userId }).sort({ createdAt: -1 }).limit(10);
  }

  /**
   * Create evidence claim
   */
  async createEvidenceClaim(
    userId: Types.ObjectId,
    data: CreateEvidenceClaimDTO
  ): Promise<typeof ResumeEvidenceClaim.prototype> {
    const profile = await this.getOrCreateProfile(userId);

    const claim = await ResumeEvidenceClaim.create({
      userId,
      resumeProfileId: profile._id,
      variantId: data.variantId || null,
      claimText: data.claimText,
      evidenceSources: data.evidenceSources,
      generatedBy: 'manual',
      verificationStatus: 'unverified',
    });

    logger.info(`[ResumeIntelligence] Created evidence claim for user ${userId}`);

    return claim;
  }

  /**
   * Get evidence claims
   */
  async getEvidenceClaims(userId: Types.ObjectId): Promise<typeof ResumeEvidenceClaim.prototype[]> {
    return await ResumeEvidenceClaim.find({ userId }).sort({ createdAt: -1 });
  }

  /**
   * Export resume
   */
  async exportResume(
    userId: Types.ObjectId,
    data: ExportResumeDTO
  ): Promise<typeof ResumeExport.prototype> {
    logger.info(`[ResumeIntelligence] Exporting resume for user ${userId}`);

    const profile = await this.getOrCreateProfile(userId);

    const exportRecord = await this.exportService.export({
      userId,
      resumeProfileId: profile._id as Types.ObjectId,
      variantId: data.variantId,
      exportType: data.exportType,
      includeATSAnalysis: data.includeATSAnalysis,
    });

    // Update profile metadata
    profile.metadata.lastExportedAt = new Date();
    profile.metadata.exportCount += 1;
    profile.exportHistory.push(exportRecord._id as Types.ObjectId);
    await profile.save();

    return exportRecord;
  }

  /**
   * Get export history
   */
  async getExportHistory(userId: Types.ObjectId): Promise<typeof ResumeExport.prototype[]> {
    return await ResumeExport.find({ userId }).sort({ createdAt: -1 }).limit(20);
  }

  /**
   * Get selected projects for resume
   */
  async getProjects(userId: Types.ObjectId): Promise<any[]> {
    const profile = await this.getOrCreateProfile(userId);
    return await Project.find({ _id: { $in: profile.selectedProjects } });
  }

  /**
   * Get selected skills for resume
   */
  async getSkills(userId: Types.ObjectId): Promise<string[]> {
    const profile = await this.getOrCreateProfile(userId);
    return profile.selectedSkills;
  }

  /**
   * Get resume versions
   */
  async getVersionHistory(userId: Types.ObjectId): Promise<typeof ResumeVersion.prototype[]> {
    return await ResumeVersion.find({ userId }).sort({ createdAt: -1 }).limit(20);
  }

  /**
   * Get credibility analysis
   */
  async getCredibilityAnalysis(userId: Types.ObjectId): Promise<{
    score: number;
    warnings: string[];
    recommendations: string[];
  }> {
    const profile = await this.getOrCreateProfile(userId);

    // Re-run orchestration to get latest credibility
    const result = await this.orchestrationEngine.orchestrate(userId);

    return {
      score: result.credibilityScore,
      warnings: [],
      recommendations: result.recommendations,
    };
  }

  /**
   * Generate resume content (simplified)
   */
  private generateResumeContent(profile: typeof ResumeProfile.prototype): string {
    const sections: string[] = [];

    // Summary
    if (profile.summary) {
      sections.push(`SUMMARY\n${profile.summary}`);
    }

    // Skills
    if (profile.selectedSkills.length > 0) {
      sections.push(`SKILLS\n${profile.selectedSkills.join(', ')}`);
    }

    // Projects
    sections.push(`PROJECTS\nSelected ${profile.selectedProjects.length} projects`);

    // Experience
    sections.push(`EXPERIENCE\nSoftware Engineer`);

    // Education
    sections.push(`EDUCATION\nBachelor's Degree`);

    return sections.join('\n\n');
  }
}
