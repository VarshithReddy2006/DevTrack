import React, { useState } from 'react';
import { CompetencyScoreCard, type CompetencyDimension } from './CompetencyScoreCard';

export type { CompetencyDimension } from './CompetencyScoreCard';

export const DEFAULT_DIMENSIONS: Array<Pick<CompetencyDimension, 'key' | 'label'>> = [
  { key: 'dsa', label: 'Algorithms & Data Structures' },
  { key: 'systemDesign', label: 'System Design & Scalability' },
  { key: 'codeQuality', label: 'Production Code Quality' },
  { key: 'mockInterview', label: 'Mock Interview Performance' },
  { key: 'communication', label: 'Communication & Leadership' },
];

interface Props {
  dimensions: CompetencyDimension[];
  targetLabel?: string;
  size?: number;
  className?: string;
}

const RINGS = [20, 40, 60, 80, 100];
const clamp = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);

/** Point for axis `index` of `count`, at `value` (0-100). Axis 0 points straight up. */
export function polarPoint(
  index: number,
  count: number,
  value: number,
  radius: number,
  center: number,
): { x: number; y: number } {
  const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
  const r = (clamp(value) / 100) * radius;
  return {
    x: Math.round((center + r * Math.cos(angle)) * 100) / 100,
    y: Math.round((center + r * Math.sin(angle)) * 100) / 100,
  };
}

export function polygonPoints(values: number[], radius: number, center: number): string {
  return values
    .map((v, i) => {
      const p = polarPoint(i, values.length, v, radius, center);
      return `${p.x},${p.y}`;
    })
    .join(' ');
}

export const ReadinessSpiderChart: React.FC<Props> = ({
  dimensions,
  targetLabel = 'Target benchmark',
  size = 360,
  className = '',
}) => {
  const [active, setActive] = useState<number | null>(null);
  const count = dimensions.length;
  const center = size / 2;
  const radius = size / 2 - 80;

  if (count < 3) {
    return (
      <p className={`text-sm text-slate-400 ${className}`}>
        At least three competency dimensions are needed to draw the chart.
      </p>
    );
  }

  const scores = dimensions.map((d) => clamp(d.score));
  const targets = dimensions.map((d) => clamp(d.target));
  const summary = dimensions
    .map((d) => `${d.label} ${d.unavailable ? 'Unknown' : Math.round(clamp(d.score)) + ' of 100'}, target ${Math.round(clamp(d.target))}`)
    .join('; ');

  return (
    <figure className={`relative ${className}`}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="h-auto w-full max-w-md"
        role="img"
        aria-labelledby="spider-title spider-desc"
      >
        <title id="spider-title">Readiness competency radar chart</title>
        <desc id="spider-desc">{summary}</desc>

        {RINGS.map((ring) => (
          <polygon
            key={ring}
            data-testid="spider-ring"
            points={polygonPoints(Array(count).fill(ring), radius, center)}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.15}
          />
        ))}

        {dimensions.map((d, i) => {
          const end = polarPoint(i, count, 100, radius, center);
          const label = polarPoint(i, count, 100, radius + 22, center);
          return (
            <g key={d.key}>
              <line x1={center} y1={center} x2={end.x} y2={end.y} stroke="currentColor" strokeOpacity={0.15} />
              <text
                x={label.x}
                y={label.y}
                fontSize={10}
                textAnchor={label.x < center - 4 ? 'end' : label.x > center + 4 ? 'start' : 'middle'}
                dominantBaseline="middle"
                fill="currentColor"
                aria-hidden="true"
              >
                {d.label}
              </text>
            </g>
          );
        })}

        <polygon
          data-testid="spider-target"
          points={polygonPoints(targets, radius, center)}
          fill="none"
          stroke="#94a3b8"
          strokeWidth={1.5}
          strokeDasharray="5 4"
        />
        <polygon
          data-testid="spider-candidate"
          points={polygonPoints(scores, radius, center)}
          fill="rgb(99 102 241 / 0.2)"
          stroke="rgb(99 102 241)"
          strokeWidth={2}
        />

        {dimensions.map((d, i) => {
          const p = polarPoint(i, count, d.score, radius, center);
          return (
            <circle
              key={d.key}
              data-testid="spider-point"
              cx={p.x}
              cy={p.y}
              r={active === i ? 6 : 4}
              fill="rgb(99 102 241)"
              tabIndex={0}
              aria-label={`${d.label}: ${d.unavailable ? 'Unknown' : Math.round(clamp(d.score)) + ' of 100'}`}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            />
          );
        })}
      </svg>

      {active !== null && (
        <CompetencyScoreCard dimension={dimensions[active]} className="absolute left-2 top-2" />
      )}

      <figcaption className="mt-2 flex gap-4 text-xs text-slate-400">
        <span>Candidate</span>
        <span>{targetLabel} (dashed)</span>
      </figcaption>

      <table className="sr-only">
        <caption>Readiness competency scores against {targetLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Dimension</th>
            <th scope="col">Score</th>
            <th scope="col">Target</th>
            <th scope="col">Percentile</th>
            <th scope="col">Key gap</th>
          </tr>
        </thead>
        <tbody>
          {dimensions.map((d) => (
            <tr key={d.key}>
              <th scope="row">{d.label}</th>
              <td>{d.unavailable ? 'Unknown' : Math.round(clamp(d.score))}</td>
              <td>{Math.round(clamp(d.target))}</td>
              <td>{d.percentile !== undefined ? Math.round(d.percentile) : 'n/a'}</td>
              <td>{d.gap ?? 'n/a'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
};

export default ReadinessSpiderChart;
