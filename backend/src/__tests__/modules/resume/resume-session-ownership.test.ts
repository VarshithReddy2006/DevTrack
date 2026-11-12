import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import { UploadService } from '../../../modules/resume/upload/upload.service.js';

describe('Issue #82: Resume Session Ownership Validation', () => {
  const uploadService = new UploadService();
  const userA = new Types.ObjectId().toString();
  const userB = new Types.ObjectId().toString();
  const sessionAId = 'session-user-a-123';
  const sessionBId = 'session-user-b-456';

  beforeEach(async () => {
    await ResumeSession.deleteMany({});

    // Create session for user A
    await ResumeSession.create({
      sessionId: sessionAId,
      userId: userA,
      currentStage: 'UPLOADED',
      uploadMetadata: {
        originalFilename: 'resume-a.pdf',
        fileType: 'pdf',
        fileSize: 1024,
        mimeType: 'application/pdf',
        uploadPath: '/tmp/resume-a.pdf',
        uploadedAt: new Date(),
      },
      parsedContent: { text: 'User A resume content' },
      timestamps: {
        uploadedAt: new Date(),
        lastUpdated: new Date(),
      },
    });

    // Create session for user B
    await ResumeSession.create({
      sessionId: sessionBId,
      userId: userB,
      currentStage: 'PARSING',
      uploadMetadata: {
        originalFilename: 'resume-b.pdf',
        fileType: 'pdf',
        fileSize: 2048,
        mimeType: 'application/pdf',
        uploadPath: '/tmp/resume-b.pdf',
        uploadedAt: new Date(),
      },
      parsedContent: { text: 'User B resume content' },
      timestamps: {
        uploadedAt: new Date(),
        lastUpdated: new Date(),
      },
    });
  });

  it('allows users to retrieve their own session details and status', async () => {
    const session = await uploadService.getSession(sessionAId, userA);
    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe(sessionAId);
    expect(String(session?.userId)).toBe(userA);

    const status = await uploadService.getSessionStatus(sessionAId, userA);
    expect(status).not.toBeNull();
    expect(status?.sessionId).toBe(sessionAId);
    expect(status?.currentStage).toBe('UPLOADED');
  });

  it('rejects foreign user session access with non-disclosing null at DB query level', async () => {
    // User B tries to access User A's session
    const sessionForUserB = await uploadService.getSession(sessionAId, userB);
    expect(sessionForUserB).toBeNull();

    const statusForUserB = await uploadService.getSessionStatus(sessionAId, userB);
    expect(statusForUserB).toBeNull();
  });

  it('returns null for nonexistent session IDs', async () => {
    const nonExistent = await uploadService.getSession('nonexistent-session', userA);
    expect(nonExistent).toBeNull();

    const statusNonExistent = await uploadService.getSessionStatus('nonexistent-session', userA);
    expect(statusNonExistent).toBeNull();
  });

  it('enforces { sessionId, userId } ownership on Report Engine', async () => {
    const { ResumeIntelligenceReportEngine } = await import('../../../modules/resume/reports/ResumeIntelligenceReportEngine.js');
    const engine = new ResumeIntelligenceReportEngine();

    // User B trying to generate report for User A's session
    await expect(engine.generateReport(userB, sessionAId)).rejects.toThrow(/not found/);
  });
});
