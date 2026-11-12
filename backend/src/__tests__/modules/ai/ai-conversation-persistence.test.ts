import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { AIConversationService } from '../../../modules/ai/conversation/AIConversationService.js';
import { AIConversation } from '../../../db/models/aiConversation.model.js';
import { AIProviderAdapter } from '../../../modules/ai/provider/AIProviderAdapter.js';
import { ReadinessContextBuilder } from '../../../modules/ai/context/ReadinessContextBuilder.js';

vi.mock('../../../modules/ai/provider/AIProviderAdapter.js', () => ({
  AIProviderAdapter: {
    generateResponse: vi.fn().mockImplementation(async (req: any) => ({
      content: `Answer to: ${req.prompt.split('\n')[0]}`,
      provider: 'mock-llm',
      model: 'mock-model-v1',
      tokensUsed: 42,
      latency: 15,
      cached: false,
    })),
  },
}));

vi.mock('../../../modules/ai/context/ReadinessContextBuilder.js', () => ({
  ReadinessContextBuilder: {
    buildContext: vi.fn().mockResolvedValue({
      readinessSummary: {
        overallScore: 75,
        dsaScore: 80,
        skillsScore: 70,
        projectsScore: 65,
        infrastructureScore: 60,
        roadmapProgress: 50,
        confidenceScore: 85,
        evidenceCoverage: 80,
      },
      progressionState: {
        currentState: 'Advanced Candidate',
        readinessForNextState: 60,
        requirements: ['System Design', 'Concurrency'],
      },
      providerFreshness: { staleProviders: [] },
      evidenceChains: [],
      roadmapGaps: [],
      recommendations: [],
      momentumSignals: { insights: [] },
    }),
  },
}));

describe('Issue #141: AI Conversation Persistence & Multi-Turn Guidance', () => {
  const userIdA = new Types.ObjectId().toString();
  const userIdB = new Types.ObjectId().toString();
  const threadId = 'copilot-thread-141';

  beforeEach(async () => {
    vi.clearAllMocks();
    await AIConversation.deleteMany({});
    AIConversationService.clearAllHistory();
  });

  it('persists question and answer turns to MongoDB and in-memory cache', async () => {
    const response = await AIConversationService.processQuestion({
      userId: userIdA,
      question: 'How can I improve my DSA score?',
      threadId,
      contextType: 'copilot',
    });

    expect(response.answer).toBeDefined();
    expect(response.threadId).toBe(threadId);

    // Verify MongoDB document was persisted
    const doc = await AIConversation.findOne({
      userId: new Types.ObjectId(userIdA),
      threadId,
    });
    expect(doc).not.toBeNull();
    expect(doc?.messages).toHaveLength(2);
    expect(doc?.messages[0].role).toBe('user');
    expect(doc?.messages[0].content).toBe('How can I improve my DSA score?');
    expect(doc?.messages[1].role).toBe('assistant');
  });

  it('includes prior turns in multi-turn conversation context', async () => {
    // First turn
    await AIConversationService.processQuestion({
      userId: userIdA,
      question: 'Turn 1 question',
      threadId,
    });

    // Second turn
    const secondTurn = await AIConversationService.processQuestion({
      userId: userIdA,
      question: 'Turn 2 question',
      threadId,
    });

    expect(secondTurn).toBeDefined();

    // Verify history now has 4 turns (2 user, 2 assistant)
    const history = await AIConversationService.getConversationHistory(userIdA, threadId);
    expect(history).toHaveLength(4);
    expect(history[0].content).toBe('Turn 1 question');
    expect(history[2].content).toBe('Turn 2 question');
  });

  it('enforces strict userId ownership preventing cross-user thread access', async () => {
    // User A creates conversation
    await AIConversationService.processQuestion({
      userId: userIdA,
      question: 'User A secret prompt',
      threadId,
    });

    // User B attempts to read threadId
    const userBHistory = await AIConversationService.getConversationHistory(userIdB, threadId);
    expect(userBHistory).toEqual([]);

    // Clear history for User B should not affect User A
    await AIConversationService.clearConversationHistory(userIdB, threadId);
    const userAHistory = await AIConversationService.getConversationHistory(userIdA, threadId);
    expect(userAHistory).toHaveLength(2);
  });

  it('clears conversation history completely from database and cache', async () => {
    await AIConversationService.processQuestion({
      userId: userIdA,
      question: 'Will be deleted',
      threadId,
    });

    await AIConversationService.clearConversationHistory(userIdA, threadId);

    const history = await AIConversationService.getConversationHistory(userIdA, threadId);
    expect(history).toEqual([]);

    const doc = await AIConversation.findOne({
      userId: new Types.ObjectId(userIdA),
      threadId,
    });
    expect(doc).toBeNull();
  });
});
