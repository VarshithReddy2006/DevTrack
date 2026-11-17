// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MatchBreakdown } from './MatchBreakdown';

afterEach(cleanup);

it('renders each dimension and distinguishes a zero score from an inapplicable measure', () => {
  render(<MatchBreakdown match={{
    score: 45.5, dimensions: { hardRequirements: 85, techStack: 0, verifiedEvidence: 70, experience: null },
  }} />);
  expect(screen.getByRole('heading', { name: 'Match breakdown' })).toBeInTheDocument();
  expect(screen.getByText('45.5%')).toBeInTheDocument();
  expect(screen.getByText('Hard requirements').nextElementSibling).toHaveTextContent('85%');
  expect(screen.getByText('Tech stack keywords').nextElementSibling).toHaveTextContent('0%');
  expect(screen.getByText('Verified evidence').nextElementSibling).toHaveTextContent('70%');
  expect(screen.getByText('Experience').nextElementSibling).toHaveTextContent('Not applicable');
});
