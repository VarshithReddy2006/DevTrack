export class CosineSimilarityEngine {
  /**
   * Cosine similarity in [-1, 1].
   *
   * Never emits NaN and never produces a non-finite score. Returns a safe 0
   * when either input is empty, has mismatched length, contains non-finite
   * values (NaN / Infinity / -Infinity), has zero L2 norm, or would overflow
   * accumulation to a non-finite intermediate. Output is clamped to [-1, 1]
   * to absorb floating-point overshoot.
   */
  calculateSimilarity(vecA: number[], vecB: number[]): number {
    if (!Array.isArray(vecA) || !Array.isArray(vecB)) return 0;
    if (vecA.length === 0 || vecB.length === 0) return 0;
    if (vecA.length !== vecB.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      const a = vecA[i];
      const b = vecB[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
      dotProduct += a * b;
      normA += a * a;
      normB += b * b;
    }

    // Guard against accumulation overflow to non-finite intermediates.
    if (!Number.isFinite(dotProduct) || !Number.isFinite(normA) || !Number.isFinite(normB)) return 0;
    if (normA === 0 || normB === 0) return 0;

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (!Number.isFinite(denominator) || denominator === 0) return 0;

    const similarity = dotProduct / denominator;
    if (!Number.isFinite(similarity)) return 0;

    return Math.max(-1, Math.min(1, similarity));
  }
}
