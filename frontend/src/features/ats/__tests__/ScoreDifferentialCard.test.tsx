import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ScoreDifferentialCard } from '../components/ScoreDifferentialCard';
import { ScoreRadialDial } from '../components/ScoreRadialDial';

afterEach(() => {
  cleanup();
});

describe('ScoreRadialDial', () => {
  it('renders SVG progressbar with accessible attributes and score readout', () => {
    render(<ScoreRadialDial score={85} />);

    const dial = screen.getByRole('progressbar', { name: 'ATS score dial' });
    expect(dial).toBeInTheDocument();
    expect(dial).toHaveAttribute('aria-valuenow', '85');
    expect(dial).toHaveAttribute('aria-valuemin', '0');
    expect(dial).toHaveAttribute('aria-valuemax', '100');

    expect(screen.getByText('85')).toBeInTheDocument();
    expect(screen.getByText('/ 100')).toBeInTheDocument();
  });

  it('clamps scores below 0 and above 100', () => {
    const { unmount } = render(<ScoreRadialDial score={-10} />);
    let dial = screen.getByRole('progressbar', { name: 'ATS score dial' });
    expect(dial).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('0')).toBeInTheDocument();
    unmount();

    render(<ScoreRadialDial score={150} />);
    dial = screen.getByRole('progressbar', { name: 'ATS score dial' });
    expect(dial).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('100')).toBeInTheDocument();
  });

  it('supports custom size, strokeWidth, and aria-label', () => {
    render(
      <ScoreRadialDial
        score={72}
        size={150}
        strokeWidth={14}
        label="Custom ATS Dial"
      />
    );

    const dial = screen.getByRole('progressbar', { name: 'Custom ATS Dial' });
    expect(dial).toBeInTheDocument();
    expect(dial).toHaveStyle({ width: '150px', height: '150px' });
  });
});

describe('ScoreDifferentialCard', () => {
  describe('Score delta pill states', () => {
    it('displays positive delta pill with +N points and emerald styling', () => {
      render(
        <ScoreDifferentialCard
          currentScore={84}
          delta={14}
        />
      );

      const deltaBadge = screen.getByRole('status', {
        name: /Score change: \+14 points/i,
      });
      expect(deltaBadge).toBeInTheDocument();
      expect(deltaBadge).toHaveTextContent('+14 points');
      expect(deltaBadge.className).toContain('text-emerald-800');
      expect(deltaBadge.className).toContain('animate-pulse');
    });

    it('displays negative delta pill with -N points and amber styling', () => {
      render(
        <ScoreDifferentialCard
          currentScore={65}
          delta={-7}
        />
      );

      const deltaBadge = screen.getByRole('status', {
        name: /Score change: -7 points/i,
      });
      expect(deltaBadge).toBeInTheDocument();
      expect(deltaBadge).toHaveTextContent('-7 points');
      expect(deltaBadge.className).toContain('text-amber-800');
      expect(deltaBadge.className).toContain('animate-pulse');
    });

    it('displays zero delta pill with neutral styling and no pulse', () => {
      render(
        <ScoreDifferentialCard
          currentScore={70}
          delta={0}
        />
      );

      const deltaBadge = screen.getByRole('status', {
        name: /Score change: 0 points/i,
      });
      expect(deltaBadge).toBeInTheDocument();
      expect(deltaBadge).toHaveTextContent('0 points');
      expect(deltaBadge.className).toContain('text-slate-700');
      expect(deltaBadge.className).not.toContain('animate-pulse');
    });

    it('calculates delta automatically from currentScore and originalScore', () => {
      render(
        <ScoreDifferentialCard
          currentScore={88}
          originalScore={70}
        />
      );

      const deltaBadge = screen.getByRole('status', {
        name: /Score change: \+18 points/i,
      });
      expect(deltaBadge).toBeInTheDocument();
      expect(deltaBadge).toHaveTextContent('+18 points');
    });
  });

  describe('Category breakdowns', () => {
    it('renders default category progress bars with sub-scores and tooltips', () => {
      render(
        <ScoreDifferentialCard
          currentScore={78}
          impactMetricsScore={85}
          actionVerbsScore={90}
          keywordDensityScore={60}
        />
      );

      expect(screen.getByText('Impact Metrics')).toBeInTheDocument();
      expect(screen.getByText('Action Verbs')).toBeInTheDocument();
      expect(screen.getByText('Keyword Density')).toBeInTheDocument();

      expect(screen.getByText('85%')).toBeInTheDocument();
      expect(screen.getByText('90%')).toBeInTheDocument();
      expect(screen.getByText('60%')).toBeInTheDocument();

      const impactBar = screen.getByRole('progressbar', { name: 'Impact Metrics' });
      expect(impactBar).toHaveAttribute('aria-valuenow', '85');

      const verbBar = screen.getByRole('progressbar', { name: 'Action Verbs' });
      expect(verbBar).toHaveAttribute('aria-valuenow', '90');

      const keywordBar = screen.getByRole('progressbar', { name: 'Keyword Density' });
      expect(keywordBar).toHaveAttribute('aria-valuenow', '60');
    });

    it('supports custom categories passed as explicit prop', () => {
      const customCategories = [
        { name: 'Formatting & Layout', score: 95, tooltip: 'Clean structure and fonts' },
        { name: 'Conciseness', score: 75, tooltip: 'Optimal bullet word counts' },
      ];

      render(
        <ScoreDifferentialCard
          currentScore={80}
          categories={customCategories}
        />
      );

      expect(screen.getByText('Formatting & Layout')).toBeInTheDocument();
      expect(screen.getByText('Conciseness')).toBeInTheDocument();
      expect(screen.getByText('95%')).toBeInTheDocument();
      expect(screen.getByText('75%')).toBeInTheDocument();

      const formatBar = screen.getByRole('progressbar', { name: 'Formatting & Layout' });
      expect(formatBar).toHaveAttribute('aria-valuenow', '95');
    });
  });

  describe('Card layout and accessibility', () => {
    it('renders accessible aside container with custom title and classes', () => {
      render(
        <ScoreDifferentialCard
          currentScore={82}
          title="Custom Editor Score"
          className="custom-card-class"
          isFloating
        />
      );

      const card = screen.getByLabelText('ATS Score Differential Card');
      expect(card).toBeInTheDocument();
      expect(card.className).toContain('custom-card-class');
      expect(card.className).toContain('sticky');
      expect(card.className).toContain('top-4');
      expect(screen.getByText('Custom Editor Score')).toBeInTheDocument();
    });
  });
});
