# Tiered quests

The backend allocates **three daily** quests (distinct solves, qualified focus
minutes, flashcard reviews) and **two weekly** quests (solves and focus minutes).
All periods are half-open UTC ranges. Daily periods start at midnight; weekly
periods start Sunday at midnight. The maintenance worker registers both UTC cron
schedules plus a retryable startup catch-up. Listing also allocates missing
current-period slots, so new users need not wait for midnight. Event consumption
allocates the slots of the day and week the activity happened in, not the time the
event is processed, so an activity at 23:59:55 handled after midnight still counts
for that day. Periods that closed 24 hours ago or earlier are not created after the
fact; events still credit any rows that already exist for them. Late progress does
not reopen the claim window.

Targets and rewards scale across the seven existing league divisions. A missing
current standing uses the last finalized promotion/demotion outcome, then bronze.
If the previous week's standing is still active and the new standing is absent,
generation for the running week returns a retryable 503 instead of freezing a tier
before rollover. Generation for a week that is already over is not blocked.
Already allocated slots retain their tier, target, and rewards throughout their
period. Unique indexes cover both user/definition/period and user/slot/period, so
a promotion cannot create extra reward slots.

For division index t (bronze = 0, grandmaster = 6), daily targets are 2+t distinct
solves, 30+10t focus minutes, and 10+2t reviews. Weekly targets are 10+5t solves and
150+30t focus minutes. Each daily quest awards 20+5t XP and one trophy; each weekly
quest awards 100+25t XP and 5+t trophies. Definitions have versioned keys; user
instances snapshot them. Trophy balance is the lifetime `UserXp.leagueTrophies`
counter. Existing weekly league rankings still use earned XP, including quest XP;
trophies do not replace the league's ranking or promotion rules.

## API

Both endpoints require the existing Clerk/local-user authentication and XP
limiter, and return private/no-store responses through the normal API envelope.
The existing v1 and deprecated unversioned aliases are also available.

- `GET /api/v2/quests`: returns `data.quests`, `data.leagueTrophies`, and
  `data.serverTime`. Each quest includes its cadence, title, division, kind,
  target/current count, start/expiry, rewards, completion and claim timestamps.
  The public `questId` is the owned **user-instance ID**; `definitionId` identifies
  the shared template.
- `POST /api/v2/quests/:questId/claim`: accepts an empty body. No client-supplied
  target, count, XP, or trophy override is accepted. Returns the credited totals,
  rewards, `claimed`, and an idempotent `duplicate` flag. Unknown/foreign instances
  return 404; incomplete or expired unclaimed instances return 409. An already
  committed claim can be retried after expiry without issuing another reward.

## Events and integrity

The XP worker pool's existing `domain-readiness` worker consumes the quest domain
events. Its existing transactional outbox relay also runs in the XP pool.
Maintenance/all registers generation schedules; xp/all processes progress,
notifications, and reward projections. No new worker pool or queue is required.

- Current platform ingestion already emits `dsa.submission.evaluated`; the quest
  consumer loads the owned accepted submission and counts the first accepted
  solve of that owned problem. Repeat accepts, failed submissions, old-period
  history imports, and future sources do not add current-period progress.
  `dsa.problem.solved` also accepts an internal problem ID, or a platform plus
  external problem ID, backed by the same stored accepted-submission evidence.
- `focus.session.completed` loads the owned completed session and applies the
  existing duration/completion/heartbeat qualification rules, without applying a
  second XP cap. It counts whole active minutes by completion time, including
  sessions whose ordinary focus XP hit its daily cap. Minutes are not split
  across midnight.
- Review submission now writes `revision.reviewed` inside its existing MongoDB
  transaction. Quest tracking verifies the owned card sequence and the committed
  source outbox record rather than trusting event-supplied time/counts. The
  `revision.card_reviewed` spelling is supported for compatible callers with the
  same committed review proof. Historic non-outboxed reviews are not backfilled.

Progress, source-identity dedupe markers, and `quest.completed` outbox rows are
written in one MongoDB transaction. Counters cap at the target. The dedupe key
includes the owned instance and source identity, not merely the envelope ID, so
renaming/replaying an event does not add progress. Claims go through the XP
processor and atomically update claim state, immutable manual/quest_<instanceId>
XP ledger, aggregate XP/level/lifetime earned XP, league trophies, analytics
totals, and a `quest.claimed` outbox row. No external effects occur inside these
transactions. MongoDB replica-set/transaction support and the new unique indexes
are required; there is no nontransactional quest fallback.

After commit, retryable consumers forward `quest.completed` and `quest.claimed`
through the owned-user SSE envelope path. Reward delivery also reconciles XP
analytics/cache/runtime projections and hands the immutable award to the existing
league scorer, whose natural award key prevents double scoring. Notification
delivery can repeat on retry; rewards cannot. Explicit delivery errors retry via
the outbox/worker infrastructure. The existing process-local SSE fallback during
Redis disconnection does not guarantee cross-process browser receipt.

Generation streams users in batches of 100 but processes them sequentially in one
maintenance job; large installations may require sharding. Expired instances and
source markers are retained for audit/idempotency; this change adds no historical
migration, public frontend drawer, or automatic purging policy.

## Validation

```sh
npm test --prefix backend -- src/__tests__/modules/quests/questEngine.test.ts
npm run build --prefix backend
```

The quest suite runs real Mongoose transactions on an owned temporary MongoDB
replica set, including competing claims and rollback failures. HTTP tests use a
fixture identity and limiter; Redis queues, cache/runtime projections, and browser
SSE delivery are mocked. These checks do not establish deployed BullMQ scheduling,
live Clerk authentication, real Redis delivery, or production throughput.
