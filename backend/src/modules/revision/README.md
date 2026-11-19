# Revision analytics

`GET /api/v2/revision/analytics` requires the existing Bearer authentication.
The same endpoint is available under `/api/v1/revision/analytics` (and the legacy
`/api/revision/analytics` alias). It returns `{ success: true, data }`, where data
contains `asOf`, `totalCards`, `cardsDueToday`, `retentionPercentage`, `mastery`,
`patterns`, and `forecast`. All percentages range from 0 to 100.

Model assumptions:

- Retention is `100 * exp(-elapsedDays / max(1, intervalDays))`. SM-2's current
  interval is a stability proxy, not a fitted psychological estimate. Elapsed
  time uses the last review or creation for never-reviewed cards, clamped to zero
  for future timestamps. Overall retention weights each card once.
- Mastered means interval strictly greater than 21 days. Of the remaining cards,
  zero repetitions means learning; positive repetitions means reviewing.
- Patterns use trimmed, deduplicated tags; cards without tags use `untagged`.
  Multi-tag cards count once in each corresponding pattern. Struggle rate is the
  percentage of cards that have been reviewed but currently have zero successful
  repetitions (the available SM-2 reset signal). It is not a historical failure rate.
- Today and the 14-day forecast use UTC calendar days, including today. Due today
  includes overdue cards and cards due later today. Snoozes postpone effective due
  time. Overdue cards appear in today's forecast bucket. The forecast counts each
  current scheduled review once; it does not predict subsequent ratings/reviews.
- Redis stores each user's snapshot for 600 seconds with a UTC date-scoped key.
  Changes may take up to ten minutes to appear; `asOf` identifies snapshot time.
  The shared cache handles command timeouts, concurrent fills, corrupt JSON, and
  Redis outages by falling back to MongoDB. HTTP responses are private/no-store.

The aggregation matches the indexed user ID before calculating metrics and returns
bounded summary/forecast results plus one row per tag. The issue's 100ms target
depends on card volume, index readiness, hardware, and Redis health; local timing
is not a production latency guarantee.

From `backend/`, run `npm test -- src/__tests__/modules/revision/revisionAnalytics.test.ts`
and `npm run build`. Tests use an owned temporary MongoDB and a deterministic Redis
command fixture; they do not require live credentials or production data.

## Prioritized daily queue

`GET /api/v2/revision/queue?limit=20&pattern=dynamic-programming&difficulty=hard`
returns `{ success: true, count, data: [...] }`. The v1 and legacy `/api` aliases
also work. Authentication and the shared API rate limit apply. Responses are
private/no-store and read current MongoDB state rather than a cached queue.

Only cards belonging to the authenticated user with `dueAt <= now` and an expired
or absent snooze are eligible. The scheduler uses `dueAt`; the issue's suggested
`nextReviewAt` does not exist. The existing `{ userId: 1, dueAt: 1 }` index supports
the initial match, so no new scheduling field or index migration is needed.

Ranking assumptions resolve the issue's competing ordering requirements:

- Score is fractional days since `dueAt` multiplied by `2.5 / easeFactor` and
  `tagWeight`. A lower ease factor and higher weight increase priority.
- To honor the explicit request that today's due cards precede overdue easy
  cards, overdue easy cards form a second tier. Within each tier, score descends;
  due date then card ID break ties deterministically. Thus the ordering is not
  globally descending score across that exception. Today uses UTC midnight;
  cards due later today remain ineligible until their scheduled time.
- `tagWeight` is a per-card weighting input (0.1–10), neutral at 1 for newly
  generated and legacy cards. No topic importance hierarchy or user preference
  API is assumed. The current card generator uses the neutral default.
- Display retention uses the same SM-2 interval stability proxy as analytics.
  It is an estimate; the requested priority formula is the ranking heuristic.
- Estimated review times are fixed planning estimates: easy 5 minutes, medium 10,
  hard 15. They are not learned from user timing data.

Each card includes its ID, problem key, title, difficulty, tags, selected/first
pattern, due time, review sequence, fractional days overdue, effective weight,
score, tier, retention percentage and estimated review minutes. `pattern` filters
an exact stored tag (including tags after the first); `difficulty` is an enum.
The limit defaults to 20 and caps at 50. Invalid, fractional, repeated or
nonpositive limits and malformed filters return 400. Unknown query keys are ignored.

The calculated ranking must examine matching due cards before selecting the best
batch. The index narrows candidates and MongoDB coalesces sort/limit; the 50ms
target still depends on candidate count, hardware and database health. Local
all-cards-due benchmarks exceeded 50ms at both 10,000 and 50,000 cards, so the
issue's latency target remains unmet. Benchmarks are observations, not a
production guarantee. Run
`npm test -- src/__tests__/modules/revision/revisionQueue.test.ts` for calculation,
filtering, privacy, boundary and 10,000/50,000-card performance checks.

## Struggle-triggered cards

Platform submission persistence now queues a `dsa.submission.evaluated` outbox
event containing only `submissionId`. The revision consumer loads the owned
submission and problem from MongoDB, rather than accepting a producer-supplied
failure count, title, or problem key. It creates/promotes a card for:

- Three or more ingested failed attempts in the current attempt window. The
  window ends at this submission's timestamp and starts after the preceding
  successful acceptance for that user/platform/problem. The third failure can
  trigger before an eventual acceptance; late/out-of-order events use submission
  time, not ingestion order. Timestamps with identical provider precision share
  a boundary; no finer ordering is invented.
- An accepted submission whose provider-supplied `runtimePercentile` is strictly
  below 25 (including zero). Milliseconds are not interpreted as a percentile.
- Any Time Limit Exceeded submission (`time_limit_exceeded`).

New cards are due one day after processing, with interval 1, initial ease 2.5,
zero repetitions/review sequence, tag `struggle_topic`, and `tagWeight` 2. The
existing queue uses that weight in its overdue ranking; due-time eligibility and
the existing overdue-easy tier remain unchanged. This does not make a future-due
card immediately eligible. Existing cards gain the tag/topic tags and at least
weight 2, without resetting ease, repetitions, interval, review sequence, due
date, snooze, title, or difficulty. Higher existing weights are preserved.

Canonical problem keys use the existing problem identity. Legacy external-ID and
Mongo-ID keys are checked before upserting, so a known existing card is reused.
The existing unique `{ userId, problemKey }` index and transactional upsert dedupe
concurrent/repeated events. Arbitrary manually chosen keys that cannot be mapped
to a problem are not automatically merged.

## Delivery and deployment

Run both `sync` and `xp` worker pools (or `all`). The existing domain outbox relay
registers these consumers on `domain-readiness` in the **xp** pool, along with
the existing readiness consumers. No separate broker or worker role is added.
`readiness` alone does not run this queue. MongoDB must support transactions
(replica set/sharded cluster); there is no non-transactional fallback.

Submission persistence and its evaluation handoff are separate steps. The whole
batch is admitted before any of its evaluations are published, since providers
often return newest first. A transaction sets `revisionEvaluationQueued` and
writes the evaluation outbox row together. If the process stops or the write fails
after the submission insert,
replaying/resyncing that submission repairs the missing handoff. Already queued
submissions do not create another event. This also permits legacy submissions
with no marker to be evaluated when seen on a later sync; it is not a standalone
historical backfill job. Existing submission counters/heatmap side effects retain
their existing behavior and are not repaired by this marker.

Card creation and `revision.card_created` outbox insertion share another
transaction. A failed outbox write rolls back a new card. The event is relayed
back through the same queue, checked against the card owner, and forwarded via
the existing SSE envelope/stream API. Its payload has `cardId`, `problemKey`,
`title`, and `reasons` (`failed_attempts`, `low_runtime_percentile`, and/or
`time_limit_exceeded`). Explicit delivery errors fail the consumer job for retry;
replayed jobs can emit duplicate notifications, so clients should deduplicate by
card ID. The existing Redis-disconnected fallback is process-local and may not
reach browser sessions on another process. The outbox does not guarantee browser
receipt. Existing cards are promoted without emitting a misleading creation event.

`PlatformSubmission.runtimePercentile` is optional, finite, and between 0 and 100;
it is stored on `DsaSubmission`. **The current public platform adapters do not
provide runtime percentiles**, so that trigger activates only when a trusted
adapter supplies the normalized field. Current public LeetCode ingestion exposes
accepted submissions only; failure/TLE triggers depend on available provider
history (such as Codeforces). Missing history or metrics are never fabricated.
This change does not add a public endpoint for user-asserted percentiles, inspect
private submission details, or change existing successful-solve card generation.

Run `npm run build` and
`npx vitest run src/__tests__/modules/revision/cardGenerator.test.ts` from
`backend/`. Tests use owned temporary MongoDB replica sets and a fixture queue
handoff. They exercise the actual persistence, relay routing, consumer dispatch,
transaction rollback/repair, thresholds, ownership, and review preservation.
Production Redis/BullMQ execution and an authenticated browser SSE session require
separate deployment verification.
