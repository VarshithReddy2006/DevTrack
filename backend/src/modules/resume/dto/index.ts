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

// Resume Export DTOs
export const ExportResumeSchema = z.object({
  variantId: z.string().optional(),
  exportType: z.enum(['pdf', 'docx', 'txt', 'json', 'md']).default('pdf'),
  includeATSAnalysis: z.boolean().default(true),
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
export type ExportResumeDTO = z.infer<typeof ExportResumeSchema>;
export type AnalyzeATSDTO = z.infer<typeof AnalyzeATSSchema>;
export type CreateEvidenceClaimDTO = z.infer<typeof CreateEvidenceClaimSchema>;
export type GenerateReportDTO = z.infer<typeof GenerateReportSchema>;
