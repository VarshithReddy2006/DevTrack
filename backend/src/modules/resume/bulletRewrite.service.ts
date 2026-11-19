import { createHash } from 'node:crypto';
import { analyzeActionVerbs, extractRequirements, scoreDifferential } from '@devtrack/ats-core';
import {
  BulletRewriteRequestSchema, BulletRewriteModelSchema, BulletRewriteResponseSchema,
  type BulletRewriteRequest, type BulletRewriteModel, type BulletRewriteResponse,
} from '@devtrack/contracts';
import { llmGateway } from '../ai/provider/LLMGateway.js';
import { AIQuotaExceededError } from '../ai/quota.service.js';
import { wrapUntrusted, ANTI_HIJACK_RULES } from '../job-targets/prompts/untrustedText.js';
import { getRedisClient, isRedisConfigured } from '../../shared/redis/client.js';
import { logger } from '../../shared/logger.js';

const TTL = 86_400;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const pending = new Map<string, Promise<BulletRewriteResponse>>();

// The gateway currently accepts text prompts, not provider-native JSON schemas.
// Specify the shape in the prompt and validate every response before use.
const OUTPUT_SHAPE = {
  rewrites: ['High Impact', 'Technical Depth', 'Leadership/Ownership'].map(style => ({
    style, action: 'Strong action phrase starting with actionVerb', context: 'Only context evidenced in the bullet',
    result: '[insert verified outcome]', actionVerb: 'Improved', metricPlaceholder: 'latency reduction (%)',
  })),
};
const SYSTEM = `${ANTI_HIJACK_RULES}
Rewrite the supplied resume bullet into exactly three distinct Action-Context-Result options in the listed style order.
Replace weak phrases such as "Worked on", "Helped with", and "Responsible for" with strong, accurate verbs.
Treat the original bullet as the ONLY evidence. Role and requested skills are preferences, not evidence.
Never invent employers, tools, metrics, outcomes, leadership, or ownership. Preserve the level of responsibility.
Always put result in an explicit square-bracket placeholder asking for a verified outcome, even when context contains an existing metric.
Use ASCII digits for numbers. Do not invent numbers, including spelled-out quantities.
Each action starts with its actionVerb. metricPlaceholder is a question/prompt for a metric, not a claimed value.
Do not return scores. Return only this JSON shape (no additional keys):
${JSON.stringify(OUTPUT_SHAPE)}`;

// Numeric and taxonomy checks complement the prompt; semantic accuracy still needs user review.
function grounded(model: BulletRewriteModel, input: BulletRewriteRequest): boolean {
  const numbers = new Set(input.bullet.match(/\d+(?:[.,]\d+)*/g) ?? []);
  const skills = new Set(extractRequirements(input.bullet).skills.map(item => item.skill));
  return model.rewrites.every(item => {
    const text = [item.action, item.context, item.result, item.metricPlaceholder].join(' ');
    return item.action.toLowerCase().startsWith(item.actionVerb.toLowerCase() + ' ')
      && (analyzeActionVerbs([item.action])[0] || /^(supported|contributed|collaborated|assisted)\b/i.test(item.action))
      && /^\[[^\[\]]+\]$/.test(item.result)
      && !(text.match(/\d+(?:[.,]\d+)*/g) ?? []).some(number => !numbers.has(number))
      && extractRequirements(text).skills.every(skill => skills.has(skill.skill));
  });
}

function templates(input: BulletRewriteRequest): BulletRewriteModel {
  // Templates quote the original as context instead of asserting new achievements.
  return { rewrites: [
    { style: 'High Impact', action: 'Describe the impact of', context: input.bullet, result: '[insert verified outcome]', actionVerb: 'Describe', metricPlaceholder: 'Measured change in time, cost, or quality' },
    { style: 'Technical Depth', action: 'Explain the technical contribution in', context: input.bullet, result: '[insert verified technical result]', actionVerb: 'Explain', metricPlaceholder: 'Measured latency, throughput, or error rate' },
    { style: 'Leadership/Ownership', action: 'Clarify your responsibility in', context: input.bullet, result: '[insert verified scope and outcome]', actionVerb: 'Clarify', metricPlaceholder: 'Verified scope of contribution and measurable outcome' },
  ] };
}

function response(model: BulletRewriteModel, input: BulletRewriteRequest, mode: 'ai' | 'template',
  degradedReason?: BulletRewriteResponse['degradedReason']): BulletRewriteResponse {
  return BulletRewriteResponseSchema.parse({
    mode, ...(degradedReason ? { degradedReason } : {}),
    rewrites: model.rewrites.map(item => {
      const text = `${item.action} ${item.context}; ${item.result}`;
      return { ...item, text, atsScoreGain: mode === 'template' ? 0 : scoreDifferential({
        originalBullets: [input.bullet], revisedBullets: [text], targetKeywords: input.skillsToHighlight ?? [],
      }).delta };
    }),
  });
}

async function generate(userId: string, input: BulletRewriteRequest, key: string): Promise<BulletRewriteResponse> {
  if (isRedisConfigured()) {
    try {
      const cached = await getRedisClient().get(key);
      if (cached) {
        const parsed = BulletRewriteResponseSchema.safeParse(JSON.parse(cached));
        // Revalidate cached model fields too, including ordered styles and evidence.
        if (parsed.success && parsed.data.mode === 'ai') {
          const model = BulletRewriteModelSchema.safeParse({ rewrites: parsed.data.rewrites.map(({ text, atsScoreGain, ...item }) => item) });
          if (model.success && grounded(model.data, input)) return response(model.data, input, 'ai');
        }
      }
    } catch { logger.warn('[bulletRewrite] Cache lookup unavailable'); }
  }
  let model: BulletRewriteModel;
  try {
    const completion = await llmGateway.generateCompletion({
      userId, feature: 'resume_rewrite', temperature: 0.3, maxTokens: 1600, bypassCache: true,
      // Scope the gateway's own prompt cache to this user, without exposing their ID.
      systemPrompt: `${SYSTEM}\nRequest scope: ${hash(userId)}`,
      prompt: wrapUntrusted('bullet_untrusted_text', input.bullet, 500) + '\n'
        + wrapUntrusted('preferences_untrusted_text', JSON.stringify({ targetRole: input.targetRole, skillsToHighlight: input.skillsToHighlight }), 2000),
    });
    if (completion.provider === 'heuristic') return response(templates(input), input, 'template', 'provider_unavailable');
    try {
      model = BulletRewriteModelSchema.parse(JSON.parse(completion.content));
      if (!grounded(model, input)) throw new Error('Unsupported evidence');
    } catch {
      return response(templates(input), input, 'template', 'output_rejected');
    }
  } catch (error) {
    if (error instanceof AIQuotaExceededError) throw error;
    logger.warn('[bulletRewrite] Provider unavailable');
    return response(templates(input), input, 'template', 'provider_unavailable');
  }
  const result = response(model, input, 'ai');
  if (isRedisConfigured()) {
    try { await getRedisClient().set(key, JSON.stringify(result), 'EX', TTL); }
    catch { logger.warn('[bulletRewrite] Cache write unavailable'); }
  }
  return result;
}

export const bulletRewriteService = {
  async suggest(userId: string, body: unknown): Promise<BulletRewriteResponse> {
    const input = BulletRewriteRequestSchema.parse(body);
    const key = 'devtrack:resume:bullet-rewrite:v1:' + hash(JSON.stringify([userId, input.bullet, input.targetRole ?? null, input.skillsToHighlight ?? []]));
    const existing = pending.get(key);
    if (existing) return existing;
    const work = generate(userId, input, key);
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  },
};
