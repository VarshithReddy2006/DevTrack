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
