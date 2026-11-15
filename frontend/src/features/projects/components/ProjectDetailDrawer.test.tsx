import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchProject, fetchProjectTasks, syncProject } from '../../../services/projectsService';
import { useProjectsStore } from '../../../store/projectsStore';
import type { ApiProject } from '../../../types/api.types';
import { ProjectDetailDrawer } from './ProjectDetailDrawer';

vi.mock('../../../services/projectsService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../services/projectsService')>(),
  fetchProject: vi.fn(),
  fetchProjectTasks: vi.fn(),
  syncProject: vi.fn(),
}));

const project: ApiProject = {
  id: 'project-1', name: 'DevTrack', description: '', repoUrl: 'https://github.com/example/devtrack.git',
  liveUrl: null, techStack: [], status: 'planning', visibility: 'private', thumbnailUrl: null,
  stars: 2, forks: 0, language: 'TypeScript', totalCommits: 0, totalPullRequests: 0,
  totalIssues: 0, openIssues: 0, lastCommitAt: null, lastCommitMessage: null,
  contributors: [], milestones: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

function renderProject(repoUrl: string | null = project.repoUrl) {
  vi.mocked(fetchProject).mockResolvedValue({ success: true, timestamp: '', message: '', data: { ...project, repoUrl } });
  vi.mocked(fetchProjectTasks).mockResolvedValue({ success: true, timestamp: '', message: '', data: [] });
  render(<ProjectDetailDrawer projectId={project.id} onClose={vi.fn()} />);
}

afterEach(() => {
  cleanup();
  useProjectsStore.getState().reset();
  vi.resetAllMocks();
});

it.each([null, 'https://gitlab.com/example/devtrack', 'https://github.com/example/devtrack/issues'])(
  'omits Sync from GitHub for repository URL %s', async (repoUrl) => {
    renderProject(repoUrl);
    await screen.findByRole('heading', { name: 'DevTrack' });
    expect(screen.queryByRole('button', { name: 'Sync from GitHub' })).toBeNull();
  },
);

it('prevents duplicate clicks and refreshes the displayed metrics after sync', async () => {
  renderProject();
  const action = await screen.findByRole('button', { name: 'Sync from GitHub' });
  expect(screen.getByText('2')).toBeInTheDocument();

  let finish!: (result: Awaited<ReturnType<typeof syncProject>>) => void;
  vi.mocked(syncProject).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  fireEvent.click(action);
  expect(action).toBeDisabled();
  expect(action).toHaveTextContent('Syncing from GitHub');
  fireEvent.click(action);
  expect(syncProject).toHaveBeenCalledTimes(1);
  expect(syncProject).toHaveBeenCalledWith(project.id);

  vi.mocked(fetchProject).mockResolvedValue({ success: true, timestamp: '', message: '', data: { ...project, stars: 42 } });
  await act(async () => finish({ success: true, timestamp: '', message: 'Project synced successfully' }));
  expect(await screen.findByText('42')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('GitHub metrics refreshed');
  expect(action).toBeEnabled();
});

it('reports sync failures and allows retry without changing the visible metrics', async () => {
  renderProject();
  const action = await screen.findByRole('button', { name: 'Sync from GitHub' });
  vi.mocked(syncProject).mockRejectedValue({ message: 'GitHub repository sync failed' });
  fireEvent.click(action);

  expect(await screen.findByRole('alert')).toHaveTextContent(/GitHub repository sync failed.*try again/i);
  expect(screen.getByText('2')).toBeInTheDocument();
  await waitFor(() => expect(action).toBeEnabled());
});
