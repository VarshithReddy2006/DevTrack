import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResumeIntelligenceDossier } from './ResumeIntelligenceDossier';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../state/useSessionState', () => ({ useSessionState: () => ({ currentSession: { sessionId: 'session-a' } }) }));
vi.mock('../../../utils/axiosClient.js', () => ({ default: mocks }));
vi.mock('framer-motion', () => ({ motion: { div: ({ children, ...props }: any) => <div {...props}>{children}</div> } }));

const report = {
  executiveSummary: { narrative: 'Summary', engineeringMaturity: 'A', atsSurvivability: 'B', recruiterTrustLevel: 'C', infrastructureMaturity: 'D', operationalReadiness: 50 },
  atsAnalysis: { atsScore: 50, atsExplanation: 'ATS', parserWarnings: [] },
  roleAlignment: { backend: 1, platform: 2, devops: 3, ml: 4, fullstack: 5, alignmentExplanation: '' },
  credibilityAnalysis: { overallScore: 50, verifiedClaims: [], unsupportedClaims: [], warnings: [], projectRankings: [] },
  recruiterProjection: { narrative: '', rejectionTriggers: [], interviewTriggers: [] },
  infrastructureMaturity: { detectedTechnologies: [] }, recommendations: [], finalVerdict: 'Verdict',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ data: { success: true, data: report } });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('downloads the PDF returned for the current session', async () => {
  mocks.post.mockResolvedValue({ data: new Blob(['%PDF-test'], { type: 'application/pdf' }), headers: { 'content-type': 'application/pdf' } });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<ResumeIntelligenceDossier />);
  fireEvent.click(await screen.findByRole('button', { name: /export dossier/i }));
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(mocks.post).toHaveBeenCalledWith('/resume-intelligence/dossier-pdf', { sessionId: 'session-a' }, { responseType: 'blob' });
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
});

it('shows a failure instead of claiming success or opening print', async () => {
  mocks.post.mockRejectedValue(new Error('server failed'));
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  render(<ResumeIntelligenceDossier />);
  fireEvent.click(await screen.findByRole('button', { name: /export dossier/i }));
  expect((await screen.findByRole('alert')).textContent).toContain('Could not download');
  expect(print).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
