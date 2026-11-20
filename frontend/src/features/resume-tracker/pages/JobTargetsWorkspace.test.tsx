// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SseEvent } from '../../../hooks/useSse';
import axiosClient from '../../../utils/axiosClient';
import { JobTargetDetailWorkspace } from './JobTargetDetailWorkspace';
import { JobTargetsWorkspace } from './JobTargetsWorkspace';

const sse = vi.hoisted(() => ({ dispatch: undefined as ((event: SseEvent) => void) | undefined }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: 'user-fixture' }) }));
vi.mock('../../../hooks/useSse', () => ({
  useSse: ({ onEvent }: { onEvent: (event: SseEvent) => void }) => { sse.dispatch = onEvent; },
}));
vi.mock('../../../utils/axiosClient', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const response = (data: unknown): AxiosResponse => ({
  data: { success: true, data }, status: 200, statusText: 'OK', headers: {},
  config: { headers: new AxiosHeaders() },
});
const parsing = {
  id: 'target-1', role: 'Backend Engineer', company: 'Sample Co',
  status: 'parsing', createdAt: '2026-11-17T06:00:00Z',
};
const ready = {
  ...parsing, status: 'ready', matchScore: 73,
  match: { score: 73, dimensions: { hardRequirements: 80, techStack: 60, verifiedEvidence: 70, experience: null } },
  missingKeywords: [{ category: 'Databases', keyword: 'PostgreSQL' }],
  gaps: [{ id: 'gap-1', description: 'Missing Docker evidence' }],
  rewriteSuggestions: [{ id: 'rewrite-1', originalText: 'Built an API', rewrittenText: 'Built an API serving 10 teams' }],
};
const get = vi.mocked(axiosClient.get);
const post = vi.mocked(axiosClient.post);

function mount(path = '/resume/targets') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/resume/targets" element={<JobTargetsWorkspace />} />
          <Route path="/resume/targets/:jobTargetId" element={<JobTargetDetailWorkspace />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  sse.dispatch = undefined;
});

afterEach(cleanup);

it.each(['text', 'URL'])('submits a posting by %s using the selected resume profile', async mode => {
  get.mockImplementation(async path => {
    if (path === '/resume-intelligence/profile') return response({ id: 'resume-1' });
    if (path === '/job-targets/target-1') return response(parsing);
    return response([]);
  });
  post.mockResolvedValue(response({ id: 'target-1', status: 'submitted' }));
  mount();

  const resumeProfile = await screen.findByLabelText('Resume profile', {}, { timeout: 5_000 });
  fireEvent.change(resumeProfile, { target: { value: 'resume-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add job target' }));
  if (mode === 'URL') {
    fireEvent.change(screen.getByLabelText('Posting URL'), { target: { value: 'https://jobs.example/backend' } });
  } else {
    fireEvent.click(screen.getByRole('tab', { name: 'Paste Job Description' }));
    fireEvent.change(screen.getByLabelText('Job description'), { target: { value: ` ${'Build reliable APIs. '.repeat(34)} ` } });
  }

  expect(screen.getByRole('button', { name: 'Analyze job posting' })).toBeEnabled();
  fireEvent.submit(screen.getByRole('form', { name: 'New job target' }));
  const posting = mode === 'URL' ? { jdUrl: 'https://jobs.example/backend' } : { jdText: 'Build reliable APIs. '.repeat(34).trim() };
  await waitFor(() => expect(post).toHaveBeenCalledExactlyOnceWith('/job-targets', { resumeProfileId: 'resume-1', ...posting }));
  expect(await screen.findByText(/Parsing · This page updates automatically/, {}, { timeout: 5_000 })).toBeInTheDocument();
});

it('loads the completed report through polling without an SSE event', async () => {
  get.mockResolvedValueOnce(response(parsing)).mockResolvedValue(response(ready));
  mount('/resume/targets/target-1');
  expect(await screen.findByText(/Parsing ·/)).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: 'Match breakdown' }, { timeout: 5_500 })).toBeInTheDocument();
  expect(get).toHaveBeenCalledTimes(2);
}, 8_000);

it.each(['jobtarget.parsed', 'jobtarget.updated'] as const)('refreshes the matching result on %s SSE and accepts a rewrite through the API', async type => {
  get.mockResolvedValueOnce(response(parsing)).mockResolvedValue(response(ready));
  post.mockResolvedValue(response({ variantId: 'variant-1' }));
  mount('/resume/targets/target-1');
  expect(await screen.findByText(/Parsing ·/)).toBeInTheDocument();

  act(() => sse.dispatch?.({
    type, timestamp: parsing.createdAt, payload: { jobTargetId: 'another-target' },
  }));
  expect(get).toHaveBeenCalledTimes(1);
  act(() => sse.dispatch?.({
    type, timestamp: parsing.createdAt, payload: { jobTargetId: 'target-1' },
  }));

  expect(await screen.findByText('73%')).toBeInTheDocument();
  expect(screen.getByText('Missing Docker evidence')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copy PostgreSQL' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Accept rewrite' }));
  expect(await screen.findByText('Rewrite accepted.')).toBeInTheDocument();
  expect(post).toHaveBeenCalledExactlyOnceWith('/job-targets/target-1/accept-rewrite', { rewriteId: 'rewrite-1' });
});

it('renders a recoverable error for a malformed ready response', async () => {
  get.mockResolvedValueOnce(response({ ...ready, match: undefined })).mockResolvedValue(response(ready));
  mount('/resume/targets/target-1');
  expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(screen.getByText('73%')).toBeInTheDocument());
});
