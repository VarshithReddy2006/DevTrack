// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SseEvent } from '../../hooks/useSse';
import type { InterviewSession } from '../../services/interviewService';
import axiosClient from '../../utils/axiosClient';
import InterviewReviewPage from './InterviewReviewPage';
import InterviewStudioPage from './InterviewStudioPage';

const sse = vi.hoisted(() => ({ dispatch: undefined as ((event: SseEvent) => void) | undefined }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: 'interview-user' }) }));
vi.mock('../../hooks/useSse', () => ({
  useSse: ({ onEvent }: { onEvent: (event: SseEvent) => void }) => {
    sse.dispatch = onEvent;
    return { isConnected: false };
  },
}));
vi.mock('../../utils/axiosClient', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const response = (data: unknown): AxiosResponse => ({
  data: { success: true, data }, status: 200, statusText: 'OK', headers: {},
  config: { headers: new AxiosHeaders() },
});
const initial: InterviewSession = {
  id: 'session-1', role: 'backend', status: 'in_progress',
  state: 'QUESTION_PENDING', stateVersion: 1, currentTurnIndex: 0,
  turns: [{ question: { prompt: 'How would you design a job scheduler?' } }],
};
const scoring: InterviewSession = {
  ...initial, state: 'SCORING', stateVersion: 2,
  turns: [{ ...initial.turns[0], answer: 'I would start with the workload.' }],
};
const nextQuestion: InterviewSession = {
  ...initial, stateVersion: 3, currentTurnIndex: 1,
  turns: [
    { ...scoring.turns[0], feedback: 'Good scope. Quantify throughput next.' },
    { question: { prompt: 'How would you choose a storage model?' } },
  ],
};
const complete: InterviewSession = {
  ...nextQuestion, status: 'completed', state: 'COMPLETED', stateVersion: 8, mode: 'basic_mode',
  scorecard: {
    scores: { problemBreakdown: 82, technicalTradeoffs: 71, edgeCases: 63, communication: 90 },
    strengths: ['You scoped the workload.'], improvements: ['Estimate throughput.'],
  },
};
const get = vi.mocked(axiosClient.get);
const post = vi.mocked(axiosClient.post);
const wait = { timeout: 5_000 };

function mount(path = '/interview') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/interview" element={<InterviewStudioPage />} />
          <Route path="/interview/:sessionId/review" element={<InterviewReviewPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function delta(seq: number, text: string, overrides: Partial<{
  sessionId: string; turnIndex: number; stateVersion: number;
}> = {}) {
  sse.dispatch?.({
    type: 'interview.turn.delta',
    timestamp: '2026-11-17T06:00:00Z',
    payload: { sessionId: 'session-1', turnIndex: 0, stateVersion: 2, seq, delta: text, ...overrides },
  });
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  sse.dispatch = undefined;
});
afterEach(cleanup);

it('starts the selected role and opens the first question', async () => {
  get.mockResolvedValue(response(null));
  post.mockResolvedValue(response({ ...initial, role: 'frontend_architect' }));
  mount();

  fireEvent.click(await screen.findByRole('radio', { name: 'Frontend Architect' }, wait));
  fireEvent.click(screen.getByRole('button', { name: 'Start interview' }));
  expect(await screen.findByRole('heading', { name: 'Question 1 of 5' }, wait)).toBeInTheDocument();
  expect(screen.getByText(initial.turns[0].question.prompt)).toBeInTheDocument();
  expect(post).toHaveBeenCalledExactlyOnceWith('/interviews', { role: 'frontend_architect' });
});

it('restores the current question and prior answers and feedback on a fresh mount', async () => {
  get.mockResolvedValue(response(nextQuestion));
  mount();

  expect(await screen.findByRole('heading', { name: 'Question 2 of 5' }, wait)).toBeInTheDocument();
  expect(get).toHaveBeenCalledExactlyOnceWith('/interviews/current', { signal: expect.any(AbortSignal) });
  expect(screen.getByText(scoring.turns[0].answer!)).toBeInTheDocument();
  expect(screen.getByText(nextQuestion.turns[0].feedback!)).toBeInTheDocument();
  expect(screen.getByText(/Voice dictation is unavailable/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Start interview' })).not.toBeInTheDocument();
});

it('submits the state version and stitches early, duplicate, and reordered tokens', async () => {
  get.mockImplementation(async path => response(path === '/interviews/current' ? initial : scoring));
  let publishAnswer!: (result: AxiosResponse) => void;
  post.mockImplementation(() => new Promise(resolve => { publishAnswer = resolve; }));
  mount();

  const input = await screen.findByRole('textbox', { name: 'Your answer' }, wait);
  fireEvent.change(input, { target: { value: scoring.turns[0].answer } });
  expect(screen.getByText('7968 characters left · Ctrl+Enter to submit')).toBeInTheDocument();
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(post).toHaveBeenCalledExactlyOnceWith('/interviews/session-1/turns/0/answer', {
    answer: scoring.turns[0].answer, stateVersion: 1,
  }), wait);

  act(() => delta(2, 'estimate throughput.'));
  await act(async () => publishAnswer(response(scoring)));
  expect(await screen.findByText('Generating feedback…', {}, wait)).toBeInTheDocument();
  expect(screen.queryByText('estimate throughput.')).not.toBeInTheDocument();

  act(() => {
    delta(0, 'Good scope. ');
    delta(1, 'stale reply ', { stateVersion: 1 });
    delta(1, 'foreign reply ', { sessionId: 'other-session' });
    delta(1, 'wrong turn ', { turnIndex: 1 });
  });
  expect(screen.getByText('Good scope.')).toBeInTheDocument();
  act(() => {
    delta(1, 'Next, ');
    delta(2, 'duplicate');
  });
  expect(screen.getByText('Good scope. Next, estimate throughput.')).toBeInTheDocument();
});

it('refreshes on a version conflict and preserves an unsent draft for the same question', async () => {
  get.mockResolvedValueOnce(response(initial)).mockResolvedValue(response({ ...initial, stateVersion: 2 }));
  post.mockRejectedValueOnce({ statusCode: 409, message: 'Interview changed. Please try again.' })
    .mockResolvedValueOnce(response(scoring));
  mount();

  const input = await screen.findByRole('textbox', { name: 'Your answer' }, wait);
  fireEvent.change(input, { target: { value: 'Keep my draft' } });
  const submit = () => fireEvent.submit(screen.getByRole('form', { name: 'Your answer' }));
  submit();

  expect(await screen.findByRole('alert', {}, wait)).toHaveTextContent('Interview changed');
  await waitFor(() => expect(get).toHaveBeenCalledWith('/interviews/session-1', { signal: expect.any(AbortSignal) }), wait);
  expect(input).toHaveValue('Keep my draft');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Submit answer' })).toBeEnabled(), wait);
  submit();
  await waitFor(() => expect(post).toHaveBeenLastCalledWith('/interviews/session-1/turns/0/answer', {
    answer: 'Keep my draft', stateVersion: 2,
  }), wait);
});

it('loads the final scorecard on completion and links to a refreshable review', async () => {
  get.mockResolvedValueOnce(response(scoring)).mockResolvedValue(response(complete));
  mount();
  expect(await screen.findByText('Generating feedback…', {}, wait)).toBeInTheDocument();

  act(() => sse.dispatch?.({
    type: 'interview.session.completed', timestamp: '2026-11-17T06:00:00Z', payload: { sessionId: 'session-1' },
  }));
  fireEvent.click(await screen.findByRole('link', { name: 'Review scorecard' }, wait));
  expect(await screen.findByRole('heading', { name: 'Scorecard' }, wait)).toBeInTheDocument();
  expect(screen.getByText('82 / 100')).toBeInTheDocument();
  expect(screen.getByText('Technical trade-offs and architecture')).toBeInTheDocument();
  expect(screen.getByText('Basic mode · Checklist scoring')).toBeInTheDocument();
  expect(screen.getByText('You scoped the workload.')).toBeInTheDocument();
  expect(screen.getByText('Estimate throughput.')).toBeInTheDocument();
});
