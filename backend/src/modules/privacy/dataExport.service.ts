// src/modules/privacy/dataExport.service.ts — GDPR Data Portability Export Service
import zlib from 'zlib';
import { randomUUID } from 'crypto';
import { Types } from 'mongoose';
import {
  User,
  UserProfile,
  UserSettings,
  DsaSubmission,
  DsaProfile,
  DsaTopicProgress,
  Project,
  ProjectTask,
  ResumeProfile,
  ResumeVersion,
  ResumeBulletRevision,
  InterviewReport,
  JobTarget,
  PublicProfile,
  FocusSession,
  UserQuestProgress,
  UserStreakLog,
  UserXp,
  XpTransaction,
  DailyActivity,
} from '../../db/models/index.js';
import { logger } from '../../shared/logger.js';
import { eventBus } from '../../shared/sse/index.js';
import { getRedisClient, isRedisConfigured } from '../../shared/redis/index.js';

export interface ExportFileEntry {
  name: string;
  content: string | Buffer;
}

export interface ExportMetadata {
  userId: string;
  generatedAt: string;
  expiresAt: string;
  categories: Record<string, number>;
  archiveBytes: number;
}

// In-memory token store for export downloads (backed by Redis when available)
const inMemoryExportStore = new Map<string, { buffer: Buffer; expiresAt: number; userId: string }>();

// Clean up expired in-memory exports periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of inMemoryExportStore.entries()) {
    if (data.expiresAt < now) {
      inMemoryExportStore.delete(token);
    }
  }
}, 60_000).unref();

/**
 * Creates a standard PKZIP archive buffer from file entries using built-in Node.js zlib.
 * Does not depend on external native binaries or third-party packages.
 */
export function buildZipArchive(files: ExportFileEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const rawData = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content, 'utf8');

    const compressed = zlib.deflateRawSync(rawData);
    const crc = zlib.crc32(rawData);
    const nameBuf = Buffer.from(file.name, 'utf8');

    // Local file header (30 bytes + filename)
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // Signature
    lh.writeUInt16LE(20, 4);         // Version needed (2.0)
    lh.writeUInt16LE(0, 6);          // General purpose bit flag
    lh.writeUInt16LE(8, 8);          // Compression method: DEFLATE (8)
    lh.writeUInt16LE(0, 10);         // Last mod time
    lh.writeUInt16LE(0, 12);         // Last mod date
    lh.writeUInt32LE(crc, 14);       // CRC-32
    lh.writeUInt32LE(compressed.length, 18); // Compressed size
    lh.writeUInt32LE(rawData.length, 22);    // Uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);    // Filename length
    lh.writeUInt16LE(0, 28);                 // Extra field length
    nameBuf.copy(lh, 30);

    localHeaders.push(lh, compressed);

    // Central directory file header (46 bytes + filename)
    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0); // Signature
    ch.writeUInt16LE(20, 4);         // Version made by
    ch.writeUInt16LE(20, 6);         // Version needed
    ch.writeUInt16LE(0, 8);          // Flags
    ch.writeUInt16LE(8, 10);         // Compression method: DEFLATE
    ch.writeUInt16LE(0, 12);         // Mod time
    ch.writeUInt16LE(0, 14);         // Mod date
    ch.writeUInt32LE(crc, 16);       // CRC-32
    ch.writeUInt32LE(compressed.length, 20); // Compressed size
    ch.writeUInt32LE(rawData.length, 24);    // Uncompressed size
    ch.writeUInt16LE(nameBuf.length, 28);    // Filename length
    ch.writeUInt16LE(0, 30);                 // Extra field length
    ch.writeUInt16LE(0, 32);                 // Comment length
    ch.writeUInt16LE(0, 34);                 // Disk number start
    ch.writeUInt16LE(0, 36);                 // Internal file attributes
    ch.writeUInt32LE(0, 38);                 // External file attributes
    ch.writeUInt32LE(offset, 42);            // Relative offset of local header
    nameBuf.copy(ch, 46);

    centralHeaders.push(ch);
    offset += lh.length + compressed.length;
  }

  const cdOffset = offset;
  const cdBuf = Buffer.concat(centralHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // End of central directory signature
  eocd.writeUInt16LE(0, 4);                // Disk number
  eocd.writeUInt16LE(0, 6);                // Disk with start of CD
  eocd.writeUInt16LE(files.length, 8);     // Total entries on disk
  eocd.writeUInt16LE(files.length, 10);    // Total entries
  eocd.writeUInt32LE(cdBuf.length, 12);    // Size of central directory
  eocd.writeUInt32LE(cdOffset, 16);        // Offset of CD
  eocd.writeUInt16LE(0, 20);               // Comment length

  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

/**
 * Extracts and compiles all personal data for a given user into machine-readable JSON files,
 * then packages them into a portable ZIP archive.
 */
export async function generateDataExport(userId: string): Promise<{ archiveBuffer: Buffer; metadata: ExportMetadata }> {
  const userObjectId = Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : null;
  const userFilter = userObjectId ? { $or: [{ userId: userObjectId }, { userId: String(userId) }] } : { userId };

  logger.info('[privacy-export] Compiling data portability archive', { userId });

  const [
    userDoc,
    userProfile,
    userSettings,
    dsaSubmissions,
    dsaProfile,
    dsaTopics,
    projects,
    resumeProfiles,
    resumeVersions,
    resumeBulletRevisions,
    interviews,
    jobTargets,
    publicProfile,
    focusSessions,
    questProgress,
    streakLogs,
    xpData,
    xpTransactions,
    dailyActivities,
  ] = await Promise.all([
    User?.findById ? User.findById(userId).lean().catch(() => null) : Promise.resolve(null),
    UserProfile?.findOne ? UserProfile.findOne(userFilter).lean().catch(() => null) : Promise.resolve(null),
    UserSettings?.findOne ? UserSettings.findOne(userFilter).lean().catch(() => null) : Promise.resolve(null),
    DsaSubmission?.find ? DsaSubmission.find(userFilter).lean().catch(() => []) : Promise.resolve([]),
    DsaProfile?.findOne ? DsaProfile.findOne(userFilter).lean().catch(() => null) : Promise.resolve(null),
    DsaTopicProgress?.find ? DsaTopicProgress.find(userFilter).lean().catch(() => []) : Promise.resolve([]),
    Project?.find ? Project.find(userFilter).lean().catch(() => []) : Promise.resolve([]),
    ResumeProfile?.find ? ResumeProfile.find(userFilter).lean().catch(() => []) : Promise.resolve([]),
    ResumeVersion?.find ? ResumeVersion.find(userFilter).lean().catch(() => []) : Promise.resolve([]),
    ResumeBulletRevision?.find ? ResumeBulletRevision.find(userFilter).lean().catch(() => []) : Promise.resolve([]),
    InterviewReport?.find ? InterviewReport.find(userFilter).lean().catch(() => []) : Promise.resolve([]),
    JobTarget?.find ? JobTarget.find(userFilter).lean().catch(() => []) : Promise.resolve([]),
    PublicProfile?.findOne ? PublicProfile.findOne(userFilter).lean().catch(() => null) : Promise.resolve(null),
    FocusSession?.find ? FocusSession.find(userFilter).lean().catch(() => []) : Promise.resolve([]),
    UserQuestProgress?.find ? UserQuestProgress.find(userFilter).lean().catch(() => []) : Promise.resolve([]),
    UserStreakLog?.find ? UserStreakLog.find(userFilter).lean().catch(() => []) : Promise.resolve([]),
    UserXp?.findOne ? UserXp.findOne(userFilter).lean().catch(() => null) : Promise.resolve(null),
    XpTransaction?.find ? XpTransaction.find(userFilter).lean().catch(() => []) : Promise.resolve([]),
    DailyActivity?.find ? DailyActivity.find(userFilter).lean().catch(() => []) : Promise.resolve([]),
  ]);

  const projectIds = (projects || []).map((p: any) => p._id);
  const projectTasks = projectIds.length > 0 && ProjectTask?.find
    ? await ProjectTask.find({ projectId: { $in: projectIds } }).lean().catch(() => [])
    : [];

  const projectsWithTasks = (projects || []).map((p: any) => ({
    ...p,
    tasks: projectTasks.filter((t: any) => String(t.projectId) === String(p._id)),
  }));

  const sanitizedUser = userDoc
    ? {
        id: userDoc._id,
        email: userDoc.email,
        username: userDoc.username,
        role: userDoc.role,
        joinedAt: userDoc.joinedAt,
        lastActiveAt: userDoc.lastActiveAt,
      }
    : null;

  const categories = {
    user: sanitizedUser ? 1 : 0,
    profile: userProfile ? 1 : 0,
    settings: userSettings ? 1 : 0,
    dsaSubmissions: dsaSubmissions.length,
    projects: projects.length,
    resumes: resumeProfiles.length + resumeVersions.length,
    interviews: interviews.length,
    jobTargets: jobTargets.length,
    activityLogs: focusSessions.length + streakLogs.length + dailyActivities.length,
    quests: questProgress.length,
    xpRecords: (xpData ? 1 : 0) + xpTransactions.length,
  };

  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const metadata: ExportMetadata = {
    userId,
    generatedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    categories,
    archiveBytes: 0,
  };

  const files: ExportFileEntry[] = [
    {
      name: 'metadata.json',
      content: JSON.stringify(metadata, null, 2),
    },
    {
      name: 'account.json',
      content: JSON.stringify({ user: sanitizedUser, profile: userProfile, settings: userSettings }, null, 2),
    },
    {
      name: 'dsa.json',
      content: JSON.stringify({ profile: dsaProfile, topics: dsaTopics, submissions: dsaSubmissions }, null, 2),
    },
    {
      name: 'projects.json',
      content: JSON.stringify(projectsWithTasks, null, 2),
    },
    {
      name: 'resume.json',
      content: JSON.stringify({ profiles: resumeProfiles, versions: resumeVersions, bulletRevisions: resumeBulletRevisions }, null, 2),
    },
    {
      name: 'interviews.json',
      content: JSON.stringify(interviews, null, 2),
    },
    {
      name: 'job-targets.json',
      content: JSON.stringify(jobTargets, null, 2),
    },
    {
      name: 'public-profile.json',
      content: JSON.stringify(publicProfile, null, 2),
    },
    {
      name: 'activity.json',
      content: JSON.stringify({ focusSessions, streakLogs, dailyActivities }, null, 2),
    },
    {
      name: 'progression.json',
      content: JSON.stringify({ xp: xpData, transactions: xpTransactions, quests: questProgress }, null, 2),
    },
  ];

  const archiveBuffer = buildZipArchive(files);
  metadata.archiveBytes = archiveBuffer.length;

  logger.info('[privacy-export] Data portability archive created successfully', {
    userId,
    sizeBytes: archiveBuffer.length,
    categories,
  });

  return { archiveBuffer, metadata };
}

/**
 * Stores the generated archive buffer under an expiring token (24h).
 */
export async function storeExportArchive(userId: string, archiveBuffer: Buffer): Promise<{ token: string; expiresAt: Date }> {
  const token = randomUUID();
  const ttlSeconds = 24 * 60 * 60; // 24 hours
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  // Store in memory
  inMemoryExportStore.set(token, {
    buffer: archiveBuffer,
    expiresAt: expiresAt.getTime(),
    userId,
  });

  // Also cache in Redis if available
  if (isRedisConfigured()) {
    try {
      const redis = getRedisClient();
      await redis.set(`privacy:export:${token}`, archiveBuffer.toString('base64'), 'EX', ttlSeconds);
      await redis.set(`privacy:export:user:${token}`, userId, 'EX', ttlSeconds);
    } catch (err) {
      logger.warn('[privacy-export] Failed to persist export in Redis, relying on in-memory store', { error: err });
    }
  }

  return { token, expiresAt };
}

/**
 * Retrieves the archive buffer associated with a download token.
 */
export async function getExportArchiveByToken(token: string): Promise<Buffer | null> {
  const mem = inMemoryExportStore.get(token);
  if (mem && mem.expiresAt > Date.now()) {
    return mem.buffer;
  }

  if (isRedisConfigured()) {
    try {
      const redis = getRedisClient();
      const b64 = await redis.get(`privacy:export:${token}`);
      if (b64) {
        return Buffer.from(b64, 'base64');
      }
    } catch (err) {
      logger.warn('[privacy-export] Failed to fetch export from Redis', { error: err });
    }
  }

  return null;
}

/**
 * Orchestrates export generation, storage, and notification to user via SSE.
 */
export async function generateAndNotifyDataExport(userId: string): Promise<{ token: string; downloadUrl: string; expiresAt: string }> {
  const { archiveBuffer, metadata } = await generateDataExport(userId);
  const { token, expiresAt } = await storeExportArchive(userId, archiveBuffer);
  const downloadUrl = `/api/v2/privacy/export/download/${token}`;

  try {
    await eventBus.publishEnvelope(userId, 'privacy.export_ready' as any, {
      downloadUrl,
      expiresAt: expiresAt.toISOString(),
      archiveBytes: archiveBuffer.length,
      categories: metadata.categories,
    });
    logger.info('[privacy-export] Dispatched privacy.export_ready SSE event', { userId, token });
  } catch (err) {
    logger.warn('[privacy-export] Failed to dispatch SSE notification', { userId, error: err });
  }

  return {
    token,
    downloadUrl,
    expiresAt: expiresAt.toISOString(),
  };
}
