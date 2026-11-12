/**
 * What to do at startup when no AI provider key is configured.
 *
 * A real cloud deployment (HTTPS origin) must have a key, so it stops. A local production
 * simulation (docker compose on localhost) keeps running and the intelligence features fall back
 * to degraded responses, matching what the startup log already tells the operator.
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
}): AiCredentialAction {
  if (opts.hasOpenAi || opts.hasGemini) return 'ok';
  if (opts.isProd && !isLocalOrigin(opts.corsOrigin)) return 'exit';
  return 'warn';
}
