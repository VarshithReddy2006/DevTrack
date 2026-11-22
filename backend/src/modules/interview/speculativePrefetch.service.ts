export interface SpeculativeBranch {
  branchId: string;
  intent: 'scalable_optimal' | 'naive_suboptimal' | 'alternative_tradeoff';
  label: string;
  conceptSignature: string;
  anticipatedKeywords: string[];
  speculativeFollowUp: string;
  feedback: string;
}

export interface PrefetchSession {
  sessionId: string;
  turnIndex: number;
  questionPrompt: string;
  branches: [SpeculativeBranch, SpeculativeBranch];
  createdAt: number;
  expiresAt: number;
}

export interface BranchMatchResult {
  matched: boolean;
  branch?: SpeculativeBranch;
  similarity: number;
  latencyMs: number;
  fallbackRequired: boolean;
}

export class SpeculativePrefetchService {
  private cache = new Map<string, PrefetchSession>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Generates 2 speculative follow-up branches anticipating likely candidate answer trajectories:
   * Branch 1: Scalable, high-throughput distributed path (caching, partitioning, asynchronous message queues).
   * Branch 2: Sub-optimal / naive synchronous in-memory or monolithic path (monolithic locks, full scans, synchronous blocking).
   */
  generateSpeculativeBranches(
    questionPrompt: string,
    turnIndex: number
  ): [SpeculativeBranch, SpeculativeBranch] {
    const qLower = questionPrompt.toLowerCase();

    // Determine domain context from question prompt
    if (qLower.includes('storage') || qLower.includes('database') || qLower.includes('data')) {
      const branchOptimal: SpeculativeBranch = {
        branchId: `branch-opt-${turnIndex}`,
        intent: 'scalable_optimal',
        label: 'Partitioned Distributed Datastore with Cache Layer',
        conceptSignature: 'database sharding horizontal partitioning redis cache-aside read replicas replication',
        anticipatedKeywords: ['shard', 'sharding', 'partition', 'partitioning', 'redis', 'cache', 'replica', 'replicas', 'distributed'],
        speculativeFollowUp: 'Excellent. Given that you partitioned the datastore and added a caching layer, how would you handle a thundering herd scenario if a celebrity user causes a massive cache miss?',
        feedback: 'Strong understanding of data tier scaling and caching strategies. Next, consider cache invalidation stampedes.',
      };

      const branchNaive: SpeculativeBranch = {
        branchId: `branch-naive-${turnIndex}`,
        intent: 'naive_suboptimal',
        label: 'Single Relational Database with Direct Synchronous Queries',
        conceptSignature: 'single database relational postgresql direct query synchronous in-memory monolithic sql table',
        anticipatedKeywords: ['single database', 'sql table', 'relational', 'direct query', 'synchronous', 'monolith', 'lock'],
        speculativeFollowUp: 'A single relational database is simple to start with, but how will this design hold up under 100k queries per second when write locks cause connection pool exhaustion?',
        feedback: 'Good baseline schema clarity, but relying on a single database instance presents a clear scalability bottleneck under peak write volume.',
      };

      return [branchOptimal, branchNaive];
    }

    if (qLower.includes('traffic') || qLower.includes('rate limit') || qLower.includes('api') || qLower.includes('request')) {
      const branchOptimal: SpeculativeBranch = {
        branchId: `branch-opt-${turnIndex}`,
        intent: 'scalable_optimal',
        label: 'Distributed Token Bucket / Sliding Window with Redis Cluster',
        conceptSignature: 'token bucket sliding window redis cluster lua script distributed rate limiter envoy api gateway',
        anticipatedKeywords: ['token bucket', 'sliding window', 'redis', 'lua', 'distributed', 'api gateway', 'rate limit'],
        speculativeFollowUp: 'Great choice using a distributed token bucket in Redis. How do you ensure high availability if the primary Redis node experiences network partitioning?',
        feedback: 'Accurate and industry-standard approach to distributed rate limiting. Consider fail-open vs fail-close resilience.',
      };

      const branchNaive: SpeculativeBranch = {
        branchId: `branch-naive-${turnIndex}`,
        intent: 'naive_suboptimal',
        label: 'In-Memory Local Counter / Application Level Map',
        conceptSignature: 'in-memory local counter hashmap app server local memory sticky session single node',
        anticipatedKeywords: ['in-memory', 'hashmap', 'local counter', 'memory', 'local map', 'sticky session'],
        speculativeFollowUp: 'Keeping counters in local server memory works for one node, but across a cluster of 50 auto-scaled API servers, how do you prevent users from exceeding the quota?',
        feedback: 'In-memory maps do not coordinate across multi-instance deployments without a shared distributed state store.',
      };

      return [branchOptimal, branchNaive];
    }

    // Default system design branches (Asynchronous Event-Driven vs Synchronous Blocking)
    const branchOptimal: SpeculativeBranch = {
      branchId: `branch-opt-${turnIndex}`,
      intent: 'scalable_optimal',
      label: 'Asynchronous Event-Driven Architecture with Message Queue',
      conceptSignature: 'kafka message queue asynchronous worker event-driven pubsub decoupled consumer buffer stream',
      anticipatedKeywords: ['kafka', 'message queue', 'queue', 'asynchronous', 'async', 'event-driven', 'worker', 'pubsub', 'consumer'],
      speculativeFollowUp: 'Solid decoupled architecture. With asynchronous message consumers, what is your strategy for maintaining idempotency during message re-delivery?',
      feedback: 'Decoupling ingestion from processing with an asynchronous queue provides excellent buffering and horizontal scaling elasticity.',
    };

    const branchNaive: SpeculativeBranch = {
      branchId: `branch-naive-${turnIndex}`,
      intent: 'naive_suboptimal',
      label: 'Synchronous End-to-End Blocking Processing',
      conceptSignature: 'synchronous blocking direct http rest call immediate process wait response monolithic thread pool',
      anticipatedKeywords: ['synchronous', 'blocking', 'direct call', 'rest call', 'immediate', 'wait', 'in-line', 'thread'],
      speculativeFollowUp: 'If downstream processing experiences sudden latency or outages, synchronous calls will quickly exhaust server thread pools. How can we decouple this?',
      feedback: 'Straightforward pipeline, but synchronous blocking introduces cascading failure vulnerabilities across services.',
    };

    return [branchOptimal, branchNaive];
  }

  /**
   * Calculates intent similarity score between candidate's answer and an anticipated branch.
   * Returns a score between 0.0 and 1.0.
   */
  calculateIntentSimilarity(answer: string, branch: SpeculativeBranch): number {
    if (!answer || answer.trim().length === 0) return 0;

    const ansLower = answer.toLowerCase();
    const ansWords = new Set(ansLower.replace(/[^a-z0-9\s_-]/g, ' ').split(/\s+/).filter(Boolean));

    // Keyword matching
    let keywordHits = 0;
    for (const kw of branch.anticipatedKeywords) {
      if (ansLower.includes(kw.toLowerCase())) {
        keywordHits += 1;
      }
    }
    // Concept signature Jaccard token overlap
    const signatureTokens = branch.conceptSignature.toLowerCase().split(/\s+/).filter(Boolean);
    let signatureHits = 0;
    for (const st of signatureTokens) {
      if (ansWords.has(st) || ansLower.includes(st)) {
        signatureHits += 1;
      }
    }

    if (keywordHits === 0 && signatureHits === 0) {
      return 0;
    }

    // Normalized scores based on expected concept density (3-4 key domain terms indicate strong intent)
    const normalizedKeywordScore = Math.min(1.0, keywordHits / 3.0);
    const normalizedSignatureScore = Math.min(1.0, signatureHits / 4.0);

    let score = normalizedKeywordScore * 0.6 + normalizedSignatureScore * 0.4;

    // Direct architectural alignment bonus: multi-keyword or multi-concept matches
    if (keywordHits >= 3 || (keywordHits >= 2 && signatureHits >= 3)) {
      score = Math.max(0.88, Math.min(0.98, score + 0.15));
    } else if (keywordHits >= 2 && signatureHits >= 2) {
      score = Math.max(0.86, Math.min(0.95, score + 0.1));
    }

    return Math.round(score * 100) / 100;
  }

  /**
   * Pre-fetches and registers speculative branches for an upcoming turn in the background.
   */
  registerPrefetch(
    sessionId: string,
    turnIndex: number,
    questionPrompt: string
  ): PrefetchSession {
    const branches = this.generateSpeculativeBranches(questionPrompt, turnIndex);
    const sessionKey = `${sessionId}:turn:${turnIndex}`;

    const prefetchSession: PrefetchSession = {
      sessionId,
      turnIndex,
      questionPrompt,
      branches,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    };

    this.cache.set(sessionKey, prefetchSession);
    return prefetchSession;
  }

  /**
   * Retrieves pre-fetched session from cache if valid.
   */
  getPrefetchSession(sessionId: string, turnIndex: number): PrefetchSession | null {
    const sessionKey = `${sessionId}:turn:${turnIndex}`;
    const session = this.cache.get(sessionKey);
    if (!session) return null;

    if (Date.now() > session.expiresAt) {
      this.cache.delete(sessionKey);
      return null;
    }
    return session;
  }

  /**
   * Evaluates candidate's actual answer against pre-fetched branches.
   * If similarity > 0.85: returns branch hit instantly (< 100ms).
   * If similarity <= 0.85: triggers graceful fallback to standard generation.
   */
  async matchOrFallback(
    sessionId: string,
    turnIndex: number,
    candidateAnswer: string
  ): Promise<BranchMatchResult> {
    const startTime = performance.now();
    const session = this.getPrefetchSession(sessionId, turnIndex);

    if (!session) {
      return {
        matched: false,
        similarity: 0,
        latencyMs: Math.round((performance.now() - startTime) * 100) / 100,
        fallbackRequired: true,
      };
    }

    let bestBranch: SpeculativeBranch | undefined;
    let highestSimilarity = 0;

    for (const branch of session.branches) {
      const sim = this.calculateIntentSimilarity(candidateAnswer, branch);
      if (sim > highestSimilarity) {
        highestSimilarity = sim;
        bestBranch = branch;
      }
    }

    const elapsed = Math.round((performance.now() - startTime) * 100) / 100;

    // Threshold: similarity > 0.85 delivers the pre-fetched response instantly
    if (highestSimilarity > 0.85 && bestBranch) {
      return {
        matched: true,
        branch: bestBranch,
        similarity: highestSimilarity,
        latencyMs: elapsed,
        fallbackRequired: false,
      };
    }

    // Branch miss: fall back to standard LLM generation
    return {
      matched: false,
      branch: bestBranch,
      similarity: highestSimilarity,
      latencyMs: elapsed,
      fallbackRequired: true,
    };
  }

  clearSession(sessionId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.cache.delete(key);
      }
    }
  }
}

export const speculativePrefetchService = new SpeculativePrefetchService();

/** Worker export helpers for runtime integration */
export async function startSpeculativePrefetchWorker(): Promise<{ stop: () => Promise<void> }> {
  return {
    stop: async () => { },
  };
}

export async function stopSpeculativePrefetchWorker(): Promise<void> { }

