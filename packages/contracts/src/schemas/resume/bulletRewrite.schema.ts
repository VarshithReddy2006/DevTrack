import { z } from 'zod';

export const BulletRewriteRequestSchema = z.object({
  bullet: z.string().trim().min(10).max(500),
  targetRole: z.string().trim().min(1).max(100).optional(),
  skillsToHighlight: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
}).strict();

const rewrite = z.object({
  style: z.enum(['High Impact', 'Technical Depth', 'Leadership/Ownership']),
  action: z.string().trim().min(1).max(150),
  context: z.string().trim().min(1).max(600),
  result: z.string().trim().min(1).max(200),
  actionVerb: z.string().trim().regex(/^[A-Za-z]+$/).max(40),
  metricPlaceholder: z.string().trim().min(1).max(150),
}).strict();

export const BulletRewriteModelSchema = z.object({
  rewrites: z.tuple([
    rewrite.extend({ style: z.literal('High Impact') }),
    rewrite.extend({ style: z.literal('Technical Depth') }),
    rewrite.extend({ style: z.literal('Leadership/Ownership') }),
  ]),
}).strict().refine(value => new Set(value.rewrites.map(item => `${item.action} ${item.context} ${item.result}`.toLowerCase())).size === 3,
  'Rewrites must be distinct');

export const BulletRewriteResponseSchema = z.object({
  rewrites: z.array(rewrite.extend({
    text: z.string().min(1).max(1000),
    atsScoreGain: z.number().int().min(-100).max(100),
  })).length(3),
  mode: z.enum(['ai', 'template']),
  degradedReason: z.enum(['provider_unavailable', 'output_rejected']).optional(),
}).strict();

export type BulletRewriteRequest = z.infer<typeof BulletRewriteRequestSchema>;
export type BulletRewriteModel = z.infer<typeof BulletRewriteModelSchema>;
export type BulletRewriteResponse = z.infer<typeof BulletRewriteResponseSchema>;
