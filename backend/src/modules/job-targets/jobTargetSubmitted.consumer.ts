import { registerConsumer } from '../../shared/events/consumerRegistry.js';
import type { JobTargetSubmittedPayload } from '../../shared/events/eventContract.js';
import { QueueNames } from '../../shared/jobs/types.js';

/** Routing metadata is safe to import in the relay; Chromium stays in ai/all. */
export function registerJobTargetSubmittedConsumer(): void {
  registerConsumer<JobTargetSubmittedPayload>('jobtarget.submitted', {
    name: 'jd.fetchSubmitted', pool: 'ai', queue: QueueNames.JD_FETCH, dedup: 'natural',
    handle: async event => (await import('./workers/jobTargetFetch.worker.js')).processJobTargetFetch(event),
  });
}
