# Evidence proof verification

Run `npm run worker:readiness` (or `all`) to process `evidence-verification` jobs.
Claim creation through ResumeIntelligenceService and ledger upserts enqueue explicit
proofs immediately. The worker also registers a durable 60-second sweep and a
startup catch-up job, repairing queue outages and discovering direct/legacy writes.
The sweep streams matching claims in batches of 100. It scans all potentially
verifiable claims; larger installations may need partitioning.

## Supported proof input

Use the existing `evidenceSources` field on an evidence claim:

```json
{
  "type": "github",
  "referenceType": "github_commit",
  "referenceId": "https://github.com/owner/repo/commit/<full-40-character-sha>",
  "metadata": {}
}
```

A GitHub-source claim may instead supply that full commit URL in `sourceUrl`.
Only HTTPS github.com commit URLs without credentials, query strings or fragments
are accepted. Repository-only links, certifications, focus/revision summaries and
unstructured prose do not provide a commit/solve proof and are left unchanged.
An explicit malformed reference is rejected. Multiple distinct references are
rejected as ambiguous; one verified source must not implicitly validate other
references on the same claim.

For DSA, use `type: "dsa"`, `referenceType: "dsa_problem"` or `"dsa_submission"`,
the corresponding local MongoDB id in `referenceId`, and
`metadata: { "platform": "leetcode" }` (or `"codeforces"`). Verification requires
an accepted submission owned by the candidate, on the same platform and an owned
problem. Empty and `manual:` external submission ids are excluded. This trusts the
existing local synchronization ledger; it does not contact either platform or
prove ownership of a newly linked platform account.

## GitHub trust policy

The verifier obtains a verified linked GitHub account id and verified emails from
Clerk using the stored user's Clerk id. It does not trust claimed emails, usernames,
or GitHub ids in evidence metadata. GitHub REST must report a public repository,
the exact requested SHA, a valid verified signature with nonempty signature/payload,
matching author **and committer** account ids, and author/committer emails in the
candidate's verified Clerk email set. Unsigned commits, another committer (including
web-flow signing), and unlisted noreply emails are conservatively rejected.

Requests only go to the fixed api.github.com origin, do not follow redirects, use a
10-second timeout and a 1 MiB decoded response limit. `GITHUB_TOKEN` is optional;
unauthenticated GitHub limits are much lower. Rate-limit headers produce a bounded
queue-wide BullMQ pause without consuming a job failure attempt. That pause also
delays local DSA jobs sharing the queue. Other provider, identity, auth, network and
signature-service errors remain retryable and do not mark a claim fraudulent.
Five ordinary failed attempts enter the existing DLQ flow. Permanent failed jobs
retain their queue ids until retention or explicit DLQ replay; sweeps do not bypass
that failure policy.

The signature authority is GitHub's REST verification attestation. This service
does not independently fetch trust keys or verify GPG/SSH signatures locally.
See [GitHub's verification fields](https://docs.github.com/en/rest/commits/commits#get-a-commit)
and [BullMQ manual rate limiting](https://docs.bullmq.io/guide/rate-limiting).

## Results and consistency

The existing public ledger status enum is preserved: pending inputs remain
`unverified`, successful proofs become `verified`, and rejected proofs become
`flagged` with a reason. `proofVerification.state` records the precise `verified`
or `rejected` decision. Flags from other moderation/verification systems are
preserved. No status migration is required.

An atomic conditional write stores the decision, receipt, success `verifiedAt`,
`verificationHash`, and notification-pending flag. The write matches the original
owner, content, proof fields, timestamp and moderation state. Concurrent decisions,
edits, deletions and stale jobs cannot publish a winning result for changed input.
`metadata.verificationAttempts` counts finalized decisions, not transport retries.

`verificationHash` is SHA-256 over canonical JSON of
`{ version: 1, userId, claimId, inputHash, receipt }`. Object keys use code-unit
ordering; array order is retained. `inputHash` binds the owner, claim id/text,
subject, source URL and evidence references/metadata. The receipt records the
specific proof scope and public source identity; it omits emails and raw signature
material. Signature/payload hashes are hashes of their canonical JSON strings.
The hash is an integrity digest, not a secret MAC or an independent signature.

The attested scope is **signed commit authorship** or **an accepted problem
submission**. It does not prove arbitrary narrative claims, implementation quality,
solved-problem counts, performance metrics, or algorithm correctness. Proofs are
point-in-time checks; account/key changes and subsequent DSA sync do not invalidate
or automatically recheck an unchanged finalized claim. Change the input revision
to request a new check. Raw/lean database consumers must compare the stored input
hash before trusting an attestation. Public document JSON hides stale success
fields and reports `unverified` after content changes, while asynchronous repair
catches up.

Removing a proof from a previously attested claim also queues retirement of the
old stored hash/status, even if the write bypasses the normal creation services.
Such claims return to `unverified` with zero proof confidence. External moderation
flags are preserved, including during stale-result serialization.

After persistence, `evidence.verified` is published privately to the user's SSE
channel. Failed delivery retries from the stored receipt without fetching GitHub
again. Delivery is at least once: clients can deduplicate by claim id/inputHash.
The existing process-local SSE fallback during Redis outages cannot guarantee
cross-process browser receipt; this change does not replace that transport.

## Architectural profile

Once a GitHub commit proof is verified, the worker queues an `analyze-architecture`
job on the same queue (job id `architecture-<claimId>-<inputHash>`; the 60-second
sweep re-queues verified commit claims that have no profile for their current
input). `../dependencyAnalyzer.service.ts` reads the repository at the verified
commit through the same `githubJson` client: the repository, one recursive tree
(the top level only when the tree passes the 1 MiB limit), and up to eight
manifests (`package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`,
`Cargo.toml`, `pom.xml`, at most two directories deep, vendored, example and
fixture folders skipped) through the contents API. It parses them with
`../intelligence/manifestParsers.ts`.

The 0-100 score adds framework 20, ORM 15 (a driver alone 10), test library or
built-in test runner 20, test files present 15, lint/type tooling 10, CI 10 and a
Dockerfile or compose file 10. Each package from the curated deprecated/insecure
list (for example `request`, `node-sass`, `pycrypto`, `github.com/dgrijalva/jwt-go`,
`log4j:log4j`) takes 5 off, at most 20. The result is stored in
`metadata.architecturalProfile` with the input hash it was computed for. The write
does not touch `updatedAt`, so it cannot break a pending verification
compare-and-set. A private or deleted repository gets `status: 'unavailable'`
with a reason instead of a score. The analysis reads dependency names, not
versions or lockfiles, so it does not resolve CVEs for specific versions or the
depth of the transitive graph. Its GitHub requests share the queue-wide rate
limit described above.

## Verification commands

Run `npm run test:evidence-verification` and `npm run build` from `backend/`.
The focused suite uses mocked Clerk/GitHub/queue/SSE boundaries and an owned
temporary MongoDB, never an application or shell database URI. It covers signature
and identity mismatches, malformed references, API backoff/failures, local ledger
ownership, concurrent decisions, stale edits, notification retries, automatic
enqueue, catch-up scanning and worker role/lifecycle behavior. Live providers,
Redis/BullMQ and cross-process browser delivery require deployment verification.
