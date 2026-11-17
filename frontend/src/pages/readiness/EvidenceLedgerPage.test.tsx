import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchEvidenceClaims, type EvidenceClaim } from '../../services/evidenceService';
import EvidenceLedgerPage from './EvidenceLedgerPage';

vi.mock('../../services/evidenceService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/evidenceService')>()),
  fetchEvidenceClaims: vi.fn(),
}));

const fetchClaims = vi.mocked(fetchEvidenceClaims);
const stamp = { createdAt: '2026-03-01T10:00:00.000Z', updatedAt: '2026-03-01T10:00:00.000Z' };
const claims: EvidenceClaim[] = [
  {
    ...stamp, id: 'c1', subjectType: 'repo', subjectKey: 'repo:acme/api', source: 'github',
    sourceUrl: 'https://github.com/acme/api', claimText: 'Maintains the acme API', verificationStatus: 'verified', confidence: 92,
    fetchedAt: '2026-03-02T10:00:00.000Z',
  },
  {
    ...stamp, id: 'c2', subjectType: 'dsa_rating', subjectKey: 'leetcode:rating', source: 'leetcode',
    claimText: 'Contest rating 1850', verificationStatus: 'partial', confidence: 55,
  },
  {
    ...stamp, id: 'c3', subjectType: 'resume_claim', subjectKey: 'resume:3', source: 'user',
    sourceUrl: 'javascript:alert(1)', claimText: 'Led a team of four', verificationStatus: 'flagged', confidence: 10,
    metadata: { lastVerifiedAt: null, verificationAttempts: 2, flaggedReason: 'No matching commits' },
  },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}><EvidenceLedgerPage /></QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => { fetchClaims.mockResolvedValue(claims); });
afterEach(() => { cleanup(); fetchClaims.mockReset(); });

it('lists claims with a text verification badge, a source link and a timestamp', async () => {
  renderPage();
  const table = await screen.findByRole('table');
  const rows = within(table).getAllByRole('row');
  expect(rows).toHaveLength(4); // header + 3
  expect(within(rows[1]).getByText('Verified')).toBeInTheDocument();
  expect(within(rows[2]).getByText('Partially verified')).toBeInTheDocument();
  expect(within(rows[3]).getByText('Flagged')).toBeInTheDocument();
  expect(within(rows[3]).getByText(/No matching commits/)).toBeInTheDocument();

  const link = within(rows[1]).getByRole('link', { name: /GitHub/ });
  expect(link).toHaveAttribute('href', 'https://github.com/acme/api');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(within(rows[1]).getByText('Mar 2, 2026')).toHaveAttribute('datetime', '2026-03-02T10:00:00.000Z');
});

it('never renders a non-http source url as a link', async () => {
  renderPage();
  const table = await screen.findByRole('table');
  expect(within(within(table).getAllByRole('row')[3]).queryByRole('link')).toBeNull();
});

it('asks the API for the selected status and category', async () => {
  renderPage();
  await screen.findByRole('table');
  expect(fetchClaims).toHaveBeenLastCalledWith({ verificationStatus: undefined, subjectType: undefined }, expect.anything());

  fireEvent.click(screen.getByRole('button', { name: 'Flagged' }));
  await waitFor(() => expect(fetchClaims).toHaveBeenLastCalledWith({ verificationStatus: 'flagged', subjectType: undefined }, expect.anything()));
  expect(screen.getByRole('button', { name: 'Flagged' })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(screen.getByRole('button', { name: 'Repository' }));
  await waitFor(() => expect(fetchClaims).toHaveBeenLastCalledWith({ verificationStatus: 'flagged', subjectType: 'repo' }, expect.anything()));

  fireEvent.click(screen.getByRole('button', { name: 'All statuses' }));
  await waitFor(() => expect(fetchClaims).toHaveBeenLastCalledWith({ verificationStatus: undefined, subjectType: 'repo' }, expect.anything()));
});

it('narrows the list as you type in the search box without another request', async () => {
  renderPage();
  await screen.findByRole('table');
  const calls = fetchClaims.mock.calls.length;
  fireEvent.change(screen.getByLabelText('Search evidence claims'), { target: { value: 'rating' } });
  const rows = within(screen.getByRole('table')).getAllByRole('row');
  expect(rows).toHaveLength(2);
  expect(within(rows[1]).getByText('Contest rating 1850')).toBeInTheDocument();
  expect(screen.getByText('1 claim')).toBeInTheDocument();
  expect(fetchClaims).toHaveBeenCalledTimes(calls);
});

it('shows a clearable empty state when nothing matches', async () => {
  renderPage();
  await screen.findByRole('table');
  fireEvent.change(screen.getByLabelText('Search evidence claims'), { target: { value: 'kubernetes' } });
  expect(screen.getByText('No claims match these filters')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(await screen.findByRole('table')).toBeInTheDocument();
});

it('shows the first-time empty state when the ledger has no claims', async () => {
  fetchClaims.mockResolvedValue([]);
  renderPage();
  expect(await screen.findByText('No evidence claims yet')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
});

it('shows an error with a retry that refetches', async () => {
  fetchClaims.mockRejectedValue(new Error('boom'));
  renderPage();
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('couldn’t load your evidence claims');
  fetchClaims.mockResolvedValue(claims);
  fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('table')).toBeInTheDocument();
});
