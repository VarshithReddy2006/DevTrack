// src/shared/observability/index.ts — Barrel export
export { SloEngine, sloEngine } from './sloEngine.js';
export type { SloConfig, SloEvaluation } from './sloEngine.js';
export { dispatchBurnRateAlert, setAlertHandler } from './burnRateAlerts.js';
export type { BurnRateAlert, AlertWebhookConfig } from './burnRateAlerts.js';

