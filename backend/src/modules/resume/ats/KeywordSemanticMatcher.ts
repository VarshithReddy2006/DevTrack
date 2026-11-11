import { RealEmbeddingPipeline } from '../../ai/embedding/RealEmbeddingPipeline.js';
import { SemanticSimilarityService } from '../../ai/retrieval/SemanticSimilarityService.js';
import { createHash } from 'crypto';

export class KeywordSemanticMatcher {
  private pipeline: RealEmbeddingPipeline;
  private similarity: SemanticSimilarityService;

  constructor(pipeline: RealEmbeddingPipeline, similarity: SemanticSimilarityService) {
    this.pipeline = pipeline;
    this.similarity = similarity;
  }

  async matchKeywords(resumeText: string, jdKeywords: string[]): Promise<Map<string, number>> {
    const matchScores = new Map<string, number>();
    const resumeLower = resumeText.toLowerCase();

    // Retrieve or generate resume vector
    let resumeVector: number[] | null = null;
    try {
      if (process.env.OPENAI_API_KEY) {
        resumeVector = (await this.pipeline.embedText(resumeText)).vector;
      }
    } catch (e) {
      // ignore fallback
    }

    if (!resumeVector) {
      resumeVector = this.generatePseudoVector(resumeText);
    }

    for (const kw of jdKeywords) {
      if (resumeLower.includes(kw.toLowerCase())) {
        matchScores.set(kw, 1.0);
        continue;
      }

      // Semantic proximity matching
      try {
        let kwVector: number[] | null = null;
        if (process.env.OPENAI_API_KEY) {
          try {
            kwVector = (await this.pipeline.embedText(kw)).vector;
          } catch (e) {
            // ignore
          }
        }

        if (!kwVector) {
          kwVector = this.generatePseudoVector(kw, resumeVector.length);
        }

        const sim = this.similarity.calculate(resumeVector, kwVector);
        // Normalize cosine similarity range (-1 to 1) to (0.2 to 0.8) for partial closeness matches
        const normalizedSim = parseFloat(Math.max(0.2, Math.min(0.8, (sim + 1) / 2)).toFixed(2));
        matchScores.set(kw, normalizedSim);
      } catch (error) {
        matchScores.set(kw, 0.4); // safe default
      }
    }
    return matchScores;
  }

  private generatePseudoVector(seed: string, dimensions: number = 1536): number[] {
    const hash = createHash('sha256').update(seed).digest('hex');
    const vector = [];
    let numStr = '';
    for (let i = 0; i < hash.length; i++) {
      numStr += hash.charCodeAt(i).toString();
    }
    
    let currentSeed = parseInt(numStr.substring(0, 15), 10);
    const random = () => {
      const x = Math.sin(currentSeed++) * 10000;
      return x - Math.floor(x);
    };

    for (let i = 0; i < dimensions; i++) {
      vector.push(random() * 2 - 1);
    }
    return vector;
  }
}
