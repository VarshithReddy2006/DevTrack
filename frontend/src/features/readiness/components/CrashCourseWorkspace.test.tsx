// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrashCourseWorkspace } from './CrashCourseWorkspace';
import type { CrashCoursePlan } from '../../../services/readinessService';

vi.mock('../../flags/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true }),
}));

const samplePlan: CrashCoursePlan = {
  window: '7d',
  targetRole: 'Backend Developer',
  paretoSkillCount: 2,
  totalMinutes: 840,
  totalHoursLabel: '14 hrs',
  blocks: [
    {
      blockId: 'cc-1',
      day: 1,
      dayLabel: 'Days 1-2',
      skill: 'Docker',
      title: 'Docker Blitz',
      paretoPriority: 10,
      revisionMinutes: 35,
      practiceMinutes: 45,
      whySelected: 'High-impact missing Backend Developer skill for technical screening.',
      practiceProject: {
        title: 'Containerize API Service',
        description: 'Multi-stage Dockerfile and compose file.',
      },
      crashCourse: {
        revisionMinutes: 35,
        paretoPriority: 10,
        coreConcepts: [
          'Multi-stage Dockerfile separates build deps from lean runtime.',
          'Layers cache chronologically; COPY manifests before source code.',
        ],
        gotchas: ['Running container processes as root introduces privilege escalation risk.'],
        rapidQA: [
          {
            question: 'How do multi-stage builds shrink image size?',
            answer: 'They copy only compiled artifacts into a minimal runtime image.',
          },
          {
            question: 'CMD vs ENTRYPOINT?',
            answer: 'ENTRYPOINT sets the fixed binary; CMD provides overridable default args.',
          },
        ],
      },
    },
    {
      blockId: 'cc-2',
      day: 3,
      dayLabel: 'Days 3-4',
      skill: 'Redis',
      title: 'Redis Blitz',
      paretoPriority: 9,
      revisionMinutes: 30,
      practiceMinutes: 40,
      whySelected: 'Covers caching, TTL invalidation, and distributed locking.',
      practiceProject: {
        title: 'Redis Cache Layer',
        description: 'Cache read endpoints with TTL.',
      },
      crashCourse: {
        revisionMinutes: 35,
        paretoPriority: 10,
        coreConcepts: ['Cache-aside pattern reads cache first, falls back to DB.'],
        gotchas: ['Forgetting TTL causes unbounded memory growth.'],
        rapidQA: [
          {
            question: 'How do you prevent cache stampede?',
            answer: 'Use request coalescing, staggered TTL jitter, or mutex locks.',
          },
        ],
      },
    },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CrashCourseWorkspace', () => {
  it('switches windows, toggles active-recall flashcards, persists revised state, and renders blitz links', async () => {
    const onWindowChange = vi.fn();
    const onMarkTopicRevised = vi.fn().mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <CrashCourseWorkspace
          window="7d"
          onWindowChange={onWindowChange}
          plan={samplePlan}
          isLoading={false}
          onMarkTopicRevised={onMarkTopicRevised}
        />
      </MemoryRouter>
    );

    expect(screen.getByText('Backend Developer Crash Course')).toBeInTheDocument();
    expect(screen.getByText('Top 2 Pareto Skills')).toBeInTheDocument();
    expect(screen.getByText('Docker Rapid Cheat Sheet')).toBeInTheDocument();
    expect(screen.getByText(/Multi-stage Dockerfile separates build deps/i)).toBeInTheDocument();

    // Window switcher invokes callback
    fireEvent.click(screen.getByRole('button', { name: /48-Hour Blitz/i }));
    expect(onWindowChange).toHaveBeenCalledWith('48h');

    // Reveal first Q&A flashcard answer & rate it
    expect(screen.queryByText(/copy only compiled artifacts/i)).not.toBeInTheDocument();
    const revealButtons = screen.getAllByRole('button', { name: /Reveal Answer/i });
    fireEvent.click(revealButtons[0]);
    expect(screen.getByText(/copy only compiled artifacts/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Got It/i }));
    expect(window.localStorage.getItem('devtrack:crash-course:qa:7d')).toContain('got_it');

    fireEvent.click(screen.getByRole('button', { name: /Review Again/i }));
    expect(window.localStorage.getItem('devtrack:crash-course:qa:7d')).toContain('review_again');

    // Mark topic revised
    fireEvent.click(screen.getByRole('button', { name: /Mark Topic Revised/i }));
    expect(onMarkTopicRevised).toHaveBeenCalledWith('Docker', true);
    expect(screen.getByText('1 / 2 topics revised (50%)')).toBeInTheDocument();

    // Blitz action bar links
    expect(screen.getByRole('link', { name: /Start 15m Blitz Focus/i })).toHaveAttribute(
      'href',
      '/focus?mission=Blitz%3A%20Docker&duration=15&mode=core'
    );
    expect(screen.getByRole('link', { name: /Practice DSA Pattern/i })).toHaveAttribute(
      'href',
      '/readiness/dsa'
    );
    expect(screen.getByRole('link', { name: /Quick Mock Interview/i })).toBeInTheDocument();
  });
});
