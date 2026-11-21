# Submission projection recovery

Platform sync now admits each submission, projects problem counts and replaces
the day's imported-submission activity bucket in one MongoDB transaction.
MongoDB must support transactions (replica set). There is no nontransactional
fallback. Duplicate-key races restart a fresh transaction.

Replaying an existing submission also reconciles its projections from admitted
source rows. It preserves manual problem titles, notes, favorites and every
non-submission daily activity bucket. Accepted source evidence can promote a
problem to solved; replay does not demote a manually solved problem.

Revision evaluation stays outside the transaction. Its existing transactional
outbox/queued flag remains responsible for idempotency; replay repairs a failed
handoff. A failed batch may have committed earlier submissions, which are safe
to replay.

## Historical repair

From backend, with an explicitly selected MONGODB_URI in the operator environment:

```powershell
npx tsx src/scripts/repair-submission-projections.ts --user-id <ObjectId> --limit 25
```

This is a read-only candidate preview. Review it, then add --apply to reconcile
that page. Pass the returned nextCursor as --after-id for the following page.
The maximum page is 100; --platform leetcode or --platform codeforces narrows
selection. No .env is loaded, and no credentials are printed. The report contains
scanned/repaired/failed counts and owned source IDs. Failed source IDs can be
retried on their original page. Repair never creates synthetic submissions.

Daily boundaries use the existing getStartOfDay server-timezone convention.
Run historical repair in the same configured timezone as the original service;
this change intentionally does not migrate date bucketing.
