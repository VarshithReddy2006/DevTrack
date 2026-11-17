// src/modules/interview/questionBank/question.schema.ts
//
// Zod schema for the curated interview question bank (v1.json).
//
// packages/contracts is not on main yet, so the schema lives next to the bank
// for now. When the shared contracts package lands this file can move there and
// be re-exported from here.
import { z } from 'zod';

export const INTERVIEW_ROLES = [
  'backend',
  'distributed_systems',
  'frontend_architect',
  'fullstack',
] as const;

export type InterviewRole = (typeof INTERVIEW_ROLES)[number];

/**
 * Difficulty doubles as the interview turn a question is designed for:
 * 1 architecture and scope, 2 data flow and modelling, 3 bottlenecks and caching,
 * 4 failure modes and edge cases, 5 observability and trade-off retrospective.
 */
export const DIFFICULTY_LEVELS = [1, 2, 3, 4, 5] as const;

export const ROLE_ID_PREFIX: Record<InterviewRole, string> = {
  backend: 'be',
  distributed_systems: 'ds',
  frontend_architect: 'fe',
  fullstack: 'fs',
};

const TOPIC_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const QUESTION_ID_PATTERN = /^[a-z]{2}-[1-5]\d{2}$/;

const nonEmptyText = (min: number, max: number) => z.string().trim().min(min).max(max);

export const interviewRoleSchema = z.enum(INTERVIEW_ROLES);

export const questionSchema = z
  .object({
    questionId: z.string().regex(QUESTION_ID_PATTERN, 'expected an id like be-101'),
    role: interviewRoleSchema,
    difficulty: z.number().int().min(1).max(5),
    topicKeys: z
      .array(z.string().regex(TOPIC_KEY_PATTERN, 'topic keys are lower snake_case'))
      .min(1)
      .max(5),
    prompt: nonEmptyText(80, 1200),
    // Progressive: hints[0] is the lightest nudge, the last one gives the most away.
    hints: z.array(nonEmptyText(10, 400)).min(2).max(4),
    // Expected discussion points an evaluator should look for in the answer.
    checklist: z.array(nonEmptyText(10, 400)).min(4).max(8),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (new Set(q.topicKeys).size !== q.topicKeys.length) {
      ctx.addIssue({ code: 'custom', path: ['topicKeys'], message: 'topicKeys must be unique' });
    }
    // The id encodes role and difficulty (be-301 = backend, level 3) so a
    // copy-pasted entry with a stale id or level is caught at boot.
    const [prefix, digits] = q.questionId.split('-');
    if (prefix !== ROLE_ID_PREFIX[q.role]) {
      ctx.addIssue({
        code: 'custom',
        path: ['questionId'],
        message: `id prefix must be "${ROLE_ID_PREFIX[q.role]}" for role ${q.role}`,
      });
    }
    if (Number(digits![0]) !== q.difficulty) {
      ctx.addIssue({
        code: 'custom',
        path: ['questionId'],
        message: `id must start with difficulty digit ${q.difficulty}`,
      });
    }
  });

export type Question = z.infer<typeof questionSchema>;

export const questionBankSchema = z
  .object({
    version: z.literal(1),
    questions: z.array(questionSchema).min(1),
  })
  .strict()
  .superRefine((bank, ctx) => {
    const seen = new Set<string>();
    bank.questions.forEach((q, i) => {
      if (seen.has(q.questionId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['questions', i, 'questionId'],
          message: `duplicate questionId ${q.questionId}`,
        });
      }
      seen.add(q.questionId);
    });

    // Every role must be able to fill a full 5-turn plan, so each role needs at
    // least one question per difficulty level.
    for (const role of INTERVIEW_ROLES) {
      for (const level of DIFFICULTY_LEVELS) {
        if (!bank.questions.some((q) => q.role === role && q.difficulty === level)) {
          ctx.addIssue({
            code: 'custom',
            path: ['questions'],
            message: `role ${role} has no question at difficulty ${level}`,
          });
        }
      }
    }
  });

export type QuestionBank = z.infer<typeof questionBankSchema>;
