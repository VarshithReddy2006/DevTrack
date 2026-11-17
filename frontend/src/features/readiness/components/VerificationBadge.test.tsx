import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { VerificationBadge } from './VerificationBadge';
import type { VerificationStatus } from '../../../services/evidenceService';

afterEach(cleanup);

it.each([
  ['verified', 'Verified'],
  ['partial', 'Partially verified'],
  ['unverified', 'Unverified'],
  ['flagged', 'Flagged'],
] as const)('writes the %s status out as text, not just colour', (status, label) => {
  render(<VerificationBadge status={status} />);
  expect(screen.getByText(label)).toBeInTheDocument();
});

it('falls back to unverified for a status it does not know', () => {
  render(<VerificationBadge status={'revoked' as VerificationStatus} />);
  expect(screen.getByText('Unverified')).toHaveAttribute('data-status', 'unverified');
});
