import { registerConsumer } from '../../../shared/events/consumerRegistry.js';
import { focusStreakConsumer } from './focusSessionCompleted.consumer.js';
import { dsaProblemSolvedStreakConsumer } from './dsaProblemSolved.consumer.js';
import { revisionCardReviewedStreakConsumer } from './revisionCardReviewed.consumer.js';

export { focusStreakConsumer } from './focusSessionCompleted.consumer.js';
export {
  dsaProblemSolvedStreakConsumer,
  handleDsaProblemSolvedStreak,
} from './dsaProblemSolved.consumer.js';
export {
  revisionCardReviewedStreakConsumer,
  handleRevisionCardReviewedStreak,
} from './revisionCardReviewed.consumer.js';

/**
 * Registers the outbox-driven streak consumers on the `domain-readiness` queue
 * (XP worker pool). Idempotent.
 */
export function registerStreakConsumers(): void {
  registerConsumer('dsa.problem.solved', dsaProblemSolvedStreakConsumer);
  registerConsumer('revision.card_reviewed', revisionCardReviewedStreakConsumer);
  registerConsumer('revision.reviewed', revisionCardReviewedStreakConsumer);
}
