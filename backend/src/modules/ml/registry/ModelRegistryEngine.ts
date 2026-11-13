// src/modules/ml/registry/ModelRegistryEngine.ts
// Tracks model versions, training datasets, evaluation metrics, drift status,
// deployment state, rollback checkpoints. Model governance mandatory.

import { MongoModelState } from '../MongoModelState.js';
import type { ModelMetadata, DeploymentState, DriftStatus, EvaluationMetrics } from '../types.js';

interface RegistryEntry extends ModelMetadata {
  registeredAt: string;
  promotedAt: string | null;
  rollbackHistory: { fromState: DeploymentState; toState: DeploymentState; reason: string; timestamp: string }[];
  evaluationGate: {
    passed: boolean;
    requiredMetrics: Partial<EvaluationMetrics>;
    actualMetrics: EvaluationMetrics;
    gatedAt: string | null;
  };
}

/**
 * ModelRegistryEngine
 *
 * Central model registry with governance:
 * - Model version tracking
 * - Training dataset lineage
 * - Evaluation metric gating (no deployment without evaluation)
 * - Drift status monitoring
 * - Deployment state management (staged → canary → production)
 * - Rollback with checkpoint restoration
 *
 * GOVERNANCE: No model deployment without passing evaluation gates.
 */
export class ModelRegistryEngine {
  private readonly registry = new MongoModelState<RegistryEntry>('ml_model_registry');

  /**
   * Register a new model version.
   */
  async register(metadata: ModelMetadata, requiredMetrics?: Partial<EvaluationMetrics>): Promise<RegistryEntry> {
    const entry: RegistryEntry = {
      ...metadata,
      deploymentState: metadata.deploymentState === 'inactive' ? 'inactive' : 'staged',
      registeredAt: new Date().toISOString(),
      promotedAt: null,
      rollbackHistory: [],
      evaluationGate: {
        passed: false,
        requiredMetrics: requiredMetrics ?? {},
        actualMetrics: metadata.evaluationMetrics,
        gatedAt: null,
      },
    };

    // Auto-evaluate gate
    if (requiredMetrics) {
      entry.evaluationGate.passed = this.checkEvaluationGate(
        metadata.evaluationMetrics,
        requiredMetrics,
      );
      if (entry.evaluationGate.passed) {
        entry.evaluationGate.gatedAt = new Date().toISOString();
      }
    } else {
      // No gate requirements → auto-pass
      entry.evaluationGate.passed = true;
      entry.evaluationGate.gatedAt = new Date().toISOString();
    }

    // A retried registration must not reset a promotion or rollback.
    const registered = await this.registry.update(metadata.modelId, current => current ? undefined : entry);
    if (registered) return registered;

    const existing = await this.registry.get(metadata.modelId);
    if (!existing || existing.version !== metadata.version || existing.modelName !== metadata.modelName) {
      throw new Error(`Model ID ${metadata.modelId} already belongs to another version`);
    }
    return existing;
  }

  /**
   * Promote a model to a deployment state.
   * GOVERNANCE: Requires evaluation gate to pass.
   */
  async promote(modelId: string, targetState: DeploymentState): Promise<boolean> {
    const validTransitions: Record<DeploymentState, DeploymentState[]> = {
      inactive: ['staged'],
      staged: ['canary', 'production'],
      canary: ['production', 'rolled-back'],
      production: ['rolled-back'],
      'rolled-back': ['staged'],
    };

    const updated = await this.registry.update(modelId, entry => {
      if (!entry?.evaluationGate.passed || !validTransitions[entry.deploymentState].includes(targetState)) {
        return undefined;
      }
      if (entry.driftStatus === 'critical' && (targetState === 'canary' || targetState === 'production')) {
        return undefined;
      }
      if (targetState === 'rolled-back') return this.rolledBack(entry, 'Deployment state changed');

      return { ...entry, deploymentState: targetState, promotedAt: new Date().toISOString() };
    });
    return updated !== undefined;
  }

  async rollback(modelId: string, reason: string): Promise<boolean> {
    const updated = await this.registry.update(modelId, entry => entry && this.rolledBack(entry, reason));
    return updated !== undefined;
  }

  async updateDriftStatus(modelId: string, driftStatus: DriftStatus): Promise<void> {
    await this.registry.update(modelId, entry => {
      if (!entry) return undefined;
      const updated = { ...entry, driftStatus };
      if (driftStatus === 'critical' && (entry.deploymentState === 'production' || entry.deploymentState === 'canary')) {
        return this.rolledBack(updated, 'Critical drift detected');
      }
      return updated;
    });
  }

  getModel(modelId: string): Promise<RegistryEntry | undefined> {
    return this.registry.get(modelId);
  }

  async getProductionModel(modelName: string): Promise<RegistryEntry | null> {
    const history = await this.getVersionHistory(modelName);
    return history.reverse().find(entry => entry.deploymentState === 'production') ?? null;
  }

  async getVersionHistory(modelName: string): Promise<RegistryEntry[]> {
    const models = await this.listModels();
    return models
      .filter(entry => entry.modelName === modelName)
      .sort((left, right) => left.registeredAt.localeCompare(right.registeredAt));
  }

  listModels(): Promise<RegistryEntry[]> {
    return this.registry.list();
  }

  async listByState(state: DeploymentState): Promise<RegistryEntry[]> {
    return (await this.listModels()).filter(entry => entry.deploymentState === state);
  }

  private rolledBack(entry: RegistryEntry, reason: string): RegistryEntry {
    if (entry.deploymentState === 'rolled-back') return entry;
    return {
      ...entry,
      deploymentState: 'rolled-back',
      rollbackHistory: [...entry.rollbackHistory, {
        fromState: entry.deploymentState,
        toState: 'rolled-back',
        reason,
        timestamp: new Date().toISOString(),
      }],
    };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private checkEvaluationGate(actual: EvaluationMetrics, required: Partial<EvaluationMetrics>): boolean {
    for (const [key, threshold] of Object.entries(required)) {
      const actualValue = (actual as Record<string, unknown>)[key];
      if (typeof threshold === 'object') {
        if (!actualValue || typeof actualValue !== 'object') return false;
        for (const [rank, minimum] of Object.entries(threshold)) {
          const value = (actualValue as Record<string, number>)[rank];
          if (!Number.isFinite(value) || !Number.isFinite(minimum) || value < minimum) return false;
        }
        continue;
      }

      if (typeof threshold !== 'number' || typeof actualValue !== 'number' ||
          !Number.isFinite(actualValue) || !Number.isFinite(threshold)) return false;
      if (key === 'logloss' || key === 'mae' || key === 'rmse' || key === 'calibrationError') {
        if (actualValue > threshold) return false;
      } else if (actualValue < threshold) {
        return false;
      }
    }
    return true;
  }
}
