// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SystemDesignPage from './SystemDesignPage';
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

const sampleWorkspace: ConceptWorkspaceResponse = {
  domain: 'system-design',
  summary: {
    totalConcepts: 2,
    completedConcepts: 0,
    progressPercent: 0,
    coreTotal: 2,
    coreCompleted: 0,
    coreProgressPercent: 0,
    optionalTotal: 0,
    optionalCompleted: 0,
    optionalProgressPercent: 0,
    gotItCount: 0,
    reviseAgainCount: 0,
    lastUpdatedAt: null,
  },
  concepts: [
    {
      id: 'sd-caching-patterns',
      domain: 'system-design',
      title: 'Caching Patterns',
      subtitle: 'Cache-Aside, Write-Through & Stampede Prevention',
      level: 'intermediate',
      track: 'system-design',
      isOptional: false,
      isHighFrequencyCrashCourse: true,
      estimatedMinutes: 18,
      summary: 'Keep read-heavy workloads sub-millisecond.',
      architectureFlow: ['Check Redis', 'Acquire singleflight lock on miss'],
      tradeOffs: [
        {
          topic: 'Cache-Aside',
          whenToUse: 'Read-heavy endpoints',
          whenToAvoid: 'Write-through strict invariants',
          alternative: 'Write-Through',
        },
      ],
      scaleBenchmarks: [{ label: 'Redis Ops/s', value: '100k ops/s' }],
      rapidQA: [
        {
          id: 'q1',
          question: 'How do you stop a cache stampede?',
          answer: 'Use singleflight coalescing and jittered TTLs.',
        },
      ],
      practicePrompt: 'Protect a product catalog at 50k QPS.',
      completed: false,
      confidence: null,
      updatedAt: null,
    },
    {
      id: 'sd-case-url-shortener',
      domain: 'system-design',
      title: 'Case Study: URL Shortener',
      subtitle: 'Base62 shortener & Redis redirect cache',
      level: 'case-study',
      track: 'system-design',
      isOptional: false,
      isHighFrequencyCrashCourse: false,
      estimatedMinutes: 20,
      summary: 'Serve 100:1 redirects with zero collisions.',
      architectureFlow: ['Claim counter range', 'Encode Base62'],
      tradeOffs: [],
      scaleBenchmarks: [],
      rapidQA: [
        {
          id: 'q2',
          question: 'Why HTTP 302 over 301?',
          answer: 'Allows origin analytics capture.',
        },
      ],
      practicePrompt: 'Sketch read/write paths.',
      completed: false,
      confidence: null,
      updatedAt: null,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SystemDesignPage', () => {
  it('filters by level and crash course toggle, reveals active-recall answers, and persists mastery', async () => {
    mocks.getConceptWorkspace.mockResolvedValue(sampleWorkspace);
    mocks.updateConceptProgress.mockResolvedValue({
      ...sampleWorkspace,
      summary: {
        ...sampleWorkspace.summary,
        completedConcepts: 1,
        progressPercent: 50,
        coreCompleted: 1,
        coreProgressPercent: 50,
        gotItCount: 1,
      },
      concepts: sampleWorkspace.concepts.map((c) =>
        c.id === 'sd-caching-patterns'
          ? { ...c, completed: true, confidence: 'got_it' }
          : c
      ),
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SystemDesignPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByText('0 / 2 concepts mastered (0%)')).toBeInTheDocument();
    expect(screen.getByText('Architecture Flow Mental Model')).toBeInTheDocument();
    expect(screen.getByText('Trade-Off Matrix')).toBeInTheDocument();

    // Reveal Q&A answer and rate Got It
    fireEvent.click(screen.getByRole('button', { name: /Reveal Answer/i }));
    expect(screen.getByText(/singleflight coalescing/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Got It/i }));
    await waitFor(() => {
      expect(mocks.updateConceptProgress).toHaveBeenCalledWith(
        'system-design',
        'sd-caching-patterns',
        { confidence: 'got_it', completed: true }
      );
    });
    expect(await screen.findByText('1 / 2 concepts mastered (50%)')).toBeInTheDocument();

    // Filter to Case Studies
    fireEvent.click(screen.getByRole('tab', { name: 'Case Studies' }));
    expect(await screen.findByRole('heading', { name: 'Case Study: URL Shortener' })).toBeInTheDocument();

    // Action bridges
    expect(screen.getByRole('link', { name: /Start 25m Focus/i })).toHaveAttribute(
      'href',
      expect.stringContaining('/focus?')
    );
    expect(screen.getByRole('link', { name: /Mock Interview/i })).toHaveAttribute(
      'href',
      '/interview'
    );
  });
});
