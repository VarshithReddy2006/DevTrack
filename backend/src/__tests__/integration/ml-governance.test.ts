import { describe, expect, it, vi } from 'vitest';
import { MLGovernanceLayer } from '../../modules/ml/governance/MLGovernanceLayer.js';
import { MLInferenceRuntime } from '../../modules/ml/inference/MLInferenceRuntime.js';
import { ModelRegistryEngine } from '../../modules/ml/registry/ModelRegistryEngine.js';
import type { InferenceRequest, InferenceResult, ModelMetadata } from '../../modules/ml/types.js';

const model: ModelMetadata = {
  modelId: 'test-model-v1',
  modelName: 'test-model',
  modelType: 'classifier',
  version: '1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  trainingDatasetId: 'test-dataset',
  evaluationMetrics: { accuracy: 0.9, logloss: 0.2 },
  status: 'ready',
  driftStatus: 'stable',
  deploymentState: 'staged',
  checkpointPath: 'test-checkpoint',
  tags: [],
};

const request: InferenceRequest = {
  requestId: 'test-request',
  modelId: model.modelId,
  input: [1],
  priority: 'normal',
  timeout: 1000,
};

function result(probability = 0.9, modelVersion = model.version): InferenceResult {
  const timestamp = new Date().toISOString();
  return {
    requestId: request.requestId,
    modelId: model.modelId,
    prediction: { label: 'test', probability, confidence: probability, allLabels: [], modelId: model.modelId, modelVersion, latencyMs: 1, timestamp },
    cached: false,
    latencyMs: 1,
    timestamp,
  };
}

function registerProvider(runtime: MLInferenceRuntime, prediction = result()) {
  const execute = vi.fn(async () => prediction);
  runtime.registerProvider({ name: 'test', priority: 1, isHealthy: () => true, execute });
  return execute;
}

describe('persistent ML governance', () => {
  it('preserves promotion, evaluation and rollback across registry instances', async () => {
    const writer = new ModelRegistryEngine();
    const reader = new ModelRegistryEngine();
    await writer.register({ ...model, deploymentState: 'production' }, { accuracy: 0.8, logloss: 0.3 });

    expect(await reader.getProductionModel(model.modelName)).toBeNull();
    expect(await writer.promote(model.modelId, 'production')).toBe(true);
    await reader.register(model);
    expect(await reader.getProductionModel(model.modelName)).toMatchObject({
      checkpointPath: model.checkpointPath,
      evaluationGate: { passed: true, requiredMetrics: { accuracy: 0.8, logloss: 0.3 } },
    });

    await reader.updateDriftStatus(model.modelId, 'critical');
    expect(await writer.getModel(model.modelId)).toMatchObject({
      driftStatus: 'critical',
      deploymentState: 'rolled-back',
      rollbackHistory: [{ fromState: 'production', reason: 'Critical drift detected' }],
    });
  });

  it.each([{ accuracy: 0.95 }, { f1: 0.5 }])('rejects unmet or missing metrics %o', async gate => {
    await new ModelRegistryEngine().register(model, gate);
    const registry = new ModelRegistryEngine();
    expect(await registry.getModel(model.modelId)).toMatchObject({ evaluationGate: { passed: false } });
    expect(await registry.promote(model.modelId, 'canary')).toBe(false);
  });

  it('persists policies, concurrent violation counts, blocks and unblocks', async () => {
    const first = new MLGovernanceLayer({ maxViolationsBeforeBlock: 2 });
    const second = new MLGovernanceLayer({ maxViolationsBeforeBlock: 2 });
    await first.registerPolicy({
      policyId: 'test-confidence',
      policyName: 'Test confidence minimum',
      modelId: model.modelId,
      enabled: true,
      action: 'suppress',
      constraints: [{ type: 'confidence_minimum', threshold: 0.8 }],
    });

    const signals = { modelId: model.modelId, confidence: 0.6, latencyMs: 1 };
    const decisions = await Promise.all([first.evaluatePrediction(signals), second.evaluatePrediction(signals)]);
    expect(decisions.map(decision => decision.action).sort()).toEqual(['block', 'suppress']);
    const fresh = new MLGovernanceLayer();
    expect(await fresh.isModelBlocked(model.modelId)).toBe(true);
    expect(await fresh.getStatus()).toMatchObject({ totalPolicies: 1, totalViolations: 2, blockedModels: [model.modelId] });
    expect(await fresh.getViolations(model.modelId)).toHaveLength(2);

    await fresh.unblockModel(model.modelId);
    expect(await first.isModelBlocked(model.modelId)).toBe(false);
    expect(await second.evaluatePrediction(signals)).toMatchObject({ allowed: false, action: 'suppress' });
  });

  it('checks promotion and persisted blocks before calling providers, including in batches', async () => {
    const registry = new ModelRegistryEngine();
    const governance = new MLGovernanceLayer();
    const runtime = new MLInferenceRuntime({ maxBatchSize: 1 }, { registry, governance });
    const execute = registerProvider(runtime);

    expect((await runtime.infer(request)).prediction.modelVersion).toBe('degraded');
    await registry.register(model);
    expect((await runtime.inferBatch(request)).prediction.modelVersion).toBe('degraded');
    expect(execute).not.toHaveBeenCalled();

    expect(await registry.promote(model.modelId, 'production')).toBe(true);
    expect((await runtime.infer(request)).prediction.modelVersion).toBe(model.version);
    await new MLGovernanceLayer().handleDrift(model.modelId, 'critical');
    expect((await runtime.infer(request)).prediction.modelVersion).toBe('degraded');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('suppresses low confidence and mismatched versions without retrying or tripping the circuit', async () => {
    const registry = new ModelRegistryEngine();
    await registry.register(model);
    await registry.promote(model.modelId, 'production');
    const governance = new MLGovernanceLayer();
    const runtime = new MLInferenceRuntime({ circuitBreakerThreshold: 1 }, { registry, governance });
    const execute = registerProvider(runtime, result(0.1));
    expect((await runtime.infer(request)).prediction.modelVersion).toBe('degraded');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus().circuitBreakerOpen).toBe(false);

    const mismatched = new MLInferenceRuntime({}, { registry, governance });
    registerProvider(mismatched, result(0.9, 'unregistered-version'));
    expect((await mismatched.infer(request)).prediction.modelVersion).toBe('degraded');
    expect(await governance.getViolations(model.modelId)).toHaveLength(1);
  });

  it('discards an in-flight result after another instance blocks the model', async () => {
    const runtime = new MLInferenceRuntime({}, { governance: new MLGovernanceLayer() });
    runtime.registerProvider({
      name: 'test',
      priority: 1,
      isHealthy: () => true,
      execute: async () => {
        await new MLGovernanceLayer().handleDrift(model.modelId, 'critical');
        return result();
      },
    });

    expect((await runtime.infer(request)).prediction.modelVersion).toBe('degraded');
  });

  it('uses degraded inference when governance storage is unavailable', async () => {
    const governance = new MLGovernanceLayer();
    vi.spyOn(governance, 'isModelBlocked').mockRejectedValue(new Error('Database unavailable'));
    const runtime = new MLInferenceRuntime({}, { governance });
    const execute = registerProvider(runtime);
    expect((await runtime.infer(request)).prediction.modelVersion).toBe('degraded');
    expect(execute).not.toHaveBeenCalled();
  });
});
