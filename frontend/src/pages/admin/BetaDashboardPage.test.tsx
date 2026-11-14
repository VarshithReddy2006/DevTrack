import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyticsService } from '../../services/analyticsService';
import { BetaDashboardPage } from './BetaDashboardPage';

vi.mock('../../services/analyticsService', () => ({
  analyticsService: { getDashboardMetrics: vi.fn() },
}));

const getMetrics = vi.mocked(analyticsService.getDashboardMetrics);

const emptyMetrics = {
  funnel: {
    resumesUploaded: 0,
    discoveryCompleted: 0,
    roadmapsGenerated: 0,
    resourceClicks: 0,
    skillsCompleted: 0,
  },
  metrics: { activationRate: 0, learningEngagement: 0, completionRate: 0 },
  feedback: [],
};

function renderDashboard() {
  return render(<MemoryRouter><BetaDashboardPage /></MemoryRouter>);
}

describe('BetaDashboardPage', () => {
  beforeEach(() => getMetrics.mockReset());
  afterEach(cleanup);

  it('retries an initial error and renders empty funnel bars at zero width', async () => {
    getMetrics.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(emptyMetrics);
    renderDashboard();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No feedback collected yet.')).toBeVisible();
    expect(getMetrics).toHaveBeenCalledTimes(2);
    const bars = screen.getAllByText('(0.0%)').map((label) =>
      label.parentElement?.parentElement?.nextElementSibling?.firstElementChild,
    );
    expect(bars).toHaveLength(5);
    bars.forEach((bar) => expect(bar).toHaveStyle({ width: '0%' }));
  });

  it('keeps the previous metrics visible while refreshing and shows the updated metrics on success', async () => {
    getMetrics.mockResolvedValueOnce(emptyMetrics);
    renderDashboard();
    await screen.findByText('No feedback collected yet.');

    const refreshed = { ...emptyMetrics, metrics: { ...emptyMetrics.metrics, activationRate: 42 } };
    let resolveRefresh!: (metrics: typeof refreshed) => void;
    getMetrics.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    expect(screen.getByText('No feedback collected yet.')).toBeVisible();
    await act(async () => resolveRefresh(refreshed));
    expect(screen.getByText('42.0%')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('keeps the previous metrics and re-enables refresh if the request fails', async () => {
    getMetrics.mockResolvedValueOnce(emptyMetrics).mockRejectedValueOnce(new Error('Unavailable'));
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh metrics');
    expect(screen.getByText('No feedback collected yet.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('paginates feedback and returns to the first page when the rating changes', async () => {
    const feedback = Array.from({ length: 21 }, (_, index) => ({
      _id: String(index),
      rating: index < 13 ? '👍' : '👎',
      page: '/dashboard',
      feedback: `Feedback entry ${index + 1}`,
      createdAt: '2026-01-01T00:00:00Z',
    }));
    getMetrics.mockResolvedValueOnce({ ...emptyMetrics, feedback });
    renderDashboard();

    const next = await screen.findByRole('button', { name: 'Next' });
    const previous = screen.getByRole('button', { name: 'Previous' });
    expect(previous).toBeDisabled();
    expect(screen.getAllByText(/^Feedback entry /)).toHaveLength(6);
    expect(screen.getByText('Page 1 of 4')).toBeVisible();
    fireEvent.click(next);
    expect(screen.getByText('Feedback entry 7')).toBeVisible();
    fireEvent.click(previous);
    expect(screen.getByText('Feedback entry 1')).toBeVisible();
    fireEvent.click(next);
    fireEvent.click(next);

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by rating' }), { target: { value: '👎' } });
    expect(screen.getByText('Page 1 of 2')).toBeVisible();
    expect(screen.getByText('Feedback entry 14')).toBeVisible();
    expect(screen.queryByText('Feedback entry 13')).toBeNull();
    fireEvent.click(next);
    expect(screen.getAllByText(/^Feedback entry /)).toHaveLength(2);
    expect(next).toBeDisabled();
  });
});
