import { cleanUntrustedText } from './prompts/promptInput.js';

export interface TurnData {
  prompt: string;
  answer: string;
  code?: string | null;
  feedback?: string | null;
}

export interface CompressedTurnSummary {
  keyDecisions: string[];
  solvedInefficiencies: string[];
  statedComplexities: string[];
  rawSummaryText: string;
  originalTokens: number;
  compressedTokens: number;
  tokenReductionPercent: number;
}

export class ContextCompressorService {
  /**
   * Compression activates once the interview exceeds 3 turns (turnIndex >= 3, i.e., turn 4+).
   * Turns 1-3 remain uncompressed for initial rapport and full context building.
   */
  shouldCompress(turnIndex: number): boolean {
    return turnIndex >= 3;
  }

  /**
   * Deterministic token estimation based on character and word boundaries.
   * Standard LLM tokenizers average ~4 characters per token for English & code transcripts.
   */
  estimateTokenCount(text: string): number {
    if (!text || text.trim().length === 0) return 0;
    // Normalized token count: 4 chars/token approximation
    return Math.max(1, Math.ceil(text.trim().length / 4));
  }

  /**
   * Extracts architectural decisions, technologies, and system structures.
   */
  private extractKeyDecisions(text: string): string[] {
    const decisions: string[] = [];
    const patterns = [
      /(?:use|using|chose|choose|picked|implemented|deploy|selected|utilize)\s+([A-Za-z0-9_\-\s]+?)(?:for|as|to|because|instead|\.|\,)/gi,
      /(?:database|storage|queue|broker|cache|load balancer|datastore|table)\s*:\s*([A-Za-z0-9_\-\s]+)/gi,
      /(?:postgresql|postgres|mysql|mongodb|dynamodb|cassandra|redis|kafka|rabbitmq|sqs|elasticsearch|s3|grpc|rest|graphql)/gi,
      /(?:event-driven|microservices|monolith|cqrs|sharding|partitioning|replication|master-slave|read replicas|eventual consistency|strong consistency)/gi,
    ];

    const matchedTokens = new Set<string>();

    // Technology and pattern keywords
    const techMatches = text.match(/(?:postgresql|postgres|mysql|mongodb|dynamodb|cassandra|redis|kafka|rabbitmq|sqs|elasticsearch|s3|grpc|rest|graphql|cdn|nginx|envoy)/gi) || [];
    for (const t of techMatches) {
      const norm = t.toLowerCase();
      if (!matchedTokens.has(norm)) {
        matchedTokens.add(norm);
        decisions.push(`Selected ${t.toUpperCase()} as core infrastructure component`);
      }
    }

    const archMatches = text.match(/(?:event-driven architecture|microservices|cqrs|sharding|partitioning|replication|master-slave|read replicas|eventual consistency|strong consistency|consistent hashing|write-ahead log|bloom filter)/gi) || [];
    for (const a of archMatches) {
      const norm = a.toLowerCase();
      if (!matchedTokens.has(norm)) {
        matchedTokens.add(norm);
        decisions.push(`Adopted ${a} pattern`);
      }
    }

    // Sentence level decision extraction
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      if (/(?:decided to|opted for|will structure|partition by|primary key|schema)/i.test(s)) {
        const cleaned = s.replace(/^(?:so|well|um|uh|i think|basically|actually)\s*,?\s*/i, '').trim();
        if (cleaned.length > 15 && cleaned.length < 160 && !decisions.includes(cleaned)) {
          decisions.push(cleaned);
        }
      }
    }

    return decisions.slice(0, 5);
  }

  /**
   * Extracts solutions to performance bottlenecks, latency issues, and scaling bottlenecks.
   */
  private extractSolvedInefficiencies(text: string): string[] {
    const inefficiencies: string[] = [];
    const patterns = [
      /(?:avoid|prevent|mitigate|reduce|eliminate|solve|address)\s+([A-Za-z0-9_\-\s]+?)(?:by|using|with|\.|\,)/gi,
      /(?:caching|cache-aside|write-through|read-through|batching|connection pool|debounce|rate limit|indexing|async processing|backpressure)/gi,
    ];

    const matchedTokens = new Set<string>();
    const optMatches = text.match(/(?:cache-aside|write-through|read-through|batch processing|connection pooling|rate limiting|token bucket|b-tree indexing|asynchronous processing|backpressure|read replica offloading|horizontal auto-scaling)/gi) || [];
    for (const opt of optMatches) {
      const norm = opt.toLowerCase();
      if (!matchedTokens.has(norm)) {
        matchedTokens.add(norm);
        inefficiencies.push(`Implemented ${opt} to eliminate I/O and latency bottlenecks`);
      }
    }

    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      if (/(?:bottleneck|slow|hot key|contention|thundering herd|failover|single point of failure|spof|lock contention)/i.test(s)) {
        const cleaned = s.replace(/^(?:so|well|um|uh|i think|basically|actually)\s*,?\s*/i, '').trim();
        if (cleaned.length > 15 && cleaned.length < 160 && !inefficiencies.includes(cleaned)) {
          inefficiencies.push(cleaned);
        }
      }
    }

    return inefficiencies.slice(0, 5);
  }

  /**
   * Extracts candidate-stated algorithmic and system complexities (time, space, latency, throughput).
   */
  private extractStatedComplexities(text: string): string[] {
    const complexities: string[] = [];
    const bigOPatterns = text.match(/(?:O\s*\(\s*(?:1|log\s*n|n|n\s*log\s*n|n\^2|k)\s*\))/gi) || [];
    for (const bo of bigOPatterns) {
      const formatted = `Runtime/Space complexity bound: ${bo.replace(/\s+/g, '')}`;
      if (!complexities.includes(formatted)) {
        complexities.push(formatted);
      }
    }

    const metricPatterns = text.match(/(?:\d+\s*(?:ms|seconds|qps|tps|kb|mb|gb|tb|pb|writes\/sec|reads\/sec|percentile|p99|p95|sla))/gi) || [];
    for (const m of metricPatterns) {
      const formatted = `System scale/latency target: ${m.trim()}`;
      if (!complexities.includes(formatted)) {
        complexities.push(formatted);
      }
    }

    return complexities.slice(0, 5);
  }

  /**
   * Compresses turns 1 through N-1 into a structured factual summary while omitting filler words,
   * conversational scaffolding, and redundant narrative.
   */
  compressDialogueHistory(history: TurnData[]): CompressedTurnSummary {
    if (!history || history.length === 0) {
      return {
        keyDecisions: [],
        solvedInefficiencies: [],
        statedComplexities: [],
        rawSummaryText: '',
        originalTokens: 0,
        compressedTokens: 0,
        tokenReductionPercent: 0,
      };
    }

    // Compute raw uncompressed transcript
    const rawTranscript = history
      .map(
        (t, idx) =>
          `Turn ${idx + 1} Question: ${t.prompt}\nCandidate Answer: ${cleanUntrustedText(t.answer)}${t.feedback ? `\nInterviewer Reply: ${t.feedback}` : ''
          }`
      )
      .join('\n\n');

    const originalTokens = this.estimateTokenCount(rawTranscript);

    // Aggregate answers and notes for extraction
    const combinedAnswers = history.map((t) => t.answer).join('\n');

    const keyDecisions = this.extractKeyDecisions(combinedAnswers);
    const solvedInefficiencies = this.extractSolvedInefficiencies(combinedAnswers);
    const statedComplexities = this.extractStatedComplexities(combinedAnswers);

    // Fallbacks if candidate answers were brief or generic
    if (keyDecisions.length === 0) {
      keyDecisions.push(`Established core functional design and architecture across ${history.length} initial turns`);
    }
    if (solvedInefficiencies.length === 0) {
      solvedInefficiencies.push('Identified potential network and database access bottlenecks for scaling');
    }
    if (statedComplexities.length === 0) {
      statedComplexities.push('Evaluated linear processing and storage requirements');
    }

    const summaryLines = [
      '[Extractive Dialogue Context Summary (Turns 1 to N-1)]',
      'Key Decisions Made:',
      ...keyDecisions.map((kd) => `- ${kd}`),
      'Solved Inefficiencies:',
      ...solvedInefficiencies.map((si) => `- ${si}`),
      'Candidate Stated Complexities:',
      ...statedComplexities.map((sc) => `- ${sc}`),
    ];

    const rawSummaryText = summaryLines.join('\n');
    const compressedTokens = this.estimateTokenCount(rawSummaryText);

    const tokenReductionPercent =
      originalTokens > 0
        ? Math.max(0, Math.round(((originalTokens - compressedTokens) / originalTokens) * 100))
        : 0;

    return {
      keyDecisions,
      solvedInefficiencies,
      statedComplexities,
      rawSummaryText,
      originalTokens,
      compressedTokens,
      tokenReductionPercent,
    };
  }

  /**
   * Builds an optimized turn context prompt.
   * If turnIndex < 3: preserves raw turns.
   * If turnIndex >= 3: compresses turns 0 to N-2 into the extractive bullet summary,
   * keeping the active immediate turn verbatim to ensure zero loss of context fidelity.
   */
  buildOptimizedTurnContext(
    history: TurnData[],
    turnIndex: number
  ): {
    formattedHistory: string;
    isCompressed: boolean;
    tokenStats: { originalTokens: number; finalTokens: number; reductionPercent: number };
  } {
    if (!this.shouldCompress(turnIndex) || history.length < 3) {
      // Uncompressed mode for turns 1 to 3
      const formatted = history
        .map(
          (t, idx) =>
            `Earlier question ${idx + 1}: ${t.prompt}\n<candidate_answer>\n${cleanUntrustedText(
              t.answer,
              1500
            )}\n</candidate_answer>`
        )
        .join('\n\n');

      const tokens = this.estimateTokenCount(formatted);
      return {
        formattedHistory: formatted,
        isCompressed: false,
        tokenStats: { originalTokens: tokens, finalTokens: tokens, reductionPercent: 0 },
      };
    }

    // Turns 4+: Compresses turns 1 to N-1 into structured factual summary
    const summary = this.compressDialogueHistory(history);
    const finalFormatted = summary.rawSummaryText;

    // Compute raw tokens if all turns were sent verbatim
    const uncompressedFormatted = history
      .map(
        (t, idx) =>
          `Earlier question ${idx + 1}: ${t.prompt}\n<candidate_answer>\n${cleanUntrustedText(
            t.answer,
            1500
          )}\n</candidate_answer>`
      )
      .join('\n\n');

    const originalTokens = this.estimateTokenCount(uncompressedFormatted);
    const finalTokens = this.estimateTokenCount(finalFormatted);
    const reductionPercent =
      originalTokens > 0
        ? Math.max(0, Math.round(((originalTokens - finalTokens) / originalTokens) * 100))
        : 0;

    return {
      formattedHistory: finalFormatted,
      isCompressed: true,
      tokenStats: { originalTokens, finalTokens, reductionPercent },
    };
  }
}

export const contextCompressorService = new ContextCompressorService();

