// src/modules/interview/questionBank/index.ts
//
// Curated, versioned interview question bank plus the pure selection logic.
// Nothing in here touches the database or the network, so it can be used from
// the interview service (once it lands) and tested on its own.
import { readFileSync } from 'node:fs';
import {
  DIFFICULTY_LEVELS,
  interviewRoleSchema,
  questionBankSchema,
  type InterviewRole,
  type Question,
  type QuestionBank,
} from './question.schema.js';

export { INTERVIEW_ROLES, questionBankSchema, questionSchema } from './question.schema.js';
export type { InterviewRole, Question, QuestionBank } from './question.schema.js';

/**
 * Parse and validate a raw question bank. Throws a readable error listing every
 * problem, so a bad edit to v1.json fails the boot instead of a live interview.
 */
export function parseQuestionBank(raw: unknown): QuestionBank {
  const result = questionBankSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid interview question bank: ${details}`);
  }
  return result.data;
}

// Read with fs instead of a JSON import: the backend compiles to ES2022 modules,
// which have no import attributes, and fix-esm-imports.mjs copies v1.json to dist.
const rawBank: unknown = JSON.parse(
  readFileSync(new URL('./v1.json', import.meta.url), 'utf8'),
);

// Validated once at module load (boot time).
export const questionBank: QuestionBank = parseQuestionBank(rawBank);

/** Lower-case a gap label and collapse separators so "Distributed Caching" matches distributed_caching. */
export function normalizeTopicKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export interface SelectOptions {
  /** Question source, defaults to the bundled v1 bank. Mostly useful in tests. */
  bank?: QuestionBank;
  /**
   * Optional random source in [0, 1) used to break ties between equally good
   * candidates, so repeat interviews do not always get the same questions.
   * Without it ties are broken by questionId and the result is deterministic.
   */
  random?: () => number;
}

/**
 * Pick a 5-turn question plan for a role, biased toward the candidate's gaps.
 *
 * Turn N uses a difficulty N question (1 architecture and scope up to 5
 * observability and trade-offs), so the result is always ordered by difficulty.
 * At each level the candidates are scored, in this order of priority:
 *   1. how many gap topics the question covers that earlier turns have not,
 *   2. how many gap topics it matches in total,
 *   3. how little it repeats topics already used by earlier turns.
 * Anything still tied is broken by `random` if given, else by questionId.
 *
 * If a role has no question at some level (only possible with a custom bank),
 * that turn borrows the closest unused difficulty so the plan stays as full as
 * the role's questions allow.
 */
export function selectQuestionsForInterview(
  role: InterviewRole,
  userGaps: readonly string[],
  options: SelectOptions = {},
): Question[] {
  const parsedRole = interviewRoleSchema.safeParse(role);
  if (!parsedRole.success) {
    throw new Error(`Unknown interview role: ${String(role)}`);
  }

  const bank = options.bank ?? questionBank;
  const pool = bank.questions.filter((q) => q.role === parsedRole.data);
  const gaps = new Set(userGaps.map(normalizeTopicKey).filter((g) => g.length > 0));

  const picked: Question[] = [];
  const coveredGaps = new Set<string>();
  const usedTopics = new Set<string>();
  const usedIds = new Set<string>();

  for (const level of DIFFICULTY_LEVELS) {
    const candidates = candidatesForLevel(pool, level, usedIds);
    if (candidates.length === 0) continue;

    const scored = candidates.map((q) => {
      const gapMatches = q.topicKeys.filter((t) => gaps.has(t));
      return {
        q,
        newGaps: gapMatches.filter((t) => !coveredGaps.has(t)).length,
        totalGaps: gapMatches.length,
        repeats: q.topicKeys.filter((t) => usedTopics.has(t)).length,
        tie: options.random ? options.random() : 0,
      };
    });

    scored.sort(
      (a, b) =>
        b.newGaps - a.newGaps ||
        b.totalGaps - a.totalGaps ||
        a.repeats - b.repeats ||
        a.tie - b.tie ||
        a.q.questionId.localeCompare(b.q.questionId),
    );

    const chosen = scored[0]!.q;
    picked.push(chosen);
    usedIds.add(chosen.questionId);
    chosen.topicKeys.forEach((t) => {
      usedTopics.add(t);
      if (gaps.has(t)) coveredGaps.add(t);
    });
  }

  return picked
    .sort((a, b) => a.difficulty - b.difficulty)
    .map((q) => structuredClone(q));
}

/** Unused questions at `level`, or at the nearest level that still has any. */
function candidatesForLevel(pool: Question[], level: number, usedIds: Set<string>): Question[] {
  const unused = pool.filter((q) => !usedIds.has(q.questionId));
  const exact = unused.filter((q) => q.difficulty === level);
  if (exact.length > 0 || unused.length === 0) return exact;

  const nearest = Math.min(...unused.map((q) => Math.abs(q.difficulty - level)));
  return unused.filter((q) => Math.abs(q.difficulty - level) === nearest);
}
