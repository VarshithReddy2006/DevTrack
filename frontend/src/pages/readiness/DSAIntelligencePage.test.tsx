import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchDsaIntelligence, syncDsaIntelligence, type DsaIntelligenceResponse } from '../../features/readiness/services/dsaIntelligenceService';
import { useUIStore } from '../../store/uiStore';
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
const activeState: DsaIntelligenceResponse = {
  ...zeroState,
  readinessScore: 87,
  readinessImpact: 120,
  confidenceScore: 92,
  verificationCoverage: 100,
  difficultyDistribution: { easy: 284, medium: 248, hard: 27, total: 639 },
};

afterEach(() => {
  cleanup();
  fetchData.mockReset();
  syncData.mockReset();
  useUIStore.setState({ sseStatus: 'disconnected', isOnline: true, isInfrastructureDegraded: false });
});

function renderPage(withRouter = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  const content = withRouter ? (
    <MemoryRouter>
      <DSAIntelligencePage />
    </MemoryRouter>
  ) : (
    <DSAIntelligencePage />
  );
  render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
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

  finishSync({
    ...activeState,
    difficultyDistribution: { easy: 12, medium: 10, hard: 3, total: 25 },
  });
  expect(await screen.findByText('Total Analyzed')).toBeInTheDocument();
  expect(screen.getByText('25')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sync Data' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Refresh Telemetry' })).toBeEnabled();
});

it('reconciles difficulty distribution including Unrated / Contest bucket so sum matches Total Analyzed', async () => {
  fetchData.mockResolvedValueOnce(activeState);
  renderPage();

  expect(await screen.findByText('87')).toBeInTheDocument();
  expect(screen.getByText('120')).toBeInTheDocument();
  expect(screen.getByText('639')).toBeInTheDocument();

  for (const [label, count] of [
    ['Easy', '284'],
    ['Medium', '248'],
    ['Hard', '27'],
    ['Unrated / Contest', '80'],
  ]) {
    expect(screen.getByText(label).closest('div')).toHaveTextContent(count);
  }
  expect(
    screen.getByLabelText('Problems solved in unrated platforms or contests without standard LeetCode difficulty tags')
  ).toBeInTheDocument();
});

it('renders categorized Data Structures and Algorithms with difficulty pills, tiers, and actionable practice cards', async () => {
  fetchData.mockResolvedValueOnce({
    ...activeState,
    strongTopics: [
      { topic: 'arrays', solved: 253, mastery: 94, tier: 'Mastery', difficulty: { easy: 120, medium: 110, hard: 23 } },
      { topic: 'hashing', solved: 40, mastery: 90, tier: 'Mastery', difficulty: { easy: 20, medium: 16, hard: 4 } },
      { topic: 'strings', solved: 35, mastery: 85, tier: 'Advanced', difficulty: { easy: 18, medium: 15, hard: 2 } },
      { topic: 'linkedList', solved: 20, mastery: 75, tier: 'Advanced', difficulty: { easy: 10, medium: 8, hard: 2 } },
      { topic: 'stack', solved: 18, mastery: 72, tier: 'Advanced', difficulty: { easy: 8, medium: 9, hard: 1 } },
      { topic: 'trees', solved: 32, mastery: 80, tier: 'Advanced', difficulty: { easy: 12, medium: 16, hard: 4 } },
      { topic: 'binarySearch', solved: 22, mastery: 76, tier: 'Advanced', difficulty: { easy: 10, medium: 10, hard: 2 } },
    ],
    weakTopics: [
      { topic: 'heaps', solved: 6, mastery: 55, tier: 'Proficient', difficulty: { easy: 2, medium: 3, hard: 1 } },
      { topic: 'dp', solved: 5, mastery: 20, tier: 'Novice', difficulty: { easy: 3, medium: 2, hard: 0 } },
    ],
    nextTopics: ['heaps', 'dp'],
  });
  renderPage(true);

  expect(await screen.findByText('Data Structures Mastery')).toBeInTheDocument();
  expect(screen.getByText('Algorithmic Paradigms')).toBeInTheDocument();
  expect(screen.getByText('253 solved')).toBeInTheDocument();
  expect(screen.getByLabelText('Easy 120, Medium 110, Hard 23')).toHaveTextContent('[E: 120|M: 110|H: 23]');
  expect(screen.getByText('94%')).toBeInTheDocument();

  // Strong topics list capped at 6 initially with Show all toggle
  expect(screen.queryByText('76%')).toBeInTheDocument(); // Still in category card
  const showAllBtn = screen.getByRole('button', { name: 'Show all (7)' });
  fireEvent.click(showAllBtn);
  expect(screen.getByRole('button', { name: 'Show top 6' })).toBeInTheDocument();

  // Actionable practice cards
  expect(screen.getByText('Top K Frequent Elements (Medium)')).toBeInTheDocument();
  expect(screen.getByText('Coin Change (Medium)')).toBeInTheDocument();

  const solveLinks = screen.getAllByRole('link', { name: /Solve Problem/ });
  expect(solveLinks[0]).toHaveAttribute('href', 'https://leetcode.com/problems/top-k-frequent-elements/');

  const focusLinks = screen.getAllByRole('link', { name: /Start 25m Focus Block/ });
  expect(focusLinks[0]).toHaveAttribute(
    'href',
    '/focus?mission=Master%20Heaps%20%26%20Priority%20Queues&duration=25&mode=dsa'
  );
});

it('omits the legacy Trust & Confidence strip from DSA Intelligence', async () => {
  useUIStore.setState({ sseStatus: 'reconnecting' });
  fetchData.mockResolvedValueOnce(activeState);
  renderPage();

  expect(await screen.findByText('Total Analyzed')).toBeInTheDocument();
  expect(screen.queryByText('Trust & Confidence')).toBeNull();
  expect(screen.queryByText('Reconnecting…')).toBeNull();
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
