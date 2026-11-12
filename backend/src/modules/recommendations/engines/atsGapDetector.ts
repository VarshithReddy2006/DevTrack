// src/modules/recommendations/engines/atsGapDetector.ts
import { ATSAnalysis } from '../../../db/models/atsAnalysis.model.js';
import { Schema, type Types } from 'mongoose';
import { saveGeneratedRecommendation } from '../../../db/models/intelligenceRecommendation.model.js';

export class ATSGapDetectionEngine {
  
  static async analyze(userId: string | Schema.Types.ObjectId, resumeProfileId: string | Schema.Types.ObjectId): Promise<Types.ObjectId[]> {
    const ids: Types.ObjectId[] = [];
    const analysis = await ATSAnalysis.findOne({ userId, resumeProfileId }).sort({ createdAt: -1 });
    if (!analysis) return ids;

    // Detect missing keywords
    for (const keyword of analysis.keywordCoverage) {
      if (!keyword.found) {
        ids.push(await saveGeneratedRecommendation({
          userId,
          resumeProfileId,
          category: 'ats',
          title: `Missing Critical Keyword: ${keyword.keyword}`,
          content: `Your resume is missing the keyword "${keyword.keyword}" which is highly expected for this role. ATS systems will penalize this omission. Add it contextually to your experience or skills section.`,
          confidence: 90,
          impact: {
            scoreImprovement: 5,
            type: 'ats'
          },
          evidenceReferences: [`keyword_missing_${keyword.keyword}`]
        }));
      }
    }

    // Detect formatting warnings
    for (const warning of analysis.formattingWarnings) {
      if (warning.impact === 'high' || warning.impact === 'medium') {
         ids.push(await saveGeneratedRecommendation({
          userId,
          resumeProfileId,
          category: 'ats',
          title: `ATS Formatting Issue: ${warning.type}`,
          content: `Detected formatting issue in ${warning.location}: ${warning.message}. This reduces parsing reliability. Use standard headers and bullet points.`,
          confidence: 85,
          impact: {
            scoreImprovement: warning.impact === 'high' ? 8 : 4,
            type: 'ats'
          },
          evidenceReferences: [`formatting_warning_${warning.type}`]
        }));
      }
    }
    
    // Detect parser warnings
    for (const warning of analysis.parserWarnings) {
      if (warning.severity === 'critical') {
         ids.push(await saveGeneratedRecommendation({
          userId,
          resumeProfileId,
          category: 'ats',
          title: `Critical ATS Parsing Failure`,
          content: `Parser failed at section ${warning.section}: ${warning.message}. ${warning.suggestion}`,
          confidence: 95,
          impact: {
            scoreImprovement: 10,
            type: 'ats'
          },
          evidenceReferences: [`parser_warning_${warning.section}`]
        }));
      }
    }
    
    // Check section integrity
    for (const section of analysis.sectionIntegrity) {
      if (!section.detected) {
        ids.push(await saveGeneratedRecommendation({
          userId,
          resumeProfileId,
          category: 'ats',
          title: `Missing Section: ${section.sectionName}`,
          content: `Standard ATS parsers could not find a "${section.sectionName}" section. This is a severe omission. Add a clearly labeled ${section.sectionName} section.`,
          confidence: 98,
          impact: {
            scoreImprovement: 15,
            type: 'ats'
          },
          evidenceReferences: [`section_missing_${section.sectionName}`]
        }));
      }
    }
    return ids;
  }
}
