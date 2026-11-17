import type { ConsumerDefinition } from '../../../shared/events/consumerRegistry.js';
import type { FocusSessionCompletedV1 } from '../../../shared/events/eventContract.js';
import { QueueNames } from '../../../shared/jobs/types.js';
import { processFocusSessionXp } from '../processor.js';

export const focusXpConsumer: ConsumerDefinition<FocusSessionCompletedV1> = {
  name: 'xp.focusSessionCompleted',
  pool: 'xp',
  queue: QueueNames.DOMAIN_FOCUS_XP,
  dedup: 'natural',
  async handle({ userId, payload }) {
    await processFocusSessionXp(userId, payload.sessionId);
  },
};
