import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../../utils/axiosClient';
import { loadBulletHistory, restoreBulletRevision } from '../../../services/bulletRevisionService';
import { BulletRevisionHistoryDrawer } from '../components/BulletRevisionHistoryDrawer';
import { RevisionDiffViewer } from '../components/RevisionDiffViewer';
import { parseBulletHistory, previewRevisionRestore, relativeRevisionTime } from '../revisionHistory';

vi.mock('../../../utils/axiosClient', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const resumeId = 'a'.repeat(24);
const bullet = (editedText: string, section = 'experience', bulletIndex = 0) => ({ section, bulletIndex, originalText: 'Original text.', editedText });
const first = [bullet('Built APIs.'), bullet('JavaScript', 'skills')];
const second = [bullet('Reduced latency 30%.'), first[1]];
const latest = [second[0], bullet('TypeScript', 'skills')];
const checkpoint = (versionNumber: number, state: ReturnType<typeof bullet>[], sectionId = '*') => ({ resumeId, versionNumber, sectionId, atsScore: 40 + versionNumber, createdAt: new Date(Date.parse('2026-11-19T01:00:00Z') + versionNumber * 60000).toISOString(), patch: [{ op: 'replace', path: '', value: state }] as { op: string; path: string; value: unknown }[], ...(versionNumber === 1 ? { baseSnapshot: [] } : {}) });
const ledger = () => ({ currentVersion: 3, revisions: [checkpoint(1, first), checkpoint(2, second, 'experience'), checkpoint(3, latest, 'skills')] });
const response = (data: unknown): AxiosResponse => ({ data: { success: true, data }, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
const restored = { _id: resumeId, variantId: 'backend-saved', roleType: 'Backend', prioritizedSkills: ['TypeScript'], bulletEdits: latest, atsScore: { score: 81 }, bulletRevisionVersion: 4 };
const get = vi.mocked(api.get), post = vi.mocked(api.post);
beforeEach(() => { get.mockReset(); post.mockReset(); get.mockResolvedValue(response(ledger())); post.mockResolvedValue(response(restored)); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('retained server ledger', () => {
  it('reconstructs array and field patches without mutating prior snapshots or input', () => {
    const input = ledger();
    input.revisions[1].patch = [{ op: 'replace', path: '/0/editedText', value: 'Reduced latency 30%.' }];
    input.revisions[2].patch = [{ op: 'remove', path: '/1', value: undefined }, { op: 'add', path: '/1', value: latest[1] }];
    const history = parseBulletHistory(input, resumeId);
    expect(history.checkpoints[0].after).toEqual(first);
    expect(history.checkpoints[1].before).toEqual(first);
    expect(history.currentBullets).toEqual(latest);
    history.currentBullets[0].editedText = 'Local mutation';
    expect(history.checkpoints[2].after).toEqual(latest);
    expect(input.revisions[0].patch[0].value).toEqual(first);
  });
  it('starts at the oldest retained baseline after pruning, without inventing lost versions', () => {
    const retained = { ...checkpoint(51, second, 'experience'), baseSnapshot: first };
    const history = parseBulletHistory({ currentVersion: 51, revisions: [retained] }, resumeId);
    expect(history.checkpoints.map(item => item.versionNumber)).toEqual([51]);
    expect(history.checkpoints[0].before).toEqual(first);
    expect(history.currentBullets).toEqual(second);
  });
  it.each(['wrong owner resource', 'gap', 'missing baseline', 'stale version', 'unsafe field', 'invalid bullet', 'invalid index'])('rejects %s instead of displaying a misleading diff', reason => {
    const input = ledger();
    if (reason === 'wrong owner resource') input.revisions[0].resumeId = 'b'.repeat(24);
    if (reason === 'gap') input.revisions.splice(1, 1);
    if (reason === 'missing baseline') delete input.revisions[0].baseSnapshot;
    if (reason === 'stale version') input.currentVersion = 4;
    if (reason === 'unsafe field') input.revisions[1].patch = [{ op: 'replace', path: '/0/__proto__', value: 'bad' }];
    if (reason === 'invalid bullet') input.revisions[1].patch = [{ op: 'replace', path: '/0/editedText', value: '' }];
    if (reason === 'invalid index') input.revisions[1].patch = [{ op: 'replace', path: '/200', value: first[0] }];
    expect(() => parseBulletHistory(input, resumeId)).toThrow();
  });
  it('previews section restores against current saved sections, and whole checkpoints independently', () => {
    const history = parseBulletHistory(ledger(), resumeId);
    const modifiedCurrent = [bullet('Latest experience'), bullet('Latest skills', 'skills')];
    expect(previewRevisionRestore(modifiedCurrent, history.checkpoints[1])).toEqual([second[0], modifiedCurrent[1]]);
    expect(previewRevisionRestore(modifiedCurrent, history.checkpoints[0])).toEqual(first);
  });
  it('uses recorded minutes and hours, including future dates', () => {
    const now = Date.parse('2026-11-19T01:15:00Z');
    expect(relativeRevisionTime('2026-11-19T01:03:00Z', now)).toContain('12 minutes');
    expect(relativeRevisionTime('2026-11-18T23:15:00Z', now)).toContain('2 hours');
    expect(relativeRevisionTime('2026-11-19T01:20:00Z', now)).toContain('5 minutes');
  });
});

describe('verified revision requests', () => {
  it('uses the real resume endpoint, cancellation signal, and exact optimistic version body', async () => {
    const signal = new AbortController().signal;
    expect((await loadBulletHistory(resumeId, signal)).currentVersion).toBe(3);
    expect(get).toHaveBeenCalledExactlyOnceWith(`/resume/${resumeId}/revisions`, { signal });
    expect(await restoreBulletRevision(resumeId, 2, 3)).toEqual(restored);
    expect(post).toHaveBeenCalledExactlyOnceWith(`/resume/${resumeId}/revisions/2/restore`, { expectedVersion: 3 });
  });
  it.each(['identity', 'version', 'bullets', 'score'])('does not replace a draft on unconfirmed %s', async reason => {
    const value: Record<string, unknown> = { ...restored };
    if (reason === 'identity') value._id = 'b'.repeat(24);
    if (reason === 'version') value.bulletRevisionVersion = 3;
    if (reason === 'bullets') delete value.bulletEdits;
    if (reason === 'score') delete value.atsScore;
    post.mockResolvedValue(response(value));
    await expect(restoreBulletRevision(resumeId, 2, 3)).rejects.toThrow('Could not confirm');
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid IDs and impossible versions before sending a mutation', async () => {
    await expect(loadBulletHistory('../other')).rejects.toThrow();
    await expect(restoreBulletRevision(resumeId, 4, 3)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });
});

it('renders semantic word additions and deletions, inert markup, all paginated changes and the no-change state', () => {
  const { container, rerender } = render(<RevisionDiffViewer before={[bullet('Built REST APIs')]} after={[bullet('Built <script>safe</script> APIs')]} />);
  expect(container.querySelector('del')).toHaveTextContent('REST');
  expect(container.querySelector('ins')).toHaveTextContent('<script>safe</script>');
  expect(container.querySelector('script')).toBeNull();
  const many = Array.from({ length: 45 }, (_, index) => bullet(`New bullet ${index}`, 'experience', index));
  rerender(<RevisionDiffViewer before={[]} after={many} />);
  expect(screen.getByText('Changes 1–20 of 45')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next changes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next changes' }));
  expect(screen.getByText('Changes 41–45 of 45')).toBeInTheDocument();
  expect(screen.getByText(/New bullet 44/)).toBeInTheDocument();
  rerender(<RevisionDiffViewer before={first} after={first} />);
  expect(screen.getByText('No bullet text changes in this comparison.')).toBeInTheDocument();
});

function mount() {
  const onClose = vi.fn(), onBusy = vi.fn(), onRestored = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><BulletRevisionHistoryDrawer userId="owner" resumeId={resumeId} dirty onClose={onClose} onBusy={onBusy} onRestored={onRestored} /></QueryClientProvider>);
  return { onClose, onBusy, onRestored };
}
async function choose() {
  fireEvent.click(await screen.findByRole('button', { name: /Version 2.*ATS/ }));
  screen.getByRole('button', { name: 'Restore this version' }).focus();
  fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
  return screen.findByRole('dialog', { name: 'Restore version 2?' });
}
it('lists actual checkpoint scores and relative times, and cancels a focused confirmation without restoring', async () => {
  const callbacks = mount();
  const dialog = await choose();
  expect(screen.getByRole('button', { name: /Version 3.*ATS 43/ })).toBeInTheDocument();
  expect(document.querySelectorAll('time')).toHaveLength(3);
  expect(within(dialog).getByRole('button', { name: 'Keep current draft' })).toHaveFocus();
  within(dialog).getByRole('button', { name: 'Close dialog' }).focus();
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(within(dialog).getByRole('button', { name: 'Confirm restore' })).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Restore version 2?' })).toBeNull());
  expect(screen.getByRole('button', { name: 'Restore this version' })).toHaveFocus();
  expect(post).not.toHaveBeenCalled(); expect(callbacks.onRestored).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' }); expect(callbacks.onClose).toHaveBeenCalledTimes(1);
});
it('sends one confirmed restore, locks dismiss while pending and returns the full verified variant', async () => {
  let finish!: (value: AxiosResponse) => void;
  post.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const callbacks = mount(); await choose();
  const confirm = screen.getByRole('button', { name: 'Confirm restore' });
  fireEvent.click(confirm); fireEvent.click(confirm);
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(callbacks.onClose).not.toHaveBeenCalled();
  expect(callbacks.onBusy).toHaveBeenCalledWith(true);
  await act(async () => { finish(response(restored)); });
  await waitFor(() => expect(callbacks.onRestored).toHaveBeenCalledExactlyOnceWith(restored, 2, 'experience'));
  expect(callbacks.onBusy).toHaveBeenLastCalledWith(false);
  expect(callbacks.onClose).toHaveBeenCalledTimes(1);
});
it.each([409, 503])('keeps the draft on HTTP %s and requires explicit history refresh before retry', async statusCode => {
  post.mockRejectedValue({ statusCode });
  const callbacks = mount(); await choose(); fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Your editor draft is unchanged');
  expect(callbacks.onRestored).not.toHaveBeenCalled(); expect(callbacks.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Restore this version' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Restore this version' })).toBeEnabled());
  expect(post).toHaveBeenCalledTimes(1);
});
it('shows empty history without fabricating a revision or restore action', async () => {
  get.mockResolvedValue(response({ currentVersion: 0, revisions: [] })); mount();
  expect(await screen.findByText(/No saved revisions yet/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Restore this version' })).toBeNull();
});
it('fails closed on malformed history, then recovers with explicit refresh', async () => {
  get.mockResolvedValueOnce(response({ currentVersion: 8, revisions: [] })); mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('trustworthy');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }));
  expect(await screen.findByRole('button', { name: /Version 3.*ATS/ })).toBeInTheDocument();
});
