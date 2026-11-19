import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SectionOrderCustomizer } from './SectionOrderCustomizer';

afterEach(cleanup);

it('moves supported sections with keyboard-accessible buttons', () => {
  const onChange = vi.fn();
  render(<SectionOrderCustomizer value={['streak', 'dsa', 'github', 'projects', 'activity']} onChange={onChange} />);

  expect(screen.getAllByRole('listitem').map((item) => item.textContent?.trim())).toEqual(['Streak', 'DSA progress', 'GitHub', 'Projects', 'Activity']);
  fireEvent.click(screen.getByRole('button', { name: 'Move DSA progress up' }));
  expect(onChange).toHaveBeenCalledWith(['dsa', 'streak', 'github', 'projects', 'activity']);
});

it('disables controls at the ends of the order', () => {
  render(<SectionOrderCustomizer value={['streak', 'dsa', 'github', 'projects', 'activity']} onChange={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Move Streak up' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Move Activity down' })).toBeDisabled();
});
