# Interview lifecycle guard integration

Status: #347 has landed. `InterviewSession` (`db/models/interviewSession.model.ts`), the routes and
`InterviewService` bind this guard (`interview.service.ts`), and the runtime registers the guard
worker (`maintenance`) and the score worker (`ai`). The text below is the original integration
guide and still describes the contract. See `../README.md`, "Session lifecycle".

Issue #442 adds an executable guard service, session-schema extension, transactional
turn handler and bound maintenance-worker factory. The production `InterviewSession`
model and routes owned by #347 are absent from this base. No replacement session model,
unauthenticated route or silently unbound runtime consumer is registered here.

## Bind the owning session service

1. Apply `addInterviewGuardFields` from `../interviewGuard.schema.ts` before compiling
   the real session model. The owning schema supplies `_id` (ObjectId), `userId`
   (the authenticated local user id), `status`, `state` and `stateVersion`.
2. Create new sessions with server-owned `startedAt`, `lastActivityAt`, `turnsCount=0`
   and `maxTurns=6`. The extension adds these fields, durable delivery flags, close
   metadata and indexes. Backfill existing records before enabling the guard: schema
   defaults do not migrate persisted rows. Clients must not edit guard counters,
   timestamps, limits, delivery fields or terminal status.
3. Instantiate `InterviewGuardService(realModel, { evaluateCompleted })`. This requires
   a real compatible model and an explicit evaluation adapter; missing configuration
   fails rather than acknowledging evaluation without an implementation.
4. Use `createGuardedInterviewTurnHandler` from `../interviewGuard.http.ts` after the
   existing `authMiddleware` on the owning `/:sessionId/turns` route. Supply the owning
   answer validator and transactional answer writer. The handler reads ownership from
   `req.user.id`, never the body, and requires the client's nonnegative `stateVersion`.
5. The answer callback receives the updated session and the active MongoDB transaction.
   Write the answer and any scoring/outbox intent using that same transaction. The
   accepted state is `SCORING`, the version is incremented, and `turnsCount-1` is the
   newly accepted answer index. Do not perform Redis, model-provider or other external
   side effects inside the retryable MongoDB callback. A failed write rolls back the
   counter, activity time and state. The owning service advances the next planned
   question to `QUESTION_PENDING` through its usual versioned state transition.
6. Add a maintenance/all runtime loader that returns
   `createInterviewGuardWorker(boundGuardService)`. The factory creates one-minute
   BullMQ job scheduling with the shared retry/DLQ policy, performs startup catch-up,
   and drains its consumer at shutdown. Runtime retains ownership of shared queues
   and Redis cleanup. Replicas share a scheduler; stopping one does not remove it.

Those route/model/runtime bindings cannot be installed until #347 supplies the owning
implementation. The existing interview-score worker likewise still has no production
session adapter. This branch does not claim an operational end-to-end interview flow.

## Limits and lifecycle rules

Every accepted answer requires matching owner/version, `in_progress` status,
`QUESTION_PENDING` state, a start time strictly less than 45 minutes ago, and a count
below both the server's configured limit and the absolute six-turn ceiling. Counters
and versions increment atomically. A seventh answer returns HTTP 400 with
`turn_limit_reached`. Concurrent final-slot requests cannot exceed six; replaying an
accepted version cannot consume another slot. Completed/expired/abandoned sessions
are rejected, foreign or missing sessions return 404, and stale versions/states
return 409. Answer validation occurs before any reservation.

At elapsed minute 40, the guard records a durable pending warning and publishes
owner-scoped `interview.time_warning` with `{ sessionId, minutesRemaining: 5 }`.
Warnings do not bump `stateVersion` or invalidate an in-flight answer evaluation.
At elapsed minute 45, an active session becomes `completed`/`COMPLETED`, its version
increments, its close timestamp is recorded and evaluation becomes durably pending.
This invalidates stale scoring results. New turn reservations at or after the deadline
are rejected, including when time crosses it between reconciliation and a transaction retry.

For a late sweep, inactivity strictly greater than two hours takes precedence and
an `in_progress` session becomes `expired` instead, without evaluation. At exactly
two hours it is not classified as abandoned, although the 45-minute elapsed deadline
still completes it. This distinction handles missed sweeps during an outage. Already
terminal sessions are left unchanged. Activity is recorded on accepted answers;
the owning service must update `lastActivityAt` for any other activity it considers
meaningful, using server time and version-aware mutations.

Scheduled transitions and warnings occur on the next successful sweep (normally
within one minute), rather than an exact wall-clock interrupt. Requests enforce the
45-minute cutoff independently of the scheduler. Infrastructure outages can delay
background actions. When both limits are already passed, the inactivity rule above
determines the terminal status.

## Evaluation and notification delivery

Timeout completion sets `guard.evaluationPending` in the same atomic session update.
The required adapter must idempotently persist and enqueue evaluation keyed by the
session id. Once #443 lands, load the completed canonical snapshot through the owning
session port, map collected code and measured duration, then use its
`enqueueCompletedInterview` API. Do not hash transient guard lease metadata as part of
the evaluation input. This base has neither #443's producer nor #347's storage adapter,
so evaluation dispatch is tested through an injected durable-adapter fixture here.

A one-minute database lease suppresses ordinary concurrent warning/evaluation delivery.
Pending flags survive enqueue/publication errors and worker restarts. The next sweep
retries after lease expiry; expired warning windows are suppressed. A failing session
does not prevent other sessions in the sweep from progressing. The job reports an
aggregate error so the shared retry/DLQ path can observe failures.

Delivery is at least once. A crash after publication/queueing and before acknowledgement,
or work outlasting its lease, can repeat a delivery. Evaluation adapters and warning
consumers must deduplicate by session id; the adapter must not acknowledge a volatile
or no-op enqueue. The existing SSE bus is best effort during Redis outages and a
successful publish is not browser-receipt acknowledgement. Live model/Redis/BullMQ,
multi-process SSE and authenticated browser behavior remain deployment checks.

## Validation

`npm run test:interview-guard` runs an owned temporary MongoDB replica set, isolated
Express fixture and mocked queue/evaluation adapters. It refuses an inherited
`MONGODB_URI` and never clears application databases. Tests cover atomic counters,
transaction rollback, concurrent reservations/sweeps, version fences, clock boundaries,
owner checks, HTTP codes, failure/retry, abandoned-session cleanup and worker lifecycle.
The MongoDB fixture limits its temporary WiredTiger journal size. The dedicated config
avoids loading the repository's global database fixture a second time. Existing SSE
tests additionally verify owner-only warning envelopes on the real local event bus.
