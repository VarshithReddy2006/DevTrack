import { registerConsumer } from '../../shared/events/consumerRegistry.js';
import type { InterviewTurnAnsweredPayload } from '../../shared/events/eventContract.js';
import { QueueNames } from '../../shared/jobs/types.js';

/**
 * Routing only: the outbox relay delivers `interview.turn.answered` to the interview-score
 * queue, where the score worker reads the event payload (see unwrapScoreJob). It lives in its
 * own file so the relay can import it without loading the LLM gateway.
 */
export function registerInterviewTurnAnsweredConsumer(): void {
  registerConsumer<InterviewTurnAnsweredPayload>('interview.turn.answered', {
    name: 'interview.score', pool: 'ai', queue: QueueNames.INTERVIEW_SCORE, dedup: 'natural',
    handle: async () => undefined,
  });
}
