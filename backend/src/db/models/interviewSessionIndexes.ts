// Index definitions shared by the InterviewSession model and its migration, so the schema
// and the migrated collection cannot drift apart.
export interface InterviewSessionIndexSpec {
  key: Record<string, 1 | -1>;
  options: {
    name: string;
    unique?: boolean;
    expireAfterSeconds?: number;
    partialFilterExpression?: Record<string, unknown>;
  };
}

export const INTERVIEW_SESSION_INDEXES: InterviewSessionIndexSpec[] = [
  {
    // At most one open session per user. Closed rows have isOpen=false and are not indexed.
    key: { userId: 1, isOpen: 1 },
    options: { name: 'uq_interviewsessions_open_per_user', unique: true, partialFilterExpression: { isOpen: true } },
  },
  {
    // A user's history, newest first.
    key: { userId: 1, createdAt: -1 },
    options: { name: 'idx_interviewsessions_user_history' },
  },
  {
    // Rows are deleted by MongoDB once retainUntil has passed.
    key: { retainUntil: 1 },
    options: { name: 'ttl_interviewsessions_retain', expireAfterSeconds: 0 },
  },
];

/**
 * Indexes that addInterviewGuardFields declares on the schema. The names are the Mongo defaults,
 * so the migration and Mongoose agree on them.
 */
export const INTERVIEW_GUARD_INDEXES: InterviewSessionIndexSpec[] = [
  { key: { status: 1, startedAt: 1 }, options: { name: 'status_1_startedAt_1' } },
  { key: { status: 1, lastActivityAt: 1 }, options: { name: 'status_1_lastActivityAt_1' } },
  {
    key: { 'guard.warningPending': 1, 'guard.deliveryLeaseUntil': 1 },
    options: { name: 'guard.warningPending_1_guard.deliveryLeaseUntil_1' },
  },
  {
    key: { 'guard.evaluationPending': 1, 'guard.deliveryLeaseUntil': 1 },
    options: { name: 'guard.evaluationPending_1_guard.deliveryLeaseUntil_1' },
  },
];
