// In-memory InterviewSessionPort for tests. commitTurnResult / commitFinalResult apply the
// same compare-and-set guard the real adapter must (in_progress, SCORING, same turn, same
// version) and record every accepted write so tests can assert nothing was written.
import { selectQuestionsForInterview, type InterviewRole } from '../../../../modules/interview/questionBank/index.js';
import type { InterviewScorecard } from '../../../../modules/interview/interview.types.js';
import type {
  CommitResult,
  FinalResult,
  InterviewSessionPort,
  ScoringSession,
  TurnResult,
} from '../../../../modules/interview/workers/interviewSessionPort.js';

export interface StoredSession extends ScoringSession {
  scorecard?: InterviewScorecard | null;
  model?: string;
  promptVersion?: string;
}

export class MemorySessionPort implements InterviewSessionPort {
  readonly sessions = new Map<string, StoredSession>();
  /** Every accepted write, in order. */
  readonly writes: (TurnResult | FinalResult)[] = [];

  add(session: StoredSession): StoredSession {
    this.sessions.set(session.id, session);
    return session;
  }

  async load(sessionId: string): Promise<ScoringSession | null> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  private guard(result: TurnResult): StoredSession | null {
    const session = this.sessions.get(result.sessionId);
    if (
      !session || session.status !== 'in_progress' || session.state !== 'SCORING'
      || session.currentTurnIndex !== result.turnIndex || session.stateVersion !== result.expectedStateVersion
    ) return null;
    return session;
  }

  private apply(session: StoredSession, result: TurnResult) {
    session.turns[result.turnIndex]!.feedback = result.feedback;
    if (result.mode === 'basic_mode') session.mode = 'basic_mode';
    session.model = result.model;
    session.promptVersion = result.promptVersion;
    session.stateVersion += 1;
    this.writes.push(result);
  }

  async commitTurnResult(result: TurnResult): Promise<CommitResult> {
    const session = this.guard(result);
    if (!session) return 'stale';
    this.apply(session, result);
    session.state = 'QUESTION_PENDING';
    session.currentTurnIndex += 1;
    return 'applied';
  }

  async commitFinalResult(result: FinalResult): Promise<CommitResult> {
    const session = this.guard(result);
    if (!session) return 'stale';
    this.apply(session, result);
    session.state = 'COMPLETED';
    session.status = 'completed';
    session.scorecard = result.scorecard;
    return 'applied';
  }
}

/** A session that has just accepted the answer to `turnIndex` (state SCORING). */
export function scoringSession(overrides: Partial<StoredSession> & { answers?: string[] } = {}): StoredSession {
  const { answers = ['An answer to the first question.'], ...rest } = overrides;
  const role: InterviewRole = rest.role ?? 'backend';
  const plan = selectQuestionsForInterview(role, []);
  const turnIndex = rest.currentTurnIndex ?? answers.length - 1;
  return {
    id: 'session-1',
    userId: 'user-1',
    role,
    status: 'in_progress',
    state: 'SCORING',
    stateVersion: 4,
    currentTurnIndex: turnIndex,
    totalTurns: plan.length,
    turns: plan.map((question, index) => ({ question, answer: answers[index] ?? null, feedback: null })),
    ...rest,
  };
}
