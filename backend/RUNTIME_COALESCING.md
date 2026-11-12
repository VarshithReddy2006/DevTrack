# Runtime event coalescing

`unifiedRuntimeStateService.updateFromEvent(event)` groups concurrent events for one user into a fixed 500 ms window measured from the first event. XP deltas accumulate, committed absolute XP totals are monotonic, and focus/session fields follow input order. Each window performs one final runtime-state update and emits one SSE patch containing persisted absolute values. Missing/stale state can require an additional rebuild write.

The returned promise resolves after MongoDB acknowledges the flush. Dispatch a burst concurrently (then await `Promise.all`) to share a window; serially awaiting each call creates separate windows and retains the persistence acknowledgement contract. Events arriving during a slow flush are serialized behind it for that user. Other users have independent windows.

The buffer holds at most 10,000 queued or in-flight events across users and explicitly rejects overload. Payloads are cloned at admission. A failed write rejects every caller in its batch; it does not emit a success patch. SSE delivery failure after a committed write is logged without rejecting the committed operation.

Call `flushPendingEvents()` after producers/workers stop and before MongoDB/SSE/Redis disconnect. API orchestration and the standalone worker entrypoint perform this drain; a recorded write failure is surfaced during drain while shutdown still releases connections.

This is a process-local performance buffer, not a durable outbox. An abrupt process crash can lose events whose promises have not resolved. Separate service instances do not share windows or serialize each other's session updates. XP producers should continue supplying committed `newTotalXp` values; unversioned deltas are additive and are not deduplicated by event ID.

Tests: `cd backend` then `npx vitest run src/__tests__/modules/runtime-state/runtime-coalescing.test.ts src/worker-entrypoint.test.ts`. The real-MongoDB tests include a 50-event burst, ordered lifecycle transitions, new-user rebuilds, overlapping windows, independent users, immutable payloads, write failures, and shutdown draining.
