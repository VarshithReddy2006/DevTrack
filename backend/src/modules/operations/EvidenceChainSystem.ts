import { randomUUID } from 'node:crypto';
import { EvidenceChainRecord } from '../../db/models/evidenceChainRecord.model.js';

export interface EvidenceNode {
  evidenceId: string;
  source: string; // e.g., 'leetcode-submission', 'github-commit', 'dependency'
  type: 'dsa' | 'skill' | 'project' | 'roadmap' | 'benchmark';
  timestamp: Date;
  data: any;
  confidence: number; // 0-100
}

export interface EvidenceLink {
  insightId: string;
  insightType: string; // e.g., 'topic-mastery', 'skill-verification', 'project-credibility'
  evidenceIds: string[];
  reasoning: string;
  contributionWeight: number; // How much this evidence contributes to the insight
}

export interface EvidenceChain {
  chainId: string;
  userId: string;
  rootInsight: string; // e.g., 'overall-readiness-score'
  nodes: EvidenceNode[];
  links: EvidenceLink[];
  createdAt: Date;
  isComplete: boolean;
}

export class EvidenceChainSystemClass {
  async createChain(userId: string, rootInsight: string): Promise<EvidenceChain> {
    const chain: EvidenceChain = {
      chainId: randomUUID(),
      userId,
      rootInsight,
      nodes: [],
      links: [],
      createdAt: new Date(),
      isComplete: false,
    };
    await EvidenceChainRecord.create(chain);
    return chain;
  }

  async addEvidenceNode(
    chainId: string,
    source: string,
    type: EvidenceNode['type'],
    data: unknown,
    confidence: number,
  ): Promise<EvidenceNode> {
    const node: EvidenceNode = { evidenceId: randomUUID(), source, type, timestamp: new Date(), data, confidence };
    const result = await EvidenceChainRecord.updateOne({ chainId }, { $push: { nodes: node } });
    if (!result.matchedCount) throw new Error(`Chain not found: ${chainId}`);
    return node;
  }

  async linkEvidenceToInsight(
    chainId: string,
    insightId: string,
    insightType: string,
    evidenceIds: string[],
    reasoning: string,
    contributionWeight: number,
  ): Promise<EvidenceLink> {
    const link: EvidenceLink = { insightId, insightType, evidenceIds, reasoning, contributionWeight };
    const result = await EvidenceChainRecord.updateOne({ chainId }, { $push: { links: link } });
    if (!result.matchedCount) throw new Error(`Chain not found: ${chainId}`);
    return link;
  }

  async markChainComplete(chainId: string): Promise<void> {
    const result = await EvidenceChainRecord.updateOne({ chainId }, { $set: { isComplete: true } });
    if (!result.matchedCount) throw new Error(`Chain not found: ${chainId}`);
  }

  async getChain(chainId: string): Promise<EvidenceChain | undefined> {
    return (await EvidenceChainRecord.findOne({ chainId }, { _id: 0 }).lean()) ?? undefined;
  }

  async getUserChains(userId: string): Promise<EvidenceChain[]> {
    return EvidenceChainRecord.find({ userId }, { _id: 0 }).sort({ createdAt: -1, _id: -1 }).lean();
  }

  async getEvidenceForInsight(insightId: string): Promise<EvidenceNode[]> {
    return (await this.explainInsight(insightId)).evidence;
  }

  async explainInsight(insightId: string): Promise<{
    insightId: string;
    evidence: EvidenceNode[];
    reasoning: string[];
    totalConfidence: number;
  }> {
    const chains = await EvidenceChainRecord.find({ 'links.insightId': insightId }, { userId: 1, links: 1 }).lean();
    const links = chains.flatMap(chain => chain.links
      .filter(link => link.insightId === insightId)
      .map(link => ({ userId: chain.userId, link })));

    const ids = [...new Set(links.flatMap(({ link }) => link.evidenceIds))];
    const sources = ids.length ? await EvidenceChainRecord.find(
      { 'nodes.evidenceId': { $in: ids }, userId: { $in: chains.map(chain => chain.userId) } },
      { userId: 1, nodes: 1 },
    ).lean() : [];
    const nodes = new Map(sources.flatMap(chain => chain.nodes.map(
      node => [node.evidenceId, { userId: chain.userId, node }] as const,
    )));
    const evidence = new Map<string, EvidenceNode>();
    let totalConfidence = 0;
    let totalWeight = 0;
    for (const { userId, link } of links) {
      const matchingNodes = link.evidenceIds.flatMap(id => {
        const match = nodes.get(id);
        return match?.userId === userId ? [match.node] : [];
      });
      for (const node of matchingNodes) evidence.set(node.evidenceId, node);
      const confidence = matchingNodes.reduce((sum, node) => sum + node.confidence, 0);
      totalConfidence += (confidence / Math.max(1, matchingNodes.length)) * link.contributionWeight;
      totalWeight += link.contributionWeight;
    }

    return {
      insightId,
      evidence: [...evidence.values()],
      reasoning: links.map(({ link }) => link.reasoning),
      totalConfidence: totalWeight > 0 ? Math.round(totalConfidence / totalWeight) : 0,
    };
  }

  async getAuditTrail(userId: string): Promise<{
    chains: EvidenceChain[];
    totalEvidence: number;
    totalLinks: number;
    averageConfidence: number;
  }> {
    const chains = await this.getUserChains(userId);
    const nodes = chains.flatMap(chain => chain.nodes);
    return {
      chains,
      totalEvidence: nodes.length,
      totalLinks: chains.reduce((sum, chain) => sum + chain.links.length, 0),
      averageConfidence: Math.round(nodes.reduce((sum, node) => sum + node.confidence, 0) / Math.max(1, nodes.length)),
    };
  }

  async getStats(): Promise<{
    totalChains: number;
    totalEvidenceNodes: number;
    totalLinks: number;
    completedChains: number;
    averageChainSize: number;
  }> {
    const [counts] = await EvidenceChainRecord.aggregate<{
      totalChains: number;
      totalEvidenceNodes: number;
      totalLinks: number;
      completedChains: number;
    }>([
      {
        $group: {
          _id: null,
          totalChains: { $sum: 1 },
          totalEvidenceNodes: { $sum: { $size: '$nodes' } },
          totalLinks: { $sum: { $size: '$links' } },
          completedChains: { $sum: { $cond: ['$isComplete', 1, 0] } },
        },
      },
      { $project: { _id: 0 } },
    ]);
    return {
      ...counts ?? { totalChains: 0, totalEvidenceNodes: 0, totalLinks: 0, completedChains: 0 },
      averageChainSize: counts ? Math.round(counts.totalEvidenceNodes / counts.totalChains) : 0,
    };
  }
}

export const EvidenceChainSystem = new EvidenceChainSystemClass();
