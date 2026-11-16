import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import mongoose, { Types } from 'mongoose';
import { expect, it, vi } from 'vitest';
import { createApp } from '../../../index.js';
import { migrateEvidenceLedger, rollbackEvidenceLedger } from '../../../db/migrations/0011-evidence-ledger.js';
import { EVIDENCE_LEDGER_INDEX } from '../../../db/models/evidenceLedgerIndex.js';
import { ResumeEvidenceClaim } from '../../../db/models/resumeEvidenceClaim.model.js';
import { User } from '../../../db/models/user.model.js';
import { ResumeEvidenceResolver } from '../../../modules/resume/evidence/ResumeEvidenceResolver.js';
import { upsertClaim } from '../../../modules/resume/evidence/evidenceLedger.service.js';
import { ResumeIntelligenceService } from '../../../modules/resume/services/ResumeIntelligenceService.js';

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn().mockResolvedValue({ sub: 'clerk_test_integration_user' }),
}));

const repoClaim = {
  subjectType: 'repo',
  subjectKey: 'repo:example/api',
  claimText: 'Verified repository',
  source: 'github',
  sourceUrl: 'https://github.com/example/api',
  fetchedAt: new Date('2026-01-01T00:00:00Z'),
  staleAfter: new Date('2026-02-01T00:00:00Z'),
  verificationStatus: 'verified',
} as const;

it('backfills duplicate legacy text without losing rows and rolls back only migration fields', async () => {
  const db = mongoose.connection.db!;
  const collection = db.collection('resumeevidenceclaims');
  await ResumeEvidenceClaim.init();
  await rollbackEvidenceLedger(db);
  const userId = new Types.ObjectId();
  const resumeProfileId = new Types.ObjectId();
  const legacy = { userId, resumeProfileId, claimText: 'Same text in two variants' };
  const first = { _id: new Types.ObjectId(), ...legacy, variantId: 'one' };
  const second = { _id: new Types.ObjectId(), ...legacy, variantId: 'two' };
  await collection.insertMany([first, second]);

  try {
    await migrateEvidenceLedger(db);
    await migrateEvidenceLedger(db);
    expect((await collection.indexes()).find(index => index.name === EVIDENCE_LEDGER_INDEX.options.name))
      .toMatchObject({ key: EVIDENCE_LEDGER_INDEX.key, ...EVIDENCE_LEDGER_INDEX.options });
    for (const row of [first, second]) {
      expect(await collection.findOne({ _id: row._id })).toMatchObject({
        ...row, subjectType: 'resume_claim', subjectKey: 'legacy:' + row._id,
      });
    }

    const claim = await upsertClaim(userId, repoClaim);
    await rollbackEvidenceLedger(db);
    await rollbackEvidenceLedger(db);
    expect(await collection.findOne({ _id: first._id })).toEqual(first);
    expect(await collection.findOne({ _id: second._id })).toEqual(second);
    expect(await collection.findOne({ _id: claim._id as Types.ObjectId })).toMatchObject({
      subjectType: 'repo', subjectKey: repoClaim.subjectKey,
    });
    expect((await collection.indexes()).some(index => index.name === EVIDENCE_LEDGER_INDEX.options.name)).toBe(false);
  } finally {
    await migrateEvidenceLedger(db);
  }
});

it('validates subject data and enforces one row per user and subject', async () => {
  const userId = new Types.ObjectId();
  const missingProfile = new ResumeEvidenceClaim({ userId, claimText: 'Resume claim' });
  await expect(missingProfile.validate()).rejects.toThrow('resumeProfileId');
  await expect(new ResumeEvidenceClaim({ userId, ...repoClaim, subjectKey: '' }).validate())
    .rejects.toThrow('subjectKey');
  await expect(upsertClaim(userId, { ...repoClaim, sourceUrl: 'file:///etc/passwd' })).rejects.toThrow('sourceUrl');

  const results = await Promise.all(Array.from({ length: 8 }, () => upsertClaim(userId, repoClaim)));
  expect(new Set(results.map(row => String(row._id))).size).toBe(1);
  expect(results[0].resumeProfileId).toBeUndefined();
  await expect(ResumeEvidenceClaim.create({ userId, ...repoClaim })).rejects.toMatchObject({ code: 11000 });
  await expect(upsertClaim(new Types.ObjectId(), repoClaim)).resolves.toMatchObject({ subjectType: 'repo' });
  const updated = await upsertClaim(userId, { ...repoClaim, claimText: 'Repository reverified' });
  expect(updated.id).toBe(results[0].id);
  expect(updated.claimText).toBe('Repository reverified');

  await expect(upsertClaim(userId, {
    ...repoClaim,
    subjectType: 'resume_claim',
    resumeProfileId: new Types.ObjectId(),
  })).rejects.toThrow('owned resume profile');
});

it('keeps legacy resolver writes away from platform claims with the same text', async () => {
  const userId = new Types.ObjectId();
  const platformClaim = await upsertClaim(userId, repoClaim);
  const resolver = new ResumeEvidenceResolver();
  await resolver.syncClaimToDB(userId, repoClaim.claimText, []);
  await resolver.syncClaimToDB(userId, repoClaim.claimText, []);
  const rows = await ResumeEvidenceClaim.find({ userId });

  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.subjectType === 'resume_claim')).toMatchObject({
    resumeProfileId: expect.any(Types.ObjectId),
    verificationStatus: 'unverified',
  });
  expect(rows.find(row => row.id === platformClaim.id)?.verificationStatus).toBe('verified');
});

it('keeps legacy resume reads scoped and serves only the authenticated owner’s filtered ledger', async () => {
  const user = await User.findOne({ clerkId: 'clerk_test_integration_user' }).orFail();
  const userId = user._id as Types.ObjectId;
  const profile = await new ResumeIntelligenceService().getOrCreateProfile(userId);
  const legacyId = new Types.ObjectId();
  await mongoose.connection.db!.collection('resumeevidenceclaims').insertOne({
    _id: legacyId, userId, resumeProfileId: profile._id, claimText: 'Unmigrated claim',
    verificationStatus: 'unverified',
  });
  const manual = await new ResumeIntelligenceService().createEvidenceClaim(userId, {
    claimText: 'Current resume claim', evidenceSources: [],
  });
  expect(manual.subjectKey).toBe('resume:' + manual.id);

  await upsertClaim(userId, repoClaim);
  await upsertClaim(userId, { ...repoClaim, subjectKey: 'repo:unverified', verificationStatus: 'unverified' });
  await upsertClaim(new Types.ObjectId(), { ...repoClaim, subjectKey: 'repo:other-user' });
  const resumeOnly = await new ResumeIntelligenceService().getEvidenceClaims(userId);
  expect(resumeOnly.map(claim => claim.id).sort()).toEqual([legacyId.toString(), manual.id].sort());

  const server = (await createApp()).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/v1/evidence/claims';
    const headers = { Authorization: 'Bearer fixture' };
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint + '?subjectType=unexpected', { headers })).status).toBe(400);

    const result = await fetch(endpoint + '?subjectType=repo&verificationStatus=verified', { headers });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ data: [{ subjectKey: repoClaim.subjectKey }] });
    const resumeResult = await fetch(endpoint + '?subjectType=resume_claim', { headers });
    const body = await resumeResult.json() as { data: Array<{ id: string }> };
    expect(body.data.map(claim => claim.id).sort()).toEqual([legacyId.toString(), manual.id].sort());
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
