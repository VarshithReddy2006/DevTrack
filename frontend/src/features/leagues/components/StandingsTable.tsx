import { Fragment, useEffect, useRef } from 'react';
import { ArrowUp, ArrowDown, Trophy } from 'lucide-react';
import type { CohortStandings, LeagueCohortMember, RankSnapshot } from '../types';
import {
  divisionLabel,
  formatPoints,
  memberName,
  rankChange,
  zoneForRank,
} from '../leagueUtils';
import { RankDelta } from './RankDelta';
import { WeekCountdown } from './WeekCountdown';

interface StandingsTableProps {
  view: CohortStandings;
  /** Ranks from an earlier look at this cohort; when given a change column is shown. */
  previousRanks?: RankSnapshot | null;
  onJoin?: () => void;
  joining?: boolean;
  onWeekEnd?: () => void;
}

function Avatar({ member }: { member: LeagueCohortMember }) {
  if (member.avatarUrl) {
    return <img src={member.avatarUrl} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" loading="lazy" />;
  }
  return (
    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold text-zinc-600">
      {memberName(member).charAt(0).toUpperCase()}
    </span>
  );
}

const ZONE_ROW_STYLE = {
  promotion: 'bg-emerald-50/40',
  safe: '',
  demotion: 'bg-red-50/40',
} as const;

const ZONE_LABEL = {
  promotion: 'Promotion zone',
  safe: '',
  demotion: 'Demotion zone',
} as const;

export function StandingsTable({ view, previousRanks, onJoin, joining = false, onWeekEnd }: StandingsTableProps) {
  const myRowRef = useRef<HTMLTableRowElement>(null);
  const showChange = Boolean(previousRanks);
  const columnCount = showChange ? 4 : 3;

  useEffect(() => {
    const row = myRowRef.current;
    // "nearest" leaves the page alone when the row is already on screen
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  }, [view.weekKey, view.cohortId, view.me?.rank]);

  if (!view.participating) {
    return (
      <section className="rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm" aria-labelledby="league-join-heading">
        <Trophy className="mx-auto h-8 w-8 text-amber-500" aria-hidden="true" />
        <h2 id="league-join-heading" className="mt-3 text-lg font-semibold text-zinc-900">You are not in a weekly league</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Join to compete with about 30 other developers on XP earned this week. The top players move up a division, the bottom ones move down.
        </p>
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={onJoin}
            disabled={joining || !onJoin}
            className="rounded-lg bg-[#12B76A] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0e9f5d] disabled:opacity-60"
          >
            {joining ? 'Joining...' : 'Join weekly league'}
          </button>
        </div>
        <div className="mt-4"><WeekCountdown resetsAt={view.resetsAt} onExpire={onWeekEnd} /></div>
      </section>
    );
  }

  const { standings, cohortSize, promotionSlots, demotionSlots } = view;
  const promotionEnd = promotionSlots > 0 ? promotionSlots : null;
  const demotionStart = demotionSlots > 0 ? cohortSize - demotionSlots + 1 : null;

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white shadow-sm" aria-labelledby="league-heading">
      <header className="flex flex-col gap-2 border-b border-zinc-200 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="league-heading" className="text-lg font-semibold text-zinc-900">{divisionLabel(view.division)} league</h2>
          <p className="text-sm text-zinc-600">
            {cohortSize} players
            {view.me && <> · You are #{view.me.rank} with {formatPoints(view.me.points)} XP</>}
          </p>
        </div>
        <WeekCountdown resetsAt={view.resetsAt} onExpire={onWeekEnd} />
      </header>

      {/* focusable so keyboard users can scroll a long table */}
      <div className="overflow-x-auto" role="region" aria-label="Weekly league standings, scrollable" tabIndex={0}>
        <table className="w-full min-w-[420px] border-collapse text-sm" aria-label="Weekly league standings">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
              <th scope="col" className="w-16 px-4 py-2 font-semibold">Rank</th>
              <th scope="col" className="px-4 py-2 font-semibold">User</th>
              <th scope="col" className="px-4 py-2 text-right font-semibold">Weekly XP</th>
              {showChange && <th scope="col" className="w-24 px-4 py-2 text-right font-semibold">Change</th>}
            </tr>
          </thead>
          <tbody>
            {standings.map((member) => {
              const zone = zoneForRank(member.rank, cohortSize, promotionSlots, demotionSlots);
              const change = showChange ? rankChange(previousRanks, member) : null;
              return (
                <Fragment key={member.userId}>
                  <tr
                    ref={member.isMe ? myRowRef : undefined}
                    aria-current={member.isMe ? 'true' : undefined}
                    data-zone={zone}
                    className={`border-t border-zinc-100 ${member.isMe ? 'bg-indigo-50 font-semibold ring-1 ring-inset ring-indigo-300' : ZONE_ROW_STYLE[zone]}`}
                  >
                    <th scope="row" className="px-4 py-2 text-left font-semibold tabular-nums text-zinc-900">
                      {member.rank}
                      {zone !== 'safe' && <span className="sr-only"> ({ZONE_LABEL[zone]})</span>}
                    </th>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-3">
                        <Avatar member={member} />
                        <div className="min-w-0">
                          <div className="truncate text-zinc-900">
                            {memberName(member)}
                            {member.isMe && <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-xs font-semibold text-indigo-800">You</span>}
                          </div>
                          {member.username && member.displayName && (
                            <div className="truncate text-xs font-normal text-zinc-500">@{member.username}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-900">{formatPoints(member.points)}</td>
                    {showChange && (
                      <td className="px-4 py-2 text-right">
                        {change === null ? <span className="text-zinc-400" aria-label="New this time">-</span> : <RankDelta delta={change} />}
                      </td>
                    )}
                  </tr>
                  {member.rank === promotionEnd && (
                    <tr data-separator="promotion">
                      <td colSpan={columnCount} className="border-t-2 border-dashed border-emerald-500 px-4 py-1 text-xs font-medium text-emerald-700">
                        <ArrowUp className="mr-1 inline h-3 w-3" aria-hidden="true" />
                        Promotion zone: top {promotionSlots} move up
                      </td>
                    </tr>
                  )}
                  {member.rank + 1 === demotionStart && (
                    <tr data-separator="demotion">
                      <td colSpan={columnCount} className="border-t-2 border-dashed border-red-500 px-4 py-1 text-xs font-medium text-red-700">
                        <ArrowDown className="mr-1 inline h-3 w-3" aria-hidden="true" />
                        Demotion zone: bottom {demotionSlots} move down
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
