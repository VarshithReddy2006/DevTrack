import { ReadinessDsa } from "../../db/models/readinessDsa.model.js";
import { loadReadinessScoreInputs } from "./readinessScore.service.js";
import { calculatePlacementRadar } from "./placementRadar.calculation.js";
export async function getPlacementRadar(userId: string, now = new Date()) {
  const [inputs, dsa] = await Promise.all([
    loadReadinessScoreInputs(userId, now),
    ReadinessDsa.findOne({ userId })
      .select({ topics: { $slice: 200 }, solveConsistency: 1, computedAt: 1 })
      .lean(),
  ]);
  const projects = inputs.projects;
  const dsaFresh =
    dsa &&
    dsa.computedAt <= now &&
    now.getTime() - dsa.computedAt.getTime() <= 7 * 86400000;
  return calculatePlacementRadar(
    {
      topics: dsaFresh ? dsa.topics : [],
      architecture: projects
        ? {
            score: projects.complexityMetrics.architectureSophistication,
            observedAt: projects.computedAt,
            coverage: projects.evidenceCoverage,
          }
        : null,
      contestRatings: inputs.contests.map((c) => c.rating),
      contestPlatforms: inputs.contests
        .filter((c) => typeof c.platform === "string" && c.platform.length > 0)
        .map((c) => ({ platform: c.platform as string, rating: c.rating })),
      revision: inputs.revision,
      solveConsistency: dsaFresh ? dsa.solveConsistency : null,
    },
    now,
  );
}
