// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReadinessPage from './ReadinessPage';

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

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ userId: 'user-1', isLoaded: true, isSignedIn: true }),
}));

vi.mock('../features/flags/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true }),
}));

vi.mock('../features/readiness/hooks/useReadinessData', () => ({
  useReadinessData: () => ({
    loading: false,
    error: null,
    refetch: vi.fn(),
    data: {
      overallReadiness: 72,
      dynamicState: {
        confidence: 82,
        momentumTrend: 'improving',
        roleAlignment: { role: 'Backend Developer', score: 74, weakAreas: ['Caching'] },
      },
      adaptiveRoadmap: [{ id: 'n1', label: 'Redis', isPrioritizedBlocker: true }],
      nextBestActions: [{ category: 'dsa', title: 'Solve Heaps' }],
      intelligenceFeed: [{ id: 'f1', type: 'achievement', message: '5-day streak', timestamp: new Date().toISOString() }],
      rawMetrics: {
        dsa: { totalSolved: 120, consistencyScore: 70 },
        projects: { complexityMetrics: { architectureSophistication: 65 } },
      },
    },
  }),
}));

vi.mock('../features/readiness/components/PlacementRadarPanel', () => ({
  PlacementRadarPanel: () => <section data-testid="placement-radar">Placement practice radar</section>,
}));

vi.mock('../features/readiness/components/ReadinessHero', () => ({
  ReadinessHero: () => <section data-testid="readiness-hero">Readiness Hero</section>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ReadinessPage', () => {
  it('renders clean workspace cards including System Design and CS Concepts, without cluttered legacy panels', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ReadinessPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(screen.getByTestId('readiness-hero')).toBeInTheDocument();
    expect(screen.getByTestId('placement-radar')).toBeInTheDocument();

    // New and core workspaces present
    expect(screen.getByText('DSA Intelligence')).toBeInTheDocument();
    expect(screen.getByText('Roadmap Intelligence')).toBeInTheDocument();
    expect(screen.getByText('System Design Concepts')).toBeInTheDocument();
    expect(screen.getByText('CS Concepts')).toBeInTheDocument();

    // Removed cluttered panels absent
    expect(screen.queryByText(/System Design Telemetry/i)).toBeNull();
    expect(screen.queryByText(/Active Blockers/i)).toBeNull();
    expect(screen.queryByText(/What should I do next\?/i)).toBeNull();
    expect(screen.queryByText(/Engineering Evolution/i)).toBeNull();
    expect(screen.queryByText(/Trust & Confidence/i)).toBeNull();
    expect(screen.queryByText(/Seven-day practice plan/i)).toBeNull();
  });
});
