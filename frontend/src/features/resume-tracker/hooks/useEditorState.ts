import { useMemo, useState } from 'react';
import type { BulletEdit } from '@devtrack/ats-core';
import { editorDocument, parseEditorDocument } from '../editor';

export function useEditorState(initial: BulletEdit[]) {
  const [baseline, setBaseline] = useState(initial);
  const [value, setValue] = useState(() => editorDocument(initial));
  const baselineDocument = useMemo(() => editorDocument(baseline), [baseline]);
  const parsed = useMemo(() => {
    try { return { bullets: parseEditorDocument(value, baseline), error: null }; }
    catch (error) { return { bullets: [] as BulletEdit[], error: (error as Error).message }; }
  }, [value, baseline]);
  return {
    value, setValue, baselineDocument, ...parsed, dirty: value !== baselineDocument,
    reset: (next: BulletEdit[]) => { setBaseline(next); setValue(editorDocument(next)); },
  };
}
