import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { BulletEdit } from '@devtrack/ats-core';
import fixtures from '../../../../../packages/ats-core/test/bullet-score-fixtures.json';
import { previewBulletScore, useLiveAtsScore } from './useLiveAtsScore';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const bullet = (editedText: string): BulletEdit => ({ section: 'Experience', bulletIndex: 0, originalText: 'Built APIs.', editedText });

it.each(fixtures)('matches the original backend score: $name', fixture => {
  expect(previewBulletScore(fixture.bullets, fixture.context)).toMatchObject(fixture.expected);
});

it('cancels obsolete previews and scores the final keystroke after 300ms', () => {
  vi.useFakeTimers();
  const context = { targetRole: 'Backend Engineer', keywords: ['Docker'] };
  const initial = [bullet('Worked on services.')];
  const { result, rerender, unmount } = renderHook(({ edits }) => useLiveAtsScore(edits, context), { initialProps: { edits: initial } });
  const before = result.current.score;
  rerender({ edits: [bullet('Built Docker services for 20 users.')] });
  act(() => { vi.advanceTimersByTime(200); });
  const latest = [bullet('Reduced Docker service latency by 30%.')];
  rerender({ edits: latest });
  act(() => { vi.advanceTimersByTime(299); });
  expect(result.current.pending).toBe(true);
  expect(result.current.score).toBe(before);
  act(() => { vi.advanceTimersByTime(1); });
  expect(result.current.pending).toBe(false);
  expect(result.current.score).toMatchObject({ quantified: 1, activeVerbs: 1, keywordsMatched: 1 });
  rerender({ edits: [bullet('Built another service.')] });
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('recalculates when the selected source changes its keyword context', () => {
  vi.useFakeTimers();
  const edits = [bullet('Built Docker services for 20 users.')];
  const { result, rerender } = renderHook(({ keywords }) => useLiveAtsScore(edits, { keywords }), { initialProps: { keywords: ['Docker'] } });
  rerender({ keywords: ['Kubernetes'] });
  act(() => { vi.advanceTimersByTime(300); });
  expect(result.current.score.keywordsMatched).toBe(0);
});
