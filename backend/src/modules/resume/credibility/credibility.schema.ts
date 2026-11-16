import { z } from 'zod';

export const credibilitySignalSchema = z.object({
  type: z.enum(['dsa', 'project', 'consistency', 'suspicious']),
  title: z.string(),
  description: z.string(),
  evidence: z.string(),
  impact: z.number().describe('Impact on overall score (-100 to 100)'),
});

export const credibilityOutputSchema = z.object({
  overallCredibility: z.number().min(0).max(100),
  dsaCredibility: z.number().min(0).max(100),
  projectCredibility: z.number().min(0).max(100),
  consistencyScore: z.number().min(0).max(100),
  verifiedClaims: z.array(z.string()),
  suspiciousClaims: z.array(z.string()),
  signals: z.array(credibilitySignalSchema),
  summary: z.string()
});

// What the model is allowed to return. Everything else in CredibilityOutput is
// computed from the deterministic engines, so extra keys from the model are dropped.
export const credibilityLlmOutputSchema = z.object({
  consistencyScore: z.number().min(0).max(100),
  verifiedClaims: z.array(z.string().max(500)).max(25),
  suspiciousClaims: z.array(z.string().max(500)).max(25),
  summary: z.string().max(2000),
});

export type CredibilitySignal = z.infer<typeof credibilitySignalSchema>;
export type CredibilityOutput = z.infer<typeof credibilityOutputSchema>;
