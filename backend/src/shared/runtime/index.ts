// src/shared/runtime/index.ts — Runtime infrastructure barrel
export { orchestrator, registerShutdownSignals } from './orchestrator.js';
export {
  getInfrastructureState,
  isOverallDegraded,
  getDegradedComponents,
  setApiStatus,
  setMongoStatus,
  setRedisStatus,
  setQueuesStatus,
  setPlatformSyncWorkerStatus,
  setXpWorkerStatus,
  setSchedulerStatus,
  setSseStatus,
  resetInfrastructureStoreForTesting,
} from './infrastructureRegistry.js';
export { OrchestrationStateMachine } from './stateMachine.js';
export type { OrchestrationState, OrchestrationEvent, TransitionContext, StateTransitionResult } from './stateMachine.js';
export type { SubsystemStatus, SubsystemState, InfrastructureState } from './infrastructureRegistry.js';
