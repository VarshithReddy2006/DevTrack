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

The `InterviewSession` model, routes and the Mongoose `InterviewSessionPort` adapter
(`interviewSession.port.ts`) from #347 now exist, and the interview-score worker is
registered under the `ai` role. See "Session lifecycle" below.

For atomic completion, the adapter (`commitFinalResult`) calls
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

## Session lifecycle (`/api/v1/interviews`)

One `InterviewSession` document holds a 5 question interview (`db/models/interviewSession.model.ts`).
`stateMachine.ts` is the only place that decides which move is legal:

    START -> QUESTION_PENDING -> SCORING -> NEXT_QUESTION -> QUESTION_PENDING ...
                                        \-> FINAL_SCORECARD -> COMPLETED

Every mutation is one compare-and-set update on `{ _id, userId, stateVersion }` that also writes
the new state and bumps `stateVersion` by one. A request carrying an older `stateVersion` gets
HTTP 409 (`STATE_VERSION_CONFLICT`); an illegal move gets HTTP 409 (`ILLEGAL_STATE_TRANSITION`)
whose message lists the allowed events. A double click, or an answer sent while a hint is being
processed, therefore has exactly one winner. `NEXT_QUESTION` and `FINAL_SCORECARD` are collapsed
into the scoring commit (`SCORING -> NEXT_QUESTION -> QUESTION_PENDING` is one write, one version).

| Route | What it does |
| --- | --- |
| `POST /` `{ role }` | Start. 201. A user with an open session gets 409 `INTERVIEW_SESSION_OPEN` with the open session in `data.session`. |
| `GET /current` | The open session or `null`, for resuming after a reconnect. |
| `GET /:sessionId` | One of the caller's sessions (404 for anyone else's). |
| `POST /:sessionId/turns/:turnIndex/answer` `{ answer, code?, stateVersion }` | Accept the answer (202). Uses the lifecycle guard's turn reservation and writes the answer and the `interview.turn.answered` outbox event in one MongoDB transaction. |
| `POST /:sessionId/turns/:turnIndex/hint` `{ stateVersion }` | Reveal the next hint of the current question. Counts as a mutation (version + 1). |
| `POST /:sessionId/finish` `{ stateVersion }` | Leave early (`abandoned`). Not allowed while an answer is being scored. Idempotent once closed. |

Clients only ever see the prompts up to the current question, the hints they asked for, the
feedback and the scorecard; the checklist and unrevealed hints stay on the server.

`isOpen` is true exactly while `status` is `in_progress`; the partial unique index
`uq_interviewsessions_open_per_user` on `{ userId, isOpen }` allows one open session per user,
including under simultaneous start requests. Model middleware clears `isOpen` (and refreshes
`retainUntil`, the 365 day TTL) for any update that sets a non-`in_progress` status, so the
lifecycle guard's updates release the slot too. Production runs with Mongoose autoIndex off:
run `npm run migrate:interview-sessions --prefix backend -- up` first.

The outbox relay delivers `interview.turn.answered` (`{ sessionId, turnIndex, stateVersion }`) to
the `interview-score` queue, so a crash after the answer commit cannot lose the scoring job. The
score worker accepts that event envelope as well as the bare job data. The `maintenance` role now
runs the guard worker with `InterviewService.sweep()`: sessions idle for more than 24 hours are
closed as `abandoned` first, then the guard applies its 40/45 minute and 2 hour inactivity rules
(a session idle for 2 to 24 hours is therefore `expired`, not `abandoned`).

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
normal access controls, retention and account-erasure integration.
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
