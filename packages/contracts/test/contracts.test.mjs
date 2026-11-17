import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  apiResponseEnvelopeSchema, ErrorCodes, FocusCompleteRequestSchema,
  FocusHeartbeatRequestSchema, FocusStartRequestSchema, ObjectIdSchema,
  PaginationMetaSchema, PaginationQuerySchema, ReviewSubmitRequestSchema,
  RevisionDueQuerySchema, UpcomingContestsQuerySchema, UpcomingContestsResponseSchema,
} from '@devtrack/contracts';

test('parses query defaults and rejects ambiguous pagination input', () => {
  assert.deepEqual(PaginationQuerySchema.parse({}), { page: 1, pageSize: 20 });
  assert.deepEqual(PaginationQuerySchema.parse({ page: '2', pageSize: '50' }), { page: 2, pageSize: 50 });
  for (const page of ['', ['2'], true, '1.5', '-1', '1e2', '9007199254740992']) {
    assert.equal(PaginationQuerySchema.safeParse({ page }).success, false);
  }
  assert.equal(PaginationQuerySchema.safeParse({ pageSize: 101 }).success, false);
  assert.equal(PaginationMetaSchema.safeParse({ page: 1, pageSize: 20, total: 0, totalPages: 0 }).success, true);
});

test('validates server-authoritative focus request fields', () => {
  assert.deepEqual(FocusStartRequestSchema.parse({ mode: ' deep-work ', plannedSec: 300 }), { mode: 'deep-work', plannedSec: 300 });
  assert.equal(FocusStartRequestSchema.safeParse({ mode: 'study', plannedSec: -4 }).success, false);
  assert.equal(FocusStartRequestSchema.safeParse({ mode: 'study', plannedSec: 300, xp: 100 }).success, false);
  const id = '656565656565656565656565';
  assert.equal(ObjectIdSchema.parse(id), id);
  assert.equal(FocusHeartbeatRequestSchema.parse({ id }).id, id);
  assert.equal(FocusCompleteRequestSchema.safeParse({ id: 'invalid' }).success, false);
});

test('validates contest feed timestamps and URLs and permits stale entries', () => {
  const scheduled = {
    platform: 'atcoder', externalId: 'abc500', contestName: 'AtCoder Beginner Contest 500',
    startTime: '2030-01-01T19:00:00+09:00', endTime: '2030-01-01T21:00:00+09:00',
    durationSeconds: 7200, url: 'https://atcoder.jp/contests/abc500',
    phase: 'UPCOMING', kind: 'scheduled', stale: true, fetchedAt: null,
  };
  assert.deepEqual(UpcomingContestsResponseSchema.parse({ contests: [scheduled] }).contests[0], scheduled);
  assert.equal(UpcomingContestsResponseSchema.safeParse({ contests: [{ ...scheduled, endTime: scheduled.startTime }] }).success, false);
  assert.equal(UpcomingContestsResponseSchema.safeParse({ contests: [{ ...scheduled, url: 'file:///tmp/contest' }] }).success, false);
  assert.equal(UpcomingContestsQuerySchema.safeParse({ platform: 'unknown' }).success, false);
});

test('validates revision sequence numbers and due-list limits', () => {
  assert.deepEqual(ReviewSubmitRequestSchema.parse({ rating: 'hard', reviewSeq: 0 }), { rating: 'hard', reviewSeq: 0 });
  assert.equal(ReviewSubmitRequestSchema.safeParse({ rating: 'hard', reviewSeq: -1 }).success, false);
  assert.equal(ReviewSubmitRequestSchema.safeParse({ rating: 'medium', reviewSeq: 0 }).success, false);
  assert.deepEqual(RevisionDueQuerySchema.parse({}), { limit: 10 });
  assert.deepEqual(RevisionDueQuerySchema.parse({ limit: '5' }), { limit: 5 });
  assert.equal(RevisionDueQuerySchema.safeParse({ limit: 101 }).success, false);
});

test('validates successful data and structured errors in the same envelope', () => {
  const envelope = apiResponseEnvelopeSchema(UpcomingContestsResponseSchema);
  assert.deepEqual(envelope.parse({ success: true, data: { contests: [] } }), { success: true, data: { contests: [] } });
  const failure = { success: false, error: { code: ErrorCodes.VALIDATION_ERROR, message: 'Validation failed',
    details: { 'query.platform': ['Platform is invalid'] } } };
  assert.deepEqual(envelope.parse(failure), failure);
  assert.equal(envelope.safeParse({ success: true, data: { contests: 'invalid' } }).success, false);
});
