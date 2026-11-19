# Post-contest rating reconciliation

The existing sync pool starts a `contest-rating-sync` BullMQ worker alongside
platform synchronization and contest refresh. Both the unified worker entrypoint
(`sync`/`all`) and the legacy `workers/worker-sync.ts` use that pool. Stop drains
the new worker before the runtime closes queues and database connections.

A startup sweep and repeatable 15-minute sweep discover scheduled Codeforces and
LeetCode contests whose stored `endTime` is at least two hours ago and no more
than seven days ago. The discovery query has a `{ kind, platform, endTime }`
index. Each contest is enqueued with a deterministic contest/hour job ID retained
for eight days. All linked users are reconciled inside that contest job, once per
hour at most, so delayed ratings, corrections, and newly linked handles can be
picked up during the seven-day window. This is not an older-history backfill.
No provider calls are made for contests without linked users. Only the configured
Codeforces `handle` or LeetCode `username` is used; the link is rechecked before
writing. Unsupported platforms and users who did not participate are skipped.

## Provider data and retries

Codeforces public regular-contest standings are fetched anonymously with only
`contestId`, in accordance with the [official API contract](https://codeforces.com/apiHelp/methods#contest.standings).
Full official standings and `contest.ratingChanges` are each fetched once per
contest, then indexed by handle locally. Practice, virtual, and out-of-competition
rows are excluded, and the contest must be `FINISHED`. Rank and points come from
standings; solved count is the number of positive-scoring problem results (which
can include partial-credit problems). Rating change is the provider's new minus
old rating. Full standings consume memory proportional to contest size.

LeetCode's public GraphQL `userContestRankingHistory` is fetched per linked user.
Attended entries are ordered by contest start time, and the exact scheduled start
time identifies the target contest. Before/after ratings come from the immediately
preceding attended entry and target entry, not the current aggregate profile.
Fractional deltas are rounded to six decimal places. The first attended contest
has no inferred baseline, so its delta is null. The endpoint does not provide a
contest score; that field is null. Missing/pending ratings remain null rather than
being represented as a zero change. An absent user/history, GraphQL errors, and
malformed responses fail the job instead of fabricating a result. This public
GraphQL interface is unversioned and can change.

Provider requests have a 20-second abort deadline covering body parsing, reject
redirects, and are spaced at least 2.1 seconds for Codeforces or 500ms for LeetCode
within each worker process. Worker concurrency is one. HTTP 429 honors numeric or
HTTP-date `Retry-After` by globally pausing the BullMQ queue and requeuing the job;
Codeforces application-level call-limit failures pause for one minute. Other
failures use five job attempts with exponential backoff starting at five seconds,
then the existing dead-letter mechanism. Hourly reconciliation provides later
opportunities within the bounded lookback. LeetCode failures do not stop other
users being processed before the job is failed for retry. Multiple processes may
still hit provider limits; a rate-limit response pauses the shared queue.

## Persistence and events

`DsaContestParticipation` stores user, scheduled contest ID, platform, handle,
rank, score, solved count, rating before/after/change, and observation timestamp.
A unique `{ userId, contestId }` index prevents duplicate history. Atomic writes
reject older observations, preserve previously published ratings when a later
response has no rating, and compare stored result fields so unchanged retries do
not produce duplicate events. The new collection is authoritative for this
reconciliation; existing legacy `DsaContest` participation rows are not migrated
or mirrored. No new history REST endpoint or browser UI is added.

Changed results emit `contest.rating_updated` through the existing SSE envelope
API, targeting only that user. Its payload includes `contestId`, `platform`,
`handle`, `rank`, `score`, `problemsSolved`, `ratingBefore`, `ratingAfter`, and
`ratingChange`. The existing Redis stream/replay and disconnected-Redis fallback
apply. Delivery is best effort after the database save, without a transactional
outbox: a crash or SSE failure after the save can lose that notification, while
the history remains saved. Clients can receive the event through the shared SSE
connection's generic event callback. Large linked-user lists make a contest job
long-running; per-user sharding is not implemented.

## Validation

Run from `backend/`:

```text
npm run build
npx vitest run src/__tests__/modules/contests/contestRatingSync.test.ts src/__tests__/modules/contests/contestRatingSources.test.ts
```

Tests use owned temporary MongoDB instances with mocked HTTP providers, queues,
and Redis. They cover positive/negative/zero and unavailable ratings, source
validation, idempotence and uniqueness, old observations, account changes,
provider downtime, Retry-After, sweep bounds, retries, and targeted events.
The existing platform-sync, contest-ingestion, worker-runtime, and SSE tests
provide regression coverage. A production Redis/BullMQ delivery and authenticated
browser smoke test require separate infrastructure; fixtures do not prove those
deployment paths.
