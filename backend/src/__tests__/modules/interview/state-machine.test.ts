import { describe, expect, it } from 'vitest';
import { INTERVIEW_STATES } from '../../../modules/interview/interview.types.js';
import {
  INTERVIEW_EVENTS,
  IllegalTransitionError,
  InterviewError,
  StateVersionConflictError,
  allowedEvents,
  assertOpen,
  assertStateVersion,
  canTransition,
  isTerminalState,
  transition,
  transitionPath,
  type InterviewEvent,
} from '../../../modules/interview/stateMachine.js';
import type { InterviewState } from '../../../modules/interview/interview.types.js';

const VALID: [InterviewState, InterviewEvent, InterviewState][] = [
  ['START', 'BEGIN', 'QUESTION_PENDING'],
  ['START', 'ABANDON', 'COMPLETED'],
  ['START', 'SWEEP', 'COMPLETED'],
  ['QUESTION_PENDING', 'SUBMIT_ANSWER', 'SCORING'],
  ['QUESTION_PENDING', 'REQUEST_HINT', 'QUESTION_PENDING'],
  ['QUESTION_PENDING', 'ABANDON', 'COMPLETED'],
  ['QUESTION_PENDING', 'SWEEP', 'COMPLETED'],
  ['SCORING', 'SCORED_NEXT', 'NEXT_QUESTION'],
  ['SCORING', 'SCORED_FINAL', 'FINAL_SCORECARD'],
  ['SCORING', 'SWEEP', 'COMPLETED'],
  ['NEXT_QUESTION', 'ADVANCE', 'QUESTION_PENDING'],
  ['NEXT_QUESTION', 'ABANDON', 'COMPLETED'],
  ['NEXT_QUESTION', 'SWEEP', 'COMPLETED'],
  ['FINAL_SCORECARD', 'COMPLETE', 'COMPLETED'],
  ['FINAL_SCORECARD', 'SWEEP', 'COMPLETED'],
];

describe('interview state machine: transitions', () => {
  it.each(VALID)('%s + %s -> %s', (from, event, to) => {
    expect(canTransition(from, event)).toBe(true);
    expect(transition(from, event)).toBe(to);
  });

  it('rejects every state/event pair that is not in the table, naming both in the error', () => {
    const valid = new Set(VALID.map(([from, event]) => `${from}:${event}`));
    let checked = 0;
    for (const state of INTERVIEW_STATES) {
      for (const event of INTERVIEW_EVENTS) {
        if (valid.has(`${state}:${event}`)) continue;
        checked++;
        expect(canTransition(state, event)).toBe(false);
        expect(() => transition(state, event)).toThrow(IllegalTransitionError);
        expect(() => transition(state, event)).toThrow(new RegExp(`${event}.*${state}`));
      }
    }
    // 6 states x 9 events minus the 15 legal pairs.
    expect(checked).toBe(INTERVIEW_STATES.length * INTERVIEW_EVENTS.length - VALID.length);
  });

  it('gives an actionable 409 for an illegal move', () => {
    try {
      transition('SCORING', 'SUBMIT_ANSWER');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InterviewError);
      expect(error).toMatchObject({ statusCode: 409, code: 'illegal_state_transition' });
      expect((error as Error).message).toContain('Allowed events: SCORED_NEXT, SCORED_FINAL, SWEEP');
    }
  });

  it('says a finished interview is finished', () => {
    expect(() => transition('COMPLETED', 'BEGIN')).toThrow(/already finished/);
  });

  it('cannot abandon while an answer is being scored or the scorecard is being written', () => {
    expect(canTransition('SCORING', 'ABANDON')).toBe(false);
    expect(canTransition('FINAL_SCORECARD', 'ABANDON')).toBe(false);
  });

  it('only COMPLETED is terminal', () => {
    expect(INTERVIEW_STATES.filter(isTerminalState)).toEqual(['COMPLETED']);
    expect(allowedEvents('COMPLETED')).toEqual([]);
  });

  it('follows the full happy path for five questions', () => {
    let state: InterviewState = 'START';
    state = transition(state, 'BEGIN');
    for (let turn = 0; turn < 4; turn++) {
      state = transition(state, 'SUBMIT_ANSWER');
      state = transition(state, 'SCORED_NEXT');
      state = transition(state, 'ADVANCE');
      expect(state).toBe('QUESTION_PENDING');
    }
    state = transition(state, 'SUBMIT_ANSWER');
    state = transition(state, 'SCORED_FINAL');
    state = transition(state, 'COMPLETE');
    expect(state).toBe('COMPLETED');
  });

  it('transitionPath validates each hop and fails on the first illegal one', () => {
    expect(transitionPath('SCORING', ['SCORED_NEXT', 'ADVANCE'])).toBe('QUESTION_PENDING');
    expect(transitionPath('SCORING', ['SCORED_FINAL', 'COMPLETE'])).toBe('COMPLETED');
    expect(transitionPath('START', [])).toBe('START');
    expect(() => transitionPath('SCORING', ['SCORED_NEXT', 'COMPLETE'])).toThrow(/COMPLETE.*NEXT_QUESTION/);
  });
});

describe('interview state machine: optimistic lock helpers', () => {
  it('accepts the current version', () => {
    expect(() => assertStateVersion(3, 3)).not.toThrow();
  });

  it.each([[2, 3], [4, 3], [0, 1]])('rejects version %i when the session is at %i with a 409', (sent, current) => {
    try {
      assertStateVersion(sent, current);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StateVersionConflictError);
      expect(error).toMatchObject({ statusCode: 409, code: 'state_version_conflict', expected: sent, actual: current });
    }
  });

  it('only an in_progress session is open', () => {
    expect(() => assertOpen('in_progress')).not.toThrow();
    for (const status of ['completed', 'abandoned', 'expired'] as const) {
      expect(() => assertOpen(status)).toThrow(new RegExp(status));
    }
  });
});
