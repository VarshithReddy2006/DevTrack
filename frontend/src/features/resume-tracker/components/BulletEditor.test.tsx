import '@testing-library/jest-dom/vitest';
import { EditorView } from '@codemirror/view';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import BulletEditor from './BulletEditor';

beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(cleanup);

it('wires suggestions into the real editor without losing strong-verb or metric marks', () => {
  const onChange = vi.fn();
  const { container } = render(<BulletEditor value="- Worked on APIs for 20 customers" readOnly={false} onChange={onChange} />);
  const field = screen.getByRole('textbox', { name: 'Resume bullets' });
  const view = EditorView.findFromDOM(field)!;
  expect(container.querySelector('.cm-weak-verb')).toHaveTextContent('Worked on');
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }));
  container.querySelector<HTMLButtonElement>('.cm-verb-suggestions button')!.click();
  expect(onChange).toHaveBeenCalledWith('- Developed APIs for 20 customers');
  expect(container.querySelector('.bullet-action-verb')).toHaveTextContent('Developed');
  expect(container.querySelector('.bullet-metric')).toHaveTextContent('20');
  expect(view.state.selection.main.head).toBe('- Developed'.length);
});

it('keeps suggestions disabled through the existing readOnly prop and external value updates', () => {
  const onChange = vi.fn();
  const { container, rerender } = render(<BulletEditor value="- Worked on APIs" readOnly={false} onChange={onChange} />);
  let field = screen.getByRole('textbox', { name: 'Resume bullets' });
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }));
  expect(container.querySelector('.cm-verb-suggestions')).not.toBeNull();
  rerender(<BulletEditor value="- Helped with builds" readOnly={true} onChange={onChange} />);
  field = screen.getByRole('textbox', { name: 'Resume bullets' });
  expect(container.querySelector('.cm-verb-suggestions')).toBeNull();
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }));
  expect(container.querySelector('.cm-verb-suggestions')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  expect(EditorView.findFromDOM(field)!.state.doc.toString()).toBe('- Helped with builds');
});
