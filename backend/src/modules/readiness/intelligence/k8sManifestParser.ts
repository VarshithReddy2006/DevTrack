import { parseAllDocuments } from 'yaml';
import { MAX_MANIFEST_BYTES } from './manifestParsers.js';

export interface KubernetesManifestSignals {
  isKubernetesManifest: boolean;
  hasResourceLimits: boolean;
  hasResourceRequests: boolean;
  hasHighAvailability: boolean;
  hasHealthProbes: boolean;
  hasAutoscaling: boolean;
  hasIngressTLS: boolean;
}

const EMPTY_SIGNALS: KubernetesManifestSignals = {
  isKubernetesManifest: false,
  hasResourceLimits: false,
  hasResourceRequests: false,
  hasHighAvailability: false,
  hasHealthProbes: false,
  hasAutoscaling: false,
  hasIngressTLS: false,
};

const KUBERNETES_KINDS = new Set([
  'ConfigMap', 'CronJob', 'DaemonSet', 'Deployment', 'HorizontalPodAutoscaler', 'Ingress',
  'Job', 'NetworkPolicy', 'PersistentVolume', 'PersistentVolumeClaim', 'Pod', 'ReplicaSet',
  'ReplicationController', 'Secret', 'Service', 'StatefulSet',
]);
const REPLICATED_KINDS = new Set(['Deployment', 'ReplicaSet', 'ReplicationController', 'StatefulSet']);

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasEntries(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
}

function inspectResource(resource: unknown, signals: KubernetesManifestSignals): void {
  if (!isRecord(resource)) return;
  if (resource.kind === 'List' && Array.isArray(resource.items)) {
    resource.items.forEach(item => inspectResource(item, signals));
    return;
  }

  const kind = typeof resource.kind === 'string' ? resource.kind : '';
  if (!KUBERNETES_KINDS.has(kind)) return;
  signals.isKubernetesManifest = true;

  const spec = isRecord(resource.spec) ? resource.spec : {};
  if (REPLICATED_KINDS.has(kind) && Number(spec.replicas) > 1) {
    signals.hasHighAvailability = true;
  }
  if (kind === 'HorizontalPodAutoscaler') signals.hasAutoscaling = true;
  if (kind === 'Ingress' && hasEntries(spec.tls)) signals.hasIngressTLS = true;

  const seen = new WeakSet<object>();
  let visited = 0;
  const visit = (value: unknown, depth: number): void => {
    if (!isRecord(value) && !Array.isArray(value)) return;
    if (depth > 40 || visited++ > 100_000 || seen.has(value)) return;
    seen.add(value);

    if (isRecord(value)) {
      if (hasEntries(value.podAntiAffinity)) signals.hasHighAvailability = true;
      if (hasEntries(value.livenessProbe) || hasEntries(value.readinessProbe)) signals.hasHealthProbes = true;

      const resources = isRecord(value.resources) ? value.resources : {};
      if (hasEntries(resources.limits)) signals.hasResourceLimits = true;
      if (hasEntries(resources.requests)) signals.hasResourceRequests = true;

      Object.values(value).forEach(child => visit(child, depth + 1));
      return;
    }
    value.forEach(child => visit(child, depth + 1));
  };
  visit(resource, 0);
}

/** Parses Kubernetes YAML documents and extracts reliability and scaling evidence. */
export function parseKubernetesManifest(content: unknown): KubernetesManifestSignals {
  if (typeof content !== 'string' || content.length > MAX_MANIFEST_BYTES) return { ...EMPTY_SIGNALS };

  const signals = { ...EMPTY_SIGNALS };
  try {
    const documents = parseAllDocuments(content, { merge: true });
    for (const document of documents) {
      if (document.errors.length > 0) continue;
      const value = document.toJS({ maxAliasCount: 100 });
      if (!isRecord(value) || typeof value.apiVersion !== 'string') continue;
      inspectResource(value, signals);
    }
  } catch {
    return { ...EMPTY_SIGNALS };
  }
  return signals;
}
