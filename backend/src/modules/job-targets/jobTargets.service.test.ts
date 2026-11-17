import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { JobTarget } from '../../db/models/jobTarget.model.js';
import { Embedding } from '../../db/models/embedding.model.js';
import { OutboxEvent } from '../../db/models/outboxEvent.model.js';
import {
  deleteJobTarget,
  JOB_TARGET_LIMIT,
  JobTargetLimitError,
  JobTargetNotFoundError,
  JobTargetValidationError,
  submitJobTarget,
} from './jobTargets.service.js';

const uid = () => new Types.ObjectId().toString();

describe('submitJobTarget', () => {
  it('stores a URL target and its outbox event together', async () => {
    const userId = uid();
    const t = await submitJobTarget(userId, { url: 'https://boards.greenhouse.io/acme/jobs/1' });
    expect(t.status).toBe('submitted');
    expect(t.url).toBe('https://boards.greenhouse.io/acme/jobs/1');
    expect(t.text).toBeNull();
    const ev = await OutboxEvent.findOne({ aggregateId: String(t._id) }).lean();
    expect(ev?.type).toBe('jobtarget.submitted');
    expect(ev?.userId).toBe(userId);
    expect(ev?.payload).toEqual({ jobTargetId: String(t._id), source: 'url' });
  });

  it('accepts pasted text', async () => {
    const t = await submitJobTarget(uid(), { text: 'Backend engineer, Node and Mongo.' });
    expect(t.text).toContain('Backend engineer');
    expect((await OutboxEvent.findOne().lean())?.payload).toMatchObject({ source: 'text' });
  });

  it('never fetches: an internal URL is only stored, the worker vets it later', async () => {
    const t = await submitJobTarget(uid(), { url: 'http://169.254.169.254/latest/meta-data/' });
    expect(t.status).toBe('submitted');
  });

  it('rejects bad input without writing anything', async () => {
    const userId = uid();
    for (const bad of [{}, { text: 'a', url: 'https://a.example/x' }, { url: 'ftp://a.example/x' }, { url: 'nope' }, { text: '   ' }]) {
      await expect(submitJobTarget(userId, bad)).rejects.toBeInstanceOf(JobTargetValidationError);
    }
    expect(await JobTarget.countDocuments()).toBe(0);
    expect(await OutboxEvent.countDocuments()).toBe(0);
  });

  it('refuses the 51st target with JOB_TARGET_LIMIT_REACHED and writes no event for it', async () => {
    const userId = uid();
    await JobTarget.insertMany(
      Array.from({ length: JOB_TARGET_LIMIT }, (_, i) => ({ userId: new Types.ObjectId(userId), text: `t${i}` })),
    );
    const err = await submitJobTarget(userId, { text: 'one too many' }).catch((e) => e);
    expect(err).toBeInstanceOf(JobTargetLimitError);
    expect(err.code).toBe('JOB_TARGET_LIMIT_REACHED');
    expect(err.status).toBe(409);
    expect(await JobTarget.countDocuments({ userId })).toBe(JOB_TARGET_LIMIT);
    expect(await OutboxEvent.countDocuments()).toBe(0);
  });

  it('counts the limit per user', async () => {
    const a = uid();
    await JobTarget.insertMany(Array.from({ length: JOB_TARGET_LIMIT }, (_, i) => ({ userId: new Types.ObjectId(a), text: `t${i}` })));
    await expect(submitJobTarget(uid(), { text: 'someone else' })).resolves.toBeTruthy();
  });
});

describe('deleteJobTarget', () => {
  it('deletes the target and cascades its embeddings', async () => {
    const userId = uid();
    const t = await submitJobTarget(userId, { text: 'Go engineer' });
    await Embedding.collection.insertOne({
      scope: 'user',
      userId: new Types.ObjectId(userId),
      sessionId: String(t._id),
      vector: [0.1, 0.2],
    });
    await deleteJobTarget(userId, String(t._id));
    expect(await JobTarget.countDocuments()).toBe(0);
    expect(await Embedding.collection.countDocuments({ sessionId: String(t._id) })).toBe(0);
  });

  it("cannot delete another user's target", async () => {
    const t = await submitJobTarget(uid(), { text: 'mine' });
    await expect(deleteJobTarget(uid(), String(t._id))).rejects.toBeInstanceOf(JobTargetNotFoundError);
    expect(await JobTarget.countDocuments()).toBe(1);
  });

  it('treats a malformed id as not found', async () => {
    await expect(deleteJobTarget(uid(), 'xyz')).rejects.toBeInstanceOf(JobTargetNotFoundError);
  });
});
