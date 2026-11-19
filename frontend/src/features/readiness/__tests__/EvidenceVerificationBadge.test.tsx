import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EvidenceVerificationBadge,
  extractProofFromClaim,
  type BadgeVerificationState,
} from '../components/EvidenceVerificationBadge';
import { VerificationProofModal, type VerificationProof } from '../components/VerificationProofModal';
import type { EvidenceClaim, VerificationStatus } from '../../../services/evidenceService';

afterEach(cleanup);

const mockVerifiedProof: VerificationProof = {
  status: 'verified',
  hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  platform: 'github',
  sourceUrl: 'https://github.com/DevTrack/sample/commit/e3b0c44',
  verifiedAt: '2026-11-19T10:00:00.000Z',
  authority: 'GitHub Signature Attestation',
  signatureStatus: 'gpg_verified',
  claimText: 'Implemented zero-downtime database migration',
  confidence: 96,
};

const mockClaim: EvidenceClaim = {
  id: 'claim-123',
  subjectType: 'repo',
  subjectKey: 'repo:devtrack-core',
  source: 'github',
  sourceUrl: 'https://github.com/DevTrack/core/commit/abc1234',
  claimText: 'Maintained 99.9% uptime for core pipeline',
  verificationStatus: 'verified',
  confidence: 94,
  metadata: {
    lastVerifiedAt: '2026-11-18T12:00:00.000Z',
    verificationAttempts: 1,
    flaggedReason: null,
    verificationProof: {
      hash: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
      authority: 'GitHub Actions CI Attestation',
      signatureStatus: 'gpg_verified',
      sourceUrl: 'https://github.com/DevTrack/core/commit/abc1234',
    },
  },
  createdAt: '2026-11-15T00:00:00.000Z',
  updatedAt: '2026-11-18T12:00:00.000Z',
};

describe('EvidenceVerificationBadge', () => {
  describe('State Rendering', () => {
    it.each([
      ['verified', 'Verified'],
      ['pending', 'Pending'],
      ['unverified', 'Unverified'],
      ['partial', 'Partially verified'],
      ['flagged', 'Flagged'],
    ] as const)('renders %s status with appropriate label text and data-status attribute', (status, label) => {
      render(<EvidenceVerificationBadge status={status as BadgeVerificationState} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      const badge = screen.getByTestId(
        status === 'verified'
          ? 'evidence-verification-badge-button'
          : 'evidence-verification-badge-static'
      );
      expect(badge).toHaveAttribute('data-status', status);
    });

    it('falls back safely to unverified for unknown status strings', () => {
      render(<EvidenceVerificationBadge status={'unknown_status' as unknown as VerificationStatus} />);
      expect(screen.getByText('Unverified')).toBeInTheDocument();
      expect(screen.getByTestId('evidence-verification-badge-static')).toHaveAttribute('data-status', 'unknown_status');
    });

    it('renders as an accessible interactive button when status is verified', () => {
      render(<EvidenceVerificationBadge status="verified" proof={mockVerifiedProof} />);
      const button = screen.getByRole('button', { name: /verified/i });
      expect(button).toBeInTheDocument();
      expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      expect(button).toHaveAttribute('aria-expanded', 'false');
    });

    it('renders as non-interactive static container when status is pending or unverified', () => {
      const { rerender } = render(<EvidenceVerificationBadge status="pending" />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.getByTestId('evidence-verification-badge-static')).toBeInTheDocument();

      rerender(<EvidenceVerificationBadge status="unverified" />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.getByTestId('evidence-verification-badge-static')).toBeInTheDocument();
    });

    it('renders icon only when showLabel is false with accessible name preserved', () => {
      render(<EvidenceVerificationBadge status="verified" showLabel={false} proof={mockVerifiedProof} />);
      expect(screen.queryByText('Verified')).not.toBeInTheDocument();
      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-label', expect.stringContaining('Verified'));
    });

    it('applies compact styling when size is sm', () => {
      render(<EvidenceVerificationBadge status="verified" size="sm" proof={mockVerifiedProof} />);
      const button = screen.getByTestId('evidence-verification-badge-button');
      expect(button.className).toContain('text-[11px]');
    });
  });

  describe('Claim Model Extraction', () => {
    it('extracts proof details directly from an EvidenceClaim object', () => {
      const proof = extractProofFromClaim(mockClaim);
      expect(proof.status).toBe('verified');
      expect(proof.hash).toBe('a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0');
      expect(proof.authority).toBe('GitHub Actions CI Attestation');
      expect(proof.signatureStatus).toBe('gpg_verified');
      expect(proof.platform).toBe('github');
      expect(proof.claimText).toBe('Maintained 99.9% uptime for core pipeline');
      expect(proof.confidence).toBe(94);
    });

    it('handles legacy claims with missing metadata and assigns default authority', () => {
      const legacyClaim: EvidenceClaim = {
        id: 'legacy-1',
        source: 'leetcode',
        claimText: 'Solved 500+ algorithmic problems',
        verificationStatus: 'verified',
        confidence: 88,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      };
      const proof = extractProofFromClaim(legacyClaim);
      expect(proof.status).toBe('verified');
      expect(proof.authority).toBe('LeetCode Verified Submission');
      expect(proof.platform).toBe('leetcode');
    });

    it('does NOT infer gpg_verified for a GitHub claim lacking explicit signature metadata (CRYPTO-01)', () => {
      const claimWithoutSig: EvidenceClaim = {
        id: 'claim-no-sig',
        source: 'github',
        claimText: 'Contributed to open source repository',
        verificationStatus: 'verified',
        confidence: 90,
        createdAt: '2026-11-15T00:00:00.000Z',
        updatedAt: '2026-11-18T12:00:00.000Z',
        metadata: {
          lastVerifiedAt: '2026-11-18T12:00:00.000Z',
          verificationAttempts: 1,
          flaggedReason: null,
        },
      };
      const proof = extractProofFromClaim(claimWithoutSig);
      expect(proof.signatureStatus).toBeUndefined();

      // Verify modal does not render GPG badge
      render(<VerificationProofModal open={true} onClose={vi.fn()} proof={proof} />);
      expect(screen.queryByTestId('proof-signature-badge')).not.toBeInTheDocument();
      expect(screen.queryByText(/GPG Verified/i)).not.toBeInTheDocument();
    });

    it('preserves and renders explicitly attested GPG signature status (CRYPTO-01)', () => {
      const claimWithExplicitSig: EvidenceClaim = {
        id: 'claim-sig',
        source: 'github',
        claimText: 'Signed commit attestation',
        verificationStatus: 'verified',
        confidence: 98,
        createdAt: '2026-11-15T00:00:00.000Z',
        updatedAt: '2026-11-18T12:00:00.000Z',
        metadata: {
          lastVerifiedAt: '2026-11-18T12:00:00.000Z',
          verificationAttempts: 1,
          flaggedReason: null,
          verificationProof: {
            signatureStatus: 'gpg_verified',
            hash: 'deadbeef1234',
          },
        },
      };
      const proof = extractProofFromClaim(claimWithExplicitSig);
      expect(proof.signatureStatus).toBe('gpg_verified');

      render(<VerificationProofModal open={true} onClose={vi.fn()} proof={proof} />);
      expect(screen.getByTestId('proof-signature-badge')).toHaveTextContent('GPG Verified');
    });

    it('renders badge directly from claim prop and opens modal on click', () => {
      render(<EvidenceVerificationBadge claim={mockClaim} />);
      const button = screen.getByRole('button', { name: /verified/i });
      fireEvent.click(button);

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Cryptographic Evidence Proof')).toBeInTheDocument();
      expect(screen.getByText('Maintained 99.9% uptime for core pipeline')).toBeInTheDocument();
    });
  });

  describe('Modal Interaction & Triggers', () => {
    it('opens proof modal when clicking verified badge', () => {
      render(<EvidenceVerificationBadge status="verified" proof={mockVerifiedProof} />);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      const button = screen.getByRole('button', { name: /verified/i });
      fireEvent.click(button);

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Cryptographic Evidence Proof')).toBeInTheDocument();
      expect(screen.getByText('Attested by GitHub Signature Attestation')).toBeInTheDocument();
    });

    it('opens proof modal when pressing Enter key on verified badge', () => {
      render(<EvidenceVerificationBadge status="verified" proof={mockVerifiedProof} />);
      const button = screen.getByRole('button', { name: /verified/i });

      fireEvent.keyDown(button, { key: 'Enter' });
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Cryptographic Evidence Proof')).toBeInTheDocument();
    });

    it('opens proof modal when pressing Space key on verified badge', () => {
      render(<EvidenceVerificationBadge status="verified" proof={mockVerifiedProof} />);
      const button = screen.getByRole('button', { name: /verified/i });

      fireEvent.keyDown(button, { key: ' ' });
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Cryptographic Evidence Proof')).toBeInTheDocument();
    });

    it('calls external onOpenModal handler when provided instead of internal modal', () => {
      const handleOpenModal = vi.fn();
      render(
        <EvidenceVerificationBadge
          status="verified"
          proof={mockVerifiedProof}
          onOpenModal={handleOpenModal}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /verified/i }));
      expect(handleOpenModal).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});

describe('VerificationProofModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders complete cryptographic proof details correctly', () => {
    render(
      <VerificationProofModal
        open={true}
        onClose={vi.fn()}
        proof={mockVerifiedProof}
        claimTitle="Implemented zero-downtime database migration"
      />
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Cryptographic Evidence Proof')).toBeInTheDocument();
    expect(screen.getByTestId('proof-status-label')).toHaveTextContent('Verified');
    expect(screen.getByTestId('proof-authority-label')).toHaveTextContent('GitHub Signature Attestation');
    expect(screen.getByTestId('proof-signature-badge')).toHaveTextContent('GPG Verified');
    expect(screen.getByTestId('proof-hash')).toHaveTextContent(mockVerifiedProof.hash!);
    expect(screen.getByTestId('platform-proof-link')).toHaveAttribute('href', mockVerifiedProof.sourceUrl);
    expect(screen.getByTestId('platform-proof-link')).toHaveAttribute('target', '_blank');
    expect(screen.getByTestId('platform-proof-link')).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('handles missing cryptographic hash gracefully without breaking', () => {
    const proofWithoutHash: VerificationProof = {
      ...mockVerifiedProof,
      hash: undefined,
      commitSha: undefined,
    };

    render(
      <VerificationProofModal
        open={true}
        onClose={vi.fn()}
        proof={proofWithoutHash}
      />
    );

    expect(screen.getByText('No cryptographic digest recorded for this claim.')).toBeInTheDocument();
    expect(screen.queryByTestId('copy-hash-button')).not.toBeInTheDocument();
  });

  it('handles missing or unsafe external links without rendering anchor tag', () => {
    const proofWithUnsafeLink: VerificationProof = {
      ...mockVerifiedProof,
      sourceUrl: 'javascript:alert(1)',
    };

    render(
      <VerificationProofModal
        open={true}
        onClose={vi.fn()}
        proof={proofWithUnsafeLink}
      />
    );

    expect(screen.queryByTestId('platform-proof-link')).not.toBeInTheDocument();
    expect(screen.getByText('No external link available')).toBeInTheDocument();
  });

  it('rejects protocol-relative URLs as unsafe and suppresses link (TEST-01)', () => {
    const proofWithProtocolRelative: VerificationProof = {
      ...mockVerifiedProof,
      sourceUrl: '//evil.com/phish',
    };

    render(
      <VerificationProofModal
        open={true}
        onClose={vi.fn()}
        proof={proofWithProtocolRelative}
      />
    );

    expect(screen.queryByTestId('platform-proof-link')).not.toBeInTheDocument();
    expect(screen.getByText('No external link available')).toBeInTheDocument();
  });

  describe('Platform Domain Validation & Anti-Spoofing (SEC-01)', () => {
    it('labels matching platform domain as verified platform destination', () => {
      render(
        <VerificationProofModal
          open={true}
          onClose={vi.fn()}
          proof={{
            ...mockVerifiedProof,
            platform: 'github',
            sourceUrl: 'https://github.com/DevTrack/sample/commit/1234567',
          }}
        />
      );

      const link = screen.getByTestId('platform-proof-link');
      expect(link).toHaveTextContent('Verify on GitHub');
      expect(link).toHaveAttribute('href', 'https://github.com/DevTrack/sample/commit/1234567');
    });

    it('labels matching platform subdomain as verified platform destination', () => {
      render(
        <VerificationProofModal
          open={true}
          onClose={vi.fn()}
          proof={{
            ...mockVerifiedProof,
            platform: 'github',
            sourceUrl: 'https://gist.github.com/user/snippet123',
          }}
        />
      );

      const link = screen.getByTestId('platform-proof-link');
      expect(link).toHaveTextContent('Verify on GitHub');
    });

    it('prevents domain spoofing from deceptive subdomains (github.com.evil.example)', () => {
      render(
        <VerificationProofModal
          open={true}
          onClose={vi.fn()}
          proof={{
            ...mockVerifiedProof,
            platform: 'github',
            sourceUrl: 'https://github.com.evil.example/commit/phish',
          }}
        />
      );

      const link = screen.getByTestId('platform-proof-link');
      expect(link).not.toHaveTextContent('Verify on GitHub');
      expect(link).toHaveTextContent('Open on github.com.evil.example');
    });

    it('prevents domain spoofing from deceptive prefix domains (evil-github.com)', () => {
      render(
        <VerificationProofModal
          open={true}
          onClose={vi.fn()}
          proof={{
            ...mockVerifiedProof,
            platform: 'github',
            sourceUrl: 'https://evil-github.com/phish',
          }}
        />
      );

      const link = screen.getByTestId('platform-proof-link');
      expect(link).not.toHaveTextContent('Verify on GitHub');
      expect(link).toHaveTextContent('Open on evil-github.com');
    });

    it('displays actual hostname for mismatched or non-platform destinations', () => {
      render(
        <VerificationProofModal
          open={true}
          onClose={vi.fn()}
          proof={{
            ...mockVerifiedProof,
            platform: 'github',
            sourceUrl: 'https://external-archive.org/record/123',
          }}
        />
      );

      const link = screen.getByTestId('platform-proof-link');
      expect(link).not.toHaveTextContent('Verify on GitHub');
      expect(link).toHaveTextContent('Open on external-archive.org');
    });
  });

  it('resets clipboard feedback immediately when modal closes and reopens (UX-01)', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    const { rerender } = render(
      <VerificationProofModal
        open={true}
        onClose={vi.fn()}
        proof={mockVerifiedProof}
      />
    );

    const copyButton = screen.getByTestId('copy-hash-button');
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(screen.getByTestId('copy-hash-button')).toHaveTextContent('Copied!');
    });

    // Close the modal
    rerender(
      <VerificationProofModal
        open={false}
        onClose={vi.fn()}
        proof={mockVerifiedProof}
      />
    );

    // Reopen the modal immediately
    rerender(
      <VerificationProofModal
        open={true}
        onClose={vi.fn()}
        proof={mockVerifiedProof}
      />
    );

    // Feedback must be reset to fresh initial state
    expect(screen.getByTestId('copy-hash-button')).toHaveTextContent('Copy Hash');
    expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
  });

  it('copies hash to clipboard and presents transient "Copied!" feedback', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    render(
      <VerificationProofModal
        open={true}
        onClose={vi.fn()}
        proof={mockVerifiedProof}
      />
    );

    const copyButton = screen.getByTestId('copy-hash-button');
    expect(copyButton).toHaveTextContent('Copy Hash');

    fireEvent.click(copyButton);

    expect(writeTextMock).toHaveBeenCalledWith(mockVerifiedProof.hash);
    await waitFor(() => {
      expect(screen.getByTestId('copy-hash-button')).toHaveTextContent('Copied!');
    });
  });

  it('handles clipboard write failure gracefully', async () => {
    const writeTextMock = vi.fn().mockRejectedValue(new Error('Permission denied'));
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    render(
      <VerificationProofModal
        open={true}
        onClose={vi.fn()}
        proof={mockVerifiedProof}
      />
    );

    const copyButton = screen.getByTestId('copy-hash-button');
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(screen.getByText(/Unable to access clipboard/i)).toBeInTheDocument();
    });
  });

  it('closes modal when close button is clicked', () => {
    const handleClose = vi.fn();
    render(
      <VerificationProofModal
        open={true}
        onClose={handleClose}
        proof={mockVerifiedProof}
      />
    );

    const closeBtn = screen.getByTestId('modal-close-button');
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
