import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchDsaIntelligence, syncDsaIntelligence, type DsaIntelligenceResponse } from '../../features/readiness/services/dsaIntelligenceService';
import DSAIntelligencePage from './DSAIntelligencePage';

vi.mock('../../store/userStore', () => ({ useUserStore: () => ({ user: { id: 'test-user' } }) }));
vi.mock('../../features/readiness/services/dsaIntelligenceService', () => ({
  fetchDsaIntelligence: vi.fn(),
  syncDsaIntelligence: vi.fn(),
}));

const fetchData = vi.mocked(fetchDsaIntelligence);
const syncData = vi.mocked(syncDsaIntelligence);
const zeroState: DsaIntelligenceResponse = {
  readinessScore: 0,
  consistencyScore: 0,
  hardProgressScore: 0,
  readinessImpact: 0,
  difficultyDistribution: { easy: 0, medium: 0, hard: 0, total: 0 },
  strongTopics: [],
  weakTopics: [],
  nextTopics: [],
  confidenceScore: 0,
  verificationCoverage: 0,
  status: 'ready',
  lastUpdated: '',
};
const activeState = {
  ...zeroState,
  readinessScore: 87,
  readinessImpact: 120,
  difficultyDistribution: { easy: 12, medium: 10, hard: 3, total: 25 },
};

afterEach(() => {
  cleanup();
  fetchData.mockReset();
  syncData.mockReset();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><DSAIntelligencePage /></QueryClientProvider>);
}

it('renders the empty state and disables Sync Data until the sync mutation completes', async () => {
  fetchData.mockResolvedValueOnce(zeroState);
  let finishSync!: (data: DsaIntelligenceResponse) => void;
  syncData.mockImplementationOnce(() => new Promise((resolve) => { finishSync = resolve; }));
  renderPage();

  const sync = await screen.findByRole('button', { name: 'Sync Data' });
  expect(screen.getByText('Awaiting initial telemetry...')).toBeInTheDocument();
  fireEvent.click(sync);
  expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeDisabled();
  expect(syncData).toHaveBeenCalledTimes(1);

  finishSync(activeState);
  expect(await screen.findByText('Total Analyzed')).toBeInTheDocument();
  expect(screen.getByText('25')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sync Data' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Refresh Telemetry' })).toBeEnabled();
});

it('renders active metric values and all difficulty counts', async () => {
  fetchData.mockResolvedValueOnce(activeState);
  renderPage();

  expect(await screen.findByText('87')).toBeInTheDocument();
  expect(screen.getByText('120')).toBeInTheDocument();
  for (const [label, count] of [['Easy', '12'], ['Medium', '10'], ['Hard', '3']]) {
    expect(screen.getByText(label).parentElement).toHaveTextContent(count);
  }
});

it('renders categorized Data Structures and Algorithms sections with solved counts and mastery percentages', async () => {
  fetchData.mockResolvedValueOnce({
    ...activeState,
    strongTopics: [{ topic: 'arrays', solved: 30, mastery: 100 }],
    weakTopics: [{ topic: 'dp', solved: 5, mastery: 20 }],
    nextTopics: ['dp', 'trees'],
  });
  renderPage();

  expect(await screen.findByText('Data Structures Mastery')).toBeInTheDocument();
  expect(screen.getByText('Algorithmic Paradigms')).toBeInTheDocument();
  expect(screen.getAllByText('Arrays & Sliding Window').length).toBeGreaterThanOrEqual(1);
  expect(screen.getAllByText('Dynamic Programming').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText('30 solved')).toBeInTheDocument();
  expect(screen.getByText('5 solved')).toBeInTheDocument();
});

it('keeps the zero state visible and makes Sync Data available after a failed sync', async () => {
  fetchData.mockResolvedValueOnce(zeroState);
  syncData.mockRejectedValueOnce(new Error('Offline'));
  renderPage();

  fireEvent.click(await screen.findByRole('button', { name: 'Sync Data' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh DSA data');
  expect(screen.getByText('Awaiting initial telemetry...')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sync Data' })).toBeEnabled();
});
