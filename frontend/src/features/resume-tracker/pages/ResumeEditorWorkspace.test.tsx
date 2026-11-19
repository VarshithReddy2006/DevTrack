import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import api from '../../../utils/axiosClient';
import { ResumeEditorWorkspace } from './ResumeEditorWorkspace';
import { EditorNavigationGuard } from '../context/EditorNavigationGuard';

vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: 'editor-user' }) }));
vi.mock('../../../utils/axiosClient', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../components/BulletEditor', () => ({ default: ({ value, onChange, readOnly }: { value: string; onChange: (value: string) => void; readOnly: boolean }) => <textarea aria-label="Resume bullets" value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} /> }));
const response = (data: unknown): AxiosResponse => ({ data: { success: true, data }, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
const profile = { _id: 'profile-id', targetRole: 'Backend Engineer', summary: 'Built a service.', selectedSkills: ['Docker'], activeVariant: 'backend-original' };
const variant = { _id: 'variant-id', variantId: 'backend-original', roleType: 'Backend', prioritizedSkills: ['Docker'], bulletEdits: [{ section: 'Experience', bulletIndex: 0, originalText: 'Worked on APIs.', editedText: 'Built a service.' }] };
const get = vi.mocked(api.get);
const post = vi.mocked(api.post);

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => {
  get.mockReset(); post.mockReset();
  get.mockImplementation(async path => response(path === '/resume-intelligence/profile' ? profile : [variant]));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/resume/editor']}><EditorNavigationGuard><Link to="/other">Other page</Link><Routes><Route path="/resume/editor" element={<ResumeEditorWorkspace />} /><Route path="/other" element={<h1>Other page</h1>} /></Routes></EditorNavigationGuard></MemoryRouter></QueryClientProvider>);
}
async function edit() {
  const field = await screen.findByLabelText('Resume bullets');
  fireEvent.change(field, { target: { value: '# Experience\n- Reduced Docker latency by 30%.' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save as variant' })).toBeEnabled());
  return field;
}
async function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Save as variant' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save variant' }));
}

it('scores edits locally, saves the actual bullets once and resets dirty state only after confirmation', async () => {
  post.mockImplementation(async (_path, input) => {
    if (!input || typeof input !== 'object') throw new Error('Missing request body');
    return response({ ...variant, _id: 'new-id', variantId: 'backend-saved', ...input, prioritizedSkills: ['Docker'], atsScore: { score: 50 } });
  });
  mount(); await edit();
  expect(get).toHaveBeenCalledTimes(2);
  expect(post).not.toHaveBeenCalled();
  expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  await submit();
  expect(await screen.findByText(/Saved backend-saved/)).toBeInTheDocument();
  expect(screen.getByText('No unsaved changes')).toBeInTheDocument();
  expect(post).toHaveBeenCalledExactlyOnceWith('/resume-intelligence/variants', expect.objectContaining({ roleType: 'Backend', bulletEdits: [{ section: 'Experience', bulletIndex: 0, originalText: 'Built a service.', editedText: 'Reduced Docker latency by 30%.' }], clientScore: expect.any(Number) }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it.each(['network failure', 'normalized API failure', 'flag stripped the edits'])('keeps the draft and dirty state when %s', async failure => {
  if (failure === 'network failure') post.mockRejectedValue(new Error('Service unavailable.'));
  else if (failure === 'normalized API failure') post.mockRejectedValue({ message: 'Service unavailable.', code: 'SERVER_ERROR' });
  else post.mockResolvedValue(response({ ...variant, bulletEdits: undefined }));
  mount(); const field = await edit(); await submit();
  expect(await screen.findByRole('alert')).toHaveTextContent(failure === 'flag stripped the edits' ? 'did not confirm the edited bullets' : 'Service unavailable.');
  expect(field).toHaveValue('# Experience\n- Reduced Docker latency by 30%.');
  expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('cancels source changes and SPA navigation without losing edits, then allows confirmed navigation', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  mount(); const field = await edit();
  fireEvent.change(screen.getByLabelText('Resume source'), { target: { value: 'profile' } });
  expect(screen.getByLabelText('Resume source')).toHaveValue('variant-id');
  fireEvent.click(screen.getByRole('link', { name: 'Other page' }));
  expect(field).toHaveValue('# Experience\n- Reduced Docker latency by 30%.');
  expect(screen.queryByRole('heading', { name: 'Other page' })).not.toBeInTheDocument();
  expect(confirm).toHaveBeenCalledTimes(2);
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('link', { name: 'Other page' }));
  expect(await screen.findByRole('heading', { name: 'Other page' })).toBeInTheDocument();
});

it('rejects malformed source responses and retries without exposing an unusable editor', async () => {
  get.mockResolvedValue(response({ arbitrary: true })); mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load');
  expect(screen.queryByLabelText('Resume bullets')).not.toBeInTheDocument();
  get.mockImplementation(async path => response(path === '/resume-intelligence/profile' ? profile : [variant]));
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByLabelText('Resume bullets')).toHaveValue('# Experience\n- Built a service.');
});
