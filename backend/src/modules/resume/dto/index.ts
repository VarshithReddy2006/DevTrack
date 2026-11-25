// src/modules/resume-intelligence/dto/index.ts
import { z } from 'zod';

// Resume Profile DTOs
export const CreateResumeProfileSchema = z.object({
  targetRole: z.string().min(1).max(100),
  summary: z.string().optional(),
  selectedProjects: z.array(z.string()).optional(),
  selectedSkills: z.array(z.string()).optional(),
});

export const UpdateResumeProfileSchema = z.object({
  targetRole: z.string().min(1).max(100).optional(),
  summary: z.string().optional(),
  selectedProjects: z.array(z.string()).optional(),
  selectedSkills: z.array(z.string()).optional(),
  activeVariant: z.string().nullable().optional(),
});

// Resume Variant DTOs
export const GenerateVariantSchema = z.object({
  roleType: z.enum(['Backend', 'Full Stack', 'Frontend', 'Infrastructure', 'Startup', 'Product Engineering']),
  customWeights: z.object({
    infraWeight: z.number().min(0).max(1).optional(),
    systemDesignWeight: z.number().min(0).max(1).optional(),
    dsaWeight: z.number().min(0).max(1).optional(),
    projectComplexityWeight: z.number().min(0).max(1).optional(),
    leadershipWeight: z.number().min(0).max(1).optional(),
  }).optional(),
});

// Live ATS editor (v2) variant request. Used only while the `ats-live-editor` flag is on.
// `clientScore` is the browser's preview score. It is diagnostic only and never stored as the score.
const singleLine = (max: number) => z.string().max(max).refine(value => !/[\r\n]/.test(value), 'Must be a single line');

export const BulletEditSchema = z.object({
  section: singleLine(50).transform(value => value.trim()).pipe(z.string().min(1)),
  bulletIndex: z.number().int().min(0).max(999),
  originalText: singleLine(1000),
  editedText: singleLine(1000).transform(value => value.trim()).pipe(z.string().min(1)),
});

export const GenerateVariantRequestV2Schema = GenerateVariantSchema.extend({
  bulletEdits: z.array(BulletEditSchema).max(200).optional(),
  jobTargetId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ID format').optional(),
  clientScore: z.number().min(0).max(100).optional(),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  (value.bulletEdits ?? []).forEach((edit, index) => {
    const key = `${edit.section.toLowerCase()}#${edit.bulletIndex}`;
    if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bulletEdits', index], message: 'Duplicate section and bulletIndex' });
    seen.add(key);
  });
});

// Server-computed ATS result stored on a variant.
export interface AtsScoreDto {
  score: number;
  extractionConfidence: number;
  parserWarningCount: number;
  formattingWarningCount: number;
  keywordsMatched: number;
  keywordsTotal: number;
  scoredAt: Date;
}

// Resume Export DTOs
export const ExportResumeSchema = z.object({
  variantId: z.string().optional(),
  exportType: z.enum(['pdf', 'docx', 'txt', 'json', 'md', 'typst', 'latex']).default('pdf'),
  template: z.enum(['classic-academic', 'modern-tech', 'minimal-single-column']).optional(),
  targetPages: z.number().int().min(1).max(2).optional(),
  includeATSAnalysis: z.boolean().default(true),
});

export const CompileTypstSchema = z.object({
  resumeData: z.object({
    header: z.object({
      name: z.string(),
      title: z.string().optional(),
      email: z.string(),
      phone: z.string().optional(),
      location: z.string().optional(),
      website: z.string().optional(),
      github: z.string().optional(),
      linkedin: z.string().optional(),
    }),
    summary: z.string().optional(),
    experience: z.array(z.object({
      role: z.string(),
      company: z.string(),
      location: z.string().optional(),
      startDate: z.string(),
      endDate: z.string(),
      bullets: z.array(z.string()),
      technologies: z.array(z.string()).optional(),
    })).optional(),
    education: z.array(z.object({
      degree: z.string(),
      institution: z.string(),
      location: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string(),
      gpa: z.string().optional(),
      honors: z.array(z.string()).optional(),
      coursework: z.array(z.string()).optional(),
    })).optional(),
    skills: z.union([
      z.array(z.object({ category: z.string(), skills: z.array(z.string()) })),
      z.record(z.array(z.string())),
      z.array(z.string()),
    ]).optional(),
    projects: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      role: z.string().optional(),
      url: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      bullets: z.array(z.string()),
      technologies: z.array(z.string()).optional(),
    })).optional(),
  }),
  options: z.object({
    template: z.enum(['classic-academic', 'modern-tech', 'minimal-single-column']).optional(),
    targetPages: z.number().int().min(1).max(2).optional(),
    paperSize: z.enum(['a4', 'us-letter']).optional(),
    strictPagination: z.boolean().optional(),
    fontSizePt: z.number().optional(),
    lineLeadingEm: z.number().optional(),
  }).optional(),
});

// ATS Analysis DTOs
export const AnalyzeATSSchema = z.object({
  variantId: z.string().optional(),
  targetKeywords: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
});

// Evidence Claim DTOs
export const CreateEvidenceClaimSchema = z.object({
  claimText: z.string().min(1).max(500),
  evidenceSources: z.array(z.object({
    type: z.enum(['github', 'project', 'dsa', 'infra', 'manual', 'ai_assisted']),
    referenceId: z.string(),
    referenceType: z.string(),
    metadata: z.record(z.unknown()).optional(),
  })),
  variantId: z.string().optional(),
});

export const GenerateReportSchema = z.object({
  sessionId: z.string().min(1),
});

export const DossierExportSchema = z.object({ sessionId: z.string().trim().min(1).max(200) });

// Type exports
export type CreateResumeProfileDTO = z.infer<typeof CreateResumeProfileSchema>;
export type UpdateResumeProfileDTO = z.infer<typeof UpdateResumeProfileSchema>;
export type GenerateVariantDTO = z.infer<typeof GenerateVariantSchema>;
export type BulletEditDTO = z.infer<typeof BulletEditSchema>;
export type GenerateVariantRequestV2DTO = z.infer<typeof GenerateVariantRequestV2Schema>;
export type ExportResumeDTO = z.infer<typeof ExportResumeSchema>;
export type AnalyzeATSDTO = z.infer<typeof AnalyzeATSSchema>;
export type CreateEvidenceClaimDTO = z.infer<typeof CreateEvidenceClaimSchema>;
export type GenerateReportDTO = z.infer<typeof GenerateReportSchema>;
