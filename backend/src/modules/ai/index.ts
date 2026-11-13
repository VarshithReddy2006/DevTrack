// src/modules/ai/index.ts
// AI Module Entry Point - Organized exports for 28 subdirectories
// Consolidates AI provider, embedding, retrieval, and reliability systems

// ---------------------------------------------------------------------------
// Core AI Provider
// ---------------------------------------------------------------------------
export { AIProviderAdapter, type AIProvider, type AIRequest, type AIResponse, type ProviderHealth, type TokenUsage } from './provider/AIProviderAdapter.js';

// ---------------------------------------------------------------------------
// Embedding Systems
// ---------------------------------------------------------------------------
export { EmbeddingProviderAdapter, type EmbeddingResponse } from './embedding/EmbeddingProviderAdapter.js';
export { RealEmbeddingPipeline } from './embedding/RealEmbeddingPipeline.js';
export type { EmbeddingScope } from './embedding/embeddingScope.js';
export { EmbeddingPersistenceLayer } from './embedding/EmbeddingPersistenceLayer.js';

// ---------------------------------------------------------------------------
// Retrieval & Similarity
// ---------------------------------------------------------------------------
export { VectorRetrievalEngine } from './retrieval/VectorRetrievalEngine.js';
export { HybridRetrievalLayer } from './retrieval/HybridRetrievalLayer.js';
export { SemanticSimilarityService } from './retrieval/SemanticSimilarityService.js';
export { CosineSimilarityEngine } from './retrieval/CosineSimilarityEngine.js';

// ---------------------------------------------------------------------------
// Reliability & Failover
// ---------------------------------------------------------------------------
export { ProviderFailoverRuntime } from './reliability/ProviderFailoverRuntime.js';
export { RuntimeReliabilityEnforcer } from './reliability/RuntimeReliabilityEnforcer.js';
export { AIDegradedHandler } from './degradation/AIDegradedHandler.js';

// ---------------------------------------------------------------------------
// Safety & Trust
// ---------------------------------------------------------------------------
export {
  PromptSafetyLayer,
  MAX_INPUT_LENGTH,
  HOMOGLYPH_MAP,
  type SafetyCheckResult,
  type SafetyPolicy,
} from './safety/PromptSafetyLayer.js';
export { TrustAwareAIResponse } from './trust/TrustAwareAIResponse.js';

// ---------------------------------------------------------------------------
// Context & Explanation
// ---------------------------------------------------------------------------
export { ReadinessContextBuilder } from './context/ReadinessContextBuilder.js';
export { RecommendationExplanationEngine } from './explanation/RecommendationExplanationEngine.js';
export { AIReadinessExplanationLayer } from './explanation/AIReadinessExplanationLayer.js';

// ---------------------------------------------------------------------------
// Production & Testing
// ---------------------------------------------------------------------------
export { SemanticProductionizationLayer } from './production/SemanticProductionizationLayer.js';
export { AITestingSuite } from './testing/AITestingSuite.js';
export { AIResponseAuditLog } from './audit/AIResponseAuditLog.js';

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------
export { AICacheManager } from './cache/AICacheManager.js';

// ---------------------------------------------------------------------------
// Conversation & Mentor
// ---------------------------------------------------------------------------
export { AIConversationService } from './conversation/AIConversationService.js';
export { ContextualEngineeringMentor } from './mentor/ContextualEngineeringMentor.js';

// ---------------------------------------------------------------------------
// Roadmap & Guidance
// ---------------------------------------------------------------------------
export { AIRoadmapGuidance } from './roadmap/AIRoadmapGuidance.js';

// ---------------------------------------------------------------------------
// 9. External Integrations (None currently active)
