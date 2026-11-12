// src/modules/recommendations/engines/credibilityReasoner.ts
import { Schema } from 'mongoose';
import { IntelligenceRecommendation } from '../../../db/models/intelligenceRecommendation.model.js';
import { ResumeEvidenceClaim } from '../../../db/models/resumeEvidenceClaim.model.js';

export class CredibilityReasoner {
  
  static async analyze(userId: string | Schema.Types.ObjectId, resumeProfileId: string | Schema.Types.ObjectId): Promise<void> {
    const claims = await ResumeEvidenceClaim.find({ userId, resumeProfileId });
    if (!claims || claims.length === 0) return;

    let hasDistributedSystems = false;
    let hasDeploymentEvidence = false;
    let hasObservability = false;

    // Analyze claims and their evidence
    for (const claim of claims) {
      const text = claim.claimText.toLowerCase();
      
      // Detect architectural claims
      if (text.includes('microservices') || text.includes('kafka') || text.includes('rabbitmq') || text.includes('redis')) {
        hasDistributedSystems = true;
      }
      
      // Check provenance for actual deployment or infra
      if (claim.provenance.includes('infra') || claim.provenance.includes('github')) {
        if (text.includes('deploy') || text.includes('kubernetes') || text.includes('docker') || text.includes('aws') || text.includes('gcp')) {
          hasDeploymentEvidence = true;
        }
        if (text.includes('datadog') || text.includes('prometheus') || text.includes('grafana') || text.includes('observability')) {
          hasObservability = true;
        }
      }

      // Generate recommendation for unverified claims
      if (claim.verificationStatus === 'unverified' || claim.verificationStatus === 'flagged') {
         // Confidence calculation based on missing provenance
         const confidence = claim.provenance.length === 0 ? 95 : 75;
         
         await IntelligenceRecommendation.create({
          userId,
          resumeProfileId,
          category: 'credibility',
          title: `Unsupported Claim Detected`,
          content: `You claim: "${claim.claimText}", but this is unsupported by any verifiable GitHub or Infrastructure evidence. A senior engineer reading this will question its authenticity. Provide concrete metrics or links.`,
          confidence,
          impact: {
            scoreImprovement: 8,
            type: 'credibility'
          },
          evidenceReferences: [claim._id.toString()]
        });
      }
    }

    // High level engineering reasoning
    if (hasDistributedSystems && !hasDeploymentEvidence) {
      // Dynamic confidence: highly confident if zero infra claims exist across the entire resume
      const totalInfraClaims = claims.filter(c => c.provenance.includes('infra')).length;
      const confidence = totalInfraClaims === 0 ? 98 : 85;

      await IntelligenceRecommendation.create({
        userId,
        resumeProfileId,
        category: 'infrastructure',
        title: `Missing Infrastructure Validation`,
        content: `Your resume references distributed systems architecture, but there is no deployment evidence, containerization evidence, or infrastructure orchestration evidence. Explain how these systems were deployed and scaled.`,
        confidence,
        impact: {
          scoreImprovement: 15,
          type: 'credibility'
        },
        evidenceReferences: ['system_level_reasoning_infra']
      });
    }

    if (hasDistributedSystems && !hasObservability) {
      const confidence = hasDeploymentEvidence ? 90 : 70; // if they don't even have deployment, observability is a secondary gap

      await IntelligenceRecommendation.create({
        userId,
        resumeProfileId,
        category: 'infrastructure',
        title: `Missing Observability Instrumentation`,
        content: `Your distributed queue orchestration claims are unsupported by observability instrumentation signals. Production distributed systems require tracing or monitoring. Mention how you monitored these queues.`,
        confidence,
        impact: {
          scoreImprovement: 10,
          type: 'credibility'
        },
        evidenceReferences: ['system_level_reasoning']
      });
    }
  }
}
