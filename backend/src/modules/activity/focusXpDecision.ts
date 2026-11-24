export const FOCUS_HEARTBEAT_SECONDS = 60;
const MIN_PLANNED_SECONDS = 25 * 60;
const SESSION_XP = 50;
const DAILY_CAP_XP = 200;

interface FocusXpSession {
  plannedSec: number;
  activeSec: number;
  coveredHeartbeatIntervals: number;
}

export type FocusXpReason =
  | 'below_min_duration'
  | 'below_completion_threshold'
  | 'below_heartbeat_coverage'
  | 'daily_cap_reached'
  | 'qualified'
  | 'anti_gaming';

interface FocusXpDecision {
  qualified: boolean;
  xpAmount: number;
  reason: FocusXpReason;
  capApplied: boolean;
}

export function computeActiveSec(activeDurationMs: number): number {
  return activeDurationMs / 1000;
}

export function computeCoverage(activeSec: number, coveredIntervals: number): number {
  const expected = Math.ceil(activeSec / FOCUS_HEARTBEAT_SECONDS);
  return expected > 0 ? Math.min(1, coveredIntervals / expected) : 0;
}

export function decideFocusXp(
  session: FocusXpSession,
  todayPriorCompletedSessions: readonly { xpAwarded: number }[],
): FocusXpDecision {
  const { plannedSec, activeSec, coveredHeartbeatIntervals } = session;
  if (!Number.isFinite(plannedSec) || plannedSec < MIN_PLANNED_SECONDS) {
    return { qualified: false, xpAmount: 0, reason: 'below_min_duration', capApplied: false };
  }
  if (!Number.isFinite(activeSec) || activeSec * 10 < plannedSec * 9) {
    return { qualified: false, xpAmount: 0, reason: 'below_completion_threshold', capApplied: false };
  }
  if (!(computeCoverage(activeSec, coveredHeartbeatIntervals) >= 0.7)) {
    return { qualified: false, xpAmount: 0, reason: 'below_heartbeat_coverage', capApplied: false };
  }

  const alreadyAwarded = todayPriorCompletedSessions.reduce((total, session) => total + session.xpAwarded, 0);
  const xpAmount = Math.max(0, Math.min(SESSION_XP, DAILY_CAP_XP - alreadyAwarded));
  return { qualified: true, xpAmount, reason: xpAmount === 0 ? 'daily_cap_reached' : 'qualified',
    capApplied: xpAmount < SESSION_XP };
}
