// src/modules/interview/scoring/checklistScorer.ts
//
// Deterministic "basic mode" scoring (Guardrail G8). Used when no AI key is configured, the
// daily quota is spent, or the model failed: the answer is matched against the question's
// curated checklist from the question bank. No network, no randomness, same input gives the
// same scorecard.
//
// How it works
//  1. Checklist items and answers are reduced to stems: lower-cased words with common
//     suffixes cut and the first six letters kept, so "caching", "cached" and "caches" meet.
//     Stop words and the verbs checklist items start with ("explains", "discusses") are dropped.
//  2. A checklist item counts as covered when the answer contains at least 40% of the item's
//     stems and at least two of them (or all of them for very short items).
//  3. Coverage (covered items / items) is combined per rubric dimension with keyword signals
//     of that dimension in the answer (scoping words, trade-off words, failure-mode words,
//     structure words and answer length):
//       problemBreakdown  = 70% coverage + 30% scoping signals
//       technicalTradeoffs = 50% coverage + 50% trade-off signals
//       edgeCases         = 50% coverage + 50% failure-mode signals
//       communication     = 60% length + 40% structure signals, scaled down when the
//                           answer is off topic (coverage below 50%)
//  4. The session scorecard is the mean of the per-turn scores; an unanswered turn is 0.
//
// This is intentionally coarse: it rewards naming the expected points and cannot judge
// whether an explanation is correct, which is why the result is labelled basic mode.
import {
  MAX_SCORECARD_ITEM_LENGTH,
  RUBRIC_DIMENSIONS,
  type InterviewScorecard,
  type RubricDimension,
} from '../interview.types.js';
import type { Question } from '../questionBank/index.js';

export const CHECKLIST_SCORER_VERSION = 'checklist-v1';
/** Stored as the "model" of a basic mode result. */
export const CHECKLIST_SCORER_MODEL = 'checklist-scorer';

const ITEM_COVERED_RATIO = 0.4;
const ITEM_COVERED_MIN_STEMS = 2;
/** Words at which an answer counts as fully developed for the length signal. */
const FULL_LENGTH_WORDS = 120;
const MAX_LISTED_ITEMS = 3;

const STOP_WORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have how if in into is it its not of on or so than that the their then there these they this those to was were what when where which while who will with would you your ' +
    // Verbs checklist items open with; a candidate does not need to repeat them.
    'states explains discusses names mentions describes identifies uses puts defines estimates scopes addresses considers proposes covers notes recognises recognizes lists shows picks chooses separates avoids ' +
    'before instead rather about also both each any all some such'
  ).split(' '),
);

const SUFFIXES = ['ations', 'ation', 'ments', 'ment', 'ities', 'ity', 'ings', 'ing', 'ied', 'ies', 'ed', 'es', 's', 'ly'];

/** Light stemmer: cut one common suffix, drop a trailing e/y/i, keep six letters. */
export function stem(word: string): string {
  let result = word.toLowerCase();
  for (const suffix of SUFFIXES) {
    if (result.endsWith(suffix) && result.length - suffix.length >= 4) {
      result = result.slice(0, -suffix.length);
      break;
    }
  }
  // Short words (api, cdn) keep their last letter; longer ones lose a trailing e, y or i.
  return (result.length > 4 ? result.replace(/[eyi]$/, '') : result).slice(0, 6);
}

/** Distinct stems of the meaningful words in a text. */
export function keywordStems(text: string): Set<string> {
  const stems = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word || STOP_WORDS.has(word)) continue;
    // Keep numbers like 301 or 99, drop other very short words.
    if (word.length < 3 && !/^\d+$/.test(word)) continue;
    stems.add(stem(word));
  }
  return stems;
}

// Signal phrases per dimension, matched as substrings of the lower-cased answer.
const SIGNALS: Record<Exclude<RubricDimension, never>, { phrases: string[]; target: number }> = {
  problemBreakdown: {
    target: 4,
    phrases: [
      'requirement', 'assum', 'scope', 'clarif', 'constraint', 'estimat', 'qps', 'throughput', 'capacity',
      'component', 'api', 'schema', 'data model', 'out of scope', 'version one', 'mvp', 'back-of-the-envelope',
      'functional', 'break down', 'first step',
    ],
  },
  technicalTradeoffs: {
    target: 4,
    phrases: [
      'trade-off', 'tradeoff', 'trade off', 'versus', ' vs ', 'instead of', 'alternative', 'downside', 'drawback',
      'pros and cons', 'at the cost', 'cost of', 'however', 'whereas', 'prefer', 'depends on', 'consistency',
      'latency', 'complexity', 'in exchange',
    ],
  },
  edgeCases: {
    target: 4,
    phrases: [
      'failure', 'fail', 'retry', 'retries', 'timeout', 'idempoten', 'duplicate', 'race', 'concurren', 'edge case',
      'what if', 'fallback', 'outage', 'overload', 'backpressure', 'dead letter', 'corrupt', 'partial', 'collision',
      'rate limit', 'poison', 'crash', 'recover', 'degrad',
    ],
  },
  communication: {
    target: 3,
    phrases: [
      'first', 'second', 'third', 'then', 'next', 'finally', 'because', 'therefore', 'so that', 'for example',
      'e.g.', 'in summary', 'to summarize', 'for instance', 'overall',
    ],
  },
};

function signalScore(answerLower: string, dimension: RubricDimension): number {
  const { phrases, target } = SIGNALS[dimension];
  const hits = phrases.filter((phrase) => answerLower.includes(phrase)).length;
  return Math.min(1, hits / target);
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export interface ChecklistItemResult {
  item: string;
  covered: boolean;
  /** Share of the item's stems found in the answer, 0 to 1. */
  ratio: number;
}

export interface ChecklistTurnScore {
  /** Covered items divided by checklist size, 0 to 1. */
  coverage: number;
  items: ChecklistItemResult[];
  scores: Record<RubricDimension, number>;
}

export interface ChecklistTurnInput {
  checklist: readonly string[];
  answer: string | null | undefined;
}

export function scoreChecklistTurn({ checklist, answer }: ChecklistTurnInput): ChecklistTurnScore {
  const text = (answer ?? '').trim();
  const answerStems = keywordStems(text);

  const items = checklist.map((item): ChecklistItemResult => {
    const itemStems = keywordStems(item);
    if (itemStems.size === 0 || answerStems.size === 0) return { item, covered: false, ratio: 0 };
    let matched = 0;
    for (const itemStem of itemStems) if (answerStems.has(itemStem)) matched++;
    const ratio = matched / itemStems.size;
    const covered = ratio >= ITEM_COVERED_RATIO && matched >= Math.min(ITEM_COVERED_MIN_STEMS, itemStems.size);
    return { item, covered, ratio };
  });

  const coverage = items.length ? items.filter((entry) => entry.covered).length / items.length : 0;

  if (!text) {
    return { coverage: 0, items, scores: { problemBreakdown: 0, technicalTradeoffs: 0, edgeCases: 0, communication: 0 } };
  }

  const lower = text.toLowerCase();
  const lengthSignal = Math.min(1, wordCount(text) / FULL_LENGTH_WORDS);
  const relevance = 0.5 + 0.5 * Math.min(1, coverage / 0.5);
  const toScore = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 100);

  return {
    coverage,
    items,
    scores: {
      problemBreakdown: toScore(0.7 * coverage + 0.3 * signalScore(lower, 'problemBreakdown')),
      technicalTradeoffs: toScore(0.5 * coverage + 0.5 * signalScore(lower, 'technicalTradeoffs')),
      edgeCases: toScore(0.5 * coverage + 0.5 * signalScore(lower, 'edgeCases')),
      communication: toScore((0.6 * lengthSignal + 0.4 * signalScore(lower, 'communication')) * relevance),
    },
  };
}

const clip = (text: string) =>
  text.length > MAX_SCORECARD_ITEM_LENGTH ? `${text.slice(0, MAX_SCORECARD_ITEM_LENGTH - 3)}...` : text;

/**
 * Short interviewer-style note for one turn in basic mode: how many expected points were hit,
 * which ones, which are still missing and (while something is missing) one hint.
 */
export function buildChecklistFeedback(
  question: Pick<Question, 'hints'>,
  score: ChecklistTurnScore,
  turnIndex = 0,
): string {
  const covered = score.items.filter((entry) => entry.covered);
  const missing = score.items.filter((entry) => !entry.covered).sort((a, b) => a.ratio - b.ratio);
  const lines = [
    `Basic mode review: your answer covered ${covered.length} of ${score.items.length} expected points for this question.`,
  ];
  if (covered.length) lines.push(`Covered: ${covered.slice(0, 2).map((entry) => entry.item).join(' ')}`);
  if (missing.length) {
    lines.push(`Still missing: ${missing.slice(0, 2).map((entry) => entry.item).join(' ')}`);
    const hint = question.hints[Math.min(turnIndex, question.hints.length - 1)] ?? question.hints[0];
    if (hint) lines.push(`Hint: ${hint}`);
  }
  return lines.join('\n');
}

/** Mean of the per-turn dimension scores; the list also carries the per-item feedback. */
export function scoreChecklistSession(turns: readonly ChecklistTurnInput[]): InterviewScorecard {
  const results = turns.map(scoreChecklistTurn);
  const scores = Object.fromEntries(
    RUBRIC_DIMENSIONS.map((dimension) => [
      dimension,
      results.length ? Math.round(results.reduce((sum, result) => sum + result.scores[dimension], 0) / results.length) : 0,
    ]),
  ) as InterviewScorecard['scores'];

  const allItems = results.flatMap((result) => result.items);
  const strengths = allItems
    .filter((entry) => entry.covered)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, MAX_LISTED_ITEMS)
    .map((entry) => clip(`Covered: ${entry.item}`));
  const improvements = allItems
    .filter((entry) => !entry.covered)
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, MAX_LISTED_ITEMS)
    .map((entry) => clip(`Not covered: ${entry.item}`));

  const answered = turns.filter((turn) => (turn.answer ?? '').trim());
  if (answered.length < turns.length) {
    improvements.push(`${turns.length - answered.length} of ${turns.length} questions were left unanswered.`);
  }
  if (scores.communication < 40 && answered.length) {
    improvements.push('Answers were short or unstructured: walk through requirements, design, trade-offs and failure modes in turn.');
  }

  return { scores, strengths, improvements };
}
