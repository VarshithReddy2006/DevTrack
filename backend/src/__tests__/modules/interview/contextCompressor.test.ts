import { describe, expect, it } from 'vitest';
import {
  contextCompressorService,
  ContextCompressorService,
  type TurnData,
} from '../../../modules/interview/contextCompressor.service.js';
import {
  speculativePrefetchService,
  SpeculativePrefetchService,
} from '../../../modules/interview/speculativePrefetch.service.js';
import {
  processInterviewTurnWithOptimization,
} from '../../../workers/worker-ai.js';
import { buildTurnReplyPrompt } from '../../../modules/interview/prompts/turnReply.prompt.js';

describe('Extractive Dialogue Context Compressor & Speculative Prompt Prefetcher', () => {
  // Realistic multi-turn interview turns
  const mockTurn1: TurnData = {
    prompt: 'How would you design a distributed URL shortening service like TinyURL that handles 100M URLs per day?',
    answer:
      'Um, so basically for this system, we need to generate unique 7-character short keys using base62 encoding. I chose PostgreSQL with a B-tree index on the short key. We will write to a master database and use read replicas to handle high read volume. I think the write throughput will be around 1,160 writes/sec, and read throughput around 11,600 reads/sec.',
    feedback: 'Good breakdown of the throughput calculations and base62 encoding schema.',
  };

  const mockTurn2: TurnData = {
    prompt: 'How do you prevent database read bottlenecks when 99% of queries are for hot, trending URLs?',
    answer:
      'Well, to avoid hot key contention and slow database read bottlenecks, I decided to deploy a Redis cluster using a cache-aside pattern. Frequently accessed URLs will be cached with an LRU eviction policy. This eliminates database I/O, ensuring p99 read latency stays under 10ms. For cache misses, we query the read replicas and populate Redis asynchronously.',
    feedback: 'Cache-aside with Redis is a solid approach to protect the database layer.',
  };

  const mockTurn3: TurnData = {
    prompt: 'If millions of URLs are generated concurrently across multiple application servers, how do you avoid short key collisions?',
    answer:
      'To eliminate key collision bottlenecks and avoid distributed locks, I opted for a dedicated key generation service (KGS) that pre-generates unique 7-character keys and stores them in memory. We can partition the key database into token ranges. Each application server fetches a batch of 1,000 pre-allocated keys. The runtime complexity to assign a key is O(1).',
    feedback: 'Pre-generating keys in a separate KGS effectively removes distributed locking overhead.',
  };

  const mockTurn4: TurnData = {
    prompt: 'How would you scale storage across multiple geographic regions and ensure high availability if a primary data center fails?',
    answer:
      'We should adopt horizontal sharding partitioned by hash of short_url across distributed datastores like Apache Cassandra with multi-region replication. We use consistent hashing to evenly distribute load and minimize data movement during cluster rebalancing. Consistency will be tunable with eventual consistency for reads and local quorum for writes.',
    feedback: 'Consistent hashing with multi-region Cassandra provides strong partition tolerance.',
  };

  const mockTurn5: TurnData = {
    prompt: 'How will you protect the URL redirect service from malicious scrapers and DDoS traffic spikes?',
    answer:
      'I will deploy an API Gateway at the edge with Envoy and implement distributed rate limiting using a token bucket algorithm backed by Redis. We will enforce rate limits of 100 requests per minute per IP. For suspicious bursts, we drop traffic with HTTP 429 and send telemetry to Kafka for security analysis.',
    feedback: 'Distributed token bucket in Redis with edge enforcement protects downstream services well.',
  };

  const mockTurn6: TurnData = {
    prompt: 'How do you handle expired URLs and analytics aggregation without degrading user redirect latency?',
    answer:
      'We should not delete expired URLs synchronously on read. Instead, a background worker can lazily mark them expired and batch delete during low-traffic hours. For redirect analytics like click counts and geolocations, each redirect publishes an event to an asynchronous Kafka topic. Consumers batch write counts into an OLAP datastore like ClickHouse.',
    feedback: 'Asynchronous event streaming keeps redirect latency under 15ms without blocking on analytics writes.',
  };

  describe('ContextCompressorService', () => {
    it('activates compression only when interview exceeds 3 turns (turnIndex >= 3)', () => {
      expect(contextCompressorService.shouldCompress(0)).toBe(false); // Turn 1
      expect(contextCompressorService.shouldCompress(1)).toBe(false); // Turn 2
      expect(contextCompressorService.shouldCompress(2)).toBe(false); // Turn 3
      expect(contextCompressorService.shouldCompress(3)).toBe(true);  // Turn 4
      expect(contextCompressorService.shouldCompress(4)).toBe(true);  // Turn 5
      expect(contextCompressorService.shouldCompress(5)).toBe(true);  // Turn 6
    });

    it('extracts structured factual bullets: Key Decisions Made, Solved Inefficiencies, Candidate Stated Complexities', () => {
      const history = [mockTurn1, mockTurn2, mockTurn3];
      const summary = contextCompressorService.compressDialogueHistory(history);

      expect(summary.keyDecisions.length).toBeGreaterThan(0);
      expect(summary.solvedInefficiencies.length).toBeGreaterThan(0);
      expect(summary.statedComplexities.length).toBeGreaterThan(0);

      expect(summary.rawSummaryText).toContain('Key Decisions Made:');
      expect(summary.rawSummaryText).toContain('Solved Inefficiencies:');
      expect(summary.rawSummaryText).toContain('Candidate Stated Complexities:');

      // Verify essential technical concepts are preserved
      const summaryLower = summary.rawSummaryText.toLowerCase();
      expect(summaryLower).toMatch(/redis|postgresql|cache|hash/);
      expect(summaryLower).toMatch(/o\(1\)|latency|bottleneck|p99|writes\/sec|throughput/);
    });

    it('reduces dialogue history tokens by >= 50% on turns 4+ while maintaining context coherence', () => {
      // 3 previous turns being compressed for Turn 4
      const historyTurns = [mockTurn1, mockTurn2, mockTurn3];
      const result = contextCompressorService.buildOptimizedTurnContext(historyTurns, 3);

      expect(result.isCompressed).toBe(true);
      expect(result.tokenStats.reductionPercent).toBeGreaterThanOrEqual(50);
      expect(result.tokenStats.finalTokens).toBeLessThan(result.tokenStats.originalTokens);

      // Verify that history is compressed into structured factual summary
      expect(result.formattedHistory).toContain('[Extractive Dialogue Context Summary');
      expect(result.formattedHistory).toContain('Key Decisions Made:');
      expect(result.formattedHistory).toContain('Solved Inefficiencies:');
      expect(result.formattedHistory).toContain('Candidate Stated Complexities:');
    });

    it('preserves uncompressed format for turns 1 to 3', () => {
      const historyTurns = [mockTurn1, mockTurn2];
      const result = contextCompressorService.buildOptimizedTurnContext(historyTurns, 2);

      expect(result.isCompressed).toBe(false);
      expect(result.tokenStats.reductionPercent).toBe(0);
      expect(result.formattedHistory).toContain('Earlier question 1:');
      expect(result.formattedHistory).toContain('Earlier question 2:');
      expect(result.formattedHistory).not.toContain('[Extractive Dialogue Context Summary');
    });

    it('buildTurnReplyPrompt integrates context compression seamlessly on turn 4+', () => {
      const promptTurn4 = buildTurnReplyPrompt({
        role: 'backend',
        turnIndex: 3, // Turn 4
        totalTurns: 6,
        question: { prompt: mockTurn4.prompt, checklist: ['Consistent hashing', 'Multi-region replication'] },
        answer: mockTurn4.answer,
        history: [
          { prompt: mockTurn1.prompt, answer: mockTurn1.answer },
          { prompt: mockTurn2.prompt, answer: mockTurn2.answer },
          { prompt: mockTurn3.prompt, answer: mockTurn3.answer },
        ],
      });

      expect(promptTurn4.prompt).toContain('[Extractive Dialogue Context Summary');
      expect(promptTurn4.prompt).toContain('Key Decisions Made:');
      expect(promptTurn4.prompt).toContain('Question 4 of 6:');
    });
  });

  describe('SpeculativePrefetchService', () => {
    it('generates 2 speculative branches predicting candidate design directions', () => {
      const branches = speculativePrefetchService.generateSpeculativeBranches(
        'How would you design the storage layer for a high throughput messaging app?',
        1
      );

      expect(branches).toHaveLength(2);
      expect(branches[0].intent).toBe('scalable_optimal');
      expect(branches[1].intent).toBe('naive_suboptimal');
      expect(branches[0].speculativeFollowUp).toBeDefined();
      expect(branches[1].speculativeFollowUp).toBeDefined();
      expect(branches[0].anticipatedKeywords.length).toBeGreaterThan(0);
    });

    it('delivers sub-200ms follow-up response on branch hit (similarity > 0.85)', async () => {
      const sessionId = 'test-session-hit-1';
      speculativePrefetchService.registerPrefetch(
        sessionId,
        1,
        'How would you scale storage across multiple database shards with cache?'
      );

      // Candidate provides an answer matching the optimal scalable branch
      const answer =
        'I will use database sharding with horizontal partitioning across PostgreSQL nodes, and introduce a distributed Redis cache-aside layer with read replicas to absorb read traffic.';

      const matchResult = await speculativePrefetchService.matchOrFallback(sessionId, 1, answer);

      expect(matchResult.matched).toBe(true);
      expect(matchResult.similarity).toBeGreaterThan(0.85);
      expect(matchResult.branch).toBeDefined();
      expect(matchResult.fallbackRequired).toBe(false);
      // Acceptance criteria: delivers sub-200ms follow-up response (typically < 100ms)
      expect(matchResult.latencyMs).toBeLessThan(200);
      expect(matchResult.branch?.speculativeFollowUp).toContain('thundering herd');
    });

    it('gracefully falls back to standard generation on branch miss (similarity <= 0.85)', async () => {
      const sessionId = 'test-session-miss-1';
      speculativePrefetchService.registerPrefetch(
        sessionId,
        1,
        'How would you scale storage across multiple database shards with cache?'
      );

      // Candidate provides an off-topic or ambiguous answer
      const answer = 'We can just ask users to wait and restart the machine if it slows down.';

      const matchResult = await speculativePrefetchService.matchOrFallback(sessionId, 1, answer);

      expect(matchResult.matched).toBe(false);
      expect(matchResult.similarity).toBeLessThanOrEqual(0.85);
      expect(matchResult.fallbackRequired).toBe(true);
    });
  });

  describe('Multi-Turn Simulated 6-Turn Interview Performance', () => {
    it('demonstrates monotonic token escalation without compression vs bounded token savings with compression', () => {
      const allTurns = [mockTurn1, mockTurn2, mockTurn3, mockTurn4, mockTurn5, mockTurn6];

      const tokenMeasurements: Array<{
        turn: number;
        uncompressedTokens: number;
        compressedTokens: number;
        reductionPercent: number;
      }> = [];

      for (let i = 0; i < allTurns.length; i++) {
        const history = allTurns.slice(0, i);
        const currentTurn = allTurns[i];

        // 1. Raw uncompressed prompt token calculation
        const rawHistoryText = history
          .map((t, idx) => `Earlier question ${idx + 1}: ${t.prompt}\n<candidate_answer>\n${t.answer}\n</candidate_answer>`)
          .join('\n\n');
        const uncompressedPromptText = `Question ${i + 1} of 6:\n${currentTurn.prompt}\n\nEarlier in this interview:\n${rawHistoryText}\n\nThe candidate answered:\n${currentTurn.answer}`;
        const uncompressedTokens = contextCompressorService.estimateTokenCount(uncompressedPromptText);

        // 2. Optimized prompt using ContextCompressor
        const optimizedHistory = contextCompressorService.buildOptimizedTurnContext(history, i);
        const compressedPromptText = `Question ${i + 1} of 6:\n${currentTurn.prompt}\n\nEarlier in this interview:\n${optimizedHistory.formattedHistory}\n\nThe candidate answered:\n${currentTurn.answer}`;
        const compressedTokens = contextCompressorService.estimateTokenCount(compressedPromptText);

        tokenMeasurements.push({
          turn: i + 1,
          uncompressedTokens,
          compressedTokens,
          reductionPercent: optimizedHistory.tokenStats.reductionPercent,
        });
      }

      // Assertions across the 6 turns:
      // Turn 1-3: Uncompressed
      expect(tokenMeasurements[0].reductionPercent).toBe(0);
      expect(tokenMeasurements[1].reductionPercent).toBe(0);
      expect(tokenMeasurements[2].reductionPercent).toBe(0);

      // Turns 4, 5, 6: Significant reduction >= 50%
      expect(tokenMeasurements[3].reductionPercent).toBeGreaterThanOrEqual(50);
      expect(tokenMeasurements[4].reductionPercent).toBeGreaterThanOrEqual(50);
      expect(tokenMeasurements[5].reductionPercent).toBeGreaterThanOrEqual(50);

      // Uncompressed tokens scale monotonically
      expect(tokenMeasurements[5].uncompressedTokens).toBeGreaterThan(tokenMeasurements[0].uncompressedTokens * 3);
    });

    it('processInterviewTurnWithOptimization delivers speculative hit or compressed fallback', async () => {
      const sessionId = 'simulated-turn-worker-session';

      // Prefetch for turn 2
      speculativePrefetchService.registerPrefetch(
        sessionId,
        1,
        'How do you prevent database read bottlenecks when 99% of queries are for hot URLs?'
      );

      // Candidate answer hits the speculative branch
      const hitResult = await processInterviewTurnWithOptimization(sessionId, {
        role: 'backend',
        turnIndex: 1,
        totalTurns: 6,
        question: { prompt: mockTurn2.prompt, checklist: ['Redis caching'] },
        answer: 'We deploy a Redis cache-aside cluster with LRU eviction and read replicas.',
        history: [{ prompt: mockTurn1.prompt, answer: mockTurn1.answer }],
      });

      expect(hitResult.source).toBe('speculative_prefetch');
      expect(hitResult.branchMatched).toBe(true);
      expect(hitResult.latencyMs).toBeLessThan(200);

      // Turn 4 with branch miss falls back to standard generation with compressed context
      const missResult = await processInterviewTurnWithOptimization(
        sessionId,
        {
          role: 'backend',
          turnIndex: 3,
          totalTurns: 6,
          question: { prompt: mockTurn4.prompt, checklist: ['Horizontal sharding'] },
          answer: 'Unrelated reply about frontend styles and CSS grid layouts.',
          history: [
            { prompt: mockTurn1.prompt, answer: mockTurn1.answer },
            { prompt: mockTurn2.prompt, answer: mockTurn2.answer },
            { prompt: mockTurn3.prompt, answer: mockTurn3.answer },
          ],
        },
        async () => 'Standard LLM reply generated with compressed prompt.'
      );

      expect(missResult.source).toBe('standard_generation');
      expect(missResult.branchMatched).toBe(false);
      expect(missResult.feedback).toContain('Standard LLM reply');
    });
  });
});

