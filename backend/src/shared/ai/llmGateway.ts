// backend/src/shared/ai/llmGateway.ts
// Re-export LLMGateway and related types from modules/ai/provider/LLMGateway for shared/ai access.

export {
  LLMGateway,
  llmGateway,
  type LLMCompletionRequest,
  type LLMCompletionResponse,
  type LLMStreamEvent,
} from '../../modules/ai/provider/LLMGateway.js';
