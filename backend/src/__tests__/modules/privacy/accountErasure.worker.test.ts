// src/__tests__/modules/privacy/accountErasure.worker.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import {
  AuditEncryptionKey,
  User,
  UserProfile,
  UserSettings,
  DsaSubmission,
  DsaProfile,
  Project,
  ProjectTask,
  ResumeProfile,
  ResumeExport,
  ResumeEvidenceClaim,
  ResumeSession,
  ResumeVariant,
  ResumeCredibility,
  RevisionCard,
  JobTarget,
  PublicProfile,
  UserXp,
  ProfileAuditLog,
} from '../../../db/models/index.js';
import { executeAccountErasure } from '../../../modules/privacy/accountErasure.worker.js';
import {
  ACCOUNT_ERASURE_TOMBSTONE,
  verifyAuditChain,
} from '../../../modules/audit/auditChain.service.js';
import {
  appendChainedAuditEvent,
  decryptChainedAuditEvent,
  inspectStoredAuditChain,
  toAuditChainFields,
  verifyStoredAuditChain,
} from '../../../modules/audit/auditLedger.service.js';
import { getRedisClient } from '../../../shared/redis/index.js';

describe('GDPR Privacy: Cascading Account Erasure with Crypto-Shredding & Audit Tombstones', () => {
  let testUserId: string;
  let testClerkId: string;
  let testUsername: string;

  beforeEach(async () => {
    testClerkId = `clerk_test_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    testUsername = `gdpr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    const user = await User.create({
      clerkId: testClerkId,
      email: `${testUsername}@example.com`,
      username: testUsername,
      displayName: 'GDPR Test User',
      role: 'user',
    });
    testUserId = user._id.toString();

    await UserProfile.create({
      userId: user._id,
      roleTitle: 'Software engineer candidate',
      techStack: ['TypeScript', 'Node.js', 'MongoDB'],
    });

    await UserSettings.create({
      userId: user._id,
      appearance: { theme: 'dark' },
    });

    await DsaProfile.create({
      userId: user._id.toString(),
      platform: 'leetcode',
      totalSolved: 42,
    });

    await DsaSubmission.create({
      userId: user._id,
      problemId: new Types.ObjectId(),
      externalId: 'ext-two-sum',
      platform: 'leetcode',
      status: 'accepted',
      language: 'typescript',
      submittedAt: new Date(),
    });

    const project = await Project.create({
      userId: user._id,
      name: 'DevTrack Privacy Service',
      description: 'GDPR Article 17 and 20 compliance suite',
    });

    await ProjectTask.create({
      projectId: project._id,
      title: 'Implement GDPR account erasure',
      description: 'Cascade deletion of all user records',
      status: 'done',
      priority: 'high',
      labels: ['gdpr', 'privacy'],
    });

    const resumeProfile = await ResumeProfile.create({
      userId: user._id,
      summary: 'Experienced full stack developer',
    });

    await ResumeExport.create({
      userId: user._id,
      resumeProfileId: resumeProfile._id,
      exportType: 'pdf',
      exportPath: '/exports/test.pdf',
      checksum: 'sha256-test',
      atsValidationState: 'passed',
      exportVersion: '1.0',
      templateVersion: 'modern',
      metadata: { fileSize: 1024, pageCount: 1, generationDurationMs: 120, atsAnalysisId: null },
    });

    await ResumeEvidenceClaim.create({
      userId: user._id,
      resumeProfileId: resumeProfile._id,
      subjectType: 'resume_claim',
      subjectKey: 'claim-123',
      source: 'user',
      claimText: 'Led development of distributed storage engine',
      variantId: null,
      verificationStatus: 'verified',
    });

    const testSessionId = `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    await ResumeSession.create({
      sessionId: testSessionId,
      userId: user._id,
      stage: 'COMPLETED',
      uploadMetadata: {
        originalFilename: 'resume.pdf',
        fileType: 'pdf',
        fileSize: 1024,
        mimeType: 'application/pdf',
        uploadPath: '/uploads/resume.pdf',
        uploadedAt: new Date(),
      },
      timestamps: {
        uploadedAt: new Date(),
        lastUpdated: new Date(),
      },
    });

    await ResumeVariant.create({
      userId: user._id,
      resumeProfileId: resumeProfile._id,
      variantId: 'variant-backend-v1',
      roleType: 'Backend',
    });

    await ResumeCredibility.create({
      sessionId: testSessionId,
      overallCredibility: 90,
      dsaCredibility: 85,
      projectCredibility: 95,
      consistencyScore: 92,
      summary: 'High credibility verification profile',
    });

    await RevisionCard.create({
      userId: user._id,
      problemKey: 'leetcode:two-sum',
      title: 'Two Sum',
      difficulty: 'easy',
      dueAt: new Date(),
    });

    await JobTarget.create({
      userId: user._id,
      title: 'Staff Engineer',
      text: 'Senior Full Stack at TechCorp',
    });

    await PublicProfile.create({
      userId: user._id,
      username: testUsername,
      slug: testUsername,
      visibility: 'public',
      published: true,
    });

    await UserXp.create({
      userId: user._id,
      totalXp: 1200,
      currentLevel: 5,
    });
  });

  it('generates 10 audit events, crypto-shreds user PII on erasure, appends tombstone, and passes verifyAuditChain()', async () => {
    // Seed another active user whose audit records must remain readable after testUserId is erased
    const otherUser = await User.create({
      clerkId: `clerk_other_${Date.now()}`,
      email: `other_${Date.now()}@example.com`,
      username: `other_${Date.now()}`,
      displayName: 'Other User',
      role: 'user',
    });

    // Generate 10 chained audit events interleaved across users
    const createdEvents = [];
    for (let i = 0; i < 10; i++) {
      const targetId = i % 3 === 0 ? otherUser._id : testUserId;
      const ev = await appendChainedAuditEvent({
        userId: targetId,
        eventType: i % 2 === 0 ? 'profile_computed' : 'dossier_downloaded',
        triggeredBy: 'system',
        details: {
          seqNote: `event-${i}`,
          ipAddress: `192.0.2.${i + 1}`,
          email: targetId === testUserId ? `${testUsername}@example.com` : otherUser.email,
        },
        timestamp: new Date(Date.UTC(2026, 10, 25, 10, i)),
      });
      createdEvents.push({ targetId: String(targetId), doc: ev });
    }

    // Before erasure: user's key exists, PII is encrypted in storage, and decrypts cleanly
    expect(await AuditEncryptionKey.countDocuments({ userId: new Types.ObjectId(testUserId) })).toBe(1);
    const firstTestEvent = createdEvents.find((e) => e.targetId === testUserId)!;
    expect(firstTestEvent.doc.userId).toBeNull();
    expect(firstTestEvent.doc.details).toEqual({ encrypted: true });
    expect(firstTestEvent.doc.encryptedDetails?.ciphertext).toBeDefined();

    const decryptedBefore = await decryptChainedAuditEvent(firstTestEvent.doc, testUserId);
    expect(decryptedBefore).toMatchObject({
      email: `${testUsername}@example.com`,
    });

    // Snapshot original record hashes & ciphertexts before erasure to ensure zero in-place mutation
    const logsBefore = await ProfileAuditLog.find({ sequenceNumber: { $type: 'number' } })
      .sort({ sequenceNumber: 1 })
      .lean();
    expect(logsBefore).toHaveLength(10);
    expect(await verifyStoredAuditChain()).toEqual({ ok: true, checked: 10 });

    const redis = getRedisClient() as any;
    if (!redis.zadd) redis.zadd = vi.fn().mockResolvedValue(1);
    if (!redis.zrem) redis.zrem = vi.fn().mockResolvedValue(1);
    if (!redis.scan)
      redis.scan = vi
        .fn()
        .mockResolvedValue(['0', [`user:${testUserId}:profile`, `portfolio:${testUsername}`]]);
    await redis.set(`user:${testUserId}:profile`, 'cached-profile');
    await redis.set(`portfolio:${testUsername}`, 'cached-portfolio');
    await redis.zadd('leaderboard:all', 1200, testUserId);

    // Execute GDPR account erasure
    const result = await executeAccountErasure(testUserId, {
      deleteClerkAccount: false,
      clearRedisCache: true,
      anonymizeAuditLogs: true,
    });

    expect(result.userId).toBe(testUserId);
    expect(result.tombstoneAppended).toBe(true);
    expect(result.shreddedAuditKeys).toBe(1);
    expect(result.deletedCounts.User).toBe(1);
    expect(await User.findById(testUserId)).toBeNull();

    // 1. User's encryption key is permanently deleted (crypto-shredded)
    expect(await AuditEncryptionKey.countDocuments({ userId: new Types.ObjectId(testUserId) })).toBe(0);
    expect(await decryptChainedAuditEvent(firstTestEvent.doc, testUserId)).toBeNull();

    // 2. Other user's audit key and records remain completely intact & decryptable
    const otherEvent = createdEvents.find((e) => e.targetId === String(otherUser._id))!;
    const otherDecrypted = await decryptChainedAuditEvent(otherEvent.doc, otherUser._id);
    expect(otherDecrypted).toMatchObject({ email: otherUser.email });

    // 3. Original 10 ProfileAuditLog records were NOT mutated in-place (exact hashes & ciphertexts preserved)
    const logsAfter = await ProfileAuditLog.find({ sequenceNumber: { $type: 'number' } })
      .sort({ sequenceNumber: 1 })
      .lean();
    expect(logsAfter).toHaveLength(11);
    for (let i = 0; i < 10; i++) {
      expect(logsAfter[i].recordHash).toBe(logsBefore[i].recordHash);
      expect(logsAfter[i].payloadHash).toBe(logsBefore[i].payloadHash);
      expect(logsAfter[i].encryptedDetails).toEqual(logsBefore[i].encryptedDetails);
      expect(logsAfter[i].subjectHash).toBe(logsBefore[i].subjectHash);
    }

    // 4. Tombstone event is appended at sequence 11 and chained onto block 10
    const tombstone = logsAfter[10];
    expect(tombstone.eventType).toBe(ACCOUNT_ERASURE_TOMBSTONE);
    expect(tombstone.sequenceNumber).toBe(11);
    expect(tombstone.previousHash).toBe(logsBefore[9].recordHash);
    expect(tombstone.userId).toBeNull();
    expect(tombstone.details).toMatchObject({
      keyDestroyed: true,
      reason: 'gdpr_right_to_erasure',
    });
    // Ensure no plaintext user PII leaked onto the tombstone
    expect(JSON.stringify(tombstone)).not.toContain(testUserId);
    expect(JSON.stringify(tombstone)).not.toContain(testUsername);

    // 5. Full hash chain passes verifyAuditChain() and inspectStoredAuditChain() 100%
    expect(verifyAuditChain(logsAfter.map(toAuditChainFields))).toEqual({ ok: true, checked: 11 });
    expect(await verifyStoredAuditChain()).toEqual({ ok: true, checked: 11 });
    expect(await inspectStoredAuditChain()).toEqual({
      ok: true,
      checked: 11,
      tombstoneCount: 1,
      erasedSubjects: [tombstone.subjectHash],
    });
  });

  it('continues the chain cleanly for subsequent audit events after an erasure tombstone and still detects tampering', async () => {
    const activeUser = await User.create({
      clerkId: `clerk_active_${Date.now()}`,
      email: `active_${Date.now()}@example.com`,
      username: `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      displayName: 'Active User',
      role: 'user',
    });

    await appendChainedAuditEvent({
      userId: testUserId,
      eventType: 'profile_computed',
      triggeredBy: 'system',
      details: { score: 80 },
    });

    await executeAccountErasure(testUserId, {
      deleteClerkAccount: false,
      clearRedisCache: false,
      anonymizeAuditLogs: true,
    });

    await appendChainedAuditEvent({
      userId: activeUser._id,
      eventType: 'visibility_changed',
      triggeredBy: 'user',
      details: { published: true },
    });

    expect(await verifyStoredAuditChain()).toEqual({ ok: true, checked: 3 });

    // Simulate tampering on the pre-erasure block; verifyAuditChain must pinpoint sequence 1
    const docs = await ProfileAuditLog.find({ sequenceNumber: { $type: 'number' } })
      .sort({ sequenceNumber: 1 })
      .lean();
    const chain = docs.map(toAuditChainFields);
    chain[0] = { ...chain[0], payloadHash: 'f'.repeat(64) };
    expect(verifyAuditChain(chain)).toMatchObject({
      ok: false,
      brokenAt: 1,
      reason: 'hash_mismatch',
    });
  });

  it('gracefully handles erasure of non-existent user', async () => {
    const nonExistentId = new Types.ObjectId().toString();
    const result = await executeAccountErasure(nonExistentId, {
      deleteClerkAccount: false,
    });

    expect(result.userId).toBe(nonExistentId);
    expect(result.deletedCounts.User).toBe(0);
    expect(result.shreddedAuditKeys).toBe(0);
    expect(result.tombstoneAppended).toBe(true);
    expect(await verifyStoredAuditChain()).toEqual({ ok: true, checked: 1 });
  });

  it('skips crypto-shredding and tombstone when anonymizeAuditLogs is false', async () => {
    await appendChainedAuditEvent({
      userId: testUserId,
      eventType: 'profile_computed',
      triggeredBy: 'system',
      details: { score: 75 },
    });

    const result = await executeAccountErasure(testUserId, {
      deleteClerkAccount: false,
      clearRedisCache: false,
      anonymizeAuditLogs: false,
    });

    expect(result.tombstoneAppended).toBe(false);
    expect(result.shreddedAuditKeys).toBe(0);
    expect(await ProfileAuditLog.countDocuments({ eventType: ACCOUNT_ERASURE_TOMBSTONE })).toBe(0);
    expect(await AuditEncryptionKey.countDocuments({ userId: new Types.ObjectId(testUserId) })).toBe(1);
  });
});
