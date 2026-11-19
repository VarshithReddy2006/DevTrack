import { useEffect, useRef } from 'react';
import { actionVerbHighlighter } from '../../ats/editor/actionVerbExtension';
import { analyzeActionVerbs } from '@devtrack/ats-core';
import { Annotation, Compartment, EditorState, RangeSetBuilder } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Decoration, EditorView, ViewPlugin, keymap, lineNumbers, type DecorationSet, type ViewUpdate } from '@codemirror/view';

const externalChange = Annotation.define<boolean>();
function highlights(view: EditorView) {
  const ranges = new RangeSetBuilder<Decoration>();
  for (let i = 1; i <= view.state.doc.lines; i++) {
    const line = view.state.doc.line(i);
    if (/^\s*#/.test(line.text)) continue;
    const prefix = line.text.match(/^\s*(?:[-*+•]\s*|\d+[.)]\s+)?/)![0].length;
    const text = line.text.slice(prefix);
    if (analyzeActionVerbs([text])[0]) {
      const verb = text.match(/^\w+/)!;
      ranges.add(line.from + prefix, line.from + prefix + verb[0].length, Decoration.mark({ class: 'bullet-action-verb' }));
    }
    for (const match of text.matchAll(/\b\d[\d,.]*(?:%|x\b)?/g)) {
      const from = line.from + prefix + match.index!;
      ranges.add(from, from + match[0].length, Decoration.mark({ class: 'bullet-metric' }));
    }
  }
  return ranges.finish();
}
const bulletHighlights = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = highlights(view); }
  update(update: ViewUpdate) { if (update.docChanged) this.decorations = highlights(update.view); }
}, { decorations: plugin => plugin.decorations });

export default function BulletEditor({ value, onChange, readOnly }: { value: string; onChange: (value: string) => void; readOnly: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ value, onChange });
  const editable = useRef(new Compartment());
  useEffect(() => { latest.current = { value, onChange }; }, [value, onChange]);
  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          lineNumbers(), EditorView.lineWrapping, history(), keymap.of([...defaultKeymap, ...historyKeymap]), bulletHighlights, actionVerbHighlighter,
          EditorView.contentAttributes.of({ 'aria-label': 'Resume bullets', 'aria-describedby': 'bullet-instructions', role: 'textbox', 'aria-multiline': 'true' }),
          editable.current.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalChange))) latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: externalChange.of(true) });
  }, [value]);
  useEffect(() => { view.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) }); }, [readOnly]);
  return <div className="resume-bullet-editor" ref={host} />;
}
