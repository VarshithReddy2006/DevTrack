import { evaluateBulletEdits, sanitizeKeywords, type BulletScoringContext } from '@devtrack/ats-core';
import type { AtsScoreDto, BulletEditDTO } from '../dto/index.js';

export { renderBulletEdits, type BulletScoringContext } from '@devtrack/ats-core';

/** The server owns the timestamp and never trusts the browser's preview score. */
export function scoreBulletEdits(edits: readonly BulletEditDTO[], context: BulletScoringContext = {}): AtsScoreDto {
  const keywords = context.keywords ? sanitizeKeywords(context.keywords) : undefined;
  return { ...evaluateBulletEdits(edits, { ...context, ...(keywords ? { keywords } : {}) }), scoredAt: new Date() };
}
