import { z } from 'zod';
import { registerConsumer, type ConsumerDefinition } from '../../shared/events/consumerRegistry.js';
import { QueueNames } from '../../shared/jobs/types.js';
import { eventBus } from '../../shared/sse/eventBus.js';
import { RevisionCard } from '../../db/models/revisionCard.model.js';
import { generateStruggleCard, revisionCardCreatedSchema } from './cardGenerator.service.js';

export const struggleCardConsumer: ConsumerDefinition = {
  name: 'revision.struggle-card', pool: 'xp', queue: QueueNames.DOMAIN_READINESS, dedup: 'natural',
  handle: async event => {
    if (event.type !== 'dsa.submission.evaluated' || event.schemaVersion !== 1) throw new Error('Unsupported submission evaluation event');
    await generateStruggleCard(event.userId, event.payload);
  },
};

export const revisionCardCreatedConsumer: ConsumerDefinition = {
  name: 'revision.card-created-sse', pool: 'xp', queue: QueueNames.DOMAIN_READINESS, dedup: 'natural',
  handle: async event => {
    if (event.type !== 'revision.card_created' || event.schemaVersion !== 1) throw new Error('Unsupported revision card event');
    z.string().regex(/^[a-fA-F0-9]{24}$/).parse(event.userId);
    const payload = revisionCardCreatedSchema.parse(event.payload);
    if (!await RevisionCard.exists({ _id: payload.cardId, userId: event.userId })) return;
    await eventBus.publishEnvelope(event.userId, 'revision.card_created', payload, event.correlationId, event.schemaVersion);
  },
};

export function registerRevisionConsumers(): void {
  registerConsumer('dsa.submission.evaluated', struggleCardConsumer);
  registerConsumer('revision.card_created', revisionCardCreatedConsumer);
}
