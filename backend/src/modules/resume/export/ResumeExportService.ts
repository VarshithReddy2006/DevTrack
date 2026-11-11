// src/modules/resume-intelligence/export/ResumeExportService.ts
import type { Types } from 'mongoose';
import { ResumeProfile, type IResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { ResumeExport } from '../../../db/models/resumeExport.model.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import { ATSCompatibilityEngine } from '../ats/ATSCompatibilityEngine.js';
import { logger } from '../../../shared/logger.js';
import { randomBytes } from 'crypto';
import fs from 'node:fs/promises';
import path from 'path';
import { escapeHtml, renderExportPdf } from './renderExportPdf.js';
import type { ExportResumeDTO } from '../dto/index.js';
import { Document, Packer, Paragraph, HeadingLevel } from 'docx';

// Report fields may contain resume text. Escape them before inserting into HTML.
function escapeReport(value: any): any {
  if (typeof value === 'string') return escapeHtml(value);
  if (Array.isArray(value)) return value.map(escapeReport);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, escapeReport(item)]));
  return value;
}

export interface IExportOptions {
  userId: Types.ObjectId;
  resumeProfileId: Types.ObjectId;
  variantId?: string;
  exportType: ExportResumeDTO['exportType'];
  includeATSAnalysis?: boolean;
  sessionId?: string;
}

/**
 * ResumeExportService
 * 
 * Responsibilities:
 * - ATS-safe PDF generation
 * - Recruiter-grade Intelligence Dossier HTML-to-PDF export
 * - Version tracking & export history metrics
 */
export class ResumeExportService {
  private atsEngine: ATSCompatibilityEngine;

  constructor() {
    this.atsEngine = new ATSCompatibilityEngine();
  }

  /**
   * Export resume or intelligence dossier to a file
   */
  async export(options: IExportOptions): Promise<typeof ResumeExport.prototype> {
    logger.info(`[ResumeExportService] Exporting resume/dossier for user ${options.userId}`);

    const exportPath = `/exports/${options.userId}/${randomBytes(8).toString('hex')}.${options.exportType}`;
    const checksum = randomBytes(16).toString('hex');

    const startedAt = Date.now();
    const fullPath = path.join(process.cwd(), exportPath);
    const content = await this.generateExport(options);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, { flag: 'wx' }).catch(async error => {
      if (error.code !== 'EEXIST') await this.removeFailedExport(fullPath);
      throw error;
    });

    const exportRecord = await ResumeExport.create({
      userId: options.userId,
      resumeProfileId: options.resumeProfileId,
      variantId: options.variantId || null,
      exportType: options.exportType,
      exportPath,
      checksum,
      atsValidationState: 'passed',
      exportVersion: '1.0.0',
      templateVersion: '1.0.0',
      metadata: {
        fileSize: Buffer.byteLength(content),
        pageCount: 1,
        generationDurationMs: Date.now() - startedAt,
        atsAnalysisId: null,
      },
    }).catch(async error => {
      await this.removeFailedExport(fullPath);
      throw error;
    });

    // Run traditional ATS analysis if requested
    if (options.includeATSAnalysis) {
      const profile = await ResumeProfile.findOne({ _id: options.resumeProfileId, userId: options.userId });
      if (profile) {
        const analysis = await this.atsEngine.analyze({
          userId: options.userId,
          resumeProfileId: options.resumeProfileId,
          variantId: options.variantId,
          exportId: exportRecord._id as Types.ObjectId,
          content: this.generateRawContent(profile),
        });

        exportRecord.metadata.atsAnalysisId = analysis._id as any;
        exportRecord.atsValidationState = analysis.atsScore >= 70 ? 'passed' : 'warning';
        await exportRecord.save();
      }
    }

    return exportRecord;
  }

  private async removeFailedExport(fullPath: string): Promise<void> {
    await fs.rm(fullPath, { force: true }).catch(error => {
      logger.error('[ResumeExportService] Could not remove failed export', error);
    });
  }

  private async generateExport(options: IExportOptions): Promise<Buffer | string> {
    if (options.exportType === 'pdf' && options.sessionId) {
      return this.generateDossierPDF(options.userId, options.sessionId);
    }

    const profile = await ResumeProfile.findOne({ _id: options.resumeProfileId, userId: options.userId });
    if (!profile) throw Object.assign(new Error('Resume profile not found'), { statusCode: 404 });

    const summary = profile.summary || 'No summary provided.';
    const skills = profile.selectedSkills || [];
    const skillList = skills.join(', ') || 'None';
    switch (options.exportType) {
      case 'pdf':
        return this.generateProfilePDF(summary, skillList);
      case 'docx':
        return this.generateProfileDOCX(profile);
      case 'txt':
        return `Resume\n\nSummary\n${summary}\n\nSkills\n${skillList}\n`;
      case 'json':
        return JSON.stringify({ summary, skills }, null, 2) + '\n';
      case 'md': {
        // Indentation keeps user-entered Markdown and HTML literal.
        const literal = (value: string) => value.split(/\r\n|[\r\n]/).map(line => `    ${line}`).join('\n');
        return `# Resume\n\n## Summary\n\n${literal(summary)}\n\n## Skills\n\n${literal(skillList)}\n`;
      }
    }
  }

  /**
   * Generates a high-fidelity recruiter-grade HTML representation of the 14-section dossier
   */
  async generateDossierPDF(userId: Types.ObjectId, sessionId: string): Promise<Buffer> {
    const session = await ResumeSession.findOne({ userId, sessionId, currentStage: 'COMPLETED' });
    if (!session?.reportState?.generated || !session.reportState.reportData) {
      throw Object.assign(new Error('Dossier not found'), { statusCode: 404 });
    }

    const report = escapeReport(session.reportState.reportData);
    const safeSessionId = escapeReport(sessionId);

    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>DevTrack Resume Intelligence Dossier</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #0f172a;
      line-height: 1.5;
      padding: 40px;
      background-color: #ffffff;
    }
    .header {
      border-bottom: 2px solid #8b5cf6;
      padding-bottom: 12px;
      margin-bottom: 25px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .header h1 {
      font-size: 20px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin: 0;
      color: #1e1b4b;
    }
    .header span {
      font-size: 9px;
      font-weight: 800;
      text-transform: uppercase;
      color: #64748b;
    }
    .grid-summary {
      display: grid;
      grid-template-cols: 2fr 1fr;
      gap: 20px;
      margin-bottom: 30px;
    }
    .card {
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 16px;
      background-color: #f8fafc;
    }
    .card-title {
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
      color: #64748b;
      margin-bottom: 8px;
    }
    .verdict-box {
      font-style: italic;
      background-color: #f5f3ff;
      border-left: 4px solid #8b5cf6;
      padding: 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      color: #4c1d95;
    }
    .metrics-row {
      display: grid;
      grid-template-cols: repeat(4, 1fr);
      gap: 12px;
      margin-top: 15px;
    }
    .metric-item {
      text-align: center;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 8px;
    }
    .metric-label {
      font-size: 8px;
      font-weight: bold;
      color: #94a3b8;
      text-transform: uppercase;
    }
    .metric-value {
      font-size: 13px;
      font-weight: 900;
      color: #1e293b;
      margin-top: 4px;
    }
    .section-title {
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #1e1b4b;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 4px;
      margin-top: 25px;
      margin-bottom: 12px;
    }
    .align-grid {
      display: grid;
      grid-template-cols: repeat(5, 1fr);
      gap: 10px;
    }
    .align-card {
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 8px;
      text-align: center;
      background: #f8fafc;
    }
    .align-label {
      font-size: 8px;
      font-weight: bold;
      color: #64748b;
    }
    .align-val {
      font-size: 14px;
      font-weight: 900;
      color: #0f172a;
      margin-top: 4px;
    }
    .project-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
    }
    .project-table th {
      border-bottom: 2px solid #e2e8f0;
      padding: 8px;
      text-transform: uppercase;
      color: #64748b;
      font-weight: bold;
    }
    .project-table td {
      border-bottom: 1px solid #f1f5f9;
      padding: 8px;
    }
    .warning-item {
      background-color: #fef3c7;
      border: 1px solid #fde68a;
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 8px;
      font-size: 11px;
      font-weight: 500;
      color: #78350f;
    }
  </style>
</head>
<body>

  <div class="header">
    <div>
      <h1>DevTrack Engineering Dossier</h1>
      <span>SECURE LEVEL II AUDIT REPORT</span>
    </div>
    <span style="font-weight: bold;">Session ID: ${safeSessionId}</span>
  </div>

  <div class="grid-summary">
    <div class="card">
      <div class="card-title">1. Executive Summary & Verdict</div>
      <div class="verdict-box">"${report.executiveSummary.narrative}"</div>
      <div class="metrics-row">
        <div class="metric-item">
          <div class="metric-label">Maturity</div>
          <div class="metric-value" style="color: #8b5cf6;">${report.executiveSummary.engineeringMaturity}</div>
        </div>
        <div class="metric-item">
          <div class="metric-label">ATS Survival</div>
          <div class="metric-value" style="color: #10b981;">${report.executiveSummary.atsSurvivability}</div>
        </div>
        <div class="metric-item">
          <div class="metric-label">Trust Index</div>
          <div class="metric-value" style="color: #f59e0b;">${report.executiveSummary.recruiterTrustLevel}</div>
        </div>
        <div class="metric-item">
          <div class="metric-label">Infra Maturity</div>
          <div class="metric-value" style="color: #6366f1;">${report.executiveSummary.infrastructureMaturity}</div>
        </div>
      </div>
    </div>

    <div class="card" style="text-align: center; display: flex; flex-col; justify-content: center; align-items: center;">
      <div class="card-title">Readiness Index</div>
      <div style="font-size: 32px; font-weight: 900; color: #8b5cf6; margin-top: 10px;">${report.executiveSummary.operationalReadiness}%</div>
      <div style="font-size: 8px; font-weight: bold; color: #94a3b8; text-transform: uppercase; margin-top: 4px;">OPERATIONAL READY</div>
    </div>
  </div>

  <div class="section-title">2. Semantic Role Compatibility Matrix</div>
  <div class="align-grid">
    <div class="align-card">
      <div class="align-label">Backend Eng</div>
      <div class="align-val">${report.roleAlignment.backend}%</div>
    </div>
    <div class="align-card">
      <div class="align-label">Platform Eng</div>
      <div class="align-val">${report.roleAlignment.platform}%</div>
    </div>
    <div class="align-card">
      <div class="align-label">DevOps Eng</div>
      <div class="align-val">${report.roleAlignment.devops}%</div>
    </div>
    <div class="align-card">
      <div class="align-label">ML Eng</div>
      <div class="align-val">${report.roleAlignment.ml}%</div>
    </div>
    <div class="align-card">
      <div class="align-label">Full Stack</div>
      <div class="align-val">${report.roleAlignment.fullstack}%</div>
    </div>
  </div>

  <div class="section-title">3. Engineering Credibility & Risk Analysis</div>
  <div>
    ${report.credibilityAnalysis.unsupportedClaims.map((claim: string) => `
      <div class="warning-item">
        <strong>[Flagged Claim]:</strong> ${claim}
      </div>
    `).join('')}
  </div>

  <div class="section-title">4. Project Intelligence Evaluation</div>
  <table class="project-table">
    <thead>
      <tr>
        <th style="text-align: left;">Project Name</th>
        <th style="text-align: center;">Originality Score</th>
        <th style="text-align: center;">Infra Depth</th>
        <th style="text-align: right;">Verdict</th>
      </tr>
    </thead>
    <tbody>
      ${report.credibilityAnalysis.projectRankings.map((p: any) => `
        <tr>
          <td style="font-weight: bold; color: #1e293b;">${p.name}</td>
          <td style="text-align: center; font-weight: bold; color: ${p.originalityScore > 70 ? '#10b981' : '#f59e0b'};">${p.originalityScore}%</td>
          <td style="text-align: center; color: #64748b;">${p.infrastructureDepth}%</td>
          <td style="text-align: right; color: #64748b;">${p.engineeringSignal}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <div class="section-title">5. Senior Engineering Roadmap Recommendations</div>
  <div style="font-size: 11px;">
    ${report.recommendations.map((rec: any, idx: number) => `
      <div style="margin-bottom: 12px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; background-color: #f8fafc;">
        <div style="display: flex; justify-content: space-between; font-weight: bold; color: #6366f1;">
          <span>Recommendation #${idx + 1} (${rec.category})</span>
          <span>Dependency: ${rec.progressionDependency}</span>
        </div>
        <p style="margin-top: 6px; font-weight: 600; color: #1e293b;">${rec.suggestion}</p>
        <div style="color: #94a3b8; font-size: 9px; margin-top: 4px;">Trace: "${rec.evidenceTraceability}"</div>
      </div>
    `).join('')}
  </div>

</body>
</html>
`;

    return renderExportPdf(htmlContent);
  }

  private async generateProfilePDF(summary: string, skills: string): Promise<Buffer> {
    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; color: #333; }
        h1 { font-size: 24px; border-bottom: 2px solid #333; }
        h2 { font-size: 18px; margin-top: 20px; }
        p { line-height: 1.6; }
      </style>
    </head>
    <body>
      <h1>Resume</h1>
      <h2>Summary</h2>
      <p>${escapeHtml(summary)}</p>
      <h2>Skills</h2>
      <p>${escapeHtml(skills)}</p>
    </body>
    </html>
    `;

    return renderExportPdf(htmlContent);
  }

  private async generateProfileDOCX(profile: IResumeProfile): Promise<Buffer> {
    const doc = new Document({
      sections: [{
        properties: {},
        children: [
          new Paragraph({
            text: "Software Engineering Resume",
            heading: HeadingLevel.HEADING_1,
          }),
          new Paragraph({
            text: "Summary",
            heading: HeadingLevel.HEADING_2,
          }),
          new Paragraph({
            text: profile.summary || "No summary provided.",
          }),
          new Paragraph({
            text: "Skills",
            heading: HeadingLevel.HEADING_2,
          }),
          new Paragraph({
            text: profile.selectedSkills?.join(', ') || "No skills listed.",
            bullet: { level: 0 },
          }),
        ],
      }],
    });

    return Packer.toBuffer(doc);
  }

  /**
   * Simple content generator for analysis placeholder
   */
  private generateRawContent(profile: any): string {
    return `
      SUMMARY: ${profile.summary || ''}
      SKILLS: ${(profile.selectedSkills || []).join(', ')}
      PROJECTS: ${profile.selectedProjects.length} projects selected.
    `;
  }
}
