import { Types } from 'mongoose';
import { IntelligenceRecommendation } from '../../../db/models/intelligenceRecommendation.model.js';
import { IntelligentRecommendationEngine } from '../recommendation/IntelligentRecommendationEngine.js';
import { RecommendationMemory } from '../recommendation/RecommendationMemory.js';
import { RecommendationLifecycleEngine } from '../recommendation/RecommendationLifecycleEngine.js';
import { logger } from '../../../shared/logger.js';

export interface TestResult {
  testName: string;
  passed: boolean;
  message: string;
  details?: any;
}

export interface TestSuite {
  suiteName: string;
  tests: TestResult[];
  passedCount: number;
  failedCount: number;
  duration: number;
}

class RecommendationStabilityTestsClass {
  /**
   * Run all recommendation stability and consistency tests
   */
  async runAllTests(): Promise<TestSuite[]> {
    logger.info('[RecommendationStabilityTests] Running all recommendation stability tests');
    
    const startTime = Date.now();
    const suites: TestSuite[] = [];
    
    // Test suite 1: Recommendation consistency
    suites.push(await this.testRecommendationConsistency());
    
    // Test suite 2: Recommendation memory stability
    suites.push(await this.testRecommendationMemoryStability());
    
    // Test suite 3: Recommendation lifecycle tracking
    suites.push(await this.testRecommendationLifecycleTracking());
    
    // Test suite 4: Recommendation uniqueness
    suites.push(await this.testRecommendationUniqueness());
    
    // Test suite 5: Confidence scoring consistency
    suites.push(await this.testConfidenceScoringConsistency());
    
    const totalDuration = Date.now() - startTime;
    logger.info('[RecommendationStabilityTests] All tests completed', { 
      totalDuration,
      totalSuites: suites.length 
    });
    
    return suites;
  }

  /**
   * Test recommendation consistency
   */
  private async testRecommendationConsistency(): Promise<TestSuite> {
    const startTime = Date.now();
    const tests: TestResult[] = [];
    const testUserId = 'test-user-consistency';
    
    try {
      // Generate recommendations twice with same input
      const input = { userId: testUserId, maxRecommendations: 5 };
      
      const firstRun = await IntelligentRecommendationEngine.generateRecommendations(input);
      const secondRun = await IntelligentRecommendationEngine.generateRecommendations(input);
      
      // Check if same number of recommendations
      const countMatch = firstRun.length === secondRun.length;
      tests.push({
        testName: 'Recommendation count consistency',
        passed: countMatch,
        message: countMatch 
          ? 'Both runs generated same number of recommendations' 
          : `Count mismatch: ${firstRun.length} vs ${secondRun.length}`,
      });
      
      // Check if recommendation IDs are unique within each run
      const firstRunUnique = new Set(firstRun.map(r => r.recommendationId)).size === firstRun.length;
      const secondRunUnique = new Set(secondRun.map(r => r.recommendationId)).size === secondRun.length;
      tests.push({
        testName: 'Recommendation ID uniqueness',
        passed: firstRunUnique && secondRunUnique,
        message: firstRunUnique && secondRunUnique
          ? 'All recommendation IDs are unique'
          : 'Duplicate recommendation IDs detected',
      });
      
      // Check if priority levels are valid
      const validPriorities = ['critical', 'high', 'medium', 'low'];
      const firstRunValidPriorities = firstRun.every(r => validPriorities.includes(r.priority));
      const secondRunValidPriorities = secondRun.every(r => validPriorities.includes(r.priority));
      tests.push({
        testName: 'Priority level validity',
        passed: firstRunValidPriorities && secondRunValidPriorities,
        message: firstRunValidPriorities && secondRunValidPriorities
          ? 'All priority levels are valid'
          : 'Invalid priority levels detected',
      });
      
      // Check if confidence scores are in valid range
      const validConfidence = firstRun.every(r => r.confidence >= 0 && r.confidence <= 100) &&
                              secondRun.every(r => r.confidence >= 0 && r.confidence <= 100);
      tests.push({
        testName: 'Confidence score range',
        passed: validConfidence,
        message: validConfidence
          ? 'All confidence scores are in valid range (0-100)'
          : 'Confidence scores outside valid range detected',
      });
      
    } catch (error) {
      tests.push({
        testName: 'Recommendation consistency',
        passed: false,
        message: `Test failed with error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
    
    const passedCount = tests.filter(t => t.passed).length;
    const failedCount = tests.length - passedCount;
    
    return {
      suiteName: 'Recommendation Consistency',
      tests,
      passedCount,
      failedCount,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Test recommendation memory stability
   */
  private async testRecommendationMemoryStability(): Promise<TestSuite> {
    const startTime = Date.now();
    const tests: TestResult[] = [];
    const testUserId = 'test-user-memory';
    
    try {
      // Clear memory for test user
      RecommendationMemory.clear();
      
      // Add a recommendation to memory
      const testRec = {
        recommendationId: 'test-rec-1',
        userId: testUserId,
        type: 'dsa',
        title: 'Test recommendation',
        state: 'active' as const,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        priority: 'high' as const,
        metadata: {},
      };
      
      RecommendationMemory.addRecommendation(testRec);
      
      // Retrieve active recommendations
      const activeRecs = RecommendationMemory.getActiveRecommendations(testUserId);
      
      // Check if recommendation was added
      tests.push({
        testName: 'Recommendation memory add',
        passed: activeRecs.length === 1,
        message: activeRecs.length === 1
          ? 'Recommendation successfully added to memory'
          : 'Recommendation not found in memory',
      });
      
      // Test cooldown check
      const shouldRegenerate = RecommendationMemory.shouldRegenerateRecommendation(testUserId, 'dsa', 'Test recommendation');
      tests.push({
        testName: 'Recommendation cooldown',
        passed: !shouldRegenerate,
        message: !shouldRegenerate
          ? 'Cooldown correctly prevents regeneration'
          : 'Cooldown not working as expected',
      });
      
      // Test completion tracking
      RecommendationMemory.markAsCompleted('test-rec-1', 85);
      const completedRec = RecommendationMemory.getActiveRecommendations(testUserId);
      tests.push({
        testName: 'Recommendation completion tracking',
        passed: completedRec.length === 0,
        message: completedRec.length === 0
          ? 'Completed recommendation removed from active list'
          : 'Completed recommendation still in active list',
      });
      
      // Test history tracking
      const history = RecommendationMemory.getHistory(testUserId);
      tests.push({
        testName: 'Recommendation history tracking',
        passed: history !== undefined && history.completedRecommendations === 1,
        message: history !== undefined && history.completedRecommendations === 1
          ? 'History correctly tracks completed recommendations'
          : 'History tracking not working as expected',
      });
      
    } catch (error) {
      tests.push({
        testName: 'Recommendation memory stability',
        passed: false,
        message: `Test failed with error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
    
    const passedCount = tests.filter(t => t.passed).length;
    const failedCount = tests.length - passedCount;
    
    return {
      suiteName: 'Recommendation Memory Stability',
      tests,
      passedCount,
      failedCount,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Test recommendation lifecycle tracking
   */
  private async testRecommendationLifecycleTracking(): Promise<TestSuite> {
    const startTime = Date.now();
    const tests: TestResult[] = [];
    const userId = new Types.ObjectId().toString();
    const recommendationId = new Types.ObjectId().toString();

    try {
      const lifecycle = await IntelligenceRecommendation.create({
        _id: recommendationId, userId, resumeProfileId: new Types.ObjectId(),
        category: 'ats', title: 'Test lifecycle', content: 'Test recommendation',
      });
      tests.push({
        testName: 'Lifecycle creation',
        passed: lifecycle.state === 'active',
        message: 'Checks initial recommendation state',
      });

      const accepted = await RecommendationLifecycleEngine.recordAction(recommendationId, userId, 'accept');
      tests.push({
        testName: 'Lifecycle event recording',
        passed: accepted.state === 'accepted',
        message: 'Checks that acceptance updates the persisted state',
      });

      await RecommendationLifecycleEngine.setEffectivenessScore(recommendationId, userId, 90);
      const scored = await RecommendationLifecycleEngine.getLifecycle(recommendationId, userId);
      tests.push({
        testName: 'Effectiveness scoring',
        passed: scored?.effectivenessScore === 90,
        message: 'Checks persisted effectiveness',
      });

      const metrics = await RecommendationLifecycleEngine.getMetrics(userId);
      tests.push({
        testName: 'Lifecycle metrics calculation',
        passed: metrics.totalRecommendations === 1 && metrics.acceptanceRate === 100,
        message: 'Checks scoped metrics',
      });
    } catch (error) {
      tests.push({
        testName: 'Recommendation lifecycle tracking',
        passed: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      await IntelligenceRecommendation.deleteOne({ _id: recommendationId, userId });
    }

    const passedCount = tests.filter(t => t.passed).length;
    const failedCount = tests.length - passedCount;
    
    return {
      suiteName: 'Recommendation Lifecycle Tracking',
      tests,
      passedCount,
      failedCount,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Test recommendation uniqueness
   */
  private async testRecommendationUniqueness(): Promise<TestSuite> {
    const startTime = Date.now();
    const tests: TestResult[] = [];
    const testUserId = 'test-user-uniqueness';
    
    try {
      // Generate recommendations
      const recommendations = await IntelligentRecommendationEngine.generateRecommendations({
        userId: testUserId,
        maxRecommendations: 10,
      });
      
      // Check for duplicate IDs
      const ids = recommendations.map(r => r.recommendationId);
      const uniqueIds = new Set(ids);
      tests.push({
        testName: 'Recommendation ID uniqueness',
        passed: uniqueIds.size === ids.length,
        message: uniqueIds.size === ids.length
          ? 'All recommendation IDs are unique'
          : `Duplicate IDs found: ${ids.length - uniqueIds.size} duplicates`,
      });
      
      // Check for duplicate titles
      const titles = recommendations.map(r => r.title.toLowerCase());
      const uniqueTitles = new Set(titles);
      tests.push({
        testName: 'Recommendation title uniqueness',
        passed: uniqueTitles.size === titles.length,
        message: uniqueTitles.size === titles.length
          ? 'All recommendation titles are unique'
          : `Duplicate titles found: ${titles.length - uniqueTitles.size} duplicates`,
      });
      
      // Check for duplicate evidence chains
      const evidenceChains = recommendations.map(r => JSON.stringify(r.evidenceChain));
      const uniqueChains = new Set(evidenceChains);
      tests.push({
        testName: 'Evidence chain uniqueness',
        passed: uniqueChains.size === evidenceChains.length,
        message: uniqueChains.size === evidenceChains.length
          ? 'All evidence chains are unique'
          : `Duplicate evidence chains found: ${evidenceChains.length - uniqueChains.size} duplicates`,
      });
      
    } catch (error) {
      tests.push({
        testName: 'Recommendation uniqueness',
        passed: false,
        message: `Test failed with error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
    
    const passedCount = tests.filter(t => t.passed).length;
    const failedCount = tests.length - passedCount;
    
    return {
      suiteName: 'Recommendation Uniqueness',
      tests,
      passedCount,
      failedCount,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Test confidence scoring consistency
   */
  private async testConfidenceScoringConsistency(): Promise<TestSuite> {
    const startTime = Date.now();
    const tests: TestResult[] = [];
    const testUserId = 'test-user-confidence';
    
    try {
      // Generate recommendations
      const recommendations = await IntelligentRecommendationEngine.generateRecommendations({
        userId: testUserId,
        maxRecommendations: 5,
      });
      
      // Check if all confidence scores are in valid range
      const allValid = recommendations.every(r => r.confidence >= 0 && r.confidence <= 100);
      tests.push({
        testName: 'Confidence score range validation',
        passed: allValid,
        message: allValid
          ? 'All confidence scores are in valid range (0-100)'
          : 'Confidence scores outside valid range detected',
      });
      
      // Check if confidence scores correlate with priority
      const criticalRecs = recommendations.filter(r => r.priority === 'critical');
      const highRecs = recommendations.filter(r => r.priority === 'high');
      const avgCriticalConfidence = criticalRecs.length > 0 
        ? criticalRecs.reduce((sum, r) => sum + r.confidence, 0) / criticalRecs.length 
        : 0;
      const avgHighConfidence = highRecs.length > 0 
        ? highRecs.reduce((sum, r) => sum + r.confidence, 0) / highRecs.length 
        : 0;
      
      // Critical recommendations should have higher confidence on average
      const confidenceCorrelation = criticalRecs.length > 0 && highRecs.length > 0
        ? avgCriticalConfidence >= avgHighConfidence
        : true; // Skip test if not enough data
      tests.push({
        testName: 'Confidence-priority correlation',
        passed: confidenceCorrelation,
        message: confidenceCorrelation
          ? 'Confidence scores correlate with priority levels'
          : 'Confidence scores do not correlate with priority levels',
      });
      
      // Check if confidence scores are consistent with evidence chain length
      const evidenceCorrelation = recommendations.every(r => {
        const evidenceLength = r.evidenceChain.length;
        // More evidence should generally mean higher confidence
        return evidenceLength > 0 ? r.confidence > 50 : true;
      });
      tests.push({
        testName: 'Confidence-evidence correlation',
        passed: evidenceCorrelation,
        message: evidenceCorrelation
          ? 'Confidence scores correlate with evidence chain length'
          : 'Confidence scores do not correlate with evidence',
      });
      
    } catch (error) {
      tests.push({
        testName: 'Confidence scoring consistency',
        passed: false,
        message: `Test failed with error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
    
    const passedCount = tests.filter(t => t.passed).length;
    const failedCount = tests.length - passedCount;
    
    return {
      suiteName: 'Confidence Scoring Consistency',
      tests,
      passedCount,
      failedCount,
      duration: Date.now() - startTime,
    };
  }
}

export const RecommendationStabilityTests = new RecommendationStabilityTestsClass();
