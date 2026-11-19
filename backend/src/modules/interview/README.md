# Post-interview rubric reports

The `ai` / `all` worker pool consumes the `interview-evaluate` queue. Jobs are named
`interview.evaluate` and contain only `{ sessionId }`. Candidate transcripts remain
in MongoDB, rather than being copied into Redis jobs or dead-letter payloads.

The evaluator reads the complete staged dialogue, separately collected candidate
code, interviewer feedback, and actual elapsed seconds when available. It requests
four integer scores (0–100): problem solving, technical communication, code
correctness/edge cases, and time/space complexity. Each contributes 25%; the server
computes the rounded arithmetic mean. These dimensions are separate from the older
system-design scorecard and do not change its API or scoring semantics.

Each model dimension requires a rationale and at least one exact, nonblank quote
from the cited candidate answer or submitted code at the cited zero-based turn
index. Quotes from interviewer feedback, invented text, invalid indices, and invalid
scores are rejected. Reports include strengths, actionable improvements, a model
answer and an optimal approach. The LLM uses the central gateway and interview quota
with prompt caching disabled. All transcript fields are bounded and fenced as data.
The accepted input is at most six turns, 8,000 characters per question/answer/feedback,
and 16,000 per code snippet; oversized input fails rather than silently dropping turns.
Code is reviewed as text; it is never executed. Citation matching establishes textual
provenance, not the correctness of the model's judgement.

Malformed responses receive one additional attempt. Missing providers, quota/provider
errors, invalid reports after retry, empty answers, or a pre-existing `basic_mode`
session produce an explicitly unevaluated `basic_mode` report. Its scores are zero
sentinels, its rationale says “Not evaluated”, and its citations are empty. It does
not invent competency measurements, strengths, quotations or model solutions. Consumers
must check `mode` before displaying scores or aggregating them into readiness.

## Completion integration

`interviewScore.worker.ts` calls `enqueueCompletedInterview` after a successful
final compare-and-set, using a fresh completed snapshot from its storage port.
A retry of that exact final job also attempts the handoff when the persisted session
is completed with the expected incremented version and final turn. Nonfinal, stale,
abandoned and expired results do not create evaluation requests.

The production `InterviewSession` model/routes/port adapter from #347 are still
absent on main. The existing interview-score consumer is also not registered in
the worker runtime until that adapter exists. This change registers the evaluator
consumer but does not fabricate that separate session service. Consequently the
deployed end-to-end session completion flow remains dependent on #347.

For atomic completion, the future adapter must call
`stageInterviewEvaluation(completedEvaluationInput(snapshot), mongoSession)` in
the same MongoDB transaction as its final session update. The snapshot must contain
the final stored reply, final mode, all turns, any candidate `code`, and measured
`durationSeconds` (otherwise null). The score-worker post-commit call queues that
same source. A timeout-completion producer such as #442 must use this same staging
API. Neither this helper nor the queue is exposed as a client HTTP endpoint.

The fallback post-commit path cannot close a crash between the session write and
source staging after all original job retries are exhausted. Atomic staging in the
owning adapter is required to eliminate that gap. Requests staged inside an aborted
transaction are rolled back. Source hashes are canonical SHA-256 integrity checks,
not signatures or proof of interview quality.

## Persistence and delivery

`InterviewEvaluationRequest` retains an immutable input snapshot and hash, plus
mutable processing/delivery state. The first source per session wins; conflicting
owners or transcripts are rejected. Worker startup explicitly creates the schema's
unique session indexes before consuming. Deploy those indexes before starting any
completion producers; remove conflicting legacy rows before provisioning if needed.

`InterviewReport` is insert-only through normal Mongoose APIs: existing document
saves (including skipped-validation saves), query updates, replacements and bulk
writes are refused. A unique session index selects one canonical report even under
redelivery. Reports have owner/session ids, source hash, timestamp, rubric version,
model/mode and complete rubric output. Administrative deletion remains available
for erasure; raw driver/database access can bypass application immutability. Both
requests and reports retain sensitive interview content and need the application's
normal access controls, retention and account-erasure integration when #347 lands.
No public report-read endpoint or frontend report rendering is added here.

A five-minute database lease serializes ordinary concurrent processing. Late model
results are fenced once that lease expires. Startup and a nonoverlapping 60-second
cursor scan requeue undelivered, unlocked requests, covering enqueue failures and
worker crashes. Evaluation failures release the lease. The shared retry/DLQ worker
is retained; removed failed jobs can be requeued by the durable recovery scan.

After saving the immutable report, the worker publishes owner-scoped
`interview.report_ready` with `{ sessionId, reportId, mode }` through the existing
SSE bus. Successful publication records `deliveredAt` on the request. A notification
retry reuses the saved report without calling the model again. This is at-least-once
publication: a crash between SSE publication and the delivery marker can repeat
the same report id. Consumers should deduplicate by report id. Publication is not
a browser-receipt acknowledgement; existing Redis/pub-sub availability and process
local fallback limitations still apply.

## Validation

Run `npm run test:interview-evaluation` in `backend/`. The stateless suite verifies
scoring, complete prompt inputs, citation validation, limits and explicit degradation.
The pipeline suite provisions its own temporary MongoDB replica set, tests atomic
staging/rollback, source ownership, immutable reports, concurrency, retries, recovery
and lifecycle. Its small WiredTiger journal configuration limits temporary disk use.
It refuses an inherited `MONGODB_URI` and never connects to application databases.
AI, Redis queues and SSE publication adapters are fixtures in that suite. Existing
interview-score, prompts, question-bank, checklist, SSE and worker-runtime regressions
cover the completion handoff and owner-scoped event envelope. Live providers,
deployed Redis/BullMQ and a complete authenticated interview flow require separate
deployment verification after the owning session adapter is available.
