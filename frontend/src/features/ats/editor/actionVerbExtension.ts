import { StateEffect, StateField, Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import {
  closeHoverTooltips, Decoration, EditorView, hasHoverTooltips, hoverTooltip, keymap, MatchDecorator,
  showTooltip, ViewPlugin, type DecorationSet, type Tooltip, type ViewUpdate,
} from '@codemirror/view';
import { suggestionsFor, verbDictionary } from './verbDictionary';

const weakVerbs = new MatchDecorator({
  regexp: new RegExp('\\b(?:' + verbDictionary.map(entry => entry.phrase.replace(/ /g, '[ \\t]+')).join('|') + ')\\b', 'gi'),
  decoration: (_match, view, from) => {
    const line = view.state.doc.lineAt(from);
    return line.from === view.state.doc.lineAt(view.state.selection.main.head).from && !/^\s*#/.test(line.text)
      ? Decoration.mark({ class: 'cm-weak-verb' }) : null;
  },
});
const highlights = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = weakVerbs.createDeco(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      // MatchDecorator bounds matching to visible ranges, rather than scanning the document.
      this.decorations = weakVerbs.createDeco(update.view);
    }
  }
}, { decorations: value => value.decorations });

const openSuggestions = StateEffect.define<Tooltip | null>();
const keyboardTooltip = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.reconfigured) value = null;
    for (const effect of tr.effects) if (effect.is(openSuggestions)) value = effect.value;
    return value;
  },
  provide: field => showTooltip.from(field),
});

function matchAt(view: EditorView, pos: number, side: number) {
  let found: { from: number; to: number } | undefined;
  view.plugin(highlights)?.decorations.between(pos, pos, (from, to) => {
    if (!(pos === from && side < 0 || pos === to && side > 0)) found = { from, to };
  });
  return found;
}

function dismiss(view: EditorView) {
  view.dispatch({ effects: [openSuggestions.of(null), closeHoverTooltips] });
  view.focus();
}

function suggestionTooltip(view: EditorView, from: number, to: number, keyboard = false): Tooltip {
  const original = view.state.sliceDoc(from, to);
  return {
    pos: from, end: to, above: true, arrow: true,
    create(view) {
      const dom = document.createElement('div');
      dom.className = 'cm-verb-suggestions';
      dom.setAttribute('role', 'group');
      dom.setAttribute('aria-label', 'Action verb suggestions');
      const label = dom.appendChild(document.createElement('p'));
      label.textContent = 'Choose a verb that matches your contribution.';
      for (const suggestion of suggestionsFor(original)) {
        const button = dom.appendChild(document.createElement('button'));
        button.type = 'button';
        button.textContent = suggestion;
        button.setAttribute('aria-label', `Replace "${original}" with "${suggestion}"`);
        button.onmousedown = event => event.preventDefault();
        button.onclick = () => {
          const current = matchAt(view, from, 1);
          if (view.state.readOnly || !view.state.facet(EditorView.editable)
            || current?.from !== from || current.to !== to || view.state.sliceDoc(from, to) !== original) return;
          view.dispatch({
            changes: { from, to, insert: suggestion },
            selection: { anchor: from + suggestion.length },
            annotations: [Transaction.userEvent.of('input.complete'), isolateHistory.of('full')],
          });
          view.focus();
        };
      }
      dom.onkeydown = event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(view); }
      };
      return { dom, mount() { if (keyboard) dom.querySelector('button')?.focus(); } };
    },
  };
}

const hoverSuggestions = hoverTooltip((view, pos, side) => {
  if (view.state.field(keyboardTooltip)) return null;
  if (view.state.readOnly || !view.state.facet(EditorView.editable)) return null;
  const match = matchAt(view, pos, side);
  return match ? suggestionTooltip(view, match.from, match.to) : null;
}, { hideOnChange: true, hideOn: tr => tr.reconfigured, hoverTime: 200 });

export const actionVerbHighlighter = [
  highlights, hoverSuggestions, keyboardTooltip,
  keymap.of([{
    key: 'Alt-Enter',
    run(view) {
      if (view.state.readOnly || !view.state.facet(EditorView.editable)) return false;
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const match = matchAt(view, view.state.selection.main.head, 1) ?? (() => {
        let first: { from: number; to: number } | undefined;
        view.plugin(highlights)?.decorations.between(line.from, line.to, (from, to) => { first ??= { from, to }; });
        return first;
      })();
      if (!match) return false;
      view.dispatch({ effects: [closeHoverTooltips, openSuggestions.of(suggestionTooltip(view, match.from, match.to, true))] });
      return true;
    },
  }, {
    key: 'Escape',
    run(view) {
      if (!view.state.field(keyboardTooltip) && !hasHoverTooltips(view.state)) return false;
      dismiss(view); return true;
    },
  }]),
  EditorView.baseTheme({
    '.cm-weak-verb': { textDecoration: 'underline wavy #d97706', textUnderlineOffset: '3px' },
    '.cm-verb-suggestions': { padding: '8px', maxWidth: 'min(320px, 85vw)', fontSize: '13px', whiteSpace: 'normal' },
    '.cm-verb-suggestions p': { margin: '0 0 6px' },
    '.cm-verb-suggestions button': { display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px', borderRadius: '4px', cursor: 'pointer', color: 'inherit', backgroundColor: 'transparent', border: '1px solid transparent' },
    '.cm-verb-suggestions button:hover': { backgroundColor: '#e2e8f0', color: '#0f172a' },
    '.cm-verb-suggestions button:focus-visible': { outline: '2px solid #7c3aed', outlineOffset: '1px' },
    '&dark .cm-verb-suggestions button:hover': { backgroundColor: '#334155', color: '#f8fafc' },
  }),
];
