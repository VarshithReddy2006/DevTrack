import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArchitectureSignalsViewer,
  buildArchitectureRecommendations,
  computeArchitectureTier,
  mapSignalsToTopologyNodes,
  type SystemDesignSignalsData,
} from '../components/ArchitectureSignalsViewer';
import { TopologyNodeCard, sanitizeExternalUrl } from '../components/TopologyNodeCard';

const mockGetSnapshot = vi.fn();

vi.mock('../../../services/readinessService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/readinessService')>();
  return {
    ...actual,
    readinessService: {
      ...actual.readinessService,
      getSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const DISTRIBUTED_SIGNALS: SystemDesignSignalsData = {
  hasPostgreSQL: true,
  hasMongoDB: true,
  hasRedis: true,
  hasCaching: true,
  hasKafka: true,
  hasRabbitMQ: true,
  hasBullMQ: true,
  hasQueueSystems: true,
  hasIngressTLS: true,
  hasRateLimiting: true,
  hasSSEWebSockets: true,
  hasDocker: true,
  hasMultiStageDockerBuild: true,
  hasNonRootDockerUser: true,
  hasKubernetes: true,
  hasKubernetesHighAvailability: true,
  hasMultiServiceTopology: true,
  composeServiceCount: 4,
  hasMonitoring: true,
  hasTracing: true,
  hasMetrics: true,
};

describe('TopologyNodeCard & URL sanitization', () => {
  it('allows http/https URLs and rejects unsafe schemes', () => {
    expect(sanitizeExternalUrl('https://github.com/org/repo')).toBe('https://github.com/org/repo');
    expect(sanitizeExternalUrl('http://localhost:3000/repo')).toBe('http://localhost:3000/repo');
    expect(sanitizeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeExternalUrl('//evil.example/repo')).toBeNull();
    expect(sanitizeExternalUrl('')).toBeNull();
  });

  it('renders node metadata, tags, evidence source, and safe repository link', () => {
    const onSelect = vi.fn();
    render(
      <TopologyNodeCard
        node={{
          id: 'redis',
          name: 'Redis',
          category: 'databases',
          description: 'In-memory cache and locks',
          iconKey: 'zap',
          tags: ['In-Memory Cache', 'Cluster Ready'],
          evidenceSource: 'docker-compose.yml',
          repositoryUrl: 'https://github.com/DevTrack/infra-demo',
        }}
        selected={false}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText('Redis')).toBeInTheDocument();
    expect(screen.getByText('In-Memory Cache')).toBeInTheDocument();
    expect(screen.getByText('Cluster Ready')).toBeInTheDocument();
    expect(screen.getByText('Source: docker-compose.yml')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /repo/i });
    expect(link).toHaveAttribute('href', 'https://github.com/DevTrack/infra-demo');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    fireEvent.click(screen.getByRole('button', { name: /inspect redis/i }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('suppresses unsafe javascript: repository URLs', () => {
    render(
      <TopologyNodeCard
        node={{
          id: 'kafka',
          name: 'Apache Kafka',
          category: 'queues',
          description: 'Streaming log',
          iconKey: 'workflow',
          tags: ['Event Streaming'],
          repositoryUrl: 'javascript:alert(1)',
        }}
      />,
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('Architecture signal mapping & tier scoring', () => {
  it('maps databases, queues, gateways, infrastructure, and observability signals', () => {
    const nodes = mapSignalsToTopologyNodes(DISTRIBUTED_SIGNALS, 'https://github.com/DevTrack/demo');
    const categories = new Set(nodes.map((n) => n.category));
    expect(categories).toEqual(
      new Set(['databases', 'queues', 'gateways', 'infrastructure', 'observability']),
    );
    expect(nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(['postgresql', 'mongodb', 'redis', 'kafka', 'rabbitmq', 'bullmq', 'ingress-tls', 'docker', 'kubernetes', 'observability']),
    );
  });

  it('computes architectural tier pills and communication patterns accurately', () => {
    expect(computeArchitectureTier(null, 0)).toMatchObject({
      tier: 0,
      label: 'Tier 0 - No Signals Detected',
      score: 0,
      architecturePattern: 'Unverified',
    });

    expect(computeArchitectureTier({ hasPostgreSQL: true }, 1, 20)).toMatchObject({
      tier: 1,
      label: 'Tier 1 - Monolith Foundation',
      score: 20,
      communicationStyle: 'Synchronous',
    });

    expect(
      computeArchitectureTier({ hasPostgreSQL: true, hasRedis: true, hasBullMQ: true, hasMultiServiceTopology: true }, 4, 58),
    ).toMatchObject({
      tier: 3,
      label: 'Tier 3 - Distributed Microservices',
      score: 58,
      architecturePattern: 'Distributed Microservices',
      communicationStyle: 'Event-Driven',
    });

    expect(computeArchitectureTier(DISTRIBUTED_SIGNALS, 10, 92)).toMatchObject({
      tier: 4,
      label: 'Tier 4 - Cloud-Native Distributed',
      score: 92,
    });
  });

  it('builds actionable recommendations only for missing signals', () => {
    const sparseRecs = buildArchitectureRecommendations({ hasPostgreSQL: true });
    expect(sparseRecs.some((r) => r.title.toLowerCase().includes('message broker'))).toBe(true);
    expect(sparseRecs.some((r) => r.title.toLowerCase().includes('redis'))).toBe(true);

    const fullRecs = buildArchitectureRecommendations(DISTRIBUTED_SIGNALS);
    expect(fullRecs).toHaveLength(0);
  });
});

describe('ArchitectureSignalsViewer', () => {
  it('renders grouped components, depth pill, evidence repo link, and filters by category', () => {
    render(
      <ArchitectureSignalsViewer
        signals={DISTRIBUTED_SIGNALS}
        architectureScore={68}
        repositoryUrl="https://github.com/DevTrack/distributed-api"
        repositoryName="distributed-api"
      />,
    );

    expect(screen.getByTestId('architecture-depth-pill')).toHaveTextContent('Tier 3 - Distributed Microservices');
    expect(screen.getByTestId('architecture-depth-pill')).toHaveTextContent('68/100');
    expect(screen.getByTestId('architecture-pattern-badge')).toHaveTextContent('Distributed Microservices');
    expect(screen.getByTestId('architecture-pattern-badge')).toHaveTextContent('Event-Driven');

    const repoLink = screen.getByTestId('architecture-repo-link');
    expect(repoLink).toHaveAttribute('href', 'https://github.com/DevTrack/distributed-api');
    expect(repoLink).toHaveTextContent('Evidence: distributed-api');

    // Grouped sections rendered
    expect(screen.getByTestId('architecture-group-databases')).toBeInTheDocument();
    expect(screen.getByTestId('architecture-group-queues')).toBeInTheDocument();
    expect(screen.getByTestId('architecture-group-gateways')).toBeInTheDocument();

    // Filter to Queues tab only
    fireEvent.click(screen.getByRole('tab', { name: /queues/i }));
    expect(screen.getByTestId('architecture-group-queues')).toBeInTheDocument();
    expect(screen.queryByTestId('architecture-group-databases')).not.toBeInTheDocument();

    // Inspect node card
    fireEvent.click(screen.getByRole('button', { name: /inspect apache kafka/i }));
    expect(screen.getByTestId('architecture-node-detail')).toHaveTextContent('Apache Kafka');
  });

  it('renders empty state and recommendations when no signals are detected', () => {
    render(<ArchitectureSignalsViewer signals={{}} />);

    expect(screen.getByTestId('architecture-empty-state')).toBeInTheDocument();
    expect(screen.getByText(/no architecture signals detected yet/i)).toBeInTheDocument();
    expect(screen.getByTestId('architecture-depth-pill')).toHaveTextContent('Tier 0 - No Signals Detected');
    expect(screen.getByTestId('architecture-recommendations')).toHaveTextContent(
      /add a message broker for asynchronous decoupling/i,
    );
  });

  it('renders loading and retryable error states', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ArchitectureSignalsViewer signals={{}} loading={true} />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading architecture signals/i);

    rerender(<ArchitectureSignalsViewer signals={{}} error="Network timeout" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Network timeout');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('connects automatically with useReadinessData when rendered standalone inside QueryClientProvider', async () => {
    mockGetSnapshot.mockResolvedValueOnce({
      success: true,
      data: {
        dynamicState: {
          progressionState: 'Production Engineering',
          momentumTrend: 'improving',
          roleAlignment: { role: 'Backend Engineer', matchScore: 82, strongAreas: [], weakAreas: [] },
          confidence: 90,
          overallScore: 80,
        },
        nextBestActions: [],
        intelligenceFeed: [],
        adaptiveRoadmap: [],
        rawMetrics: {
          core: null,
          dsa: null,
          skills: null,
          benchmarks: null,
          projects: {
            complexityMetrics: { architectureSophistication: 82 },
            systemDesignSignals: {
              hasPostgreSQL: true,
              hasRedis: true,
              hasBullMQ: true,
              hasDocker: true,
              hasMultiServiceTopology: true,
              composeServiceCount: 3,
            },
          },
        },
      },
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ArchitectureSignalsViewer />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('PostgreSQL')).toBeInTheDocument();
    expect(screen.getByText('BullMQ')).toBeInTheDocument();
    expect(screen.getByTestId('architecture-depth-pill')).toHaveTextContent('Tier 4 - Cloud-Native Distributed');
    queryClient.clear();
  });
});
