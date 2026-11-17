// src/__tests__/modules/interview/question-bank.test.ts
// Question bank content, boot-time schema validation and gap-driven selection.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  INTERVIEW_ROLES,
  normalizeTopicKey,
  parseQuestionBank,
  questionBank,
  selectQuestionsForInterview,
  type InterviewRole,
  type Question,
  type QuestionBank,
} from '../../../modules/interview/questionBank/index.js';

const PREFIX: Record<InterviewRole, string> = {
  backend: 'be',
  distributed_systems: 'ds',
  frontend_architect: 'fe',
  fullstack: 'fs',
};

function q(role: InterviewRole, difficulty: number, n: number, topicKeys: string[]): Question {
  return {
    questionId: `${PREFIX[role]}-${difficulty}0${n}`,
    role,
    difficulty,
    topicKeys,
    prompt: `Prompt for ${role} level ${difficulty} variant ${n}. `.padEnd(90, 'x'),
    hints: ['A first gentle nudge here.', 'A second, more direct hint.'],
    checklist: ['Covers point one', 'Covers point two', 'Covers point three', 'Covers point four'],
  };
}

/** Raw bank object that passes the schema: every role has one question per level. */
function validRaw(): { version: 1; questions: Question[] } {
  const questions: Question[] = [];
  for (const role of INTERVIEW_ROLES) {
    for (const level of [1, 2, 3, 4, 5]) questions.push(q(role, level, 1, [`topic_${level}`]));
  }
  return { version: 1, questions };
}

const roleQuestions = (role: InterviewRole) => questionBank.questions.filter((x) => x.role === role);

describe('question bank content (v1.json)', () => {
  it('has at least 40 questions and covers all four roles', () => {
    expect(questionBank.questions.length).toBeGreaterThanOrEqual(40);
    expect([...new Set(questionBank.questions.map((x) => x.role))].sort()).toEqual(
      [...INTERVIEW_ROLES].sort(),
    );
  });

  it('gives every role at least two questions at every difficulty level', () => {
    for (const role of INTERVIEW_ROLES) {
      for (const level of [1, 2, 3, 4, 5]) {
        const count = roleQuestions(role).filter((x) => x.difficulty === level).length;
        expect(count, `${role} level ${level}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('has unique ids and unique prompts', () => {
    const ids = questionBank.questions.map((x) => x.questionId);
    const prompts = questionBank.questions.map((x) => x.prompt);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  it('has progressive hints (at least two, none repeated) and a real checklist', () => {
    for (const item of questionBank.questions) {
      expect(new Set(item.hints).size, item.questionId).toBe(item.hints.length);
      expect(item.hints.length, item.questionId).toBeGreaterThanOrEqual(2);
      expect(item.checklist.length, item.questionId).toBeGreaterThanOrEqual(4);
    }
  });

  it('is exactly what the file on disk contains', () => {
    const onDisk = JSON.parse(
      readFileSync(
        new URL('../../../modules/interview/questionBank/v1.json', import.meta.url),
        'utf8',
      ),
    );
    expect(parseQuestionBank(onDisk)).toEqual(questionBank);
  });
});

describe('parseQuestionBank (boot-time validation)', () => {
  it('accepts a well formed bank', () => {
    expect(parseQuestionBank(validRaw()).questions).toHaveLength(20);
  });

  it('rejects an unknown role', () => {
    const raw = validRaw() as any;
    raw.questions[0].role = 'devops';
    expect(() => parseQuestionBank(raw)).toThrow(/Invalid interview question bank/);
  });

  it.each([0, 6, 2.5])('rejects difficulty %s', (difficulty) => {
    const raw = validRaw() as any;
    raw.questions[0].difficulty = difficulty;
    expect(() => parseQuestionBank(raw)).toThrow(/Invalid interview question bank/);
  });

  it('rejects a duplicate questionId and names it', () => {
    const raw = validRaw();
    raw.questions.push({ ...raw.questions[0]! });
    expect(() => parseQuestionBank(raw)).toThrow(/duplicate questionId be-101/);
  });

  it('rejects an id whose prefix or level digit disagrees with role and difficulty', () => {
    const wrongPrefix = validRaw();
    wrongPrefix.questions[0]!.questionId = 'ds-101';
    expect(() => parseQuestionBank(wrongPrefix)).toThrow(/id prefix must be "be"/);

    const wrongLevel = validRaw();
    wrongLevel.questions[0]!.questionId = 'be-301';
    expect(() => parseQuestionBank(wrongLevel)).toThrow(/difficulty digit 1/);
  });

  it('rejects topic keys that are not snake_case or are repeated', () => {
    const bad = validRaw();
    bad.questions[0]!.topicKeys = ['Database Indexing'];
    expect(() => parseQuestionBank(bad)).toThrow(/lower snake_case/);

    const repeated = validRaw();
    repeated.questions[0]!.topicKeys = ['caching', 'caching'];
    expect(() => parseQuestionBank(repeated)).toThrow(/topicKeys must be unique/);
  });

  it('rejects missing or too thin hints, checklist and prompt', () => {
    const noHints = validRaw();
    noHints.questions[0]!.hints = [];
    expect(() => parseQuestionBank(noHints)).toThrow(/hints/);

    const shortChecklist = validRaw();
    shortChecklist.questions[0]!.checklist = ['one', 'two'];
    expect(() => parseQuestionBank(shortChecklist)).toThrow(/checklist/);

    const shortPrompt = validRaw();
    shortPrompt.questions[0]!.prompt = 'What is an API?';
    expect(() => parseQuestionBank(shortPrompt)).toThrow(/prompt/);
  });

  it('rejects unknown fields so typos in the JSON do not pass silently', () => {
    const raw = validRaw() as any;
    raw.questions[0].difficulity = 3;
    expect(() => parseQuestionBank(raw)).toThrow(/Invalid interview question bank/);
  });

  it('rejects a bank where a role cannot fill every difficulty level', () => {
    const raw = validRaw();
    raw.questions = raw.questions.filter((x) => !(x.role === 'fullstack' && x.difficulty === 4));
    expect(() => parseQuestionBank(raw)).toThrow(/role fullstack has no question at difficulty 4/);
  });

  it('rejects the wrong version and non-object input', () => {
    expect(() => parseQuestionBank({ ...validRaw(), version: 2 })).toThrow();
    expect(() => parseQuestionBank(null)).toThrow(/Invalid interview question bank/);
  });
});

describe('selectQuestionsForInterview', () => {
  it.each(INTERVIEW_ROLES)('returns 5 questions of role %s ordered by difficulty 1 to 5', (role) => {
    const plan = selectQuestionsForInterview(role, []);
    expect(plan.map((x) => x.difficulty)).toEqual([1, 2, 3, 4, 5]);
    expect(plan.every((x) => x.role === role)).toBe(true);
    expect(new Set(plan.map((x) => x.questionId)).size).toBe(5);
  });

  it('is deterministic without gaps and without a random source', () => {
    const a = selectQuestionsForInterview('backend', []);
    const b = selectQuestionsForInterview('backend', []);
    expect(a.map((x) => x.questionId)).toEqual(b.map((x) => x.questionId));
  });

  it('prefers questions on gap topics over the default pick', () => {
    const baseline = selectQuestionsForInterview('backend', []);
    // be-402 (concurrency) and be-302 (caching) are not the id-order defaults at their level.
    const plan = selectQuestionsForInterview('backend', ['concurrency', 'caching']);
    const ids = plan.map((x) => x.questionId);
    expect(ids).toContain('be-402');
    expect(ids).toContain('be-302');
    expect(baseline.map((x) => x.questionId)).not.toEqual(ids);
  });

  it('puts a gap topic into the plan for every topic in the bank', () => {
    for (const role of INTERVIEW_ROLES) {
      const topics = new Set(roleQuestions(role).flatMap((x) => x.topicKeys));
      for (const topic of topics) {
        const plan = selectQuestionsForInterview(role, [topic]);
        expect(
          plan.some((x) => x.topicKeys.includes(topic)),
          `${role} / ${topic}`,
        ).toBe(true);
      }
    }
  });

  it('spreads several gaps over different turns instead of stacking one topic', () => {
    // caching lives at level 3, concurrency at level 4 and observability at level 5,
    // so all three gaps can be covered in one plan.
    const plan = selectQuestionsForInterview('backend', ['caching', 'concurrency', 'observability']);
    const ids = plan.map((x) => x.questionId);
    expect(ids).toEqual(expect.arrayContaining(['be-302', 'be-402', 'be-501']));
  });

  it('prefers a question covering more gap topics when levels tie', () => {
    const plan = selectQuestionsForInterview('distributed_systems', ['retries_backoff', 'backpressure']);
    // ds-402 matches both gaps, the other level 4 questions match none or one.
    expect(plan.find((x) => x.difficulty === 4)?.questionId).toBe('ds-402');
  });

  it('matches gap labels regardless of case, spaces and dashes', () => {
    const viaLabel = selectQuestionsForInterview('distributed_systems', ['Distributed Caching']);
    const viaKey = selectQuestionsForInterview('distributed_systems', ['distributed_caching']);
    expect(viaLabel.map((x) => x.questionId)).toEqual(viaKey.map((x) => x.questionId));
    expect(viaLabel.map((x) => x.questionId)).toContain('ds-301');
    expect(normalizeTopicKey('  Database-Indexing ')).toBe('database_indexing');
  });

  it('ignores gaps that match nothing and empty strings', () => {
    const none = selectQuestionsForInterview('fullstack', []);
    const noise = selectQuestionsForInterview('fullstack', ['quantum_computing', '', '   ']);
    expect(noise.map((x) => x.questionId)).toEqual(none.map((x) => x.questionId));
  });

  it('only biases within the requested role', () => {
    // websockets_scaling only exists in fullstack questions, so it must not leak in.
    const plan = selectQuestionsForInterview('backend', ['websockets_scaling']);
    expect(plan.every((x) => x.role === 'backend')).toBe(true);
  });

  it('keeps difficulty order even when gaps pull from late levels', () => {
    const plan = selectQuestionsForInterview('frontend_architect', ['design_systems', 'security', 'cdn']);
    expect(plan.map((x) => x.difficulty)).toEqual([1, 2, 3, 4, 5]);
    expect(plan.map((x) => x.questionId)).toEqual(
      expect.arrayContaining(['fe-502', 'fe-403', 'fe-301']),
    );
  });

  it('uses the random source only to break ties and stays valid', () => {
    const gaps = ['caching'];
    const seen = new Set<string>();
    for (let seed = 0; seed < 8; seed++) {
      let state = seed + 1;
      const random = () => {
        state = (state * 48271) % 2147483647;
        return state / 2147483647;
      };
      const plan = selectQuestionsForInterview('backend', gaps, { random });
      expect(plan.map((x) => x.difficulty)).toEqual([1, 2, 3, 4, 5]);
      // The gap-matching question at level 3 always wins regardless of randomness.
      expect(plan[2]!.questionId).toBe('be-302');
      seen.add(plan.map((x) => x.questionId).join(','));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('returns copies so callers cannot mutate the shared bank', () => {
    const plan = selectQuestionsForInterview('backend', []);
    plan[0]!.hints.push('tampered');
    plan[0]!.topicKeys.length = 0;
    const again = selectQuestionsForInterview('backend', []);
    expect(again[0]!.hints).not.toContain('tampered');
    expect(again[0]!.topicKeys.length).toBeGreaterThan(0);
  });

  it('does not mutate the gaps argument', () => {
    const gaps = Object.freeze(['Caching', 'concurrency']);
    expect(() => selectQuestionsForInterview('backend', gaps)).not.toThrow();
  });

  it('throws on an unknown role', () => {
    expect(() => selectQuestionsForInterview('devops' as InterviewRole, [])).toThrow(/Unknown interview role/);
  });

  describe('role with few matches', () => {
    it('returns fewer than 5 without duplicates when the role has fewer questions', () => {
      const bank: QuestionBank = {
        version: 1,
        questions: [q('backend', 1, 1, ['a']), q('backend', 3, 1, ['b']), q('backend', 5, 1, ['c'])],
      };
      const plan = selectQuestionsForInterview('backend', ['b'], { bank });
      expect(plan.map((x) => x.questionId)).toEqual(['be-101', 'be-301', 'be-501']);
    });

    it('borrows the nearest unused difficulty when a level is missing', () => {
      const bank: QuestionBank = {
        version: 1,
        questions: [
          q('fullstack', 1, 1, ['a']),
          q('fullstack', 2, 1, ['b']),
          q('fullstack', 4, 1, ['c']),
          q('fullstack', 4, 2, ['d']),
          q('fullstack', 5, 1, ['e']),
        ],
      };
      const plan = selectQuestionsForInterview('fullstack', [], { bank });
      expect(plan).toHaveLength(5);
      expect(new Set(plan.map((x) => x.questionId)).size).toBe(5);
      expect(plan.map((x) => x.difficulty)).toEqual([1, 2, 4, 4, 5]);
    });

    it('returns an empty plan for a role with no questions', () => {
      const bank: QuestionBank = { version: 1, questions: [q('backend', 1, 1, ['a'])] };
      expect(selectQuestionsForInterview('fullstack', ['a'], { bank })).toEqual([]);
    });

    it('still prefers gap topics when a level has several candidates', () => {
      const bank: QuestionBank = {
        version: 1,
        questions: [
          q('backend', 1, 1, ['x']),
          q('backend', 2, 1, ['y']),
          q('backend', 3, 1, ['z']),
          q('backend', 3, 2, ['target']),
          q('backend', 4, 1, ['w']),
          q('backend', 5, 1, ['v']),
        ],
      };
      expect(selectQuestionsForInterview('backend', [], { bank })[2]!.questionId).toBe('be-301');
      expect(selectQuestionsForInterview('backend', ['target'], { bank })[2]!.questionId).toBe('be-302');
    });
  });
});
