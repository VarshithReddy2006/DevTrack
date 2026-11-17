import type { ClientSession, Types } from 'mongoose';
import { FocusSession, UserXp, XpTransaction } from '../../db/models/index.js';

export async function ensureUserXp(userId: Types.ObjectId): Promise<void> {
  try {
    await UserXp.updateOne({ userId }, { $setOnInsert: { userId } }, { upsert: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000 || !await UserXp.exists({ userId })) throw error;
  }
}

export async function readFocusXpForDay(
  userId: Types.ObjectId, completedAt: Date, session: ClientSession,
): Promise<{ xpAwarded: number }[]> {
  const day = completedAt.toISOString().slice(0, 10);
  const start = new Date(day);
  const end = new Date(start.getTime() + 86_400_000);
  const reserved = await FocusSession.find({
    userId, status: 'completed', completedAt: { $gte: start, $lt: end }, 'xp.amount': { $gt: 0 },
  }).select('xp.amount').session(session).lean();
  const legacy = await XpTransaction.find({
    userId, sourceType: 'focus_session', sourceId: /^focus_/, xpAwarded: { $gt: 0 },
    $or: [
      { 'metadata.focusCompletionDay': day },
      { 'metadata.focusCompletionDay': { $exists: false }, createdAt: { $gte: start, $lt: end } },
    ],
  }).select('xpAwarded').session(session).lean();
  return [...reserved.map(row => ({ xpAwarded: row.xp!.amount })), ...legacy];
}
