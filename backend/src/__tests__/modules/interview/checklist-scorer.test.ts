import { describe, expect, it } from 'vitest';
import {
  buildChecklistFeedback,
  keywordStems,
  scoreChecklistSession,
  scoreChecklistTurn,
  stem,
} from '../../../modules/interview/scoring/checklistScorer.js';
import { questionBank } from '../../../modules/interview/questionBank/index.js';

const urlShortener = questionBank.questions.find(q => q.questionId === 'be-101')!;

const GOOD_ANSWER = `First I would clarify requirements: functional ones are create, redirect and expiry, plus custom aliases
and analytics; non-functional are p99 latency under 50 ms, availability and durability. Estimate: 100M new links a month is
about 40 writes per second, and with a 100:1 ratio about 4000 reads per second, so the system is read-heavy. For the short
code I would use a base62 encoding of a unique counter instead of hashing, because hashing needs collision handling. A 301
redirect is cacheable by browsers but hides repeat clicks from analytics, while 302 keeps analytics accurate, so I would pick
302 at the start. I would put a cache like Redis in front of a key-value store since the core path is a single key lookup.
For version one I leave out analytics dashboards and abuse detection.`;

describe('stemming and keywords', () => {
  it('maps inflections of a word to the same stem', () => {
    expect(new Set(['cache', 'caches', 'cached', 'caching'].map(stem)).size).toBe(1);
    expect(new Set(['retry', 'retries', 'retried', 'retrying'].map(stem)).size).toBe(1);
    expect(new Set(['queue', 'queues', 'queueing'].map(stem)).size).toBe(1);
    expect(stem('replication')).toBe(stem('replications'));
    expect(stem('cache')).not.toBe(stem('queue'));
  });

  it('drops stop words, checklist verbs and one or two letter words but keeps numbers', () => {
    const stems = keywordStems('Explains the 301 redirect and a CDN in an API');
    expect(stems).toEqual(new Set(['301', 'redire', 'cdn', 'api']));
  });
});

describe('scoreChecklistTurn', () => {
  it('covers every checklist item for a strong answer and scores it high', () => {
    const result = scoreChecklistTurn({ checklist: urlShortener.checklist, answer: GOOD_ANSWER });
    expect(result.coverage).toBe(1);
    expect(result.items.every(item => item.covered)).toBe(true);
    expect(result.scores.problemBreakdown).toBeGreaterThanOrEqual(90);
    expect(result.scores.communication).toBeGreaterThanOrEqual(80);
  });

  it('scores an off-topic answer at the floor', () => {
    const result = scoreChecklistTurn({ checklist: urlShortener.checklist, answer: 'I would paint the office walls blue and order pizza on Friday for the whole team.' });
    expect(result.coverage).toBe(0);
    expect(Object.values(result.scores).slice(0, 3)).toEqual([0, 0, 0]);
    expect(result.scores.communication).toBeLessThan(10);
  });

  it('gives empty or whitespace answers zero in every dimension', () => {
    for (const answer of ['', '   \n', null, undefined]) {
      expect(scoreChecklistTurn({ checklist: urlShortener.checklist, answer }).scores)
        .toEqual({ problemBreakdown: 0, technicalTradeoffs: 0, edgeCases: 0, communication: 0 });
    }
  });

  it('gives partial credit between the two extremes for a partly right answer', () => {
    const partial = 'I would estimate the write rate at about 40 per second and conclude it is read-heavy, then put a cache in front of the key-value store.';
    const result = scoreChecklistTurn({ checklist: urlShortener.checklist, answer: partial });
    expect(result.coverage).toBeGreaterThan(0);
    expect(result.coverage).toBeLessThan(1);
    const strong = scoreChecklistTurn({ checklist: urlShortener.checklist, answer: GOOD_ANSWER });
    expect(result.scores.problemBreakdown).toBeLessThan(strong.scores.problemBreakdown);
    expect(result.scores.problemBreakdown).toBeGreaterThan(0);
  });

  it('is deterministic and independent of letter case', () => {
    const a = scoreChecklistTurn({ checklist: urlShortener.checklist, answer: GOOD_ANSWER });
    const b = scoreChecklistTurn({ checklist: urlShortener.checklist, answer: GOOD_ANSWER.toUpperCase() });
    expect(scoreChecklistTurn({ checklist: urlShortener.checklist, answer: GOOD_ANSWER })).toEqual(a);
    expect(b.scores).toEqual(a.scores);
  });

  it('always returns scores inside 0-100', () => {
    const stuffed = Array(200).fill('trade-off versus failure retry idempotent timeout requirement estimate api schema first then finally').join(' ');
    const result = scoreChecklistTurn({ checklist: urlShortener.checklist, answer: stuffed });
    for (const value of Object.values(result.scores)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('copes with an empty checklist', () => {
    const result = scoreChecklistTurn({ checklist: [], answer: GOOD_ANSWER });
    expect(result.coverage).toBe(0);
    expect(result.items).toEqual([]);
  });
});

describe('question bank invariants', () => {
  it('counts every checklist item as covered when the answer restates it, for all questions', () => {
    for (const q of questionBank.questions) {
      const result = scoreChecklistTurn({ checklist: q.checklist, answer: q.checklist.join(' ') });
      expect(result.coverage, q.questionId).toBe(1);
    }
  });

  it('does not credit a generic unrelated answer on any question', () => {
    const unrelated = 'The weather was nice so we went for a long walk, ate lunch together and talked about holiday plans for next summer.';
    for (const q of questionBank.questions) {
      expect(scoreChecklistTurn({ checklist: q.checklist, answer: unrelated }).coverage, q.questionId).toBe(0);
    }
  });

  it('keeps another question\'s model answer well below full credit', () => {
    for (const q of questionBank.questions) {
      const other = questionBank.questions.find(o => o.role === q.role && o.questionId !== q.questionId && o.difficulty === q.difficulty);
      if (!other) continue;
      const result = scoreChecklistTurn({ checklist: q.checklist, answer: other.checklist.join(' ') });
      expect(result.coverage, `${other.questionId} answering ${q.questionId}`).toBeLessThan(0.7);
    }
  });
});

describe('buildChecklistFeedback', () => {
  it('reports the count, covered and missing points and one hint', () => {
    const score = scoreChecklistTurn({
      checklist: urlShortener.checklist,
      answer: 'I would estimate about 40 writes per second and say the system is read-heavy.',
    });
    const text = buildChecklistFeedback(urlShortener, score, 1);
    const covered = score.items.filter(i => i.covered).length;
    expect(text).toContain(`covered ${covered} of 6 expected points`);
    expect(text).toContain('Covered:');
    expect(text).toContain('Still missing:');
    expect(text).toContain(`Hint: ${urlShortener.hints[1]}`);
  });

  it('skips the missing and hint lines when everything was covered', () => {
    const text = buildChecklistFeedback(urlShortener, scoreChecklistTurn({ checklist: urlShortener.checklist, answer: GOOD_ANSWER }));
    expect(text).toContain('covered 6 of 6');
    expect(text).not.toContain('Still missing');
    expect(text).not.toContain('Hint:');
  });
});

describe('scoreChecklistSession', () => {
  const turns = [
    { checklist: urlShortener.checklist, answer: GOOD_ANSWER },
    { checklist: urlShortener.checklist, answer: null },
  ];

  it('averages the turns and counts an unanswered turn as zero', () => {
    const strong = scoreChecklistTurn(turns[0]!).scores;
    const card = scoreChecklistSession(turns);
    expect(card.scores.problemBreakdown).toBe(Math.round(strong.problemBreakdown / 2));
    expect(card.scores.edgeCases).toBe(Math.round(strong.edgeCases / 2));
  });

  it('lists covered points as strengths and missing ones as improvements, within the UI limits', () => {
    const card = scoreChecklistSession(turns);
    expect(card.strengths.length).toBeGreaterThan(0);
    expect(card.strengths.length).toBeLessThanOrEqual(5);
    expect(card.improvements.length).toBeLessThanOrEqual(5);
    expect(card.strengths.every(s => s.startsWith('Covered: ') && s.length <= 300)).toBe(true);
    expect(card.improvements).toContain('1 of 2 questions were left unanswered.');
  });

  it('suggests structuring answers when communication is weak', () => {
    const card = scoreChecklistSession([{ checklist: urlShortener.checklist, answer: 'Use a database.' }]);
    expect(card.scores.communication).toBeLessThan(40);
    expect(card.improvements.some(text => text.startsWith('Answers were short'))).toBe(true);
  });

  it('returns an all-zero card for no turns', () => {
    expect(scoreChecklistSession([]).scores).toEqual({ problemBreakdown: 0, technicalTradeoffs: 0, edgeCases: 0, communication: 0 });
  });
});
