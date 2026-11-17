import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  fetchPublication,
  publishProfile,
  unpublishProfile,
  type PublicationStatus,
} from '../services/publicationService';
import PortfolioSettingsPage from './PortfolioSettingsPage';

vi.mock('../services/publicationService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/publicationService')>()),
  fetchPublication: vi.fn(),
  publishProfile: vi.fn(),
  unpublishProfile: vi.fn(),
}));

const fetchStatus = vi.mocked(fetchPublication);
const publish = vi.mocked(publishProfile);
const unpublish = vi.mocked(unpublishProfile);

const hidden = { streak: false, dsa: false, github: false, projects: false, activity: false };
const draft: PublicationStatus = { published: false, slug: null, sections: hidden, publicationVersion: 0, consentVersion: null, publishedAt: null };
const live: PublicationStatus = {
  published: true, slug: 'jane', sections: { ...hidden, streak: true }, publicationVersion: 3,
  consentVersion: '2026-01', publishedAt: '2026-02-01T00:00:00.000Z',
};
const apiError = (statusCode: number, message: string) => ({ success: false, statusCode, message, code: 'X' });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}><PortfolioSettingsPage /></QueryClientProvider>
    </MemoryRouter>,
  );
}

const handle = () => screen.getByLabelText('Public handle');
const type = (value: string) => fireEvent.change(handle(), { target: { value } });

beforeEach(() => { fetchStatus.mockResolvedValue(draft); });
afterEach(() => {
  cleanup();
  fetchStatus.mockReset(); publish.mockReset(); unpublish.mockReset();
});

it('starts as a private draft with every section off and Publish disabled', async () => {
  renderPage();
  expect(await screen.findByText('Draft / Private')).toBeInTheDocument();
  expect(screen.getAllByRole('switch').every((s) => s.getAttribute('aria-checked') === 'false')).toBe(true);
  expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Unpublish Immediately' })).toBeNull();
});

it('needs a valid handle and the consent tick before Publish enables', async () => {
  renderPage();
  await screen.findByText('Draft / Private');
  type('ab');
  fireEvent.click(screen.getByRole('checkbox'));
  expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  type('jane');
  expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
  fireEvent.click(screen.getByRole('checkbox'));
  expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
});

it('publishes the normalized handle, the chosen sections and the consent version', async () => {
  publish.mockResolvedValue(live);
  renderPage();
  await screen.findByText('Draft / Private');
  type('  Jane ');
  fireEvent.click(screen.getByRole('switch', { name: 'Streak' }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

  await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  expect(publish).toHaveBeenCalledWith({ slug: 'jane', sections: { ...hidden, streak: true }, consentVersion: '2026-11' });
  expect(await screen.findByText('Published at /u/jane')).toBeInTheDocument();
  const liveLink = screen.getByRole('link', { name: /View Live/ });
  expect(liveLink).toHaveAttribute('href', '/u/jane');
});

it('shows a 409 from the server on the handle and stays a draft', async () => {
  publish.mockRejectedValue(apiError(409, 'This handle is already taken'));
  renderPage();
  await screen.findByText('Draft / Private');
  type('jane');
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
  expect(await screen.findByText('This handle is already taken')).toBeInTheDocument();
  expect(screen.getByText('Draft / Private')).toBeInTheDocument();
  type('janet');
  expect(screen.queryByText('This handle is already taken')).toBeNull();
});

it('unpublishes straight away and goes back to a private draft', async () => {
  fetchStatus.mockResolvedValue(live);
  unpublish.mockResolvedValue({ ...live, published: false, slug: null });
  renderPage();
  expect(await screen.findByText('Published at /u/jane')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Unpublish Immediately' }));
  expect(await screen.findByText('Draft / Private')).toBeInTheDocument();
  expect(unpublish).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('link', { name: /View Live/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Unpublish Immediately' })).toBeNull();
});

it('saves a section change right away while published, with the live handle', async () => {
  fetchStatus.mockResolvedValue(live);
  publish.mockResolvedValue({ ...live, sections: { ...hidden, streak: true, dsa: true } });
  renderPage();
  await screen.findByText('Published at /u/jane');
  fireEvent.click(screen.getByRole('switch', { name: 'DSA progress' }));
  await waitFor(() => expect(publish).toHaveBeenCalledWith({
    slug: 'jane', sections: { ...hidden, streak: true, dsa: true }, consentVersion: '2026-01',
  }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'DSA progress' })).toHaveAttribute('aria-checked', 'true'));
});

it('puts the switch back and says so when saving a section fails', async () => {
  fetchStatus.mockResolvedValue(live);
  publish.mockRejectedValue(apiError(500, 'boom'));
  renderPage();
  await screen.findByText('Published at /u/jane');
  fireEvent.click(screen.getByRole('switch', { name: 'DSA progress' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Couldn\'t save that change');
  expect(screen.getByRole('switch', { name: 'DSA progress' })).toHaveAttribute('aria-checked', 'false');
});

it('offers an Update handle button only when the handle differs from the live one', async () => {
  fetchStatus.mockResolvedValue(live);
  publish.mockResolvedValue({ ...live, slug: 'janet' });
  renderPage();
  await screen.findByText('Published at /u/jane');
  expect(screen.queryByRole('button', { name: 'Update handle' })).toBeNull();
  type('janet');
  fireEvent.click(screen.getByRole('button', { name: 'Update handle' }));
  await waitFor(() => expect(publish).toHaveBeenCalledWith({ slug: 'janet', sections: live.sections, consentVersion: '2026-01' }));
  expect(await screen.findByText('Published at /u/janet')).toBeInTheDocument();
});

it('does not crash and does not retry when the server has no publication API (404)', async () => {
  fetchStatus.mockRejectedValue(apiError(404, 'Not found'));
  renderPage();
  expect(await screen.findByText(/aren’t available on this server yet/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  expect(fetchStatus).toHaveBeenCalledTimes(1);
});

it('shows a retry for other load failures', async () => {
  fetchStatus.mockRejectedValue(apiError(500, 'boom'));
  renderPage();
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('couldn’t load your portfolio settings');
  fetchStatus.mockResolvedValue(draft);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Draft / Private')).toBeInTheDocument();
});
