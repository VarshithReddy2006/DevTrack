import { registerConsumer } from '../../../shared/events/consumerRegistry.js';
import { focusSessionCompletedConsumer } from './focusSessionCompleted.consumer.js';
import { jobTargetParsedConsumer } from './jobTargetParsed.consumer.js';
import { revisionReviewedConsumer } from './revisionReviewed.consumer.js';
import { registerRevisionConsumers } from '../../revision/dsaEvents.consumer.js';

export * from './focusSessionCompleted.consumer.js';
export * from './jobTargetParsed.consumer.js';
export * from './revisionReviewed.consumer.js';

/** Registers the readiness consumers (queue `domain-readiness`, xp worker pool). Idempotent. */
export function registerReadinessConsumers(): void {
  registerRevisionConsumers();
  registerConsumer('focus.session.completed', focusSessionCompletedConsumer);
  registerConsumer('revision.reviewed', revisionReviewedConsumer);
  registerConsumer('jobtarget.parsed', jobTargetParsedConsumer);
}
