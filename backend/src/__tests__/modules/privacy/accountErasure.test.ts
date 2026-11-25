// src/__tests__/modules/privacy/accountErasure.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import JSZip from 'jszip';
import {
  User,
  UserProfile,
  UserSettings,
  DsaSubmission,
  DsaProfile,
  Project,
  ResumeProfile,
  RevisionCard,
  JobTarget,
  PublicProfile,
  UserXp,
  ProfileAuditLog,
} from '../../../db/models/index.js';
import {
  generateDataExport,
  storeExportArchive,
  getExportArchiveByToken,
} from '../../../modules/privacy/dataExport.service.js';
import { executeAccountErasure } from '../../../modules/privacy/accountErasure.worker.js';
import { getRedisClient } from '../../../shared/redis/index.js';

describe('GDPR Privacy: Data Export & Cascading Account Erasure', () => {
  let testUserId: string;
  let testClerkId: string;
  let testUsername: string;

  beforeEach(async () => {
    testClerkId = `clerk_test_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    testUsername = `gdpr_user_${Date.now()}`;

    // Seed User
    const user = await User.create({
      clerkId: testClerkId,
      email: `${testUsername}@example.com`,
      username: testUsername,
      displayName: 'GDPR Test User',
      role: 'user',
    });
    testUserId = user._id.toString();

    // Seed UserProfile & Settings
    await UserProfile.create({
      userId: user._id,
      roleTitle: 'Software engineer candidate',
      techStack: ['TypeScript', 'Node.js', 'MongoDB'],
    });

    await UserSettings.create({
      userId: user._id,
      appearance: {
        theme: 'dark',
      },
    });

    // Seed DSA submissions & profile
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

    // Seed Project
    await Project.create({
      userId: user._id,
      name: 'DevTrack Privacy Service',
      description: 'GDPR Article 17 and 20 compliance suite',
    });

    // Seed Resume
    await ResumeProfile.create({
      userId: user._id,
      summary: 'Experienced full stack developer',
    });

    // Seed Revision Card
    await RevisionCard.create({
      userId: user._id,
      problemKey: 'leetcode:two-sum',
      title: 'Two Sum',
      difficulty: 'easy',
      dueAt: new Date(),
    });

    // Seed JobTarget
    await JobTarget.create({
      userId: user._id,
      title: 'Staff Engineer',
      text: 'Senior Full Stack at TechCorp',
    });

    // Seed PublicProfile
    await PublicProfile.create({
      userId: user._id,
      username: testUsername,
      slug: testUsername,
      visibility: 'public',
      published: true,
    });

    // Seed UserXp
    await UserXp.create({
      userId: user._id,
      totalXp: 1200,
      currentLevel: 5,
    });

    // Seed ProfileAuditLog
    await ProfileAuditLog.create({
      userId: user._id,
      eventType: 'profile_computed',
      triggeredBy: 'system',
      details: { initialScore: 85, ipAddress: '127.0.0.1' },
    });
  });

  describe('Data Portability Export Pipeline (GDPR Article 20)', () => {
    it('generates a valid, readable ZIP archive containing all user data categories', async () => {
      const { archiveBuffer, metadata } = await generateDataExport(testUserId);

      expect(archiveBuffer).toBeInstanceOf(Buffer);
      expect(archiveBuffer.length).toBeGreaterThan(0);

      // Verify ZIP magic number (PK\x03\x04)
      expect(archiveBuffer[0]).toBe(0x50);
      expect(archiveBuffer[1]).toBe(0x4b);
      expect(archiveBuffer[2]).toBe(0x03);
      expect(archiveBuffer[3]).toBe(0x04);

      // Verify metadata schema
      expect(metadata.userId).toBe(testUserId);
      expect(metadata.categories.user).toBe(1);
      expect(metadata.categories.profile).toBe(1);
      expect(metadata.categories.dsaSubmissions).toBe(1);
      expect(metadata.categories.projects).toBe(1);
      expect(metadata.categories.resumes).toBe(1);
      expect(metadata.categories.jobTargets).toBe(1);

      // Decompress and verify ZIP contents
      const zip = await JSZip.loadAsync(archiveBuffer);
      const files = Object.keys(zip.files);

      expect(files).toContain('metadata.json');
      expect(files).toContain('account.json');
      expect(files).toContain('dsa.json');
      expect(files).toContain('projects.json');
      expect(files).toContain('resume.json');
      expect(files).toContain('activity.json');

      const accountJsonStr = await zip.file('account.json')!.async('string');
      const accountData = JSON.parse(accountJsonStr);
      expect(accountData.user.username).toBe(testUsername);
      expect(accountData.profile.roleTitle).toBe('Software engineer candidate');
      expect(accountData.settings.appearance?.theme).toBe('dark');

      const dsaJsonStr = await zip.file('dsa.json')!.async('string');
      const dsaData = JSON.parse(dsaJsonStr);
      expect(dsaData.submissions).toHaveLength(1);
      expect(dsaData.submissions[0].externalId).toBe('ext-two-sum');

      const projectsJsonStr = await zip.file('projects.json')!.async('string');
      const projectsData = JSON.parse(projectsJsonStr);
      expect(projectsData[0].name).toBe('DevTrack Privacy Service');
    });

    it('stores and retrieves archive via expiring token', async () => {
      const { archiveBuffer } = await generateDataExport(testUserId);
      const { token, expiresAt } = await storeExportArchive(testUserId, archiveBuffer);

      expect(token).toBeDefined();
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

      const retrieved = await getExportArchiveByToken(token);
      expect(retrieved).not.toBeNull();
      expect(Buffer.compare(archiveBuffer, retrieved!)).toBe(0);

      // Non-existent token returns null
      const nonExistent = await getExportArchiveByToken('invalid-token-uuid');
      expect(nonExistent).toBeNull();
    });
  });

  describe('Transactional Cascading Account Erasure (GDPR Article 17)', () => {
    it('executes cascading deletion across all collections, clears cache, and anonymizes audit logs', async () => {
      const redis = getRedisClient() as any;
      if (!redis.zadd) redis.zadd = vi.fn().mockResolvedValue(1);
      if (!redis.zrem) redis.zrem = vi.fn().mockResolvedValue(1);
      if (!redis.scan) redis.scan = vi.fn().mockResolvedValue(['0', [`user:${testUserId}:profile`, `portfolio:${testUsername}`]]);
      await redis.set(`user:${testUserId}:profile`, 'cached-profile');
      await redis.set(`portfolio:${testUsername}`, 'cached-portfolio');
      await redis.zadd('leaderboard:all', 1200, testUserId);

      // Execute account erasure
      const result = await executeAccountErasure(testUserId, {
        deleteClerkAccount: false, // Avoid external Clerk API calls in unit test
        clearRedisCache: true,
        anonymizeAuditLogs: true,
      });

      expect(result.userId).toBe(testUserId);
      expect(result.deletedCounts.User).toBe(1);
      expect(result.deletedCounts.UserProfile).toBe(1);
      expect(result.deletedCounts.UserSettings).toBe(1);
      expect(result.deletedCounts.DsaSubmission).toBe(1);
      expect(result.deletedCounts.DsaProfile).toBe(1);
      expect(result.deletedCounts.Project).toBe(1);
      expect(result.deletedCounts.ResumeProfile).toBe(1);
      expect(result.deletedCounts.RevisionCard).toBe(1);
      expect(result.deletedCounts.JobTarget).toBe(1);
      expect(result.deletedCounts.PublicProfile).toBe(1);
      expect(result.deletedCounts.UserXp).toBe(1);

      // Verify all collections now return null or 0 documents for deleted user
      const userAfter = await User.findById(testUserId);
      expect(userAfter).toBeNull();

      const profileAfter = await UserProfile.findOne({ userId: testUserId });
      expect(profileAfter).toBeNull();

      const settingsAfter = await UserSettings.findOne({ userId: testUserId });
      expect(settingsAfter).toBeNull();

      const submissionsAfter = await DsaSubmission.find({ userId: testUserId });
      expect(submissionsAfter).toHaveLength(0);

      const projectsAfter = await Project.find({ userId: testUserId });
      expect(projectsAfter).toHaveLength(0);

      const resumesAfter = await ResumeProfile.find({ userId: testUserId });
      expect(resumesAfter).toHaveLength(0);

      const publicProfileAfter = await PublicProfile.findOne({ userId: testUserId });
      expect(publicProfileAfter).toBeNull();

      // Verify ProfileAuditLog was anonymized instead of deleted (to preserve audit chain)
      const auditLogsAfter = await ProfileAuditLog.find({ 'details.anonymized': true });
      expect(auditLogsAfter.length).toBeGreaterThan(0);
      expect(auditLogsAfter[0].userId).toBeNull();
      expect(auditLogsAfter[0].details.anonymized).toBe(true);

      // Verify no audit log contains the original testUserId
      const lingeringAuditLogs = await ProfileAuditLog.find({ userId: new Types.ObjectId(testUserId) });
      expect(lingeringAuditLogs).toHaveLength(0);
    });

    it('gracefully handles erasure of non-existent user or already purged records', async () => {
      const nonExistentId = new Types.ObjectId().toString();
      const result = await executeAccountErasure(nonExistentId, {
        deleteClerkAccount: false,
      });

      expect(result.userId).toBe(nonExistentId);
      expect(result.deletedCounts.User).toBe(0);
    });
  });
});
