# Ops: anti-gaming review

`AntiGamingWorker` (daily, 03:00 UTC) flags a public profile when its suspicion score goes
above 70. These endpoints let maintainers look at a flag and decide on it. They are served on
`/api/v1/ops/anti-gaming/*` and `/api/v2/ops/anti-gaming/*`.

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /ops/anti-gaming/flagged?state=open&page=1&pageSize=20` | ops roles | Flagged profiles, highest score first, with the last 5 anti-gaming audit entries each. `state` is `open` (default), `confirmed` or `pardoned`. |
| `GET /ops/anti-gaming/:userId/breakdown` | ops roles | The inputs the verification engine scored, daily solves for 30 days with the most hard solves inside 10 minutes, XP peaks over the 7 day look-back (same windows and exclusions as the engine), GitHub commits per UTC hour for 90 days, the anti-gaming audit timeline and earlier decisions. |
| `POST /ops/anti-gaming/:userId/action` | admin | Body `{ "action": "pardon" \| "penalize", "note": "..." }`. The note is required. |

Ops roles are the ones `opsAuditorMiddleware` accepts (`admin`, `moderator`, `trust_operator`,
`readonly_auditor`).

## Decisions

**Pardon** clears `antiGaming.isFlagged` (badges and the dossier come back on the public
profile) and stores `antiGaming.review = { status: 'pardoned', flags, ... }`. The raw score is
kept. Profile rebuilds derive the flag in `applyAntiGamingReview`, so the next sweep leaves the
profile unflagged while its flags are a subset of the pardoned ones. A new flag re-flags it and
the sweep logs `flag_raised` and emits `profile.flagged` as usual. Once an audit comes back clean
the pardon ends, so a later episode needs a new review. A profile that is not flagged cannot be
pardoned.

**Penalize** confirms the gaming:

- XP earned from 7 days before the latest `flag_raised` entry up to now is taken off `UserXp`
  (level and `xpToNextLevel` are recomputed, the `UserAnalytics` copy follows). Manual admin
  grants are not touched. The `XpTransaction` ledger stays as it is.
- Derived badges are removed from the snapshot and stay removed on later rebuilds.
- `antiGaming.review.status` becomes `confirmed_gaming`, which keeps the profile flagged for good.

Penalize also works on a profile the sweep has not flagged (or one that was pardoned earlier), for
cases a maintainer finds by hand. A confirmed penalty is final: a second penalty or a pardon
returns `409 ALREADY_PENALIZED`.

## Audit trail

Every decision writes an `anti_gaming_pardoned` / `anti_gaming_penalized` entry to the audit
ledger through `appendChainedAuditEvent` (`triggeredBy: 'admin'`, with note, actor, flags and the
XP/badge changes in the encrypted details). `ProfileAuditLog` has a 90 day TTL, so the same
decision is also written to `AntiGamingDecision`, which has no TTL and rejects updates and
deletes made through the model. Both rows are written in the same transaction as the profile
change.

The review endpoints and the sweep read rows stored with a plain `userId` as well as chained rows
(matched by the salted subject hash). The sweep uses the latest scored check or decision as its
baseline, so it does not log a `flag_cleared` right after a pardon or a `flag_raised` right after
a penalty.

Account erasure deletes the user's `AntiGamingDecision` rows and shreds the audit key, which
leaves the chained entries unreadable.
