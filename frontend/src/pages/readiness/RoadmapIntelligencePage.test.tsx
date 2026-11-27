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

    // Verified skills and live trust telemetry render cleanly
    expect(await screen.findByText('Target: Full Stack Developer · 10 hrs/wk')).toBeInTheDocument();
    expect(screen.getByText('Verified · GitHub')).toBeInTheDocument();
    expect(screen.getByText('Verified · Resume')).toBeInTheDocument();
    expect(screen.getByText('Moderate (78%)')).toBeInTheDocument();
    expect(screen.getByText('64% covered')).toBeInTheDocument();
    expect(screen.getByText('Just now')).toBeInTheDocument();

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
  });
});
