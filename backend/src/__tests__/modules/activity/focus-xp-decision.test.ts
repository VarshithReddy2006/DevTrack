import { describe, expect, it } from 'vitest';
import { computeActiveSec, computeCoverage, decideFocusXp } from '../../../modules/activity/focusXpDecision.js';

const fullSession = { plannedSec: 1500, activeSec: 1500, coveredHeartbeatIntervals: 25 };

describe('focus XP decision', () => {
  it.each([
    [{ plannedSec: 1499 }, 'below_min_duration'],
    [{ plannedSec: NaN }, 'below_min_duration'],
    [{ activeSec: 1349.999 }, 'below_completion_threshold'],
    [{ activeSec: NaN }, 'below_completion_threshold'],
    [{ coveredHeartbeatIntervals: 17 }, 'below_heartbeat_coverage'],
  ])('rejects %j with %s', (patch, reason) => {
    expect(decideFocusXp({ ...fullSession, ...patch }, [])).toEqual({
      qualified: false, xpAmount: 0, reason, capApplied: false,
    });
  });

  it('uses precise active time and accepts exactly 90% completion', () => {
    expect(computeActiveSec(1349999)).toBe(1349.999);
    expect(decideFocusXp({ ...fullSession, activeSec: 1350, coveredHeartbeatIntervals: 17 }, []).xpAmount).toBe(50);
  });

  it('accepts exactly 70% coverage across active minutes', () => {
    expect(computeCoverage(0, 0)).toBe(0);
    expect(computeCoverage(1801, 21)).toBeCloseTo(21 / 31);
    expect(computeCoverage(60, 2)).toBe(1);
    expect(decideFocusXp({ plannedSec: 1800, activeSec: 1800, coveredHeartbeatIntervals: 21 }, []).xpAmount).toBe(50);
  });

  it.each([[150, 50, false], [175, 25, true], [200, 0, true], [250, 0, true]])(
    'awards %i prior XP only up to the daily cap',
    (prior, xpAmount, capApplied) => {
      expect(decideFocusXp(fullSession, [{ xpAwarded: 50 }, { xpAwarded: prior - 50 }])).toEqual({
        qualified: true, xpAmount, reason: xpAmount ? 'qualified' : 'daily_cap_reached', capApplied,
      });
    },
  );
});
