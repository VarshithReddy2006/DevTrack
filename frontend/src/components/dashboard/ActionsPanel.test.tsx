import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import ProjectsPage from '../../pages/ProjectsPage';
import { ActionsPanel } from './ActionsPanel';

vi.mock('../../hooks/useProjectsData', () => ({
  useProjectDetail: () => ({ data: null, status: 'idle', refresh: vi.fn() }),
  useProjectsData: () => ({
    data: { projects: [] },
    status: 'success',
    refresh: vi.fn(),
    createProject: vi.fn(),
    deleteProject: vi.fn(),
  }),
}));

afterEach(cleanup);

it('opens the existing New Project dialog from Quick Actions and clears the create intent on close', async () => {
  function CurrentLocation() {
    const location = useLocation();
    return <output>{location.pathname}{location.search}</output>;
  }

  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <CurrentLocation />
      <Routes>
        <Route path="/dashboard" element={<ActionsPanel />} />
        <Route path="/projects" element={<ProjectsPage />} />
      </Routes>
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole('link', { name: 'Create Project' }));
  const dialog = await screen.findByRole('dialog', { name: 'New Project' });
  expect(screen.getByText('/projects?create=1')).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Project' })).toBeNull());
  expect(screen.getByText('/projects')).toBeInTheDocument();
});

it.each(['Log Activity', 'Review Mistakes'])('marks %s as unavailable and explains why', (name) => {
  render(<MemoryRouter><ActionsPanel /></MemoryRouter>);
  const button = screen.getByRole('button', { name });
  expect(button).toBeDisabled();
  expect(button).toHaveAccessibleDescription('Manual activity logging and mistake review are unavailable.');
});
