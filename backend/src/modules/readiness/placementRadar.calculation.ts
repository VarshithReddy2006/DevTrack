export const RADAR_VERSION = "placement-radar-v1";
export type AxisKey =
  | "structures"
  | "algorithms"
  | "architecture"
  | "coreCs"
  | "behavioral";
export interface TopicEvidence {
  name: string;
  masteryLevel: number;
  evidenceCoverage: number;
  recency: Date;
}
export interface SystemDesignConceptInput {
  mastered: number;
  total: number;
  masteredTitles?: string[];
  lastUpdatedAt?: Date | null;
}

export interface CoreCsConceptInput {
  mastered: number;
  total: number;
  masteredTitles?: string[];
  optionalMastered?: number;
  optionalTotal?: number;
  lastUpdatedAt?: Date | null;
}

export interface RadarInput {
  topics: TopicEvidence[];
  architecture: { score: number; observedAt: Date; coverage: number } | null;
  systemDesignConcept?: SystemDesignConceptInput | null;
  coreCsConcept?: CoreCsConceptInput | null;
  contestRatings: number[];
  contestPlatforms?: Array<{ platform: string; rating: number }>;
  revision: { reviews: number; lapses: number };
  solveConsistency: number | null;
}
const TOPICS: Record<AxisKey, readonly string[]> = {
  structures: [
    "array",
    "arrays",
    "string",
    "strings",
    "linked list",
    "stack",
    "queue",
    "tree",
    "binary tree",
    "heap",
    "hash table",
    "graph",
    "trie",
  ],
  algorithms: [
    "dynamic programming",
    "greedy",
    "sorting",
    "binary search",
    "backtracking",
    "recursion",
    "two pointers",
    "sliding window",
    "divide and conquer",
    "breadth first search",
    "depth first search",
  ],
  coreCs: [
    "operating systems",
    "dbms",
    "databases",
    "computer networks",
    "oop",
    "object oriented programming",
  ],
  architecture: [],
  behavioral: [],
};
const LABELS: Record<AxisKey, string> = {
  structures: "Data structures",
  algorithms: "Algorithms",
  architecture: "System architecture",
  coreCs: "Core CS",
  behavioral: "Behavioral",
};
const percent = (n: number) => Number.isFinite(n) && n >= 0 && n <= 100;
const fresh = (date: Date, now: Date) =>
  date instanceof Date &&
  Number.isFinite(date.getTime()) &&
  date <= now &&
  now.getTime() - date.getTime() <= 7 * 86400000;
const normalize = (s: string) =>
  s.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
export function calculatePlacementRadar(input: RadarInput, now: Date) {
  const axes = (Object.keys(LABELS) as AxisKey[]).map((key) => {
    // Only explicit topic mappings qualify. A graph problem is not architecture evidence.
    const unique = new Map<string, TopicEvidence>();
    for (const topic of input.topics) {
      const name = normalize(topic.name);
      if (
        !TOPICS[key].includes(name) ||
        !percent(topic.masteryLevel) ||
        !percent(topic.evidenceCoverage) ||
        !topic.evidenceCoverage ||
        !fresh(topic.recency, now)
      )
        continue;
      const previous = unique.get(name);
      if (!previous || previous.recency < topic.recency)
        unique.set(name, topic);
    }
    const topics = [...unique.values()].sort(
      (a, b) => a.masteryLevel - b.masteryLevel || a.name.localeCompare(b.name),
    );
    let score: number | null = topics.length
      ? Math.round(
          topics.reduce((s, t) => s + t.masteryLevel, 0) / topics.length,
        )
      : null;
    let evidence = topics.map(
      (t) => `${t.name}: ${Math.round(t.masteryLevel)}/100`,
    );
    if (key === "architecture") {
      const hasProxy = Boolean(
        input.architecture &&
        percent(input.architecture.score) &&
        percent(input.architecture.coverage) &&
        input.architecture.coverage > 0 &&
        fresh(input.architecture.observedAt, now)
      );
      const sdConcept = input.systemDesignConcept;
      const sdTimeOk =
        !sdConcept?.lastUpdatedAt ||
        (sdConcept.lastUpdatedAt instanceof Date &&
          Number.isFinite(sdConcept.lastUpdatedAt.getTime()) &&
          sdConcept.lastUpdatedAt <= now);
      const hasSdConcepts = Boolean(
        sdConcept &&
        sdConcept.total > 0 &&
        sdConcept.mastered > 0 &&
        sdTimeOk
      );

      if (hasSdConcepts && sdConcept) {
        const conceptScore = Math.round((sdConcept.mastered / sdConcept.total) * 100);
        const topTitles = (sdConcept.masteredTitles ?? []).slice(0, 3);
        if (hasProxy && input.architecture) {
          score = Math.round(conceptScore * 0.65 + input.architecture.score * 0.35);
          evidence = [
            `System Design: ${sdConcept.mastered}/${sdConcept.total} concepts mastered`,
            ...topTitles,
            "Verified project architecture proxy",
          ];
        } else {
          score = conceptScore;
          evidence = [
            `System Design: ${sdConcept.mastered}/${sdConcept.total} concepts mastered`,
            ...topTitles,
          ];
        }
      } else if (hasProxy && input.architecture) {
        score = Math.round(input.architecture.score);
        evidence = [
          "Verified project architecture proxy; not a system-design interview grade",
        ];
      }
    }

    if (key === "coreCs" && input.coreCsConcept) {
      const cs = input.coreCsConcept;
      const csTimeOk =
        !cs.lastUpdatedAt ||
        (cs.lastUpdatedAt instanceof Date &&
          Number.isFinite(cs.lastUpdatedAt.getTime()) &&
          cs.lastUpdatedAt <= now);
      if (cs.total > 0 && cs.mastered > 0 && csTimeOk) {
        // Strictly compute Core CS score from core track only; Distributed Systems is optional bonus.
        const coreConceptScore = Math.round((cs.mastered / cs.total) * 100);
        score =
          score !== null ? Math.round((score + coreConceptScore) / 2) : coreConceptScore;
        const topTitles = (cs.masteredTitles ?? []).slice(0, 3);
        const bonusNote =
          cs.optionalMastered && cs.optionalMastered > 0
            ? [`Distributed Systems (Optional): ${cs.optionalMastered}/${cs.optionalTotal ?? cs.optionalMastered} explored`]
            : [];
        evidence = [
          ...evidence,
          `Core CS: ${cs.mastered}/${cs.total} fundamentals mastered`,
          ...topTitles,
          ...bonusNote,
        ];
      }
    }

    // Current interview reports grade coding/communication, not behavioral STAR answers.
    const gap =
      key === "behavioral"
        ? "No behavioral rubric source is available; coding interview grades are not substituted."
        : score === null
          ? "No fresh mapped evidence in the last seven days."
          : topics[0]
            ? `Lowest observed topic: ${topics[0].name}`
            : key === "coreCs" && input.coreCsConcept && input.coreCsConcept.mastered < input.coreCsConcept.total
              ? `${input.coreCsConcept.total - input.coreCsConcept.mastered} Core CS concepts remaining in /readiness/cs-distributed.`
              : key === "architecture" && input.systemDesignConcept && input.systemDesignConcept.mastered < input.systemDesignConcept.total
                ? `${input.systemDesignConcept.total - input.systemDesignConcept.mastered} System Design concepts remaining in /readiness/system-design.`
                : "Review architecture trade-offs with an interviewer.";
    return { key, label: LABELS[key], score, evidence, gap };
  });
  const priorities = [...axes]
    .sort(
      (a, b) => (a.score ?? -1) - (b.score ?? -1) || a.key.localeCompare(b.key),
    )
    .slice(0, 3);
  const tasks: Record<AxisKey, [string, string]> = {
    structures: [
      "Solve two problems on the weakest observed data structure",
      "Re-solve without notes and explain invariants",
    ],
    algorithms: [
      "Practice two problems on the weakest algorithm tag",
      "Compare time and space complexity of two approaches",
    ],
    architecture: [
      "Sketch a service with storage, cache and failure paths",
      "Explain scaling limits and failure trade-offs aloud",
    ],
    coreCs: [
      "Review one OS, database or networking concept",
      "Explain the concept and test it with five recall questions",
    ],
    behavioral: [
      "Draft a STAR story about a difficult collaboration",
      "Rehearse it with a peer and request specific feedback",
    ],
  };
  const plan = Array.from({ length: 7 }, (_, i) => {
    if (i === 6)
      return {
        day: 7,
        axis: null,
        minutes: 30,
        task: "Review the week, repeat weak questions, and refresh evidence. No score gain is guaranteed.",
      };
    const axis = priorities[i % priorities.length];
    return {
      day: i + 1,
      axis: axis.key,
      minutes: 30,
      task: `${tasks[axis.key][Math.floor(i / 3)]}. ${axis.score === null ? "Collect evidence before interpreting this axis." : axis.gap}`,
    };
  });
  const validRatings = input.contestRatings.filter(
    (n) => Number.isFinite(n) && n >= 0 && n <= 10000,
  );
  const validPlatforms = (input.contestPlatforms ?? []).filter(
    (c) => Number.isFinite(c.rating) && c.rating >= 0 && c.rating <= 10000,
  );
  const r = input.revision;
  return {
    version: RADAR_VERSION,
    generatedAt: now.toISOString(),
    axes,
    plan,
    coverage: axes.filter((a) => a.score !== null).length,
    signals: {
      contestRatings: validRatings,
      ...(validPlatforms.length > 0 ? { contestPlatforms: validPlatforms } : {}),
      retentionPercent:
        Number.isInteger(r.reviews) &&
        r.reviews > 0 &&
        Number.isInteger(r.lapses) &&
        r.lapses >= 0 &&
        r.lapses <= r.reviews
          ? Math.round(100 * (1 - r.lapses / r.reviews))
          : null,
      reviews7d: r.reviews,
      consistencyPercent:
        input.solveConsistency !== null && percent(input.solveConsistency)
          ? input.solveConsistency
          : null,
    },
    caveat:
      "Practice indicators, not hiring probabilities or employer-validated placement cutoffs. Missing evidence is unknown, not a zero grade.",
  };
}
