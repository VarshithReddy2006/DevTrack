import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RatingBar } from './RatingBar';

afterEach(cleanup);

describe('RatingBar', () => {
  it('maps clicks and 1/2/3 shortcuts to backend ratings', () => {
    const onRate = vi.fn();
    render(<RatingBar onRate={onRate} />);
    fireEvent.click(screen.getByRole('button', { name: /Failed/ }));
    fireEvent.keyDown(window, { key: '2' });
    fireEvent.keyDown(window, { key: '3' });
    expect(onRate.mock.calls.map(([rating]) => rating)).toEqual(['failed', 'hard', 'easy']);
  });

  it('ignores editable targets, modifiers, repeats, and disabled shortcuts', () => {
    const onRate = vi.fn();
    const { rerender } = render(<><input aria-label="Notes" /><RatingBar onRate={onRate} /></>);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Notes' }), { key: '1' });
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    fireEvent.keyDown(window, { key: '1', repeat: true });
    rerender(<RatingBar onRate={onRate} disabled />);
    fireEvent.keyDown(window, { key: '1' });
    fireEvent.click(screen.getByRole('button', { name: /Failed/ }));
    expect(onRate).not.toHaveBeenCalled();
  });

  it('removes its shortcut listener when unmounted', () => {
    const onRate = vi.fn();
    const { unmount } = render(<RatingBar onRate={onRate} />);
    unmount();
    fireEvent.keyDown(window, { key: '1' });
    expect(onRate).not.toHaveBeenCalled();
  });
});
