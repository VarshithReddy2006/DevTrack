import '@testing-library/jest-dom/vitest';
import { Compartment, EditorState } from '@codemirror/state';
import { history, redo, undo } from '@codemirror/commands';
import { activateHover, EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { actionVerbHighlighter } from '../editor/actionVerbExtension';
import { suggestionsFor } from '../editor/verbDictionary';

const views: EditorView[] = [];
beforeAll(() => {
  // jsdom has no layout; real-browser hover and layout need a separate smoke check.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  for (const view of views.splice(0)) { view.destroy(); view.dom.parentElement?.remove(); }
  vi.restoreAllMocks();
});

function editor(doc: string, anchor = 0, extra: ReturnType<Compartment['of']>[] = []) {
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({ parent, state: EditorState.create({
    doc, selection: { anchor }, extensions: [history(), actionVerbHighlighter, ...extra],
  }) });
  views.push(view); return view;
}
const marks = (view: EditorView) => [...view.dom.querySelectorAll('.cm-weak-verb')].map(node => node.textContent);
function key(view: EditorView, name: string, altKey = false) {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { key: name, altKey, bubbles: true }), 'editor');
}
function hover(view: EditorView, pos = 3, side: -1 | 1 = 1) {
  activateHover(view, pos, side, { until: tr => tr.docChanged || !!tr.selection });
  return view.dom.querySelector<HTMLElement>('.cm-verb-suggestions');
}

describe('local weak-verb matching', () => {
  it.each([
    ['- Worked on APIs', 'Worked on'],
    ['* helped with deployments', 'helped with'],
    ['1. Responsible for testing', 'Responsible for'],
    ['• WORKED ON RELEASES', 'WORKED ON'],
    ['  + Helped   with reviews', 'Helped   with'],
    ['Was involved in releases', 'Was involved in'],
    ['Participated in design', 'Participated in'],
  ])('underlines the exact phrase in %s', (doc, phrase) => {
    expect(marks(editor(doc))).toEqual([phrase]);
  });
  it.each(['Built APIs', 'Reworked ongoing tasks', 'Helped without context', '# Worked on APIs', '## Responsible for tasks', 'Worked oncall'])('ignores %s', doc => {
    expect(marks(editor(doc))).toEqual([]);
  });
  it('highlights only the active line and moves marks with the caret', () => {
    const view = editor('- Worked on APIs\n- Helped with deployments');
    expect(marks(view)).toEqual(['Worked on']);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(marks(view)).toEqual(['Helped with']);
    view.dispatch({ selection: { anchor: 0 } });
    expect(marks(view)).toEqual(['Worked on']);
  });
  it('updates matching after typing, deleting, and inserting newlines', () => {
    const view = editor('Worked o');
    view.dispatch({ changes: { from: 8, insert: 'n APIs' } });
    expect(marks(view)).toEqual(['Worked on']);
    view.dispatch({ changes: { from: 0, to: 1, insert: 'R' } });
    expect(marks(view)).toEqual([]);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Worked on APIs\nHelped with builds' }, selection: { anchor: 30 } });
    expect(marks(view)).toEqual(['Helped with']);
  });
  it('does not join phrases across lines', () => {
    const view = editor('Worked\non deployments');
    expect(marks(view)).toEqual([]);
  });
  it('preserves lower/title/upper case in all three alternatives', () => {
    expect(suggestionsFor('worked on')).toEqual(['developed', 'improved', 'contributed to']);
    expect(suggestionsFor('Worked on')).toEqual(['Developed', 'Improved', 'Contributed to']);
    expect(suggestionsFor('WORKED ON')).toEqual(['DEVELOPED', 'IMPROVED', 'CONTRIBUTED TO']);
    expect(suggestionsFor('not a match')).toEqual([]);
  });
});

describe('suggestion interaction', () => {
  it('opens three labeled buttons on a marked phrase and replaces only its range', () => {
    const view = editor('- Worked on APIs handling customer requests');
    const tooltip = hover(view)!;
    const buttons = tooltip.querySelectorAll('button');
    expect(buttons).toHaveLength(3);
    expect(tooltip).toHaveAccessibleName('Action verb suggestions');
    expect(buttons[0]).toHaveAccessibleName('Replace "Worked on" with "Developed"');
    buttons[0].click();
    expect(view.state.doc.toString()).toBe('- Developed APIs handling customer requests');
    expect(view.state.selection.main.head).toBe('- Developed'.length);
    expect(marks(view)).toEqual([]);
    expect(view.dom.querySelector('.cm-verb-suggestions')).toBeNull();
  });
  it('maintains an independent undo step even immediately after typing', () => {
    const view = editor('- Worked on APIs');
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' safely' }, userEvent: 'input.type' });
    hover(view)!.querySelector('button')!.click();
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- Worked on APIs safely');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- Worked on APIs');
    expect(redo(view)).toBe(true); expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- Developed APIs safely');
  });
  it('supports Alt+Enter anywhere on the active line, focus, Escape, and keyboard activation', () => {
    const view = editor('- Worked on APIs', 16);
    view.focus();
    expect(key(view, 'Enter', true)).toBe(true);
    let first = view.dom.querySelector<HTMLButtonElement>('.cm-verb-suggestions button')!;
    expect(first).toHaveFocus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(view.dom.querySelector('.cm-verb-suggestions')).toBeNull();
    expect(view.contentDOM).toHaveFocus();
    key(view, 'Enter', true);
    first = view.dom.querySelector<HTMLButtonElement>('.cm-verb-suggestions button')!;
    first.click();
    expect(view.state.doc.toString()).toBe('- Developed APIs');
    expect(view.contentDOM).toHaveFocus();
  });
  it('does not intercept Alt+Enter or Escape when there is no suggestion', () => {
    const view = editor('Built reliable APIs');
    expect(key(view, 'Enter', true)).toBe(false);
    expect(key(view, 'Escape')).toBe(false);
    expect(hover(view, 3)).toBeNull();
  });
  it('dismisses pointer hover with Escape from the editor and avoids duplicate keyboard/hover panels', () => {
    const view = editor('- Worked on APIs');
    hover(view);
    expect(key(view, 'Escape')).toBe(true);
    expect(view.dom.querySelector('.cm-verb-suggestions')).toBeNull();
    key(view, 'Enter', true);
    hover(view);
    expect(view.dom.querySelectorAll('.cm-verb-suggestions')).toHaveLength(1);
  });
  it('honors hover boundaries', () => {
    const view = editor('- Worked on APIs');
    expect(hover(view, 2, -1)).toBeNull();
    expect(hover(view, 11, 1)).toBeNull();
    expect(hover(view, 2, 1)).not.toBeNull();
  });
  it('dismisses on caret changes and external document updates', () => {
    const view = editor('- Worked on APIs\n- Helped with deployments');
    key(view, 'Enter', true);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(view.dom.querySelector('.cm-verb-suggestions')).toBeNull();
    hover(view, view.state.doc.line(2).from + 3);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Built APIs' } });
    expect(view.dom.querySelector('.cm-verb-suggestions')).toBeNull();
  });
  it('rejects stale replacement buttons after a change', () => {
    const view = editor('- Worked on APIs');
    const stale = hover(view)!.querySelector('button')!;
    view.dispatch({ changes: { from: 0, insert: 'prefix ' } });
    stale.click();
    expect(view.state.doc.toString()).toBe('prefix - Worked on APIs');
  });
  it.each(['readOnly', 'editable'])('respects %s reconfiguration and blocks even stale buttons', mode => {
    const settings = new Compartment();
    const view = editor('- Worked on APIs', 0, [settings.of([])]);
    const stale = hover(view)!.querySelector('button')!;
    view.dispatch({ effects: settings.reconfigure(mode === 'readOnly' ? EditorState.readOnly.of(true) : EditorView.editable.of(false)) });
    expect(view.dom.querySelector('.cm-verb-suggestions')).toBeNull();
    expect(hover(view)).toBeNull();
    expect(key(view, 'Enter', true)).toBe(false);
    stale.click(); expect(view.state.doc.toString()).toBe('- Worked on APIs');
  });
  it('uses text nodes for untrusted surrounding content', () => {
    const view = editor('- Worked on <img src=x onerror=alert(1)>');
    const tooltip = hover(view)!;
    expect(tooltip.querySelector('img')).toBeNull();
    tooltip.querySelector('button')!.click();
    expect(view.state.doc.toString()).toContain('<img src=x onerror=alert(1)>');
  });
  it('makes no fetch or XHR calls while typing, opening suggestions, or replacing', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const view = editor('- Worked on APIs');
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' for customers' } });
    key(view, 'Enter', true);
    view.dom.querySelector<HTMLButtonElement>('.cm-verb-suggestions button')!.click();
    expect(fetchSpy).not.toHaveBeenCalled(); expect(xhrSpy).not.toHaveBeenCalled();
  });
  it('keeps rapid edits within the active-line matching budget on a 200-bullet document', () => {
    const view = editor(Array.from({ length: 200 }, () => '- Worked on reliable APIs for customers').join('\n'));
    const samples: number[] = [];
    for (let index = 0; index < 150; index++) {
      const start = performance.now();
      view.dispatch({ changes: { from: view.state.doc.line(1).to, insert: 'x' } });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    console.info(`Action verb active-line edit p95: ${p95.toFixed(2)}ms (150 edits, 200 bullets, jsdom)`);
    expect(p95).toBeLessThan(50);
    expect(marks(view)).toEqual(['Worked on']);
  });
});
