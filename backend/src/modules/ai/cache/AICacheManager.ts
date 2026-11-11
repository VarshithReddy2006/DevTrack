import { createHash } from 'node:crypto';
import { logger } from '../../../shared/logger.js';

export interface PromptCacheKey {
  provider: string;
  model: string;
  userPrompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: string;
  responseSchemaVersion?: string;
  tenantScope?: string;
}

export interface CacheEntry {
  key: string;
  response: string;
  prompt: string;
  model: string;
  provider: string;
  timestamp: Date;
  ttl: number;
  hitCount: number;
  contextVersion: string;
}

export interface CacheStats {
  totalEntries: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  totalSize: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
}

class AICacheManagerClass {
  private cache: Map<string, CacheEntry> = new Map();
  private maxCacheSize: number = 1000;
  private defaultTTL: number = 5 * 60 * 1000; // 5 minutes
  private hitCount: number = 0;
  private missCount: number = 0;

  /**
   * Get cached response
   */
  get(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.missCount++;
      return null;
    }

    // Check if entry has expired
    const age = Date.now() - entry.timestamp.getTime();
    if (age > entry.ttl) {
      this.cache.delete(key);
      this.missCount++;
      return null;
    }

    // Update hit count
    entry.hitCount++;
    this.hitCount++;
    
    logger.debug('[AICacheManager] Cache hit', { key, hitCount: entry.hitCount });
    
    return entry;
  }

  /**
   * Set cached response
   */
  set(key: string, response: string, prompt: string, model: string, provider: string, contextVersion: string, ttl?: number): void {
    // Check if cache is full
    if (this.cache.size >= this.maxCacheSize) {
      this.evictOldest();
    }

    const entry: CacheEntry = {
      key,
      response,
      prompt,
      model,
      provider,
      timestamp: new Date(),
      ttl: ttl || this.defaultTTL,
      hitCount: 0,
      contextVersion,
    };

    this.cache.set(key, entry);
    
    logger.debug('[AICacheManager] Cache set', { key, model, provider });
  }

  /**
   * Generate cache key from prompt and context
   */
  generateKey(prompt: string, contextVersion: string, model: string, provider: string): string {
    return this.generatePromptKey({ userPrompt: prompt, responseSchemaVersion: contextVersion, model, provider });
  }

  generatePromptKey(input: PromptCacheKey): string {
    const keyData = JSON.stringify({
      provider: input.provider,
      model: input.model,
      systemPrompt: input.systemPrompt ?? '',
      userPrompt: input.userPrompt,
      temperature: input.temperature ?? null,
      maxTokens: input.maxTokens ?? null,
      responseFormat: input.responseFormat ?? null,
      responseSchemaVersion: input.responseSchemaVersion ?? null,
      tenantScope: input.tenantScope ?? null,
    });
    return createHash('sha256').update(keyData).digest('hex');
  }

  /**
   * Generate semantic cache key (simplified version)
   */
  generateSemanticKey(prompt: string): string {
    // Simple semantic hashing - in production would use embeddings
    const normalized = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
    const words = normalized.split(' ').slice(0, 10); // First 10 words
    return Buffer.from(words.join(' ')).toString('base64');
  }

  /**
   * Check if similar prompt exists in cache
   */
  findSimilar(prompt: string, threshold: number = 0.8): CacheEntry | null {
    const semanticKey = this.generateSemanticKey(prompt);
    
    for (const [key, entry] of this.cache.entries()) {
      const entrySemanticKey = this.generateSemanticKey(entry.prompt);
      
      // Simple similarity check (in production would use cosine similarity on embeddings)
      if (semanticKey === entrySemanticKey) {
        logger.debug('[AICacheManager] Similar cache entry found', { semanticKey });
        return entry;
      }
    }
    
    return null;
  }

  /**
   * Evict oldest entry
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTimestamp = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp.getTime() < oldestTimestamp) {
        oldestTimestamp = entry.timestamp.getTime();
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      logger.debug('[AICacheManager] Evicted oldest entry', { key: oldestKey });
    }
  }

  /**
   * Evict expired entries
   */
  evictExpired(): number {
    const now = Date.now();
    let evictedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      const age = now - entry.timestamp.getTime();
      if (age > entry.ttl) {
        this.cache.delete(key);
        evictedCount++;
      }
    }

    if (evictedCount > 0) {
      logger.info('[AICacheManager] Evicted expired entries', { count: evictedCount });
    }

    return evictedCount;
  }

  /**
   * Clear cache
   */
  clear(): void {
    this.cache.clear();
    this.hitCount = 0;
    this.missCount = 0;
    logger.info('[AICacheManager] Cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const totalEntries = this.cache.size;
    const totalRequests = this.hitCount + this.missCount;
    const hitRate = totalRequests > 0 ? (this.hitCount / totalRequests) * 100 : 0;
    
    // Calculate total size (rough approximation)
    let totalSize = 0;
    const byProvider: Record<string, number> = {};
    const byModel: Record<string, number> = {};

    for (const entry of this.cache.values()) {
      totalSize += entry.response.length + entry.prompt.length;
      
      byProvider[entry.provider] = (byProvider[entry.provider] || 0) + 1;
      byModel[entry.model] = (byModel[entry.model] || 0) + 1;
    }

    return {
      totalEntries,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: Math.round(hitRate),
      totalSize,
      byProvider,
      byModel,
    };
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Set max cache size
   */
  setMaxCacheSize(size: number): void {
    this.maxCacheSize = size;
    
    // Evict entries if new size is smaller
    while (this.cache.size > this.maxCacheSize) {
      this.evictOldest();
    }
    
    logger.info('[AICacheManager] Max cache size updated', { size });
  }

  /**
   * Set default TTL
   */
  setDefaultTTL(ttl: number): void {
    this.defaultTTL = ttl;
    logger.info('[AICacheManager] Default TTL updated', { ttl });
  }

  /**
   * Get entry by key
   */
  getEntry(key: string): CacheEntry | undefined {
    return this.cache.get(key);
  }

  /**
   * Delete entry by key
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Warm cache with common prompts
   */
  warmCache(commonPrompts: Array<{ prompt: string; response: string; model: string; provider: string; contextVersion: string }>): void {
    commonPrompts.forEach(({ prompt, response, model, provider, contextVersion }) => {
      const key = this.generateKey(prompt, contextVersion, model, provider);
      this.set(key, response, prompt, model, provider, contextVersion);
    });
    
    logger.info('[AICacheManager] Cache warmed', { count: commonPrompts.length });
  }

  /**
   * Export cache entries
   */
  exportEntries(): CacheEntry[] {
    return Array.from(this.cache.values());
  }

  /**
   * Import cache entries
   */
  importEntries(entries: CacheEntry[]): void {
    entries.forEach(entry => {
      this.cache.set(entry.key, entry);
    });
    
    logger.info('[AICacheManager] Cache entries imported', { count: entries.length });
  }
}

export const AICacheManager = new AICacheManagerClass();
