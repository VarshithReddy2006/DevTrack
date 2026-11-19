# Job target score consumption

`jobtarget.scored` v1 runs through the existing `domain-readiness` queue in the
`xp` worker pool. `registerReadinessConsumers()` also registers it for the outbox
relay. Run `xp` (or `all`) for relay and consumer delivery.

The envelope must have an event ID, an ObjectId user ID, and schemaVersion 1.
Its payload is:

```json
{
  "jobTargetId": "507f1f77bcf86cd799439011",
  "matchScore": 45,
  "missingSkills": ["PostgreSQL", "Docker", "Kubernetes"],
  "scoredAt": "2026-11-19T10:00:00.000Z"
}
```

Scores are finite percentages from 0 to 100. Missing skills are ordered by the
producer's priority, at most 50 nonempty strings of at most 200 characters each.
The consumer trims and deduplicates them case-insensitively, preserving the first
spelling/order. Unsupported or malformed events are logged and dropped.

In one inbox transaction, the consumer updates the owned `JobTarget` to
`completed`, stores the score/gaps/scoredAt/source event ID, and updates the
user's latest scored readiness context. A score below 60 flags its first three
distinct missing skills as advisory high-priority goals. Scores of 60 or higher
clear those goals. This does not mark any skill verified or change the candidate's
selected career role. Different targets retain their own scores; only the newest
score supplies the user's readiness context. Equal timestamps use lexical event
ID ordering for deterministic convergence. Deleted, foreign and older results are
ignored. Existing `submitted`, `fetching`, `ready` and `failed` states remain valid.

After commit, the consumer invalidates `cache:readiness-gaps:<userId>` with the
shared Redis generation fence and emits a user-scoped `jobtarget.updated` SSE
message containing the source event ID, target ID, `completed` status, score,
gaps, highPrioritySkills and scoredAt. The existing readiness-v2 snapshot includes
these advisory goals at `inputs.jobTargets.latestScore`. Reads use a five-minute
cache and fall back to MongoDB when Redis is unavailable. Invalidation failure
retries the consumer's post-commit work rather than acknowledging it.

## Retry and deployment boundaries

- MongoDB transactions and the existing unique `(consumer, eventId)` inbox index
  are required. There is deliberately no standalone partial-write fallback.
- Inbox rows are retained without a TTL. The target's score identity also fences
  duplicate or stale writes after inbox deletion. No new index/migration is needed
  for the additive model fields.
- A persisted 30-second publication lease prevents concurrent redelivery from
  publishing twice. Successful notifications are marked on the target, so ordinary
  retries do not notify again. Failed synchronous publication releases the lease;
  a crashed publisher's lease can be reclaimed. If the queue exhausts its existing
  retry budget before a lease expires, replay the job from the existing DLQ after
  expiration.
- MongoDB and SSE delivery cannot be committed atomically. A crash after publishing
  and before recording success can repeat the same SSE event ID. The shared bus
  performs best-effort Redis pub/sub and does not acknowledge browser receipt;
  reconnecting clients should read authoritative state. This is not exactly-once
  transport delivery or an offline notification inbox.

## Scoring producer integration

`jdScore.worker` now supplies **both** the existing `jobtarget.parsed` outbox input
and the new `jobtarget.scored` input to `JobTargetPort.completeScore`. Its adapter
must commit the score result and both outbox rows together. Keep the parsed event:
it supplies target role/requirements to the existing readiness consumer. The
scored event uses the deterministic score and taxonomy-based missing skills,
prioritizing mandatory gaps before other gaps; it does not invent experience gaps
or use the model's advisory fit estimate.

Current main still defaults `JobTargetPort` to the explicitly unwired adapter.
This issue adds the consumer and producer contract, **not** the separate candidate
input/storage adapter. Until that adapter is registered, production scoring jobs
still fail loudly and cannot produce either event. Tests cover the real inbox,
MongoDB projection, outbox relay and local SSE with a fixture producer; they do
not establish deployed end-to-end scoring or Redis pub/sub delivery.
The resume tracker now invalidates its target queries for `jobtarget.updated` as
well as the existing `jobtarget.parsed` event. The production API/storage adapter
must still map its stored result to the existing frontend report DTO (including
the UI's `ready` state and score dimensions).

Focused validation from `backend/`:

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
npm exec vitest run src/__tests__/modules/job-targets/jobTargetScored.test.ts
```
