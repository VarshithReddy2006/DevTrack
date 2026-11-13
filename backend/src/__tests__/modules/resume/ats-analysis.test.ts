// src/__tests__/modules/resume/ats-analysis.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ATSCompatibilityEngine } from '../../../modules/resume/ats/ATSCompatibilityEngine.js';
import { ATSAnalysis } from '../../../db/models/atsAnalysis.model.js';
import type { ISectionIntegrity } from '../../../db/models/atsAnalysis.model.js';
import { ResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { ResumeEvidenceClaim } from '../../../db/models/resumeEvidenceClaim.model.js';
import { Types } from 'mongoose';
import { AnalyzeATSSchema } from '../../../modules/resume/dto/index.js';

vi.mock('../../../db/models/atsAnalysis.model.js');
vi.mock('../../../db/models/resumeProfile.model.js');
vi.mock('../../../db/models/resumeEvidenceClaim.model.js');
vi.mock('../../../shared/logger.js');

describe('ATSCompatibilityEngine', () => {
  let engine: ATSCompatibilityEngine;
  const userId = new Types.ObjectId();
  const resumeProfileId = new Types.ObjectId();

  beforeEach(() => {
    vi.clearAllMocks();
    (ResumeProfile.findById as any).mockResolvedValue({
      targetRole: 'Full Stack Developer',
    });
    (ResumeEvidenceClaim.find as any).mockResolvedValue([]);
    (ATSAnalysis.create as any).mockImplementation((data: any) => Promise.resolve(data));
    engine = new ATSCompatibilityEngine();
  });

  it('should analyze ATS compatibility and return a calibrated score', async () => {
    const result = await engine.analyze({
      userId,
      resumeProfileId,
      content: 'This is a sample resume summary. Summary of skills: Node.js, Docker, Git. Experience in Backend. Projects include scaling. Education: BS CS. Certifications: AWS.',
      targetKeywords: ['Node.js', 'Docker', 'AWS'],
    });

    expect(result.atsScore).toBeGreaterThan(0);
    expect(result.atsScore).toBeLessThanOrEqual(100);
  });

  it('should detect parser warnings for multi-column layouts', async () => {
    const multiColumnContent = 'Name\t\t\tExperience\t\t\tSkills\nJohn Doe\t\tSoftware Engineer\t\tJavaScript\nLine 3\t\t\tLine 4\t\t\tLine 5';
    const result = await engine.analyze({
      userId,
      resumeProfileId,
      content: multiColumnContent,
    });

    const hasMultiColumnWarning = result.parserWarnings.some((w: any) => 
      w.message.toLowerCase().includes('multi-column')
    );
    expect(hasMultiColumnWarning).toBe(true);
  });

  it('recognizes standalone section aliases and reports the matching headings', async () => {
    const content = [
      'Professional Summary',
      'Backend engineer building developer tools.',
      '## Professional Experience',
      'Engineer at Example',
      'Selected Projects',
      'Built a deployment tool.',
      '  Core Competencies:  ',
      'TypeScript, MongoDB',
      'Education & Credentials',
      'BSc Computer Science',
      'CERTIFICATIONS',
      'AWS Certified Developer',
    ].join('\r\n');

    const result = await engine.analyze({ userId, resumeProfileId, content });

    expect(result.sectionIntegrity).toEqual([
      { sectionName: 'summary', detected: true, confidence: 90, matchedHeading: 'Professional Summary', issues: [] },
      { sectionName: 'experience', detected: true, confidence: 100, matchedHeading: '## Professional Experience', issues: [] },
      { sectionName: 'projects', detected: true, confidence: 90, matchedHeading: 'Selected Projects', issues: [] },
      { sectionName: 'skills', detected: true, confidence: 100, matchedHeading: 'Core Competencies:', issues: [] },
      { sectionName: 'education', detected: true, confidence: 90, matchedHeading: 'Education & Credentials', issues: [] },
      { sectionName: 'certifications', detected: true, confidence: 100, matchedHeading: 'CERTIFICATIONS', issues: [] },
    ]);
  });

  it('ignores body mentions and list items and scores the missing sections accordingly', async () => {
    const lines = [
      'Summary',
      'Experience with distributed systems',
      '- Professional Experience',
      '1. Projects',
      '\u2022 Skills',
      'Collaborated with education providers',
      'Education.',
      'Certifications: AWS',
    ];
    const analyze = (content: string) => engine.analyze({ userId, resumeProfileId, content });
    const incomplete = await analyze(lines.join('\n'));
    const complete = await analyze([
      ...lines, 'Experience', 'Projects', 'Skills', 'Education', 'Certifications',
    ].join('\n'));

    const sections: ISectionIntegrity[] = incomplete.sectionIntegrity;
    expect(sections.filter(section => section.detected).map(section => section.sectionName))
      .toEqual(['summary']);
    expect(sections.find(section => section.sectionName === 'education'))
      .toEqual({ sectionName: 'education', detected: false, confidence: 0, issues: ['Section "education" not found'] });
    expect(incomplete.atsScore).toBeLessThan(complete.atsScore);
    expect(incomplete.extractionConfidence).toBeLessThan(complete.extractionConfidence);
  });

  it('should detect tables layout warning in resume text', async () => {
    const tabularContent = 'Name | Title | Year\nJohn Doe | SWE | 2024\n|---|---|---|';
    const result = await engine.analyze({
      userId,
      resumeProfileId,
      content: tabularContent,
    });

    const hasTableWarning = result.parserWarnings.some((w: any) => 
      w.message.toLowerCase().includes('table')
    );
    expect(hasTableWarning).toBe(true);
  });

  it('should detect image and graphics warnings', async () => {
    const graphicsContent = 'This is my resume [image] or profile.jpg embedded in header.';
    const result = await engine.analyze({
      userId,
      resumeProfileId,
      content: graphicsContent,
    });

    const hasGraphicsWarning = result.parserWarnings.some((w: any) => 
      w.message.toLowerCase().includes('graphics') || w.message.toLowerCase().includes('image')
    );
    expect(hasGraphicsWarning).toBe(true);
  });

  it('should detect heading inconsistency formatting warnings', async () => {
    const content = 'SUMMARY\nMy profile details.\n\nexperience\nJob history in frontend.';
    const result = await engine.analyze({
      userId,
      resumeProfileId,
      content,
    });

    const hasInconsistentHeadings = result.formattingWarnings.some((w: any) => 
      w.type === 'heading_inconsistency'
    );
    expect(hasInconsistentHeadings).toBe(true);
  });

  it('should apply role-specific deductions for backend roles with missing essential sections', async () => {
    (ResumeProfile.findById as any).mockResolvedValue({
      targetRole: 'Backend Engineer',
    });

    // Content missing essential experience & projects sections
    const weakContent = 'SUMMARY\nOnly has summary and nothing else.';
    const result = await engine.analyze({
      userId,
      resumeProfileId,
      content: weakContent,
    });

    // Score should be very low due to severe backend deductions
    expect(result.atsScore).toBeLessThanOrEqual(50);
  });

  it('should deduct direct credibility penalties for unverified infrastructure claims', async () => {
    (ResumeProfile.findById as any).mockResolvedValue({
      targetRole: 'Backend Engineer',
    });

    (ResumeEvidenceClaim.find as any).mockResolvedValue([
      {
        claimText: 'I scale microservices with Kubernetes',
        verificationStatus: 'unverified',
        provenance: [],
      },
      {
        claimText: 'Designed RabbitMQ distributed system queue',
        verificationStatus: 'flagged',
        provenance: ['manual'],
      }
    ]);

    const result = await engine.analyze({
      userId,
      resumeProfileId,
      content: 'I scale microservices with Kubernetes and designed RabbitMQ queue.',
    });

    // Verification claims being unverified or flagged causes penalty up to 10
    expect(result.atsScore).toBeLessThan(90);
  });
  describe('keyword coverage with regex characters', () => {
    const content = 'Built services in C++ and C#. Also used Node.js, nodexjs-style tooling and (parens) daily.';

    const coverage = async (targetKeywords: string[]) => {
      const result = await engine.analyze({ userId, resumeProfileId, content, targetKeywords });
      return result.keywordCoverage as Array<{ keyword: string; found: boolean; frequency: number }>;
    };

    it('does not throw for keywords like c++, c# and (', async () => {
      await expect(coverage(['c++', 'c#', '(', '[', '\\', '*'])).resolves.toHaveLength(6);
    });

    it('matches symbol keywords literally', async () => {
      const result = await coverage(['c++', 'c#']);
      expect(result[0]).toMatchObject({ keyword: 'c++', found: true, frequency: 1 });
      expect(result[1]).toMatchObject({ keyword: 'c#', found: true, frequency: 1 });
    });

    it('treats . as a literal dot', async () => {
      const result = await coverage(['node.js', 'node.x']);
      expect(result[0]).toMatchObject({ found: true, frequency: 1 });
      expect(result[1]).toMatchObject({ found: false, frequency: 0 });
    });

    it('does not treat .* as a wildcard', async () => {
      const result = await coverage(['.*']);
      expect(result[0]).toMatchObject({ found: false, frequency: 0 });
    });

    it('still respects word boundaries for plain keywords', async () => {
      const result = await coverage(['node', 'script']);
      expect(result[0]).toMatchObject({ found: true, frequency: 1 });
      expect(result[1]).toMatchObject({ found: false, frequency: 0 });
    });
  });

  describe('AnalyzeATSSchema targetKeywords', () => {
    it('accepts symbol keywords', () => {
      expect(AnalyzeATSSchema.safeParse({ targetKeywords: ['c++', 'c#', '.net'] }).success).toBe(true);
    });

    it('rejects too many keywords', () => {
      const keywords = Array.from({ length: 51 }, (_, i) => `kw${i}`);
      expect(AnalyzeATSSchema.safeParse({ targetKeywords: keywords }).success).toBe(false);
    });

    it('rejects empty and oversized keywords', () => {
      expect(AnalyzeATSSchema.safeParse({ targetKeywords: ['  '] }).success).toBe(false);
      expect(AnalyzeATSSchema.safeParse({ targetKeywords: ['a'.repeat(101)] }).success).toBe(false);
    });
  });
});
