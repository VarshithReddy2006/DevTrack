// ============================================================================
// modelIndexes.test.ts — each Mongoose index is declared once
// ============================================================================
// Mongoose logs "Duplicate schema index on {...}" at startup, and MongoDB refuses
// a second index on the same keys with different options, when a field says
// `index: true` (or `unique: true`) and the schema also calls `schema.index()` for
// the same keys. This loads every model and fails if any model lists the same index
// keys twice. It needs no database connection.
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

// Importing a model registers it with mongoose. Keep one line per file in src/db/models.
import '../../db/models/activityEvent.model.js';
import '../../db/models/aiConversation.model.js';
import '../../db/models/aiResponseAuditLog.model.js';
import '../../db/models/analyticsEvent.model.js';
import '../../db/models/atsAnalysis.model.js';
import '../../db/models/behavioralTelemetry.model.js';
import '../../db/models/betaCohort.model.js';
import '../../db/models/betaUser.model.js';
import '../../db/models/careerIntent.model.js';
import '../../db/models/connectedPlatform.model.js';
import '../../db/models/dailyActivity.model.js';
import '../../db/models/dailyChallenge.model.js';
import '../../db/models/datasetIngestion.model.js';
import '../../db/models/deadLetterJob.model.js';
import '../../db/models/dsaContest.model.js';
import '../../db/models/dsaProblem.model.js';
import '../../db/models/dsaProfile.model.js';
import '../../db/models/dsaSubmission.model.js';
import '../../db/models/dsaTopicProgress.model.js';
import '../../db/models/embedding.model.js';
import '../../db/models/evidenceChainRecord.model.js';
import '../../db/models/featureUsageAnalytics.model.js';
import '../../db/models/fineTuneRun.model.js';
import '../../db/models/focusSession.model.js';
import '../../db/models/intelligenceRecommendation.model.js';
import '../../db/models/mlBaseline.model.js';
import '../../db/models/mlExperiment.model.js';
import '../../db/models/mission.model.js';
import '../../db/models/notification.model.js';
import '../../db/models/onboardingAnalytics.model.js';
import '../../db/models/platformStats.model.js';
import '../../db/models/processedEvent.model.js';
import '../../db/models/profileAuditLog.model.js';
import '../../db/models/profileTimelineEvent.model.js';
import '../../db/models/profileView.model.js';
import '../../db/models/project.model.js';
import '../../db/models/projectTask.model.js';
import '../../db/models/publicProfile.model.js';
import '../../db/models/readinessBenchmarks.model.js';
import '../../db/models/readinessCore.model.js';
import '../../db/models/readinessDsa.model.js';
import '../../db/models/readinessProjects.model.js';
import '../../db/models/readinessRoadmap.model.js';
import '../../db/models/readinessSkills.model.js';
import '../../db/models/readinessSnapshotRecord.model.js';
import '../../db/models/recommendation.model.js';
import '../../db/models/recommendationMemory.model.js';
import '../../db/models/resumeCredibility.model.js';
import '../../db/models/resumeEvidenceClaim.model.js';
import '../../db/models/resumeExport.model.js';
import '../../db/models/resumeProfile.model.js';
import '../../db/models/resumeSession.model.js';
import '../../db/models/resumeVariant.model.js';
import '../../db/models/resumeVersion.model.js';
import '../../db/models/semanticAnalysis.model.js';
import '../../db/models/sessionReplay.model.js';
import '../../db/models/syncJob.model.js';
import '../../db/models/unifiedRuntimeState.model.js';
import '../../db/models/user.model.js';
import '../../db/models/userAnalytics.model.js';
import '../../db/models/userDailyChallenge.model.js';
import '../../db/models/userFeedback.model.js';
import '../../db/models/userProfile.model.js';
import '../../db/models/userSettings.model.js';
import '../../db/models/userSkillProgress.model.js';
import '../../db/models/userStreakLog.model.js';
import '../../db/models/userXp.model.js';
import '../../db/models/verifiedProject.model.js';
import '../../db/models/xpTransaction.model.js';

describe('Mongoose model indexes', () => {
  it('loads every model file in src/db/models', () => {
    const here = readFileSync(path.resolve('src/__tests__/db/modelIndexes.test.ts'), 'utf8');
    const files = readdirSync(path.resolve('src/db/models')).filter((f) => f.endsWith('.model.ts'));
    const missing = files.filter((f) => !here.includes(`/db/models/${f.replace(/\.ts$/, '.js')}'`));
    expect(missing, 'add an import for these model files at the top of this test').toEqual([]);
  });

  it('defines each index once per model', () => {
    const duplicates: string[] = [];
    for (const name of mongoose.modelNames()) {
      const seen = new Map<string, number>();
      for (const [keys] of mongoose.model(name).schema.indexes()) {
        const key = JSON.stringify(keys);
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      for (const [key, count] of seen) {
        if (count > 1) duplicates.push(`${name} ${key} x${count}`);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
