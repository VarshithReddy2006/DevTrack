import type { AIProvider } from './AIProviderAdapter.js';

/**
 * A provider failed after the first delta was already handed to the caller. A different
 * provider cannot continue the text, so the stream stops and the caller decides what to do.
 * Kept out of AIProviderAdapter.ts so it can be imported without loading the provider SDKs.
 */
export class AIStreamInterruptedError extends Error {
  constructor(readonly provider: AIProvider, readonly partialContent: string, readonly cause: unknown) {
    super(`AI stream from ${provider} was interrupted after ${partialContent.length} characters`);
    this.name = 'AIStreamInterruptedError';
  }
}
