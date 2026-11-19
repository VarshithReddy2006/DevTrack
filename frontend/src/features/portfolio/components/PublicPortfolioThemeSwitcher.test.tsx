import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PublicPortfolioThemeSwitcher } from './PublicPortfolioThemeSwitcher';

afterEach(cleanup);

it('renders all four accessible theme options and reports a selection', () => {
  const onChange = vi.fn();
  render(<PublicPortfolioThemeSwitcher value="modern-dark" onChange={onChange} />);

  expect(screen.getAllByRole('radio')).toHaveLength(4);
  expect(screen.getByText('Clean Minimal Light')).toBeInTheDocument();
  expect(screen.getByText('Monokai Hacker')).toBeInTheDocument();
  expect(screen.getByText('Terminal / Monospace')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /Modern Dark/ })).toBeChecked();
  fireEvent.click(screen.getByRole('radio', { name: /Terminal \/ Monospace/ }));
  expect(onChange).toHaveBeenCalledWith('terminal-monospace');
});

it('disables every option while a publication mutation is pending', () => {
  render(<PublicPortfolioThemeSwitcher value="modern-dark" onChange={vi.fn()} disabled />);
  screen.getAllByRole('radio').forEach((radio) => expect(radio).toBeDisabled());
});
