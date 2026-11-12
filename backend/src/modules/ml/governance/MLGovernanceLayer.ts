// src/modules/ml/governance/MLGovernanceLayer.ts
// Enforces confidence minimums, drift detection, unsafe model blocking,
// degraded-mode inference, rollback protection, model explainability.
// ML systems remain bounded, observable, and explainable.

import { logger } from '../../../shared/logger.js';
import { MongoModelState } from '../MongoModelState.js';
import type {
  GovernancePolicy,
  GovernanceConstraint,
  GovernanceAction,
  GovernanceViolation,
  MLPrediction,
  ModelMetadata,
  DriftStatus,
} from '../types.js';

const VIOLATION_WINDOW_MS = 300_000;

interface GovernanceState {
  modelId: string;
  policies: GovernancePolicy[];
  blocked: boolean;
  totalViolations: number;
  recentViolations: GovernanceViolation[];
}

type PredictionSignals = Pick<MLPrediction, 'modelId' | 'confidence' | 'latencyMs'>;

interface GovernanceDecision {
  allowed: boolean;
  action: GovernanceAction;
  violations: GovernanceViolation[];
  explanation: string[];
}

interface ModelSafetyCheck {
  modelId: string;
  safe: boolean;
  concerns: string[];
  timestamp: string;
}

/**
 * MLGovernanceLayer
 *
 * Enforces ML safety and governance:
 * 1. Confidence minimums — block predictions below threshold
 * 2. Drift detection — suppress drifting models
 * 3. Unsafe model blocking — prevent deployment of untested models
 * 4. Degraded-mode inference — fallback to deterministic when ML fails
 * 5. Rollback protection — auto-rollback on governance violations
 * 6. Model explainability — require explanation for all outputs
 *
 * INVARIANT: ML systems remain bounded, observable, and explainable.
 * No black-box intelligence. No uncontrolled autonomous reasoning.
 */
export class MLGovernanceLayer {
  private readonly store = new MongoModelState<GovernanceState>('ml_model_governance');

  private emptyState(modelId: string): GovernanceState {
    return { modelId, policies: [], blocked: false, totalViolations: 0, recentViolations: [] };
  }

  // Global thresholds
  private globalConfidenceMinimum: number;
  private globalLatencyMaximumMs: number;
  private globalErrorRateMaximum: number;
  private maxViolationsBeforeBlock: number;

  constructor(config?: {
    confidenceMinimum?: number;
    latencyMaximumMs?: number;
    errorRateMaximum?: number;
    maxViolationsBeforeBlock?: number;
  }) {
    this.globalConfidenceMinimum = config?.confidenceMinimum ?? 0.2;
    this.globalLatencyMaximumMs = config?.latencyMaximumMs ?? 5000;
    this.globalErrorRateMaximum = config?.errorRateMaximum ?? 0.1;
    this.maxViolationsBeforeBlock = config?.maxViolationsBeforeBlock ?? 5;

    logger.info('[MLGovernanceLayer] Initialized', {
      confidenceMinimum: this.globalConfidenceMinimum,
      latencyMaximumMs: this.globalLatencyMaximumMs,
    });
  }

  /**
   * Register a governance policy for a model.
   */
  async registerPolicy(policy: GovernancePolicy): Promise<void> {
    await this.store.update(policy.modelId, (state = this.emptyState(policy.modelId)) => ({
      ...state,
      policies: [...state.policies.filter(existing => existing.policyId !== policy.policyId), policy],
    }));
    logger.info(`[MLGovernance] Policy registered: ${policy.policyName} for model ${policy.modelId}`);
  }

  /**
   * Evaluate whether a prediction should be allowed.
   */
  async evaluatePrediction(prediction: PredictionSignals): Promise<GovernanceDecision> {
    let decision: GovernanceDecision | undefined;
    await this.store.update(prediction.modelId, (state = this.emptyState(prediction.modelId)) => {
      if (state.blocked) {
        decision = this.blockedDecision(prediction.modelId, []);
        return undefined;
      }

      decision = this.evaluatePolicies(prediction, state.policies);
      const { violations } = decision;
      if (violations.length === 0) return undefined;

      const recentViolations = [...this.recent(state), ...violations];
      const blocked = decision.action === 'block' || recentViolations.length >= this.maxViolationsBeforeBlock;
      if (blocked) decision = this.blockedDecision(prediction.modelId, violations);
      return {
        ...state,
        blocked,
        totalViolations: state.totalViolations + violations.length,
        recentViolations,
      };
    });
    return decision!;
  }

  private blockedDecision(modelId: string, violations: GovernanceViolation[]): GovernanceDecision {
    return {
      allowed: false,
      action: 'block',
      violations,
      explanation: [`Model ${modelId} is blocked due to governance violations`],
    };
  }

  private evaluatePolicies(prediction: PredictionSignals, policies: GovernancePolicy[]): GovernanceDecision {
    const violations: GovernanceViolation[] = [];
    const explanations: string[] = [];

    // 1. Global confidence minimum
    if (!Number.isFinite(prediction.confidence) || prediction.confidence < this.globalConfidenceMinimum) {
      violations.push({
        policyId: 'global_confidence',
        modelId: prediction.modelId,
        constraintType: 'confidence_minimum',
        threshold: this.globalConfidenceMinimum,
        actualValue: prediction.confidence,
        action: 'suppress',
        timestamp: new Date().toISOString(),
      });
      explanations.push(`Confidence ${prediction.confidence.toFixed(3)} below minimum ${this.globalConfidenceMinimum}`);
    }

    // 2. Latency check
    if (prediction.latencyMs > this.globalLatencyMaximumMs) {
      violations.push({
        policyId: 'global_latency',
        modelId: prediction.modelId,
        constraintType: 'latency_maximum',
        threshold: this.globalLatencyMaximumMs,
        actualValue: prediction.latencyMs,
        action: 'warn',
        timestamp: new Date().toISOString(),
      });
      explanations.push(`Latency ${prediction.latencyMs}ms exceeds maximum ${this.globalLatencyMaximumMs}ms`);
    }

    // 3. Check model-specific policies
    for (const policy of policies) {
      if (policy.modelId !== prediction.modelId || !policy.enabled) continue;

      for (const constraint of policy.constraints) {
        const currentValue = this.getConstraintValue(constraint.type, prediction);
        if (currentValue !== null && !this.checkConstraint(constraint, currentValue)) {
          violations.push({
            policyId: policy.policyId,
            modelId: policy.modelId,
            constraintType: constraint.type,
            threshold: constraint.threshold,
            actualValue: currentValue,
            action: policy.action,
            timestamp: new Date().toISOString(),
          });
          explanations.push(`Policy "${policy.policyName}": ${constraint.type} = ${currentValue.toFixed(3)}, threshold = ${constraint.threshold}`);
        }
      }
    }

    const action = this.determineAction(violations);
    return {
      allowed: action === 'allow' || action === 'warn',
      action,
      violations,
      explanation: explanations,
    };
  }

  /**
   * Check model safety before deployment.
   */
  checkModelSafety(metadata: ModelMetadata): ModelSafetyCheck {
    const concerns: string[] = [];

    // Must have evaluation metrics
    const metrics = metadata.evaluationMetrics;
    if (!metrics.ndcg && !metrics.f1 && !metrics.accuracy) {
      concerns.push('No evaluation metrics available — model not tested');
    }

    // Must not be drifting
    if (metadata.driftStatus === 'critical') {
      concerns.push('Model has critical drift — unsafe for deployment');
    }

    // Must have a version
    if (!metadata.version) {
      concerns.push('Model has no version — unversioned models cannot be governed');
    }

    // Must have a training dataset
    if (!metadata.trainingDatasetId) {
      concerns.push('No training dataset linked — lineage not traceable');
    }

    // Check quality thresholds
    if (metrics.accuracy !== undefined && metrics.accuracy < 0.5) {
      concerns.push(`Accuracy ${metrics.accuracy.toFixed(3)} below acceptable threshold (0.5)`);
    }
    if (metrics.f1 !== undefined && metrics.f1 < 0.3) {
      concerns.push(`F1 score ${metrics.f1.toFixed(3)} below acceptable threshold (0.3)`);
    }

    return {
      modelId: metadata.modelId,
      safe: concerns.length === 0,
      concerns,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Handle drift detection for a model.
   */
  async handleDrift(modelId: string, driftStatus: DriftStatus): Promise<GovernanceAction> {
    switch (driftStatus) {
      case 'stable':
        return 'allow';
      case 'drifting':
        logger.warn(`[MLGovernance] Model ${modelId} is drifting — monitoring`);
        return 'warn';
      case 'critical':
        logger.warn(`[MLGovernance] Model ${modelId} has critical drift — suppressing`);
        await this.store.update(modelId, (state = this.emptyState(modelId)) => ({ ...state, blocked: true }));
        return 'fallback_deterministic';
      default:
        return 'allow';
    }
  }

  /**
   * Unblock a model (after fixes).
   */
  async unblockModel(modelId: string): Promise<void> {
    await this.store.update(modelId, state => state && { ...state, blocked: false, recentViolations: [] });
    logger.info(`[MLGovernance] Model ${modelId} unblocked`);
  }

  async isModelBlocked(modelId: string): Promise<boolean> {
    return (await this.store.get(modelId))?.blocked ?? false;
  }

  /** Get violations from the rolling governance window. */
  async getViolations(modelId?: string): Promise<GovernanceViolation[]> {
    if (modelId !== undefined) {
      const state = await this.store.get(modelId);
      return state ? this.recent(state) : [];
    }
    return (await this.store.list()).flatMap(state => this.recent(state))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  async getStatus(): Promise<{
    totalPolicies: number;
    totalViolations: number;
    blockedModels: string[];
    recentViolations: GovernanceViolation[];
  }> {
    const states = await this.store.list();
    return {
      totalPolicies: states.reduce((total, state) => total + state.policies.length, 0),
      totalViolations: states.reduce((total, state) => total + state.totalViolations, 0),
      blockedModels: states.filter(state => state.blocked).map(state => state.modelId),
      recentViolations: states.flatMap(state => this.recent(state))
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp)).slice(-10),
    };
  }

  /**
   * Require explainability for a prediction.
   * Returns true if the prediction has sufficient explanation.
   */
  requireExplainability(prediction: MLPrediction): {
    explainable: boolean;
    missingElements: string[];
  } {
    const missing: string[] = [];

    if (prediction.featureImportance.length === 0) {
      missing.push('No feature importance available');
    }
    if (prediction.confidence === 0) {
      missing.push('Confidence is zero — prediction cannot be trusted');
    }
    if (prediction.evidenceCoverage < 0.1) {
      missing.push('Evidence coverage too low — prediction not well-grounded');
    }

    return { explainable: missing.length === 0, missingElements: missing };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private getConstraintValue(type: GovernanceConstraint['type'], prediction: PredictionSignals): number | null {
    switch (type) {
      case 'confidence_minimum': return prediction.confidence;
      case 'latency_maximum': return prediction.latencyMs;
      default: return null;
    }
  }

  private checkConstraint(constraint: GovernanceConstraint, currentValue: number): boolean {
    switch (constraint.type) {
      case 'confidence_minimum': return currentValue >= constraint.threshold;
      case 'latency_maximum': return currentValue <= constraint.threshold;
      case 'error_rate_maximum': return currentValue <= constraint.threshold;
      case 'drift_threshold': return currentValue <= constraint.threshold;
      case 'staleness_maximum': return currentValue <= constraint.threshold;
      default: return true;
    }
  }

  private determineAction(violations: GovernanceViolation[]): GovernanceAction {
    if (violations.length === 0) return 'allow';

    // Highest severity wins
    const actionPriority: GovernanceAction[] = [
      'block', 'rollback', 'fallback_deterministic', 'suppress', 'warn', 'allow',
    ];
    let worstAction: GovernanceAction = 'allow';

    for (const violation of violations) {
      const currentPriority = actionPriority.indexOf(violation.action);
      const worstPriority = actionPriority.indexOf(worstAction);
      if (currentPriority < worstPriority) worstAction = violation.action;
    }

    return worstAction;
  }

  private recent(state: GovernanceState): GovernanceViolation[] {
    const cutoff = Date.now() - VIOLATION_WINDOW_MS;
    return state.recentViolations.filter(violation => Date.parse(violation.timestamp) > cutoff);
  }
}
