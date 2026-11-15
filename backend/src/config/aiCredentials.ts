/**
 * What to do at startup when no AI provider key is configured.
 *
 * In production or development, if AI keys are omitted, the server runs in degraded
 * AI mode and intelligence features fall back to deterministic responses.
 * If explicitly configured to require AI keys (requireAi: true / REQUIRE_AI_KEYS=true), it exits.
 */
export type AiCredentialAction = 'ok' | 'warn' | 'exit';

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

export function isLocalOrigin(origin: string): boolean {
  return LOCAL_ORIGIN.test(origin.trim());
}

export function aiCredentialAction(opts: {
  isProd: boolean;
  corsOrigin: string;
  hasOpenAi: boolean;
  hasGemini: boolean;
  requireAi?: boolean;
}): AiCredentialAction {
  if (opts.hasOpenAi || opts.hasGemini) return 'ok';
  if (opts.requireAi) return 'exit';
  return 'warn';
}
