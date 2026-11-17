import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PublicationSections } from '../../../services/publicationService';
import { SectionToggles } from './SectionToggles';

afterEach(cleanup);

const sections: PublicationSections = { streak: true, dsa: false, github: false, projects: false, activity: false };

it('renders one switch for each of the five real sections', () => {
  render(<SectionToggles sections={sections} onToggle={vi.fn()} />);
  const switches = screen.getAllByRole('switch');
  expect(switches.map((s) => s.id)).toEqual(['streak', 'dsa', 'github', 'projects', 'activity'].map((n) => `portfolio-section-${n}`));
  expect(screen.getByRole('switch', { name: 'Streak' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('switch', { name: 'DSA progress' })).toHaveAttribute('aria-checked', 'false');
});

it('reports which section flipped and to what', () => {
  const onToggle = vi.fn();
  render(<SectionToggles sections={sections} onToggle={onToggle} />);
  fireEvent.click(screen.getByRole('switch', { name: 'GitHub' }));
  fireEvent.click(screen.getByRole('switch', { name: 'Streak' }));
  expect(onToggle).toHaveBeenNthCalledWith(1, 'github', true);
  expect(onToggle).toHaveBeenNthCalledWith(2, 'streak', false);
});
