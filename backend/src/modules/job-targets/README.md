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

# Job target fetching

`jobtarget.submitted` is routed by the existing outbox relay to `jd-fetch` in
the `ai` / `all` worker role. Run the `xp` role as well: it owns that relay.
The worker loads the owned target from MongoDB; URLs in event payloads are ignored.
Pasted text bypasses network and browser work. URL targets use the existing
SSRF-safe static fetch and cleaned main/article/body text. Fewer than 150 words
triggers a sandboxed Chromium fallback. Successful text is bounded to 50,000
characters, persisted as `ready`, and submitted to the existing `jd-parse` queue,
which already queues `jd-score` after parsing.

The fetch worker implements retrieval, not the unfinished storage integration of
those downstream workers. Main's `JobTargetPort` still defaults to an unwired
adapter; a working registered parse/score storage adapter is required for end-to-end
ATS results. Fetching and queue handoff can run independently of that adapter.

## Browser isolation and limits

- Chromium's sandbox stays enabled. Startup fails if the host cannot support it;
  there is no `--no-sandbox` fallback. Supply a compatible Puppeteer Chromium binary
  and its OS dependencies in the ai worker deployment. The existing generic backend
  Docker image is not a verified scraper deployment.
- Chromium uses a pipe for DevTools, a dead fixed HTTP proxy with loopback bypass
  disabled, disabled QUIC and nonproxied WebRTC, and failed browser DNS resolution.
  It never uses `request.continue()`. Allowed GET document/script/style/XHR/fetch
  requests are fulfilled by Node's `safeFetch`, which checks every DNS answer and
  pins the socket to a vetted address. Browser redirects are returned manually so
  their next request is intercepted and screened again.
- An enforced response CSP blocks frames, workers, objects, forms, popups and
  downloads. Service workers and cache are bypassed. Non-HTTP protocols and
  nonstandard subresource ports are refused. Other methods/resources are aborted.
  No upstream cookies, authorization or browser request headers are forwarded;
  public cross-origin GET responses are readable through wildcard CORS. This is
  an unauthenticated public-page renderer, not a user browser session.
- Rendering has one 10-second deadline covering its initial fetch, launch,
  navigation and extraction. Cancellation reaches pending Node sockets; DNS waits
  are bounded too. Cleanup has separate bounded waits, closes the page and browser,
  and kills the owned browser process if graceful close fails. Each render starts
  a disposable browser; one fetch job runs at a time per ai worker process.
- The initial response and subsequent intercepted responses share a 5 MiB budget;
  initial HTTP redirect responses are individually bounded by safeFetch. At most
  100 subsequent requests are admitted. Encoded bodies are refused to avoid
  decompression bypasses. Rendered text also has a 5 MiB check. The JavaScript heap
  is constrained, but these byte limits are not a total Chromium RSS limit; deploy
  with normal process/container memory and egress limits as additional containment.
- A Redis Lua sliding window uses Redis server time and atomically admits at most
  three render attempts per user per 60 seconds, shared across processes. The
  reservation happens before browser launch and fails closed on Redis failure.

Blocked targets and payload violations are permanent fetch failures; transient
network, timeout, rate-budget and queue failures can be retried through the existing
worker/DLQ policy. Persisted failure reasons are codes rather than fetched content.
Text is saved before queue handoff, so a handoff retry reuses saved text. Parse jobs
use a stable target-based id and retain completion for one day (up to 1,000 jobs);
this is bounded queue deduplication, not a permanent exactly-once guarantee.
Deleting a target prevents subsequent owned writes from recreating it.

## Validation

Run `npm run test:job-fetch` and `npm run build` from `backend/`. The focused suite
uses fixture transports and mocked worker adapters, an owned temporary MongoDB
for persistence/ownership/deletion/queue-retry checks, and actual sandboxed Chromium
for JavaScript rendering, redirects and SSRF refusal. It does not contact live job
boards or require a shared MongoDB/Redis server. GET-only access, discarded cookies,
the CSP, payload budgets, unsupported encodings, bot protection and login walls can
prevent some real job boards from rendering; failures remain explicit.

The ordinary backend unit suite includes the mocked browser/worker checks. The
dedicated `test:job-fetch` command additionally runs the actual-browser and owned
MongoDB checks under `tests/`; it requires a working sandboxed Chromium installation.
