import { evaluateBulletEdits, type BulletScoringContext } from '@devtrack/ats-core';
import type { AtsScoreDto, BulletEditDTO } from '../dto/index.js';

export { renderBulletEdits, type BulletScoringContext } from '@devtrack/ats-core';

/** The server owns the timestamp and never trusts the browser's preview score. */
export function scoreBulletEdits(edits: readonly BulletEditDTO[], context: BulletScoringContext = {}): AtsScoreDto {
  return { ...evaluateBulletEdits(edits, context), scoredAt: new Date() };
}
