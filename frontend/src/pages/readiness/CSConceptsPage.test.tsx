// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CSConceptsPage from './CSConceptsPage';
import type { ConceptWorkspaceResponse } from '../../services/readinessService';

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    }),
  });
});

const mocks = vi.hoisted(() => ({
  getConceptWorkspace: vi.fn(),
  updateConceptProgress: vi.fn(),
}));

vi.mock('../../services/readinessService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/readinessService')>();
  return {
    ...actual,
    readinessService: {
      ...actual.readinessService,
      getConceptWorkspace: mocks.getConceptWorkspace,
      updateConceptProgress: mocks.updateConceptProgress,
    },
  };
});

vi.mock('../../features/flags/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true }),
}));

const sampleCsWorkspace: ConceptWorkspaceResponse = {
  domain: 'cs-concepts',
  summary: {
    totalConcepts: 3,
    completedConcepts: 1,
    progressPercent: 33,
    coreTotal: 2,
    coreCompleted: 1,
    coreProgressPercent: 50,
    optionalTotal: 1,
    optionalCompleted: 0,
    optionalProgressPercent: 0,
    gotItCount: 1,
    reviseAgainCount: 0,
    lastUpdatedAt: null,
  },
  concepts: [
    {
      id: 'cs-os-processes-threads',
      domain: 'cs-concepts',
      title: 'Processes vs Threads',
      subtitle: 'Virtual address space isolation',
      level: 'beginner',
      track: 'core-cs',
      subTrack: 'os',
      isOptional: false,
      isHighFrequencyCrashCourse: true,
      estimatedMinutes: 14,
      summary: 'Processes own isolated virtual memory.',
      architectureFlow: ['Fork clones page table'],
      tradeOffs: [],
      scaleBenchmarks: [],
      rapidQA: [
        {
          id: 'cs-q1',
          question: 'What is shared across threads?',
          answer: 'Heap, code, and open file descriptors.',
        },
      ],
      practicePrompt: 'Contrast event loop vs goroutines.',
      completed: true,
      confidence: 'got_it',
      updatedAt: null,
    },
    {
      id: 'cs-dbms-acid-isolation',
      domain: 'cs-concepts',
      title: 'ACID & Isolation Levels',
      subtitle: 'MVCC snapshots & Write Skew',
      level: 'beginner',
      track: 'core-cs',
      subTrack: 'dbms',
      isOptional: false,
      isHighFrequencyCrashCourse: true,
      estimatedMinutes: 18,
      summary: 'MVCC prevents readers blocking writers.',
      architectureFlow: ['Obtain monotonic xmin'],
      tradeOffs: [],
      scaleBenchmarks: [],
      rapidQA: [
        {
          id: 'cs-q2',
          question: 'What is Write Skew?',
          answer: 'Disjoint updates violating shared invariant.',
        },
      ],
      practicePrompt: 'Prevent double-spending cleanly.',
      completed: false,
      confidence: null,
      updatedAt: null,
    },
    {
      id: 'cs-ds-raft-consensus',
      domain: 'cs-concepts',
      title: 'Raft Consensus Intuition',
      subtitle: 'Leader election & majority commits',
      level: 'advanced',
      track: 'distributed-systems',
      subTrack: 'distributed-systems',
      isOptional: true,
      isHighFrequencyCrashCourse: false,
      estimatedMinutes: 18,
      summary: 'Split Raft into leader election and log replication.',
      architectureFlow: ['Randomized election timeouts prevent split votes'],
      tradeOffs: [],
      scaleBenchmarks: [],
      rapidQA: [
        {
          id: 'ds-q1',
          question: 'Why odd voting nodes?',
          answer: 'Even nodes give same fault tolerance at higher quorum cost.',
        },
      ],
      practicePrompt: 'Explain ReadIndex leader leases.',
      completed: false,
      confidence: null,
      updatedAt: null,
    },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CSConceptsPage', () => {
  it('separates optional Distributed Systems from Core CS scoring and requires explicit opt-in or tab selection', async () => {
    mocks.getConceptWorkspace.mockResolvedValue(sampleCsWorkspace);
    mocks.updateConceptProgress.mockResolvedValue(sampleCsWorkspace);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <CSConceptsPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Core CS Readiness reflects strictly Core CS (1 / 2 = 50%)
    expect(await screen.findByText('1 / 2 (50%)')).toBeInTheDocument();
    expect(screen.getByText(/optional for Core CS readiness/i)).toBeInTheDocument();

    // Distributed Systems topic stays hidden until opted in
    expect(screen.queryByText(/Raft Consensus Intuition/i)).toBeNull();

    // Toggle opt-in switch and switch to Distributed Systems tab
    fireEvent.click(
      screen.getByRole('switch', { name: /Include Distributed Systems/i })
    );
    fireEvent.click(screen.getByRole('tab', { name: /Distributed Systems \(Optional\)/i }));

    expect(await screen.findByRole('heading', { name: 'Raft Consensus Intuition' })).toBeInTheDocument();
    expect(screen.getByText('Optional · If Interested')).toBeInTheDocument();

    // Reveal Q&A and mark Revise Again
    fireEvent.click(screen.getByRole('button', { name: /Reveal Answer/i }));
    expect(screen.getByText(/same fault tolerance/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Revise Again/i }));
    await waitFor(() => {
      expect(mocks.updateConceptProgress).toHaveBeenCalledWith(
        'cs-concepts',
        'cs-ds-raft-consensus',
        { confidence: 'revise_again' }
      );
    });

    expect(screen.getByRole('link', { name: /Start 20m Focus/i })).toHaveAttribute(
      'href',
      expect.stringContaining('/focus?')
    );
  });
});
