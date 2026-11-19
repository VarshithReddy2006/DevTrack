import { Types, type ClientSession } from 'mongoose';
import { z } from 'zod';
import { Quest, type IQuest } from '../../db/models/quest.model.js';
import { UserQuestProgress } from '../../db/models/userQuestProgress.model.js';
import { LeagueStanding, LEAGUE_DIVISIONS, type LeagueDivision } from '../../db/models/leagueStanding.model.js';
import { User } from '../../db/models/user.model.js';
import { UserXp } from '../../db/models/userXp.model.js';
import { runInTransaction } from '../../db/transaction.js';
import { weekKeyFor, weekRange, previousWeekKey } from '../leagues/weeks.js';

export const questObjectId = z.string().regex(/^[a-fA-F0-9]{24}$/);
export const questError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode, code: 'QUEST_ERROR' });

export function questPeriods(now: Date) {
  const dailyStart = new Date(now.toISOString().slice(0, 10));
  const weekly = weekRange(weekKeyFor(now));
  return {
    daily: { periodKey: 'daily:' + dailyStart.toISOString().slice(0, 10), startsAt: dailyStart, expiresAt: new Date(+dailyStart + 86_400_000) },
    weekly: { periodKey: 'weekly:' + weekKeyFor(now), startsAt: weekly.start, expiresAt: weekly.end },
  };
}

export function questDefinitions(division: LeagueDivision): IQuest[] {
  const tier = LEAGUE_DIVISIONS.indexOf(division);
  const goals = [
    ['daily', 'dsa_solve', 2 + tier, 'distinct problems'],
    ['daily', 'focus_minutes', 30 + tier * 10, 'qualified focus minutes'],
    ['daily', 'revision_review', 10 + tier * 2, 'flashcards'],
    ['weekly', 'dsa_solve', 10 + tier * 5, 'distinct problems'],
    ['weekly', 'focus_minutes', 150 + tier * 30, 'qualified focus minutes'],
  ] as const;
  return goals.map(([cadence, kind, targetCount, label]) => ({
    key: `v1:${division}:${cadence}:${kind}`, slot: `${cadence}:${kind}`, cadence, division, kind,
    title: `${kind === 'dsa_solve' ? 'Solve' : kind === 'focus_minutes' ? 'Complete' : 'Review'} ${targetCount} ${label}`,
    targetCount, xpReward: cadence === 'daily' ? 20 + tier * 5 : 100 + tier * 25,
    trophyReward: cadence === 'daily' ? 1 : 5 + tier,
  }));
}

// First-time unique-key races abort a transaction; retry the whole unit against
// the committed winner. Other failures must propagate rather than lose progress.
export async function questTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await runInTransaction(work); }
    catch (error) { if ((error as { code?: number }).code !== 11000 || attempt >= 3) throw error; }
  }
}

export async function generateUserQuests(userId: string, now = new Date(), cadence?: 'daily' | 'weekly') {
  questObjectId.parse(userId);
  const periods = questPeriods(now);
  const filter = { userId, periodKey: { $in: [periods.daily.periodKey, periods.weekly.periodKey] } };
  const existing = await UserQuestProgress.find(filter).sort({ cadence: 1, slot: 1 }).lean();
  const slots = questDefinitions('bronze').filter(item => !cadence || item.cadence === cadence).map(item => item.slot);
  if (slots.every(slot => existing.some(row => row.slot === slot))) return existing;
  const active = await LeagueStanding.findOne({ userId, weekKey: weekKeyFor(now) }).lean();
  if (!active && await LeagueStanding.exists({ userId, weekKey: previousWeekKey(weekKeyFor(now)), status: 'active' })) {
    throw questError(503, 'League rollover is pending; retry quest generation');
  }
  const previous = active ? null : await LeagueStanding.findOne({ userId, status: 'finalized' }).sort({ weekKey: -1 }).lean();
  const division = active?.division ?? previous?.nextDivision ?? 'bronze';
  const definitions = questDefinitions(division).filter(item => !cadence || item.cadence === cadence);
  const templates: Array<(IQuest & { _id: Types.ObjectId; __v?: number }) | null> = [];
  for (const definition of definitions) {
    try {
      templates.push(await Quest.findOneAndUpdate({ key: definition.key }, { $setOnInsert: definition }, { upsert: true, new: true }).lean());
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      templates.push(await Quest.findOne({ key: definition.key }).lean());
    }
  }
  await questTransaction(async session => {
    for (const template of templates) {
      if (!template) throw new Error('Quest definition missing');
      const { _id, key: _key, __v: _version, ...snapshot } = template;
      const period = periods[template.cadence];
      await UserQuestProgress.updateOne({ userId, slot: template.slot, periodKey: period.periodKey }, {
        $setOnInsert: { ...snapshot, userId: new Types.ObjectId(userId), questId: _id, ...period },
      }, { upsert: true, session });
    }
  });
  return UserQuestProgress.find({ userId, periodKey: { $in: [periods.daily.periodKey, periods.weekly.periodKey] } }).sort({ cadence: 1, slot: 1 }).lean();
}

export async function listUserQuests(userId: string, now = new Date()) {
  const rows = await generateUserQuests(userId, now);
  const wallet = await UserXp.findOne({ userId }).select('leagueTrophies').lean();
  return {
    serverTime: now.toISOString(), leagueTrophies: wallet?.leagueTrophies ?? 0,
    quests: rows.map(row => ({
      questId: row._id.toString(), definitionId: row.questId.toString(), periodKey: row.periodKey,
      cadence: row.cadence, division: row.division, kind: row.kind, title: row.title,
      targetCount: row.targetCount, currentCount: row.currentCount, completed: row.completed,
      claimed: row.claimed, completedAt: row.completedAt, claimedAt: row.claimedAt,
      startsAt: row.startsAt, expiresAt: row.expiresAt, xpReward: row.xpReward, trophyReward: row.trophyReward,
    })),
  };
}

export async function runQuestGenerationSweep(now = new Date()) {
  let users = 0;
  for await (const user of User.find().select('_id').lean().cursor({ batchSize: 100 })) {
    await generateUserQuests(user._id.toString(), now);
    users++;
  }
  return { users };
}
