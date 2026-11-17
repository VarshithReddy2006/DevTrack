// The only way the job target workers reach a model: through the shared LLMGateway.

import { llmGateway } from '../ai/provider/LLMGateway.js';

export interface JdLlmRequest {
  userId: string;
  systemPrompt: string;
  prompt: string;
  maxTokens: number;
}

export interface JdLlm {
  /** False when no provider key is set. Callers then skip the model and use the taxonomy result. */
  isConfigured(): boolean;
  /** Resolves with the raw reply text. Rejects when no real provider answered. */
  complete(request: JdLlmRequest): Promise<string>;
}

export const JD_LLM_FEATURE = 'jd_analysis';
export const JD_LLM_TIMEOUT_MS = 45_000;

export function createGatewayJdLlm(timeoutMs = JD_LLM_TIMEOUT_MS): JdLlm {
  return {
    isConfigured: () => Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY),
    async complete({ userId, systemPrompt, prompt, maxTokens }) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          llmGateway.generateCompletion({
            userId,
            systemPrompt,
            prompt,
            maxTokens,
            temperature: 0.1,
            feature: JD_LLM_FEATURE,
            // The gateway's default heuristic reply is prose. Return nothing so it can never pass for JSON.
            heuristicFallback: () => '',
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`JD analysis model call timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
        if (response.provider === 'heuristic' || !response.content) throw new Error('No AI provider answered');
        return response.content;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
