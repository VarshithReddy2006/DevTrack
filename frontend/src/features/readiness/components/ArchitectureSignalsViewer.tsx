import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Layers,
  Lightbulb,
  RefreshCw,
  Server,
} from 'lucide-react';
import type { ReadinessSnapshot } from '../../../services/readinessService';
import { useReadinessData } from '../hooks/useReadinessData';
import {
  TopologyNodeCard,
  sanitizeExternalUrl,
  type TopologyCategory,
  type TopologyNode,
} from './TopologyNodeCard';

export interface SystemDesignSignalsData {
  hasRedis?: boolean;
  hasMemcached?: boolean;
  hasCaching?: boolean;
  hasBullMQ?: boolean;
  hasRabbitMQ?: boolean;
  hasKafka?: boolean;
  hasSQS?: boolean;
  hasQueueSystems?: boolean;
  hasSSEWebSockets?: boolean;
  hasSocketIO?: boolean;
  hasWebRTC?: boolean;
  hasDocker?: boolean;
  hasKubernetes?: boolean;
  hasDeploymentPipelines?: boolean;
  hasInfraOrchestration?: boolean;
  hasMultiStageDockerBuild?: boolean;
  hasNonRootDockerUser?: boolean;
  hasDockerHealthcheck?: boolean;
  usesMinimalDockerBaseImage?: boolean;
  hasKubernetesResourceLimits?: boolean;
  hasKubernetesResourceRequests?: boolean;
  hasKubernetesHighAvailability?: boolean;
  hasKubernetesHealthProbes?: boolean;
  hasKubernetesAutoscaling?: boolean;
  hasIngressTLS?: boolean;
  composeServiceCount?: number;
  hasMultiServiceTopology?: boolean;
  hasMonitoring?: boolean;
  hasLogging?: boolean;
  hasTracing?: boolean;
  hasMetrics?: boolean;
  hasCDN?: boolean;
  hasEdgeComputing?: boolean;
  hasPostgreSQL?: boolean;
  hasMongoDB?: boolean;
  hasMySQL?: boolean;
  hasElasticsearch?: boolean;
  hasGraphQL?: boolean;
  hasREST?: boolean;
  hasgRPC?: boolean;
  hasAuthSystem?: boolean;
  hasRateLimiting?: boolean;
  hasEncryption?: boolean;
}

export interface ArchitectureRecommendation {
  id: string;
  title: string;
  description: string;
  impactLabel: string;
}

export interface ArchitectureTierSummary {
  tier: 0 | 1 | 2 | 3 | 4;
  label: string;
  score: number;
  architecturePattern: 'Distributed Microservices' | 'Service-Oriented' | 'Monolith / Single-Service' | 'Unverified';
  communicationStyle: 'Event-Driven' | 'Realtime / Hybrid' | 'Synchronous';
}

export interface ArchitectureSignalsViewerProps {
  signals?: SystemDesignSignalsData | null;
  snapshot?: ReadinessSnapshot | null;
  customNodes?: TopologyNode[];
  architectureScore?: number | null;
  repositoryUrl?: string | null;
  repositoryName?: string | null;
  recommendations?: ArchitectureRecommendation[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

type CategoryFilter = 'all' | TopologyCategory;

const CATEGORY_TABS: Array<{ id: CategoryFilter; label: string }> = [
  { id: 'all', label: 'All Components' },
  { id: 'databases', label: 'Databases' },
  { id: 'queues', label: 'Queues' },
  { id: 'gateways', label: 'Gateways' },
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'observability', label: 'Observability' },
];

const CATEGORY_GROUP_META: Record<TopologyCategory, { title: string; subtitle: string }> = {
  databases: {
    title: 'Databases & Caching',
    subtitle: 'Persistent data stores, search indexes, and low-latency caching layers',
  },
  queues: {
    title: 'Message Queues & Streaming',
    subtitle: 'Asynchronous job workers, event brokers, and decoupled pipelines',
  },
  gateways: {
    title: 'Gateways, Proxies & APIs',
    subtitle: 'Edge routing, TLS ingress, rate limiting, and realtime transport surfaces',
  },
  infrastructure: {
    title: 'Containers & Orchestration',
    subtitle: 'Container builds, multi-service topologies, Kubernetes, and CI/CD delivery',
  },
  observability: {
    title: 'Observability & Security',
    subtitle: 'Telemetry pipelines, distributed tracing, auth boundaries, and encryption',
  },
};

const CATEGORY_ORDER: TopologyCategory[] = [
  'databases',
  'queues',
  'gateways',
  'infrastructure',
  'observability',
];

function collectTags(pairs: Array<[boolean | undefined, string]>, fallback: string[] = []): string[] {
  const tags = pairs.filter(([flag]) => Boolean(flag)).map(([, label]) => label);
  return tags.length > 0 ? tags : fallback;
}

/** Converts SystemDesignSignals booleans into structured TopologyNode cards. */
export function mapSignalsToTopologyNodes(
  signals: SystemDesignSignalsData | null | undefined,
  repositoryUrl?: string | null,
): TopologyNode[] {
  if (!signals) return [];
  const nodes: TopologyNode[] = [];

  // Databases & Caching
  if (signals.hasPostgreSQL) {
    nodes.push({
      id: 'postgresql',
      name: 'PostgreSQL',
      category: 'databases',
      description: 'Relational SQL persistence detected in repository dependencies or compose services.',
      iconKey: 'database',
      tags: ['Relational DB', 'ACID', 'Replication Ready'],
      evidenceSource: 'manifest / docker-compose',
      repositoryUrl,
    });
  }
  if (signals.hasMongoDB) {
    nodes.push({
      id: 'mongodb',
      name: 'MongoDB',
      category: 'databases',
      description: 'Document database detected for flexible schema storage and aggregation queries.',
      iconKey: 'database',
      tags: ['Document Store', 'Replica Set Ready'],
      evidenceSource: 'manifest / docker-compose',
      repositoryUrl,
    });
  }
  if (signals.hasMySQL) {
    nodes.push({
      id: 'mysql',
      name: 'MySQL / MariaDB',
      category: 'databases',
      description: 'Structured relational engine detected in service configuration.',
      iconKey: 'database',
      tags: ['Relational DB', 'Cluster Ready'],
      evidenceSource: 'manifest / docker-compose',
      repositoryUrl,
    });
  }
  if (signals.hasElasticsearch) {
    nodes.push({
      id: 'elasticsearch',
      name: 'Elasticsearch / OpenSearch',
      category: 'databases',
      description: 'Distributed full-text search and indexing cluster detected.',
      iconKey: 'hard-drive',
      tags: ['Search Index', 'Sharded Cluster'],
      evidenceSource: 'manifest / docker-compose',
      repositoryUrl,
    });
  }
  if (signals.hasRedis) {
    nodes.push({
      id: 'redis',
      name: 'Redis',
      category: 'databases',
      description: 'In-memory key-value store for distributed caching, locks, and pub/sub.',
      iconKey: 'zap',
      tags: ['In-Memory Cache', 'Cluster / Sentinel Ready'],
      evidenceSource: 'manifest / docker-compose',
      repositoryUrl,
    });
  } else if (signals.hasMemcached) {
    nodes.push({
      id: 'memcached',
      name: 'Memcached',
      category: 'databases',
      description: 'Distributed in-memory object caching layer detected.',
      iconKey: 'zap',
      tags: ['Distributed Cache'],
      evidenceSource: 'manifest / docker-compose',
      repositoryUrl,
    });
  } else if (signals.hasCaching) {
    nodes.push({
      id: 'caching',
      name: 'Application Cache',
      category: 'databases',
      description: 'In-process or distributed caching primitives detected in backend code.',
      iconKey: 'zap',
      tags: ['Caching Layer'],
      evidenceSource: 'repository manifest',
      repositoryUrl,
    });
  }

  // Message Queues
  if (signals.hasKafka) {
    nodes.push({
      id: 'kafka',
      name: 'Apache Kafka',
      category: 'queues',
      description: 'Distributed event streaming log enabling partitioned async consumers.',
      iconKey: 'workflow',
      tags: ['Event Streaming', 'Partitioned Log'],
      evidenceSource: 'manifest / docker-compose',
      repositoryUrl,
    });
  }
  if (signals.hasRabbitMQ) {
    nodes.push({
      id: 'rabbitmq',
      name: 'RabbitMQ',
      category: 'queues',
      description: 'AMQP message broker decoupling producers from background workers.',
      iconKey: 'layers',
      tags: ['AMQP Broker', 'Async Queues'],
      evidenceSource: 'manifest / docker-compose',
      repositoryUrl,
    });
  }
  if (signals.hasBullMQ) {
    nodes.push({
      id: 'bullmq',
      name: 'BullMQ',
      category: 'queues',
      description: 'Redis-backed distributed job queue with retries and dead-letter handling.',
      iconKey: 'layers',
      tags: ['Redis-Backed Queue', 'Worker Jobs'],
      evidenceSource: 'package.json',
      repositoryUrl,
    });
  }
  if (signals.hasSQS) {
    nodes.push({
      id: 'sqs',
      name: 'Amazon SQS',
      category: 'queues',
      description: 'Managed cloud message queue detected for asynchronous task decoupling.',
      iconKey: 'layers',
      tags: ['Managed Queue', 'DLQ Ready'],
      evidenceSource: 'repository manifest',
      repositoryUrl,
    });
  }
  if (
    signals.hasQueueSystems &&
    !signals.hasKafka &&
    !signals.hasRabbitMQ &&
    !signals.hasBullMQ &&
    !signals.hasSQS
  ) {
    nodes.push({
      id: 'queue-systems',
      name: 'Async Job Queue',
      category: 'queues',
      description: 'Background task queue detected for asynchronous processing.',
      iconKey: 'layers',
      tags: ['Async Decoupling'],
      evidenceSource: 'repository manifest',
      repositoryUrl,
    });
  }

  // Gateways & APIs
  if (signals.hasIngressTLS) {
    nodes.push({
      id: 'ingress-tls',
      name: 'Ingress / Reverse Proxy',
      category: 'gateways',
      description: 'TLS-terminated ingress controller or reverse proxy gateway configured.',
      iconKey: 'globe',
      tags: ['TLS Termination', 'Reverse Proxy'],
      evidenceSource: 'k8s / ingress manifest',
      repositoryUrl,
    });
  }
  if (signals.hasCDN || signals.hasEdgeComputing) {
    nodes.push({
      id: 'cdn-edge',
      name: 'CDN & Edge Gateway',
      category: 'gateways',
      description: 'Edge delivery or CDN distribution configured to reduce client latency.',
      iconKey: 'network',
      tags: collectTags([
        [signals.hasCDN, 'CDN Edge'],
        [signals.hasEdgeComputing, 'Edge Compute'],
      ]),
      evidenceSource: 'infra config',
      repositoryUrl,
    });
  }
  if (signals.hasRateLimiting) {
    nodes.push({
      id: 'rate-limiter',
      name: 'API Rate Limiter',
      category: 'gateways',
      description: 'Request throttling middleware protecting API gateway endpoints.',
      iconKey: 'shield',
      tags: ['Traffic Shaping', 'Abuse Protection'],
      evidenceSource: 'repository manifest',
      repositoryUrl,
    });
  }
  if (signals.hasSSEWebSockets || signals.hasSocketIO || signals.hasWebRTC) {
    nodes.push({
      id: 'realtime-gateway',
      name: 'Realtime Gateway',
      category: 'gateways',
      description: 'Persistent streaming transport for live updates and bidirectional events.',
      iconKey: 'radio',
      tags: collectTags([
        [signals.hasSSEWebSockets, 'SSE / WebSockets'],
        [signals.hasSocketIO, 'Socket.IO'],
        [signals.hasWebRTC, 'WebRTC'],
      ]),
      evidenceSource: 'repository manifest',
      repositoryUrl,
    });
  }
  if (signals.hasREST || signals.hasGraphQL || signals.hasgRPC) {
    nodes.push({
      id: 'api-surface',
      name: 'API Interface Layer',
      category: 'gateways',
      description: 'Explicit service API contracts detected across backend handlers.',
      iconKey: 'server',
      tags: collectTags([
        [signals.hasREST, 'REST'],
        [signals.hasGraphQL, 'GraphQL'],
        [signals.hasgRPC, 'gRPC'],
      ]),
      evidenceSource: 'repository manifest',
      repositoryUrl,
    });
  }

  // Infrastructure & Orchestration
  if (signals.hasDocker) {
    nodes.push({
      id: 'docker',
      name: 'Docker Containers',
      category: 'infrastructure',
      description: 'Containerized runtime build with reproducible environment packaging.',
      iconKey: 'box',
      tags: collectTags(
        [
          [signals.hasMultiStageDockerBuild, 'Multi-Stage Build'],
          [signals.hasNonRootDockerUser, 'Non-Root User'],
          [signals.hasDockerHealthcheck, 'Healthcheck'],
          [signals.usesMinimalDockerBaseImage, 'Minimal Base'],
        ],
        ['Containerized'],
      ),
      evidenceSource: 'Dockerfile',
      repositoryUrl,
    });
  }
  if (signals.hasKubernetes || signals.hasInfraOrchestration) {
    nodes.push({
      id: 'kubernetes',
      name: 'Kubernetes / IaC Orchestration',
      category: 'infrastructure',
      description: 'Declarative workload scheduling, scaling, or Terraform/IaC provisioning.',
      iconKey: 'cpu',
      tags: collectTags(
        [
          [signals.hasKubernetesHighAvailability, 'High Availability'],
          [signals.hasKubernetesAutoscaling, 'Autoscaling'],
          [signals.hasKubernetesHealthProbes, 'Health Probes'],
          [signals.hasKubernetesResourceLimits, 'Resource Limits'],
          [signals.hasKubernetesResourceRequests, 'Resource Requests'],
        ],
        ['Orchestration'],
      ),
      evidenceSource: 'k8s / iac manifests',
      repositoryUrl,
    });
  }
  if (signals.hasMultiServiceTopology || (signals.composeServiceCount ?? 0) > 1) {
    const count = signals.composeServiceCount ?? 0;
    nodes.push({
      id: 'multi-service-topology',
      name: 'Multi-Service Topology',
      category: 'infrastructure',
      description: 'Multi-container service graph coordinated via Docker Compose.',
      iconKey: 'network',
      tags: [count > 0 ? `${count} Compose Services` : 'Multi-Service Mesh'],
      evidenceSource: 'docker-compose.yml',
      repositoryUrl,
    });
  }
  if (signals.hasDeploymentPipelines) {
    nodes.push({
      id: 'ci-cd',
      name: 'CI/CD Pipeline',
      category: 'infrastructure',
      description: 'Automated build, verification, and deployment workflows detected.',
      iconKey: 'git-branch',
      tags: ['Automated Delivery'],
      evidenceSource: '.github/workflows',
      repositoryUrl,
    });
  }

  // Observability & Security
  if (signals.hasMonitoring || signals.hasMetrics || signals.hasTracing || signals.hasLogging) {
    nodes.push({
      id: 'observability',
      name: 'Observability Stack',
      category: 'observability',
      description: 'Telemetry instrumentation for runtime visibility and incident diagnosis.',
      iconKey: 'activity',
      tags: collectTags([
        [signals.hasMonitoring, 'Monitoring'],
        [signals.hasMetrics, 'Prometheus / Metrics'],
        [signals.hasTracing, 'Distributed Tracing'],
        [signals.hasLogging, 'Structured Logging'],
      ]),
      evidenceSource: 'manifest / docker-compose',
      repositoryUrl,
    });
  }
  if (signals.hasAuthSystem || signals.hasEncryption) {
    nodes.push({
      id: 'security-controls',
      name: 'Auth & Encryption Layer',
      category: 'observability',
      description: 'Authentication boundaries and cryptographic data protection detected.',
      iconKey: 'lock',
      tags: collectTags([
        [signals.hasAuthSystem, 'AuthN / AuthZ'],
        [signals.hasEncryption, 'Encryption'],
      ]),
      evidenceSource: 'repository manifest',
      repositoryUrl,
    });
  }

  return nodes;
}

/** Computes architectural complexity score, tier label, and system pattern classifications. */
export function computeArchitectureTier(
  signals: SystemDesignSignalsData | null | undefined,
  nodesCount: number,
  explicitScore?: number | null,
): ArchitectureTierSummary {
  if (!signals && nodesCount === 0) {
    return {
      tier: 0,
      label: 'Tier 0 - No Signals Detected',
      score: 0,
      architecturePattern: 'Unverified',
      communicationStyle: 'Synchronous',
    };
  }

  const s = signals ?? {};
  let computed = 0;
  if (s.hasPostgreSQL || s.hasMongoDB || s.hasMySQL || s.hasElasticsearch) computed += 15;
  if (s.hasRedis || s.hasMemcached || s.hasCaching) computed += 15;
  if (s.hasKafka || s.hasRabbitMQ || s.hasBullMQ || s.hasSQS || s.hasQueueSystems) computed += 20;
  if (s.hasDocker) computed += 12;
  if (s.hasMultiServiceTopology || (s.composeServiceCount ?? 0) > 1) computed += 10;
  if (s.hasKubernetes || s.hasInfraOrchestration) computed += 15;
  if (s.hasIngressTLS || s.hasRateLimiting || s.hasCDN) computed += 8;
  if (s.hasMonitoring || s.hasTracing || s.hasMetrics || s.hasLogging) computed += 10;
  if (s.hasDeploymentPipelines) computed += 5;

  const fallbackFromNodes = nodesCount > 0 ? Math.min(nodesCount * 15, 100) : 0;
  const rawScore =
    typeof explicitScore === 'number' && Number.isFinite(explicitScore)
      ? explicitScore
      : Math.max(computed, fallbackFromNodes);
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  const hasQueue = Boolean(s.hasKafka || s.hasRabbitMQ || s.hasBullMQ || s.hasSQS || s.hasQueueSystems);
  const hasRealtime = Boolean(s.hasSSEWebSockets || s.hasSocketIO || s.hasWebRTC);
  const hasMultiService = Boolean(s.hasKubernetes || s.hasMultiServiceTopology || (s.composeServiceCount ?? 0) > 1);

  const communicationStyle: ArchitectureTierSummary['communicationStyle'] = hasQueue
    ? 'Event-Driven'
    : hasRealtime
      ? 'Realtime / Hybrid'
      : 'Synchronous';

  const architecturePattern: ArchitectureTierSummary['architecturePattern'] =
    score === 0 && nodesCount === 0
      ? 'Unverified'
      : hasMultiService || (hasQueue && score >= 50)
        ? 'Distributed Microservices'
        : score >= 25
          ? 'Service-Oriented'
          : 'Monolith / Single-Service';

  if (score === 0 && nodesCount === 0) {
    return {
      tier: 0,
      label: 'Tier 0 - No Signals Detected',
      score: 0,
      architecturePattern,
      communicationStyle,
    };
  }
  if (score >= 75) {
    return {
      tier: 4,
      label: 'Tier 4 - Cloud-Native Distributed',
      score,
      architecturePattern,
      communicationStyle,
    };
  }
  if (score >= 50) {
    return {
      tier: 3,
      label: 'Tier 3 - Distributed Microservices',
      score,
      architecturePattern,
      communicationStyle,
    };
  }
  if (score >= 25) {
    return {
      tier: 2,
      label: 'Tier 2 - Service-Oriented Architecture',
      score,
      architecturePattern,
      communicationStyle,
    };
  }
  return {
    tier: 1,
    label: 'Tier 1 - Monolith Foundation',
    score,
    architecturePattern,
    communicationStyle,
  };
}

/** Derives prioritized next-step recommendations from missing architecture signals. */
export function buildArchitectureRecommendations(
  signals: SystemDesignSignalsData | null | undefined,
  snapshotActions?: ReadinessSnapshot['nextBestActions'],
): ArchitectureRecommendation[] {
  const s = signals ?? {};
  const recs: ArchitectureRecommendation[] = [];

  if (!s.hasKafka && !s.hasRabbitMQ && !s.hasBullMQ && !s.hasSQS && !s.hasQueueSystems) {
    recs.push({
      id: 'rec-message-broker',
      title: 'Add a message broker for asynchronous decoupling',
      description:
        'Introduce BullMQ, RabbitMQ, or Kafka to offload heavy tasks and demonstrate event-driven resilience.',
      impactLabel: '+20 Depth',
    });
  }

  if (!s.hasRedis && !s.hasMemcached && !s.hasCaching) {
    recs.push({
      id: 'rec-caching',
      title: 'Introduce Redis caching and distributed state',
      description:
        'Back hot read paths or rate-limiting counters with Redis to improve latency and scalability.',
      impactLabel: '+15 Depth',
    });
  }

  if (!s.hasDocker || !s.hasMultiServiceTopology) {
    recs.push({
      id: 'rec-compose-topology',
      title: 'Define a multi-service Docker Compose topology',
      description:
        'Package your API alongside its database and cache in docker-compose.yml with healthchecks and non-root users.',
      impactLabel: '+15 Depth',
    });
  }

  if (!s.hasMonitoring && !s.hasTracing && !s.hasMetrics) {
    recs.push({
      id: 'rec-observability',
      title: 'Instrument metrics and distributed tracing',
      description:
        'Export Prometheus metrics or OpenTelemetry traces so production readiness can be verified.',
      impactLabel: '+10 Depth',
    });
  }

  if (!s.hasIngressTLS && !s.hasRateLimiting) {
    recs.push({
      id: 'rec-gateway-guard',
      title: 'Configure reverse proxy TLS and rate limiting',
      description:
        'Add Nginx/Envoy/Ingress TLS termination and API rate-limiting policies at your service boundary.',
      impactLabel: '+8 Depth',
    });
  }

  for (const action of snapshotActions ?? []) {
    if (action.category !== 'project') continue;
    if (recs.some((r) => r.id === action.id)) continue;
    recs.push({
      id: action.id,
      title: action.title,
      description: action.description,
      impactLabel: `${action.priority.toUpperCase()} Priority`,
    });
  }

  return recs.slice(0, 4);
}

const ConnectedReadinessBridge: React.FC<{
  onState: (state: { snapshot?: ReadinessSnapshot | null; loading: boolean; error: string | null; refetch: () => void }) => void;
}> = ({ onState }) => {
  const { data, loading, error, refetch } = useReadinessData();
  const refetchRef = React.useRef(refetch);
  React.useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);
  const stableRefetch = React.useCallback(() => {
    void refetchRef.current();
  }, []);

  React.useEffect(() => {
    onState({ snapshot: data ?? null, loading, error, refetch: stableRefetch });
  }, [data, loading, error, stableRefetch, onState]);
  return null;
};

export const ArchitectureSignalsViewer: React.FC<ArchitectureSignalsViewerProps> = ({
  signals: signalsProp,
  snapshot: snapshotProp,
  customNodes,
  architectureScore: explicitScore,
  repositoryUrl,
  repositoryName,
  recommendations: explicitRecommendations,
  loading: loadingProp = false,
  error: errorProp = null,
  onRetry,
}) => {
  const [connectedState, setConnectedState] = useState<{
    snapshot?: ReadinessSnapshot | null;
    loading: boolean;
    error: string | null;
    refetch: () => void;
  } | null>(null);

  const shouldUseHook =
    signalsProp === undefined &&
    snapshotProp === undefined &&
    customNodes === undefined &&
    !loadingProp &&
    !errorProp;

  const activeSnapshot = snapshotProp ?? connectedState?.snapshot ?? null;
  const activeSignals: SystemDesignSignalsData | null | undefined =
    signalsProp !== undefined
      ? signalsProp
      : (activeSnapshot?.rawMetrics?.projects?.systemDesignSignals as SystemDesignSignalsData | undefined);

  const loading = loadingProp || (shouldUseHook && (connectedState?.loading ?? true));
  const error = errorProp ?? (shouldUseHook ? connectedState?.error ?? null : null);
  const handleRetry = onRetry ?? connectedState?.refetch;

  const [selectedCategory, setSelectedCategory] = useState<CategoryFilter>('all');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const resolvedRepoUrl =
    repositoryUrl ??
    (activeSnapshot?.rawMetrics?.projects?.repositoryUrl as string | undefined) ??
    null;
  const safeRepoUrl = sanitizeExternalUrl(resolvedRepoUrl);

  const allNodes = useMemo(() => {
    if (customNodes) return customNodes;
    return mapSignalsToTopologyNodes(activeSignals, safeRepoUrl);
  }, [customNodes, activeSignals, safeRepoUrl]);

  const rawProjectsScore = activeSnapshot?.rawMetrics?.projects?.complexityMetrics?.architectureSophistication;
  const resolvedScore =
    explicitScore !== undefined
      ? explicitScore
      : typeof rawProjectsScore === 'number'
        ? rawProjectsScore
        : null;

  const tierSummary = useMemo(
    () => computeArchitectureTier(activeSignals, allNodes.length, resolvedScore),
    [activeSignals, allNodes.length, resolvedScore],
  );

  const recommendations = useMemo(() => {
    if (explicitRecommendations) return explicitRecommendations;
    return buildArchitectureRecommendations(activeSignals, activeSnapshot?.nextBestActions);
  }, [explicitRecommendations, activeSignals, activeSnapshot?.nextBestActions]);

  const visibleNodes = useMemo(() => {
    if (selectedCategory === 'all') return allNodes;
    return allNodes.filter((n) => n.category === selectedCategory);
  }, [allNodes, selectedCategory]);

  const groupedNodes = useMemo(() => {
    const groups = new Map<TopologyCategory, TopologyNode[]>();
    for (const cat of CATEGORY_ORDER) {
      const items = visibleNodes.filter((n) => n.category === cat);
      if (items.length > 0) groups.set(cat, items);
    }
    return groups;
  }, [visibleNodes]);

  const selectedNode = useMemo(
    () => allNodes.find((n) => n.id === selectedNodeId) ?? null,
    [allNodes, selectedNodeId],
  );

  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      all: allNodes.length,
      databases: 0,
      queues: 0,
      gateways: 0,
      infrastructure: 0,
      observability: 0,
    };
    for (const node of allNodes) counts[node.category]++;
    return counts;
  }, [allNodes]);

  return (
    <section
      aria-labelledby="architecture-signals-heading"
      className="rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-sm"
    >
      {shouldUseHook && <ConnectedReadinessBridge onState={setConnectedState} />}

      {/* Header & Architectural Depth Pill */}
      <div className="flex flex-col gap-4 border-b border-slate-100 pb-5 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-indigo-600" aria-hidden={true} />
            <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-600">
              System Design Telemetry
            </span>
          </div>
          <h2
            id="architecture-signals-heading"
            className="mt-1 text-xl font-black tracking-tight text-slate-900"
          >
            Architecture &amp; Cloud Topology Signals
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Verified infrastructure components extracted from repository manifests, Dockerfiles, and orchestration configs.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            data-testid="architecture-depth-pill"
            className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3.5 py-1.5 text-xs font-bold text-indigo-800"
          >
            <span>{tierSummary.label}</span>
            <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-extrabold text-white">
              {tierSummary.score}/100
            </span>
          </div>

          <span
            data-testid="architecture-pattern-badge"
            className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700"
          >
            {tierSummary.architecturePattern} &middot; {tierSummary.communicationStyle}
          </span>

          {safeRepoUrl && (
            <a
              href={safeRepoUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="architecture-repo-link"
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-indigo-300 hover:text-indigo-700"
            >
              <span>{repositoryName ? `Evidence: ${repositoryName}` : 'Evidence Repository'}</span>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden={true} />
            </a>
          )}
        </div>
      </div>

      {/* Loading / Error States */}
      {loading && (
        <div role="status" className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 animate-pulse">
          {[0, 1, 2].map((idx) => (
            <div key={idx} className="h-32 rounded-2xl border border-slate-200 bg-slate-100" />
          ))}
          <span className="sr-only">Loading architecture signals…</span>
        </div>
      )}

      {!loading && error && (
        <div
          role="alert"
          className="mt-6 flex flex-col items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 sm:flex-row sm:items-center"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden={true} />
            <span>Unable to load architecture signals: {error}</span>
          </div>
          {handleRetry && (
            <button
              type="button"
              onClick={handleRetry}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 cursor-pointer"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden={true} />
              Retry
            </button>
          )}
        </div>
      )}

      {/* Main Content */}
      {!loading && !error && (
        <>
          {/* Category Filter Tabs */}
          {allNodes.length > 0 && (
            <div
              role="tablist"
              aria-label="Filter detected architecture components by category"
              className="mt-5 flex flex-wrap gap-2"
            >
              {CATEGORY_TABS.map((tab) => {
                const count = categoryCounts[tab.id];
                if (tab.id !== 'all' && count === 0) return null;
                const isSelected = selectedCategory === tab.id;
                return (
                  <button
                    key={tab.id}
                    role="tab"
                    type="button"
                    aria-selected={isSelected}
                    onClick={() => setSelectedCategory(tab.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                      isSelected
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <span>{tab.label}</span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                        isSelected ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-700'
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Empty State */}
          {allNodes.length === 0 ? (
            <div
              data-testid="architecture-empty-state"
              className="mt-5 flex flex-col sm:flex-row items-center justify-between gap-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 px-5 py-6 text-center sm:text-left"
            >
              <div className="flex flex-col sm:flex-row items-center gap-3.5 min-w-0">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-400">
                  <Server className="h-5 w-5" aria-hidden={true} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-slate-900">
                    No architecture signals detected yet
                  </h3>
                  <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-600">
                    Sync a GitHub repository containing a Dockerfile, docker-compose.yml, Kubernetes manifest, or backend dependency manifest to map your system topology.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 shrink-0">
                <a
                  href="/projects"
                  className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-xs hover:bg-indigo-700 transition-colors"
                >
                  Sync GitHub Repositories
                </a>
                <a
                  href="/settings"
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  Configure Repo
                </a>
              </div>
            </div>
          ) : (
            <div className="mt-6 space-y-6">
              {[...groupedNodes.entries()].map(([category, nodes]) => {
                const meta = CATEGORY_GROUP_META[category];
                return (
                  <div key={category} data-testid={`architecture-group-${category}`}>
                    <div className="mb-3 flex items-baseline justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-bold text-slate-900">{meta.title}</h3>
                        <p className="text-xs text-slate-500">{meta.subtitle}</p>
                      </div>
                      <span className="text-xs font-semibold text-slate-500">
                        {nodes.length} {nodes.length === 1 ? 'component' : 'components'}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {nodes.map((node) => (
                        <TopologyNodeCard
                          key={node.id}
                          node={node}
                          selected={selectedNodeId === node.id}
                          onSelect={(clicked) =>
                            setSelectedNodeId((prev) => (prev === clicked.id ? null : clicked.id))
                          }
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Selected Component Inspection Drawer */}
          {selectedNode && (
            <div
              data-testid="architecture-node-detail"
              aria-live="polite"
              className="mt-6 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 text-sm text-slate-800"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-indigo-700">
                    Selected Signal Details
                  </p>
                  <h4 className="mt-0.5 font-bold text-slate-900">{selectedNode.name}</h4>
                  <p className="mt-1 text-xs text-slate-700">{selectedNode.description}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedNodeId(null)}
                  className="rounded-lg border border-indigo-200 bg-white px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {/* Actionable Next-Step Recommendations */}
          <div
            data-testid="architecture-recommendations"
            className="mt-6 rounded-2xl border border-slate-200 bg-slate-50/80 p-5"
          >
            <div className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-amber-500" aria-hidden={true} />
              <h3 className="text-sm font-bold text-slate-900">
                Recommended Next Steps for Architecture Readiness
              </h3>
            </div>

            {recommendations.length === 0 ? (
              <div className="mt-3 flex items-center gap-2 text-xs font-medium text-emerald-700">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden={true} />
                <span>
                  Strong coverage across persistence, caching, async queues, containerization, and observability.
                </span>
              </div>
            ) : (
              <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                {recommendations.map((rec) => (
                  <li
                    key={rec.id}
                    className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-bold text-slate-900">{rec.title}</span>
                      <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-800 border border-amber-200">
                        {rec.impactLabel}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-slate-600">{rec.description}</p>
                    <div className="mt-2.5 pt-2 border-t border-slate-100 flex justify-end">
                      <a
                        href="/projects"
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 transition-colors"
                      >
                        Add Evidence →
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
};
