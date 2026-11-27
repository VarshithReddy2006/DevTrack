# Tamper-evident ProfileAuditLog

`ProfileAuditLog` is a hash chain. Every row stores its position and the hash of the row
before it:

```
recordHash  = sha256(sequenceNumber | previousHash | chainTimestamp | subjectHash | eventType | payloadHash)
payloadHash = sha256(canonical JSON of { userId, triggeredBy, details, encryptedDetails,
                                         suspicionScoreBefore, suspicionScoreAfter, createdAt })
```

For an `ACCOUNT_ERASURE_TOMBSTONE` the payload is its `details`. Verification recomputes
`payloadHash` from the stored fields, so editing, deleting or inserting a row breaks the chain
at a specific sequence number.

- `auditChain.service.ts`: the pure helpers (hashing, encryption, `verifyAuditChain`, `merkleRoot`).
- `auditLedger.service.ts`: appending, per-user keys, reading rows back.
- `auditCheckpoint.service.ts`: daily checkpoints and `verifyAuditIntegrity`.

## Writing and reading

All writers go through `appendChainedAuditEvent(input, session?)`: the anti-gaming sweep, focus
entropy and league sniping checks, profile publish/unpublish and dossier downloads. Rows hold a
salted `subjectHash` instead of the user id, and the details are encrypted with the user's key,
which account erasure destroys.

To read one user's rows use `auditRowsFor(userId)` as the query filter (it also matches rows
written before the chain, which have a plain `userId`), and `decryptChainedAuditEvent` for the
details.

Two writers that read the same tail collide on the unique `sequenceNumber` index. With a caller
session the row commits or rolls back with the rest and MongoDB reports the collision as a
write conflict, which `withTransaction` retries on the new tail. Without one the append re-reads
the tail and tries again. A fixed `_id` makes the call idempotent, which the sweep uses for its
one-entry-per-day rows.

Rows written before this change have no `sequenceNumber`; they are not part of the chain and
expire with the TTL. Hashing a row is well under 1 ms (the test checks the average over 2000
rows). The cost that matters is that audit writes are serialized by the chain tail.

## Checkpoints and the 90 day TTL

Rows expire after 90 days, which deletes the start of the chain. The maintenance worker runs
`seal_audit_checkpoint` at 00:30 UTC and stores an `AuditCheckpoint` for the previous UTC day:

- the sequence range (`fromSequence`..`toSequence`) and record count
- `anchorHash` (hash of the row before the range) and `lastRecordHash`
- the Merkle root of the range's record hashes
- `previousCheckpointHash`, so checkpoints form their own chain, and `checkpointHash`
- `signature`: HMAC-SHA256 of `checkpointHash` with `AUDIT_CHECKPOINT_SECRET`

A day is only sealed after its range verifies against the previous checkpoint. Checkpoints have
no TTL and reject updates and deletes made through the model. A day without rows still gets an
(empty) checkpoint.

## Verifying

`verifyAuditIntegrity(fromSeq?, toSeq?)` returns `{ ok, checked, brokenAt, reason, ... }`.

Without a range it checks the checkpoint chain (hashes, links, signatures), then walks every
row from the oldest checkpoint whose day is fully inside the TTL window to the newest row. Rows
before that may have expired and are not reported. It fails with:

| reason | meaning |
|---|---|
| `hash_mismatch` | the row at `brokenAt` was edited |
| `previous_hash_mismatch` | the link to the previous row is wrong (edited row whose hash was recomputed, or a forged row) |
| `sequence_gap` | rows are missing before `brokenAt` |
| `duplicate_or_out_of_order` | a row was inserted out of order |
| `checkpoint_mismatch` | the rows of a sealed day no longer match its root (the chain was rebuilt after sealing) |
| `checkpoint_tampered` | a checkpoint was edited, removed from the middle, or signed with another key |
| `records_missing` | rows of a sealed day inside the TTL window are gone from the end |

With `fromSeq` it starts there, anchored on genesis (sequence 1), a checkpoint that ends just
before it, or the stored row before it (`anchoredBy` says which).

The daily job runs the full verification after sealing and fails (so it lands in the failed
jobs and the DLQ) when the chain is broken.

Limits: rows added after the last checkpoint can be removed from the end without detection
until the next checkpoint is sealed. Anyone with database access and `AUDIT_CHECKPOINT_SECRET`
can rebuild everything, so keep the secret off the database host.
