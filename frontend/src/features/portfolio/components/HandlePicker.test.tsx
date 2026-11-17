import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HandlePicker } from './HandlePicker';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function Harness({ serverError }: { serverError?: string | null }) {
  const [value, setValue] = useState('');
  return <HandlePicker value={value} onChange={setValue} serverError={serverError} />;
}

const type = (value: string) => fireEvent.change(screen.getByLabelText('Public handle'), { target: { value } });

it('waits 300ms after the last keystroke before judging the format', () => {
  render(<Harness />);
  type('a');
  act(() => { vi.advanceTimersByTime(299); });
  expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('false');
  type('ab');
  act(() => { vi.advanceTimersByTime(299); });
  expect(screen.queryByText(/at least 3/)).toBeNull();
  act(() => { vi.advanceTimersByTime(1); });
  expect(screen.getByText(/at least 3/)).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
});

it('says so when the format is fine', () => {
  render(<Harness />);
  type('Jane-Doe');
  act(() => { vi.advanceTimersByTime(300); });
  expect(screen.getByText('Format looks good. Your page would live at /u/jane-doe.')).toBeInTheDocument();
});

it('shows what the server said about a taken or reserved handle', () => {
  render(<Harness serverError="This handle is already taken" />);
  type('jane');
  act(() => { vi.advanceTimersByTime(300); });
  expect(screen.getByText('This handle is already taken')).toBeInTheDocument();
  expect(screen.queryByText(/Format looks good/)).toBeNull();
});
