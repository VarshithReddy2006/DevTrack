import { z } from 'zod';

export const semanticAnalysisZodSchema = z.object({
  extractedSkills: z.object({
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    databases: z.array(z.string()),
    cloudTools: z.array(z.string()),
    devOpsTools: z.array(z.string()),
    aiMlTools: z.array(z.string()),
  }).strict(),
  experienceSignals: z.object({
    yearsOfExperience: z.number().describe("Estimated total years of experience"),
    engineeringDepth: z.number().min(0).max(10).describe("Score from 0 to 10 evaluating engineering complexity"),
    projectComplexity: z.number().min(0).max(10),
    leadershipIndicators: z.number().min(0).max(10),
    productionExposure: z.number().min(0).max(10),
  }).strict(),
  roleAlignment: z.object({
    backend: z.number().min(0).max(100).describe("Alignment percentage 0-100"),
    frontend: z.number().min(0).max(100),
    fullstack: z.number().min(0).max(100),
    ml: z.number().min(0).max(100),
    devops: z.number().min(0).max(100),
  }).strict(),
  weaknesses: z.array(z.string()).describe("List of vague wording, missing metrics, weak impact, technology inconsistencies, or keyword gaps"),
  strengths: z.array(z.string()).describe("List of impressive achievements, strong metrics, or high-value signals"),
  semanticSummary: z.string().describe("A 2-3 sentence overall summary of the candidate's profile"),
  confidenceScore: z.number().min(0).max(100).describe("How confident the AI is in this extraction (0-100) based on resume clarity"),
}).strict();

export type SemanticAnalysisOutput = z.infer<typeof semanticAnalysisZodSchema>;
