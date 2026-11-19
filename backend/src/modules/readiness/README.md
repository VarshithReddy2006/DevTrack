# Composite readiness score

`GET /api/v2/readiness/score` requires the existing authentication middleware and
scores only the authenticated user. The response uses the standard success/data
envelope, `Cache-Control: private, no-store`, a 0–1000 scale and scoring version
`composite-v1`. The existing 0–100 snapshot engine and its response stay unchanged.
The shared readiness router also exposes the score on the v1 and deprecated
unversioned aliases.

## Deterministic formula

Overall = round(30% DSA + 25% system design + 25% projects + 20% interview).
Each dimension is rounded to an integer before applying the overall weights.
These normalization references are explicit initial heuristics, not calibrated
cross-platform percentiles or a prediction of hiring outcomes.

- DSA = 60% difficulty + 25% contest rating + 15% revision. Difficulty is
  `min(1000, 2 * (easy + 2*medium + 3*hard))` from the stored DSA snapshot.
  Rating is `min(1000, bestRating / 3000 * 1000)`, taking the latest valid
  participated rating per supported platform within 180 days, then the best
  of those ratings. Revision is
  `1000 * min(reviews/20, 1) * (1 - lapses/reviews)` across the existing seven
  UTC calendar-day buckets, including today; no reviews contributes zero.
- System design = 10 times (40% architecture sophistication + 35%
  infrastructure sophistication + 25% deployment evidence).
- Projects = 10 times (40% project credibility + 30% repository quality +
  20% contribution consistency + 10% documentation quality).
- Interview = 10 times the mean of four 0–100 rubric dimensions, averaged over
  at most ten most recent unique, owned, completed AI sessions within 30 days.
  Basic-mode, foreign, future, malformed and stale reports do not count.

Design and project inputs reuse the existing stored project-intelligence
summaries from verified projects, including infrastructure/Docker/topology,
commit, test-presence and documentation signals. This endpoint does not verify
repositories again or measure test coverage; repository quality is a proxy.
DSA/project summaries older than seven days are excluded. Invalid, future or
missing evidence awards zero; unavailable weights are never redistributed.

Interview report storage is not present on main yet (#347/#443).
`readinessScoreSources.loadInterviewScores` is the explicit adapter seam for
that storage. Its default returns `null`, so the production response marks
interview evidence `unavailable`, awards zero interview points, and currently
has a maximum overall score of **800**. Adapter errors propagate as failures
rather than being reported as absent evidence. Tests supply reports through
this seam; there is no live interview integration in this change.

`evidence` reports status, observation time and notes for each dimension.
`completeness` measures weighted input availability, not confidence or skill:
DSA has 60/25/15 availability for its three inputs; the other dimensions have
100% availability when their required valid source is present. `isDegraded`
is true below 100%; `missingDimensions` lists dimensions without available
evidence. Valid zero-valued evidence may be complete while earning no points.

## Storage and cache

Every successful cache-miss calculation first persists a `ReadinessSnapshot`
with the full response/provenance. There is one latest observation per user,
UTC Monday-start week and scoring version. A deterministic `_id` fences
concurrent first writes; guarded upserts prevent older observations replacing
newer ones. A compound unique index also covers user/week/version. This is
on-demand weekly history: inactive weeks are not backfilled, and there is no
scheduled capture or new history endpoint. Existing v1 history is separate.

Redis caches each user/week/version for one hour through the existing bounded,
fail-soft cache manager. Source updates may take up to one hour to appear.
Responses are validated for owner, version, range, arithmetic, evidence
consistency, age and UTC week before reuse. Incompatible cache entries are
invalidated and rebuilt. Redis outages fall back to Mongo; source/history
failures fail the request and do not fill the cache with fabricated results.
The existing cache manager coalesces concurrent fills within each API process.

## Validation

`readinessScore.test.ts` exercises candidate levels, invalid/stale/missing
evidence, interview sampling, real Mongo source scoping and history races,
Redis command-boundary fixtures, authentication routing, and legacy snapshot
compatibility. Redis fixtures exercise TTL, generation and outage behavior;
they do not establish live Redis interoperability or production latency.
