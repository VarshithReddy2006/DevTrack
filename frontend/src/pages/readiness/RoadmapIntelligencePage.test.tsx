// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RoadmapIntelligencePage from './RoadmapIntelligencePage';

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    }),
  });
});

const mocks = vi.hoisted(() => ({
  getDomainIntelligence: vi.fn(),
  getMilestoneRoadmap: vi.fn(),
  generateMilestoneRoadmap: vi.fn(),
  toggleMilestoneTask: vi.fn(),
  getSkillResource: vi.fn(),
  toggleSkillProgress: vi.fn(),
  getCrashCoursePlan: vi.fn(),
  setIntent: vi.fn(),
}));

vi.mock('../../services/readinessService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/readinessService')>();
  return {
    ...actual,
    readinessService: {
      ...actual.readinessService,
      getDomainIntelligence: mocks.getDomainIntelligence,
      getMilestoneRoadmap: mocks.getMilestoneRoadmap,
      generateMilestoneRoadmap: mocks.generateMilestoneRoadmap,
      toggleMilestoneTask: mocks.toggleMilestoneTask,
      getSkillResource: mocks.getSkillResource,
      toggleSkillProgress: mocks.toggleSkillProgress,
      getCrashCoursePlan: mocks.getCrashCoursePlan,
      setIntent: mocks.setIntent,
    },
  };
});

vi.mock('../../features/flags/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true }),
}));

vi.mock('../../services/jobTargetsService', () => ({
  listJobTargets: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/analyticsService', () => ({
  analyticsService: {
    trackEvent: vi.fn(),
    submitFeedback: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../hooks/useSse', () => ({
  useSseConnectionState: () => ({ isManaged: false, connectionStatus: 'connected' }),
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RoadmapIntelligencePage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RoadmapIntelligencePage', () => {
  it('hydrates verified skills, wires milestone timeline, and dynamically loads selected learning resources', async () => {
    mocks.getDomainIntelligence.mockResolvedValue({
      success: true,
      data: {
        domain: 'roadmap',
        noRoleSelected: false,
        targetRole: 'Full Stack Developer',
        goal: 'First Job',
        experienceLevel: 'Intermediate',
        weeklyHours: 10,
        targetDeadlineWeeks: 12,
        currentStage: 'Intermediate',
        roadmapProgress: 38,
        verifiedSkills: ['React', 'Node.js', 'TypeScript'],
        verifiedSkillSources: [
          { skill: 'React', source: 'github' },
          { skill: 'Node.js', source: 'resume' },
          { skill: 'TypeScript', source: 'project' },
        ],
        completedRoadmapSkills: [],
        missingSkills: ['Docker', 'Redis', 'SQL'],
        prioritySkills: ['Docker', 'Redis', 'SQL'],
        nextSkill: 'Docker',
        nextThreeSkills: ['Docker', 'Redis', 'SQL'],
        highestImpactSkill: 'Docker',
        readinessGain: 8,
        skillGains: {
          Docker: 12,
          Redis: 9,
          SQL: 6,
        },
        estimatedWeeksToNextMilestone: 5,
        confidence: 78,
        lastSyncedAt: new Date().toISOString(),
        verificationCoverage: 64,
        nextSkillResource: {
          skill: 'Docker',
          whyLearn: 'Containerization for consistent deployments.',
          estimatedTime: '1-2 Weeks',
          practiceProject: {
            title: 'Containerize a Node.js REST API',
            description: 'Write a Dockerfile and docker-compose.yml.',
          },
          resources: [
            {
              title: 'Docker Official Docs',
              type: 'docs',
              url: 'https://docs.docker.com/',
              provider: 'Official',
            },
          ],
        },
        skillResources: {
          Docker: {
            skill: 'Docker',
            whyLearn: 'Containerization for consistent deployments.',
            estimatedTime: '1-2 Weeks',
            practiceProject: {
              title: 'Containerize a Node.js REST API',
              description: 'Write a Dockerfile and docker-compose.yml.',
            },
            resources: [
              {
                title: 'Docker Official Docs',
                type: 'docs',
                url: 'https://docs.docker.com/',
                provider: 'Official',
              },
            ],
          },
        },
      },
    });

    mocks.getMilestoneRoadmap.mockResolvedValue({
      id: 'rm-1',
      targetRoleId: 'full-stack-developer',
      targetRole: 'Full Stack Developer',
      targetSource: 'role_catalog',
      targetDeadlineWeeks: 12,
      baselineReadinessScore: 70,
      missingSkills: ['Docker', 'Redis', 'SQL'],
      deferredSkills: [],
      source: 'template',
      degradedReason: null,
      generatedAt: new Date().toISOString(),
      progress: 0,
      milestones: [
        {
          milestoneId: 'm1',
          sequence: 1,
          startWeek: 1,
          endWeek: 2,
          skills: ['Docker'],
          objective: 'Containerize services with Docker',
          projectArchitecture: 'Multi-container API',
          keyConcepts: ['Multi-stage builds'],
          dsaPatterns: ['Graphs'],
          verificationCriteria: ['Image under 200MB'],
          tasks: [
            {
              taskId: 't1',
              kind: 'project',
              title: 'Build multi-stage Dockerfile',
              completed: false,
              completedAt: null,
            },
          ],
          completed: false,
          completedAt: null,
          progress: 0,
        },
      ],
    });

    mocks.getSkillResource.mockResolvedValue({
      skill: 'Redis',
      whyLearn: 'In-memory caching for low-latency APIs.',
      estimatedTime: '1 Week',
      practiceProject: {
        title: 'API Request Caching',
        description: 'Cache expensive queries in Redis.',
      },
      resources: [
        {
          title: 'Redis Documentation',
          type: 'docs',
          url: 'https://redis.io/docs/',
          provider: 'Official',
        },
      ],
    });

    mocks.toggleMilestoneTask.mockResolvedValue({
      id: 'rm-1',
      targetRoleId: 'full-stack-developer',
      targetRole: 'Full Stack Developer',
      targetSource: 'role_catalog',
      targetDeadlineWeeks: 12,
      baselineReadinessScore: 70,
      missingSkills: ['Docker', 'Redis', 'SQL'],
      deferredSkills: [],
      source: 'template',
      degradedReason: null,
      generatedAt: new Date().toISOString(),
      progress: 100,
      milestones: [
        {
          milestoneId: 'm1',
          sequence: 1,
          startWeek: 1,
          endWeek: 2,
          skills: ['Docker'],
          objective: 'Containerize services with Docker',
          projectArchitecture: 'Multi-container API',
          keyConcepts: ['Multi-stage builds'],
          dsaPatterns: ['Graphs'],
          verificationCriteria: ['Image under 200MB'],
          tasks: [
            {
              taskId: 't1',
              kind: 'project',
              title: 'Build multi-stage Dockerfile',
              completed: true,
              completedAt: new Date().toISOString(),
            },
          ],
          completed: true,
          completedAt: new Date().toISOString(),
          progress: 100,
        },
      ],
    });

    renderPage();

    // Verified skills render cleanly and legacy Trust & Confidence strip is omitted
    expect(await screen.findByText('Target: Full Stack Developer · 10 hrs/wk')).toBeInTheDocument();
    expect(screen.getByText('Verified · GitHub')).toBeInTheDocument();
    expect(screen.getByText('Verified · Resume')).toBeInTheDocument();
    expect(screen.queryByText('Trust & Confidence')).toBeNull();

    // Milestone timeline rendered and checkbox persists via API
    expect(await screen.findByText('2-Week Sprint Roadmap')).toBeInTheDocument();
    const milestoneCheckbox = await screen.findByRole('checkbox', { name: 'Build multi-stage Dockerfile' });
    fireEvent.click(milestoneCheckbox);
    await waitFor(() => {
      expect(mocks.toggleMilestoneTask).toHaveBeenCalledWith('m1', 't1', true);
    });

    // Clicking step 2 ("Redis") in Learning Path loads its resource & execution links
    const redisStepBtn = screen.getByRole('button', { name: /2\s*Up Next\s*Redis/i });
    fireEvent.click(redisStepBtn);
    await waitFor(() => {
      expect(mocks.getSkillResource).toHaveBeenCalledWith('Redis');
    });
    expect(await screen.findByText('Learning Resource: Redis')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Start 25m Focus Block/i })).toHaveAttribute(
      'href',
      '/focus?mission=Master%20Redis&duration=25&mode=core'
    );
    expect(screen.getByRole('link', { name: /Create in Projects/i })).toHaveAttribute(
      'href',
      expect.stringContaining('/projects?create=1&title=API%20Request%20Caching')
    );
    expect(screen.getByText('+12% readiness gain')).toBeInTheDocument();
    expect(screen.getByText('+9% readiness gain')).toBeInTheDocument();
  });

  it('switches to Crash Course Blitz mode, loads Pareto crash plan, and shows sync banner when completed skills overlap active milestones', async () => {
    mocks.getDomainIntelligence.mockResolvedValue({
      success: true,
      data: {
        domain: 'roadmap',
        noRoleSelected: false,
        targetRole: 'Backend Developer',
        goal: 'First Job',
        experienceLevel: 'Intermediate',
        weeklyHours: 10,
        targetDeadlineWeeks: 12,
        currentStage: 'Intermediate',
        roadmapProgress: 45,
        verifiedSkills: ['Docker'],
        verifiedSkillSources: [{ skill: 'Docker', source: 'resume' }],
        completedRoadmapSkills: [],
        missingSkills: ['Redis', 'SQL'],
        prioritySkills: ['Redis', 'SQL'],
        nextSkill: 'Redis',
        nextThreeSkills: ['Redis', 'SQL'],
        highestImpactSkill: 'Redis',
        readinessGain: 10,
        skillGains: { Redis: 11, SQL: 7 },
        estimatedWeeksToNextMilestone: 4,
        confidence: 25,
        lastSyncedAt: new Date().toISOString(),
        verificationCoverage: 50,
        nextSkillResource: {
          skill: 'Redis',
          whyLearn: 'Fast caching.',
          estimatedTime: '1 Week',
          practiceProject: { title: 'Cache Layer', description: 'Cache queries.' },
          resources: [],
        },
      },
    });

    mocks.getMilestoneRoadmap.mockResolvedValue({
      id: 'rm-sync',
      targetRoleId: 'backend-developer',
      targetRole: 'Backend Developer',
      targetSource: 'role_catalog',
      targetDeadlineWeeks: 12,
      baselineReadinessScore: 55,
      missingSkills: ['Docker', 'Redis'],
      deferredSkills: [],
      source: 'template',
      degradedReason: null,
      generatedAt: new Date().toISOString(),
      progress: 0,
      milestones: [
        {
          milestoneId: 'm1',
          sequence: 1,
          startWeek: 1,
          endWeek: 2,
          skills: ['Docker'],
          objective: 'Containerize services',
          projectArchitecture: 'API service',
          keyConcepts: ['Dockerfile'],
          dsaPatterns: ['Trees'],
          verificationCriteria: ['Builds cleanly'],
          tasks: [
            {
              taskId: 't1',
              kind: 'build',
              title: 'Write Dockerfile',
              completed: false,
              completedAt: null,
            },
          ],
          completed: false,
          completedAt: null,
          progress: 0,
        },
      ],
    });

    mocks.getCrashCoursePlan.mockResolvedValue({
      window: '7d',
      targetRole: 'Backend Developer',
      paretoSkillCount: 1,
      totalMinutes: 840,
      totalHoursLabel: '14 hrs',
      blocks: [
        {
          blockId: 'cc-redis',
          day: 1,
          dayLabel: 'Days 1-2',
          skill: 'Redis',
          title: 'Redis Blitz',
          paretoPriority: 10,
          revisionMinutes: 30,
          practiceMinutes: 45,
          whySelected: 'High-impact Backend skill.',
          practiceProject: { title: 'Cache Layer', description: 'Cache queries.' },
          crashCourse: {
            revisionMinutes: 30,
            paretoPriority: 10,
            coreConcepts: ['Cache-aside pattern keeps DB source of truth.'],
            gotchas: ['Missing TTL can fill memory.'],
            rapidQA: [
              {
                question: 'What eviction policy suits LRU caches?',
                answer: 'allkeys-lru evicts least recently used keys under memory pressure.',
              },
            ],
          },
        },
      ],
    });

    renderPage();

    // Desync banner renders when completed skill ("Docker") overlaps incomplete milestone
    expect(
      await screen.findByText(/Skills updated — Regenerate Sprint Plan/i)
    ).toBeInTheDocument();

    // Legacy Trust & Confidence strip is omitted
    expect(screen.queryByText('Trust & Confidence')).toBeNull();

    // Switch to Crash Course Blitz
    fireEvent.click(screen.getByRole('button', { name: /Crash Course Blitz/i }));
    await waitFor(() => {
      expect(mocks.getCrashCoursePlan).toHaveBeenCalledWith('7d', expect.anything());
    });
    expect(await screen.findByText('Backend Developer Crash Course')).toBeInTheDocument();
    expect(screen.getByText('Redis Rapid Cheat Sheet')).toBeInTheDocument();
  });
});
