import type { Types } from 'mongoose';
import { ATSAnalysis } from '../../../db/models/atsAnalysis.model.js';
import type { IParserWarning, IFormattingWarning, IKeywordCoverage, ISectionIntegrity } from '../../../db/models/atsAnalysis.model.js';
import { ResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { ResumeEvidenceClaim } from '../../../db/models/resumeEvidenceClaim.model.js';
import { logger } from '../../../shared/logger.js';
import { escapeRegExp } from '../../../shared/regex.js';

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

    const parserWarnings = this.validateParserSafety(input.content);
    const formattingWarnings = this.validateFormatting(input.content);
    const keywordCoverage = this.analyzeKeywordCoverage(input.content, input.targetKeywords || []);
    const sectionIntegrity = this.validateSectionIntegrity(input.content);
    const extractionConfidence = this.calculateExtractionConfidence(
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
      const claims = await ResumeEvidenceClaim.find({ resumeProfileId: input.resumeProfileId });
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
      logger.warn(`[ATSCompatibility] Failed to fetch profile/claims for calibration: ${e instanceof Error ? e.message : String(e)}`);
    }

    const atsScore = this.calculateATSScore(
      parserWarnings,
      formattingWarnings,
      keywordCoverage,
      sectionIntegrity,
      extractionConfidence,
      targetRole,
      credibilityPenalty
    );
    const recommendations = this.generateRecommendations(
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
        wordCount: input.content.split(/\s+/).length,
      },
    });

    logger.info(`[ATSCompatibility] ATS score: ${atsScore}`);

    return analysis;
  }

  /**
   * Validate parser safety
   */
  private validateParserSafety(content: string): IParserWarning[] {
    const warnings: IParserWarning[] = [];

    // Check for multi-column layout indicators
    if (this.hasMultiColumnLayout(content)) {
      warnings.push({
        severity: 'critical',
        message: 'Multi-column layout detected',
        section: 'layout',
        suggestion: 'Use single-column layout for better ATS compatibility',
      });
    }

    // Check for tables
    if (this.hasTables(content)) {
      warnings.push({
        severity: 'warning',
        message: 'Tables detected in content',
        section: 'formatting',
        suggestion: 'Replace tables with simple text formatting',
      });
    }

    // Check for special characters
    if (this.hasSpecialCharacters(content)) {
      warnings.push({
        severity: 'info',
        message: 'Special characters detected',
        section: 'content',
        suggestion: 'Minimize use of special characters and symbols',
      });
    }

    // Check for images/graphics references
    if (this.hasGraphics(content)) {
      warnings.push({
        severity: 'critical',
        message: 'Graphics or images detected',
        section: 'content',
        suggestion: 'Remove all images and graphics for ATS compatibility',
      });
    }

    return warnings;
  }

  /**
   * Validate formatting
   */
  private validateFormatting(content: string): IFormattingWarning[] {
    const warnings: IFormattingWarning[] = [];

    // Check for inconsistent heading styles
    if (this.hasInconsistentHeadings(content)) {
      warnings.push({
        type: 'heading_inconsistency',
        message: 'Inconsistent heading styles detected',
        location: 'document',
        impact: 'medium',
      });
    }

    // Check for excessive formatting
    if (this.hasExcessiveFormatting(content)) {
      warnings.push({
        type: 'excessive_formatting',
        message: 'Excessive text formatting detected',
        location: 'document',
        impact: 'low',
      });
    }

    // Check for non-standard fonts
    if (this.hasNonStandardFonts(content)) {
      warnings.push({
        type: 'font_issue',
        message: 'Non-standard fonts may not parse correctly',
        location: 'document',
        impact: 'medium',
      });
    }

    return warnings;
  }

  /**
   * Analyze keyword coverage
   */
  private analyzeKeywordCoverage(content: string, targetKeywords: string[]): IKeywordCoverage[] {
    const contentLower = content.toLowerCase();

    return targetKeywords.map(keyword => {
      const keywordLower = keyword.toLowerCase();
      // \b does not work next to symbols (c++, c#, .net), so use lookarounds
      // that only reject neighbouring word characters.
      const regex = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(keywordLower)}(?![A-Za-z0-9_])`, 'gi');
      const matches = content.match(regex) || [];
      const frequency = matches.length;

      // Extract context (surrounding text)
      const context: string[] = [];
      const sentences = content.split(/[.!?]+/);
      sentences.forEach(sentence => {
        if (sentence.toLowerCase().includes(keywordLower)) {
          context.push(sentence.trim());
        }
      });

      return {
        keyword,
        found: frequency > 0,
        frequency,
        context: context.slice(0, 3), // Top 3 contexts
      };
    });
  }

  /**
   * Validate section integrity
   */
  private validateSectionIntegrity(content: string): ISectionIntegrity[] {
    const standardSections = [
      'summary',
      'experience',
      'projects',
      'skills',
      'education',
      'certifications',
    ];

    return standardSections.map(sectionName => {
      const detected = this.detectSection(content, sectionName);
      const confidence = detected ? 100 : 0;
      const issues: string[] = [];

      if (!detected) {
        issues.push(`Section "${sectionName}" not found`);
      }

      return {
        sectionName,
        detected,
        confidence,
        issues,
      };
    });
  }

  /**
   * Calculate extraction confidence
   */
  private calculateExtractionConfidence(
    parserWarnings: IParserWarning[],
    formattingWarnings: IFormattingWarning[],
    sectionIntegrity: ISectionIntegrity[]
  ): number {
    let confidence = 100;

    // Deduct for parser warnings
    parserWarnings.forEach(warning => {
      if (warning.severity === 'critical') confidence -= 20;
      else if (warning.severity === 'warning') confidence -= 10;
      else confidence -= 5;
    });

    // Deduct for formatting warnings
    formattingWarnings.forEach(warning => {
      if (warning.impact === 'high') confidence -= 15;
      else if (warning.impact === 'medium') confidence -= 8;
      else confidence -= 3;
    });

    // Deduct for missing sections
    const missingSections = sectionIntegrity.filter(s => !s.detected).length;
    confidence -= missingSections * 5;

    return Math.max(0, Math.min(100, confidence));
  }

  /**
   * Calculate ATS score
   */
  private calculateATSScore(
    parserWarnings: IParserWarning[],
    formattingWarnings: IFormattingWarning[],
    keywordCoverage: IKeywordCoverage[],
    sectionIntegrity: ISectionIntegrity[],
    extractionConfidence: number,
    targetRole: string = 'Full Stack Developer',
    credibilityPenalty: number = 0
  ): number {
    let score = 100;

    const isSystemRole = /backend|devops|platform|infrastructure|systems|sre/i.test(targetRole);

    // Parser warnings impact
    const criticalWarnings = parserWarnings.filter(w => w.severity === 'critical').length;
    score -= criticalWarnings * (isSystemRole ? 20 : 15);

    const warningLevel = parserWarnings.filter(w => w.severity === 'warning').length;
    score -= warningLevel * (isSystemRole ? 10 : 8);

    // Formatting warnings impact
    const highImpactFormatting = formattingWarnings.filter(w => w.impact === 'high').length;
    score -= highImpactFormatting * (isSystemRole ? 12 : 10);

    const mediumImpactFormatting = formattingWarnings.filter(w => w.impact === 'medium').length;
    score -= mediumImpactFormatting * (isSystemRole ? 6 : 5);

    // Keyword coverage impact
    if (keywordCoverage.length > 0) {
      const foundKeywords = keywordCoverage.filter(k => k.found).length;
      const keywordScore = (foundKeywords / keywordCoverage.length) * 20;
      score += keywordScore - 20; // Adjust baseline
      // Additional penalty for highly keyword-weak resumes in system roles
      if (isSystemRole && foundKeywords / keywordCoverage.length < 0.4) {
        score -= 10;
      }
    }

    // Section integrity impact
    const detectedSections = sectionIntegrity.filter(s => s.detected).length;
    const sectionScore = (detectedSections / sectionIntegrity.length) * 20;
    score += sectionScore - 20; // Adjust baseline

    // Additional critical section penalties for system roles
    if (isSystemRole) {
      const missingEssential = sectionIntegrity.filter(s => !s.detected && ['experience', 'skills', 'projects'].includes(s.sectionName)).length;
      score -= missingEssential * 15;
    }

    // Extraction confidence impact
    score = (score + extractionConfidence) / 2;

    // Apply credibility validation penalty (direct integration of recruiter validation)
    score -= credibilityPenalty;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    parserWarnings: IParserWarning[],
    formattingWarnings: IFormattingWarning[],
    keywordCoverage: IKeywordCoverage[],
    sectionIntegrity: ISectionIntegrity[]
  ): string[] {
    const recommendations: string[] = [];

    // Parser warning recommendations
    if (parserWarnings.some(w => w.severity === 'critical')) {
      recommendations.push('Address critical parser warnings immediately');
    }

    // Formatting recommendations
    if (formattingWarnings.some(w => w.impact === 'high')) {
      recommendations.push('Simplify formatting for better ATS compatibility');
    }

    // Keyword recommendations
    const missingKeywords = keywordCoverage.filter(k => !k.found);
    if (missingKeywords.length > 0) {
      recommendations.push(`Add missing keywords: ${missingKeywords.map(k => k.keyword).join(', ')}`);
    }

    // Section recommendations
    const missingSections = sectionIntegrity.filter(s => !s.detected);
    if (missingSections.length > 0) {
      recommendations.push(`Add missing sections: ${missingSections.map(s => s.sectionName).join(', ')}`);
    }

    return recommendations;
  }

  // Helper methods for detection
  private hasMultiColumnLayout(content: string): boolean {
    // Check for excessive horizontal spacing or consecutive blocks of white space
    const lines = content.split('\n');
    let multiColumnLineCount = 0;
    for (const line of lines) {
      if (line.includes('\t\t') || /\s{4,}/.test(line)) {
        multiColumnLineCount++;
        if (multiColumnLineCount >= 3) return true;
      }
    }
    return false;
  }

  private hasTables(content: string): boolean {
    const lines = content.split('\n');
    let tableLineCount = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('-')) {
        return true;
      }
      if ((trimmed.match(/\|/g) || []).length >= 2) {
        tableLineCount++;
        if (tableLineCount >= 2) return true;
      }
    }
    if (/\+[-+=]+\+/.test(content) || /\|[-+=]+\|/.test(content)) {
      return true;
    }
    return false;
  }

  private hasSpecialCharacters(content: string): boolean {
    return /[★☆●○■□▪▫◆◇]/.test(content);
  }

  private hasGraphics(content: string): boolean {
    const lower = content.toLowerCase();
    const graphicKeywords = ['[image]', '[graphic]', '[logo]', '<img>', '<svg>', 'chart:', 'graph:'];
    if (graphicKeywords.some(kw => lower.includes(kw))) {
      return true;
    }
    if (/\.(png|jpe?g|gif|svg|webp)\b/i.test(content)) {
      return true;
    }
    return false;
  }

  private hasInconsistentHeadings(content: string): boolean {
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const headings: string[] = [];
    const standardSectionRegex = /\b(summary|profile|about|objective|experience|work history|employment|projects|portfolio|skills|technologies|education|certifications)\b/i;

    for (const line of lines) {
      if (line.length < 50 && standardSectionRegex.test(line)) {
        headings.push(line);
      }
    }

    if (headings.length < 2) return false;

    let hasAllCaps = false;
    let hasMixedCase = false;

    for (const h of headings) {
      const cleaned = h.replace(/[^a-zA-Z\s]/g, '').trim();
      if (cleaned.length === 0) continue;
      if (cleaned === cleaned.toUpperCase()) {
        hasAllCaps = true;
      } else {
        hasMixedCase = true;
      }
    }

    return hasAllCaps && hasMixedCase;
  }

  private hasExcessiveFormatting(content: string): boolean {
    const boldItalicMatches = content.match(/(\*\*|\*|__|_)/g) || [];
    return boldItalicMatches.length > 15;
  }

  private hasNonStandardFonts(content: string): boolean {
    const lower = content.toLowerCase();
    const badFonts = ['comic sans', 'wingdings', 'webdings', 'zapf dingbats', 'impact', 'papyrus'];
    return badFonts.some(font => lower.includes(font));
  }

  private detectSection(content: string, sectionName: string): boolean {
    const sectionPatterns: Record<string, RegExp[]> = {
      summary: [/\b(summary|profile|about|objective)\b/i],
      experience: [/\b(experience|work history|employment)\b/i],
      projects: [/\b(projects|portfolio)\b/i],
      skills: [/\b(skills|technologies|technical skills)\b/i],
      education: [/\b(education|academic)\b/i],
      certifications: [/\b(certifications|certificates)\b/i],
    };

    const patterns = sectionPatterns[sectionName] || [];
    return patterns.some(pattern => pattern.test(content));
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
      logger.error(`[ATSCompatibility] Greenhouse Sync Error: ${err.message}`);
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
      logger.error(`[ATSCompatibility] Workday Sync Error: ${err.message}`);
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
      logger.error(`[ATSCompatibility] Lever Sync Error: ${err.message}`);
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
      logger.error(`[ATSCompatibility] Taleo Sync Error: ${err.message}`);
      throw err;
    }
  }
}
