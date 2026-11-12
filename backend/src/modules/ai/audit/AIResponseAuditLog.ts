import { isObjectIdOrHexString, type FilterQuery, type PipelineStage, type Types } from 'mongoose';
import { AIResponseAuditLog as AuditLogModel, type IAIResponseAuditLog } from '../../../db/models/aiResponseAuditLog.model.js';
import { escapeRegExp } from '../../../shared/regex.js';
import { logger } from '../../../shared/logger.js';

export interface AuditLogEntry {
  logId: string;
  userId: string;
  timestamp: Date;
  requestType: string;
  prompt: string;
  systemPrompt: string;
  model: string;
  provider: string;
  latency: number;
  tokensUsed: number;
  cached: boolean;
  contextVersion: string;
  responseConfidence: number;
  moderationFlags: string[];
  hallucinationFlags: string[];
  safetyViolations: string[];
  response: string;
  success: boolean;
  errorMessage?: string;
}

export interface AuditStats {
  totalRequests: number;
  totalTokens: number;
  averageLatency: number;
  cacheHitRate: number;
  moderationFlagCount: number;
  hallucinationFlagCount: number;
  safetyViolationCount: number;
  failureCount: number;
  byProvider: Record<string, {
    requests: number;
    tokens: number;
    latency: number;
  }>;
  byModel: Record<string, {
    requests: number;
    tokens: number;
    latency: number;
  }>;
}

type StoredEntry = Pick<IAIResponseAuditLog,
  'userId' | 'requestType' | 'model' | 'provider' | 'latencyMs' | 'tokensUsed' | 'cached' |
  'contextVersion' | 'responseConfidence' | 'moderationFlags' | 'hallucinationFlags' |
  'safetyViolations' | 'success' | 'createdAt'> & { _id: Types.ObjectId };

type Breakdown = AuditStats['byProvider'][string];
type Totals = Omit<AuditStats, 'byProvider' | 'byModel' | 'cacheHitRate'> & { cachedCount: number };

const flagFields = {
  moderation: 'moderationFlags',
  hallucination: 'hallucinationFlags',
  safety: 'safetyViolations',
} as const;
const timeframeHours = new Map([['hour', 1], ['day', 24], ['week', 168], ['month', 720]]);

function toEntry(record: StoredEntry): AuditLogEntry {
  return {
    logId: record._id.toHexString(),
    timestamp: record.createdAt,
    userId: record.userId,
    requestType: record.requestType ?? 'unknown',
    model: record.model ?? 'unknown',
    provider: record.provider,
    latency: record.latencyMs,
    tokensUsed: record.tokensUsed ?? 0,
    cached: record.cached ?? false,
    contextVersion: record.contextVersion ?? '',
    responseConfidence: record.responseConfidence ?? 0,
    moderationFlags: record.moderationFlags ?? [],
    hallucinationFlags: record.hallucinationFlags ?? [],
    safetyViolations: record.safetyViolations ?? [],
    success: record.success ?? true,
    prompt: '',
    systemPrompt: '',
    response: '',
  };
}

function breakdown(field: '$provider' | '$model'): PipelineStage.FacetPipelineStage[] {
  return [{
    $group: {
      _id: { $ifNull: [field, 'unknown'] },
      requests: { $sum: 1 },
      tokens: { $sum: '$tokensUsed' },
      latency: { $avg: '$latencyMs' },
    },
  }];
}

type AuditLogInput = Omit<AuditLogEntry, 'logId' | 'timestamp' | 'prompt' | 'systemPrompt' | 'response'>
  & Partial<Pick<AuditLogEntry, 'prompt' | 'systemPrompt' | 'response'>>;

export class AIResponseAuditLogClass {
  async log(entry: AuditLogInput): Promise<AuditLogEntry | undefined> {
    try {
      // Persist metadata only. Prompts, generated text and provider errors can contain user data.
      const record = await AuditLogModel.create({
        userId: entry.userId,
        requestType: entry.requestType,
        model: entry.model,
        provider: entry.provider,
        latencyMs: entry.latency,
        tokensUsed: entry.tokensUsed,
        cached: entry.cached,
        contextVersion: entry.contextVersion,
        responseConfidence: entry.responseConfidence,
        moderationFlags: entry.moderationFlags,
        hallucinationFlags: entry.hallucinationFlags,
        safetyViolations: entry.safetyViolations,
        success: entry.success,
      });
      return toEntry(record.toObject());
    } catch {
      logger.warn('[AIResponseAuditLog] Failed to persist audit entry');
      return undefined;
    }
  }

  async getEntry(logId: string): Promise<AuditLogEntry | undefined> {
    if (!isObjectIdOrHexString(logId)) return undefined;
    const record = await AuditLogModel.findById(logId).select('-prompt -response').lean<StoredEntry>();
    return record ? toEntry(record) : undefined;
  }

  getUserEntries(userId: string, limit = 100): Promise<AuditLogEntry[]> {
    return this.findEntries({ userId }, limit);
  }

  getEntriesByType(requestType: string, limit = 100): Promise<AuditLogEntry[]> {
    return this.findEntries({ requestType }, limit);
  }

  getFlaggedEntries(flagType: keyof typeof flagFields, limit = 100): Promise<AuditLogEntry[]> {
    return this.findEntries({ [flagFields[flagType] + '.0']: { $exists: true } }, limit);
  }

  getFailedEntries(limit = 100): Promise<AuditLogEntry[]> {
    return this.findEntries({ success: false }, limit);
  }

  getRecentEntries(limit = 50): Promise<AuditLogEntry[]> {
    return this.findEntries({}, limit);
  }

  search(query: string, limit = 100): Promise<AuditLogEntry[]> {
    const pattern = new RegExp(escapeRegExp(query), 'i');
    return this.findEntries({ $or: [{ requestType: pattern }, { userId: pattern }] }, limit);
  }

  private async findEntries(filter: FilterQuery<IAIResponseAuditLog>, limit: number): Promise<AuditLogEntry[]> {
    if (!Number.isFinite(limit) || limit < 1) return [];
    const records = await AuditLogModel.find(filter)
      .select('-prompt -response')
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.min(1000, Math.floor(limit)))
      .lean<StoredEntry[]>();
    return records.map(toEntry);
  }

  async calculateStats(timeframe?: string): Promise<AuditStats> {
    const hours = timeframe ? timeframeHours.get(timeframe) : undefined;
    const match = hours ? { createdAt: { $gte: new Date(Date.now() - hours * 60 * 60 * 1000) } } : {};
    const [result] = await AuditLogModel.aggregate<{
      totals: Totals[];
      providers: Array<Breakdown & { _id: string }>;
      models: Array<Breakdown & { _id: string }>;
    }>([
      { $match: match },
      {
        $facet: {
          totals: [{
            $group: {
              _id: null,
              totalRequests: { $sum: 1 },
              totalTokens: { $sum: '$tokensUsed' },
              averageLatency: { $avg: '$latencyMs' },
              cachedCount: { $sum: { $cond: [{ $eq: ['$cached', true] }, 1, 0] } },
              moderationFlagCount: { $sum: { $size: { $ifNull: ['$moderationFlags', []] } } },
              hallucinationFlagCount: { $sum: { $size: { $ifNull: ['$hallucinationFlags', []] } } },
              safetyViolationCount: { $sum: { $size: { $ifNull: ['$safetyViolations', []] } } },
              failureCount: { $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] } },
            },
          }],
          providers: breakdown('$provider'),
          models: breakdown('$model'),
        },
      },
    ]);
    const totals = result?.totals[0];
    return {
      totalRequests: totals?.totalRequests ?? 0,
      totalTokens: totals?.totalTokens ?? 0,
      averageLatency: Math.round(totals?.averageLatency ?? 0),
      cacheHitRate: totals ? Math.round((totals.cachedCount / totals.totalRequests) * 100) : 0,
      moderationFlagCount: totals?.moderationFlagCount ?? 0,
      hallucinationFlagCount: totals?.hallucinationFlagCount ?? 0,
      safetyViolationCount: totals?.safetyViolationCount ?? 0,
      failureCount: totals?.failureCount ?? 0,
      byProvider: Object.fromEntries((result?.providers ?? []).map(({ _id, ...stats }) => [_id, stats])),
      byModel: Object.fromEntries((result?.models ?? []).map(({ _id, ...stats }) => [_id, stats])),
    };
  }

  async clear(): Promise<void> {
    await AuditLogModel.deleteMany({});
  }

  async clearOldEntries(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { deletedCount } = await AuditLogModel.deleteMany({ createdAt: { $lt: cutoff } });
    return deletedCount;
  }

  getLogSize(): Promise<number> {
    return AuditLogModel.countDocuments().exec();
  }
}

export const AIResponseAuditLog = new AIResponseAuditLogClass();
