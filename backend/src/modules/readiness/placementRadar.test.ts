import { describe, it, expect } from "vitest";
import {
  calculatePlacementRadar,
  type RadarInput,
} from "./placementRadar.calculation.js";
const now = new Date("2026-11-22T00:00:00Z");
const base: RadarInput = {
  topics: [],
  architecture: null,
  contestRatings: [],
  revision: { reviews: 0, lapses: 0 },
  solveConsistency: null,
};
describe("placement practice evidence", () => {
  it("keeps missing evidence unknown and never reuses coding grades for behavioral evidence", () => {
    const result = calculatePlacementRadar(base, now);
    expect(result.coverage).toBe(0);
    expect(result.axes.every((a) => a.score === null)).toBe(true);
    expect(result.plan).toHaveLength(7);
  });
  it("maps explicit topic tags, deduplicates latest evidence and rejects stale/future/invalid rows", () => {
    const t = (name: string, masteryLevel: number, recency = now) => ({
      name,
      masteryLevel,
      recency,
      evidenceCoverage: 80,
    });
    const result = calculatePlacementRadar(
      {
        ...base,
        topics: [
          t("array", 10, new Date(+now - 1000)),
          t("array", 70),
          t("dynamic-programming", 40),
          t("OS", 100),
          t("dbms", 90),
          t("tree", NaN),
          t("heap", 90, new Date(+now - 8 * 86400000)),
          t("graph", 99, new Date(+now + 1000)),
        ],
      },
      now,
    );
    expect(result.axes.map((a) => a.score)).toEqual([70, 40, null, 90, null]);
    expect(result.axes[1].gap).toContain("dynamic-programming");
  });
  it("separates architecture proxy from topic mastery and preserves zero evidence scores", () => {
    const result = calculatePlacementRadar(
      {
        ...base,
        architecture: { score: 0, observedAt: now, coverage: 50 },
        revision: { reviews: 10, lapses: 3 },
        contestRatings: [1200, -1, NaN, 10001],
        solveConsistency: 50,
      },
      now,
    );
    expect(result.axes[2].score).toBe(0);
    expect(result.axes[2].evidence[0]).toContain("proxy");
    expect(result.signals).toEqual({
      contestRatings: [1200],
      retentionPercent: 70,
      reviews7d: 10,
      consistencyPercent: 50,
    });
  });
  it("plans deterministic daily work and does not create retention from invalid counters", () => {
    const result = calculatePlacementRadar(
      { ...base, revision: { reviews: 3, lapses: 9 } },
      now,
    );
    expect(result.signals.retentionPercent).toBeNull();
    expect(result.plan.map((p) => p.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result).toEqual(
      calculatePlacementRadar(
        { ...base, revision: { reviews: 3, lapses: 9 } },
        now,
      ),
    );
  });
});
