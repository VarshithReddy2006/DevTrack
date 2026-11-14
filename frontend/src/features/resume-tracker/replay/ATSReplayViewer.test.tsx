import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ResumeAnalysisWorkspace } from '../pages/ResumeAnalysisWorkspace';
import { afterEach, expect, it, vi } from 'vitest';
import { resumeUploadService } from '../../../services/resumeUploadService';
import { useSessionState } from '../state/useSessionState';
import type { ResumeSession } from '../types/resumeContracts';
import { ATSReplayViewer } from './ATSReplayViewer';

vi.mock('../../../services/resumeUploadService', () => ({
  resumeUploadService: { getSession: vi.fn(), resumeSession: vi.fn() },
}));

vi.mock('../../../hooks/useSse', () => ({ useSse: vi.fn() }));

const session: ResumeSession = {
  sessionId: 'resume-1',
  userId: 'user-1',
  createdAt: '',
  updatedAt: '',
  status: 'analyzing',
  fileInfo: { fileName: 'resume.pdf', fileSize: 40, mimeType: 'application/pdf' },
  stages: {
    upload: { status: 'success' },
    ats: { status: 'pending' },
    intelligence: { status: 'pending' },
    credibility: { status: 'pending' },
    recommendations: { status: 'pending' },
  },
};

function renderReplay(data: ResumeSession) {
  useSessionState.setState({ currentSession: data });
  render(<MemoryRouter><ATSReplayViewer /></MemoryRouter>);
}

afterEach(() => {
  cleanup();
  useSessionState.setState(useSessionState.getInitialState(), true);
  vi.resetAllMocks();
});

it.each(['pending', 'processing'] as const)('keeps the timeline visible while ATS is %s', (status) => {
  renderReplay({ ...session, stages: { ...session.stages, ats: { status } } });
  expect(screen.getByRole('status')).toHaveTextContent(/waiting for ATS analysis|in progress/i);
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  expect(screen.getAllByText('Awaiting results')).toHaveLength(3);
});

it('shows persisted ATS failure details and queues the existing recovery action', async () => {
  vi.mocked(resumeUploadService.getSession).mockResolvedValue({
    data: {
      ...session,
      currentStage: 'FAILED',
      uploadMetadata: { originalFilename: 'resume.pdf', fileSize: 40, mimeType: 'application/pdf' },
      processingHistory: [{ stage: 'ATS_ANALYZING', status: 'failed', error: 'Timed out' }],
      atsState: { analyzed: false },
      embeddingState: { generated: false },
      semanticState: { analyzed: false },
      recommendationState: { generated: false },
      failureState: { failed: true, failureReason: 'Parser timed out' },
      checkpointState: { stage: 'EXTRACTING' },
    },
  });
  await useSessionState.getState().fetchSession(session.sessionId);
  render(<MemoryRouter><ATSReplayViewer /></MemoryRouter>);

  expect(screen.getByRole('alert')).toHaveTextContent('Parser timed out');
  vi.mocked(resumeUploadService.resumeSession).mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Retry analysis' }));
  expect(await screen.findByText(/Retry queued/)).toBeInTheDocument();
  expect(resumeUploadService.resumeSession).toHaveBeenCalledWith(session.sessionId);
  expect(screen.getByRole('button', { name: 'Retry analysis' })).toBeDisabled();
});

it('offers a return to upload when there is no recoverable checkpoint', () => {
  renderReplay({ ...session, status: 'failed' });
  expect(screen.getByRole('link', { name: 'Return to Upload' })).toHaveAttribute('href', '/resume');
});

it('renders measured results including structured warnings and semantic similarity', () => {
  renderReplay({
    ...session,
    status: 'completed',
    stages: { ...session.stages, ats: { status: 'success' }, intelligence: { status: 'success' } },
    parsedContent: {
      text: 'Experience',
      sections: { Experience: 'Example', Skills: 'TypeScript' },
      parsingDiagnostics: { confidence: 0.91, warnings: ['Missing heading'], errors: [] },
    },
    atsState: { parserWarnings: ['Missing heading', { message: 'Unexpected columns' }] },
    semanticState: { semanticSimilarity: 0.82 },
  });

  expect(screen.getByText('Parsed 10 characters')).toBeInTheDocument();
  expect(screen.getByText('Identified 2 sections')).toBeInTheDocument();
  expect(screen.getByText('Parsing confidence: 91%')).toBeInTheDocument();
  expect(screen.getByText('Semantic similarity: 82%')).toBeInTheDocument();
  expect(screen.getAllByText('Missing heading')).toHaveLength(1);
  expect(screen.getByText('Unexpected columns')).toBeInTheDocument();
});

it('reports unavailable metrics when a completed session has no replay data', () => {
  renderReplay({ ...session, status: 'completed', stages: { ...session.stages, ats: { status: 'success' } } });
  expect(screen.getByText('Character count unavailable')).toBeInTheDocument();
  expect(screen.getByText('Section count unavailable')).toBeInTheDocument();
  expect(screen.getByText('Role alignment unavailable')).toBeInTheDocument();
});

it('opens ATS Replay from the analysis workspace before the report is available', async () => {
  useSessionState.setState({ currentSession: session });
  render(
    <MemoryRouter initialEntries={['/resume/analysis/resume-1']}>
      <Routes>
        <Route path="/resume/analysis/:sessionId" element={<ResumeAnalysisWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'ATS Replay' }));
  expect(await screen.findByRole('heading', { name: 'Operational Replay Workspace' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Waiting for ATS analysis');
});
