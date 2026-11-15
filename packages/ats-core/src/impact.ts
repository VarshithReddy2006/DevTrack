const impactMetric = /(?:[$€£]\s*\d|\b\d[\d,.]*\s*(?:%|[x×](?!\w)|(?:ms|seconds?|minutes?|hours?|days?|users?|requests?|customers?|tickets?|projects?|deployments?|transactions?)\b))/i;

export function analyzeQuantifiedImpact(bullets: readonly string[]): boolean[] {
  return bullets.map(bullet => impactMetric.test(bullet));
}
