import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { migrateInterviewSessions, rollbackInterviewSessions } from '../../../db/migrations/0015-interview-sessions.js';
import { INTERVIEW_GUARD_INDEXES, INTERVIEW_SESSION_INDEXES } from '../../../db/models/interviewSessionIndexes.js';

const names = [...INTERVIEW_SESSION_INDEXES, ...INTERVIEW_GUARD_INDEXES].map((spec) => spec.options.name);

describe('0015-interview-sessions migration', () => {
  it('creates every index, enforces one open session per user and rolls back', async () => {
    const db = mongoose.connection.db!;
    await db.collection('interviewsessions').drop().catch(() => undefined);

    await migrateInterviewSessions(db);
    await migrateInterviewSessions(db); // running it twice is harmless
    const sessions = db.collection('interviewsessions');
    const created = (await sessions.indexes()).map((index) => index.name);
    expect(created).toEqual(expect.arrayContaining(names));

    await sessions.insertOne({ userId: 'u1', isOpen: true });
    await expect(sessions.insertOne({ userId: 'u1', isOpen: true })).rejects.toMatchObject({ code: 11000 });
    // Closed sessions are outside the partial index, so history can grow freely.
    await sessions.insertMany([{ userId: 'u1', isOpen: false }, { userId: 'u1', isOpen: false }]);
    await sessions.insertOne({ userId: 'u2', isOpen: true });

    await rollbackInterviewSessions(db);
    await rollbackInterviewSessions(db); // already rolled back
    const left = (await sessions.indexes()).map((index) => index.name);
    for (const name of names) expect(left).not.toContain(name);
    // Rollback keeps the data.
    expect(await sessions.countDocuments({})).toBe(4);
    await sessions.drop();
  });

  it('keeps migration and schema index names in step', async () => {
    const { InterviewSession } = await import('../../../db/models/interviewSession.model.js');
    const fromSchema = InterviewSession.schema.indexes().map(([, options]) => options?.name).filter(Boolean);
    for (const spec of INTERVIEW_SESSION_INDEXES) expect(fromSchema).toContain(spec.options.name);
    await InterviewSession.init();
    const built = (await InterviewSession.collection.indexes()).map((index) => index.name);
    for (const name of names) expect(built).toContain(name);
  });
});
