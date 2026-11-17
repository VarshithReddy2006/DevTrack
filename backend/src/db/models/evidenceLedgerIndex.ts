export const EVIDENCE_LEDGER_INDEX = {
  key: { userId: 1, subjectType: 1, subjectKey: 1 } as const,
  options: {
    name: 'uq_resumeevidenceclaims_subject_key',
    unique: true,
    // Old binaries and unmigrated rows have no subject key.
    partialFilterExpression: { subjectKey: { $type: 'string' } },
  },
};
