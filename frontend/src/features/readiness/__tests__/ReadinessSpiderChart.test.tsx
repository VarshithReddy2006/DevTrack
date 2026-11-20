import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ReadinessSpiderChart,
  DEFAULT_DIMENSIONS,
  polarPoint,
  polygonPoints,
  type CompetencyDimension,
} from '../components/ReadinessSpiderChart';

afterEach(cleanup);

const dims: CompetencyDimension[] = DEFAULT_DIMENSIONS.map((d, i) => ({
  ...d,
  score: 40 + i * 10,
  target: 80,
  percentile: 50 + i,
  gap: `gap ${i}`,
}));

describe('polar math', () => {
  it('puts axis 0 straight up and scales by value', () => {
    expect(polarPoint(0, 5, 100, 100, 150)).toEqual({ x: 150, y: 50 });
    expect(polarPoint(0, 5, 50, 100, 150)).toEqual({ x: 150, y: 100 });
    expect(polarPoint(0, 5, 0, 100, 150)).toEqual({ x: 150, y: 150 });
  });

  it('clamps out-of-range values to 0-100', () => {
    expect(polarPoint(0, 5, 250, 100, 150)).toEqual(polarPoint(0, 5, 100, 100, 150));
    expect(polarPoint(0, 5, -5, 100, 150)).toEqual({ x: 150, y: 150 });
  });

  it('builds one point per value', () => {
    expect(polygonPoints([10, 20, 30, 40, 50], 100, 150).split(' ')).toHaveLength(5);
  });
});

describe('ReadinessSpiderChart', () => {
  it('renders candidate and target polygons with 5 points each', () => {
    render(<ReadinessSpiderChart dimensions={dims} />);
    expect(screen.getByTestId('spider-candidate').getAttribute('points')!.split(' ')).toHaveLength(5);
    expect(screen.getByTestId('spider-target').getAttribute('points')!.split(' ')).toHaveLength(5);
    expect(screen.getAllByTestId('spider-point')).toHaveLength(5);
    expect(screen.getAllByTestId('spider-ring')).toHaveLength(5);
  });

  it('updates the polygon when props change', () => {
    const { rerender } = render(<ReadinessSpiderChart dimensions={dims} />);
    const before = screen.getByTestId('spider-candidate').getAttribute('points');
    rerender(<ReadinessSpiderChart dimensions={dims.map((d) => ({ ...d, score: 90 }))} />);
    expect(screen.getByTestId('spider-candidate').getAttribute('points')).not.toBe(before);
  });

  it('shows a tooltip with score, percentile and gap on hover and focus', () => {
    render(<ReadinessSpiderChart dimensions={dims} />);
    const points = screen.getAllByTestId('spider-point');
    fireEvent.mouseEnter(points[1]);
    expect(screen.getByRole('status')).toHaveTextContent('Score 50/100');
    expect(screen.getByRole('status')).toHaveTextContent('Percentile 51');
    expect(screen.getByRole('status')).toHaveTextContent('Gap: gap 1');
    fireEvent.mouseLeave(points[1]);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.focus(points[2]);
    expect(screen.getByRole('status')).toHaveTextContent('Score 60/100');
  });

  it('exposes an accessible name and a screen reader table', () => {
    const { container } = render(<ReadinessSpiderChart dimensions={dims} />);
    expect(screen.getByRole('img', { name: /readiness competency radar chart/i })).toBeInTheDocument();
    const table = container.querySelector('table.sr-only');
    expect(table).not.toBeNull();
    expect(table!.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(table).toHaveTextContent('Algorithms & Data Structures');
  });

  it('falls back to a message with fewer than three dimensions', () => {
    render(<ReadinessSpiderChart dimensions={dims.slice(0, 2)} />);
    expect(screen.getByText(/at least three/i)).toBeInTheDocument();
  });
});
