import { Types } from 'mongoose';
import { VerifiedProject } from '../../../db/models/verifiedProject.model.js';
import { PlatformStats } from '../../../db/models/platformStats.model.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import type { IEvidenceSource } from '../../../db/models/resumeEvidenceClaim.model.js';
import { parseGitHubRepositoryUrl } from '../../projects/project-github-sync.js';

export interface ResolvedEvidence {
  sourceModel: 'VerifiedProject' | 'PlatformStats' | 'ResumeSession';
  sourceId: string;
}

function repositoryKey(url: string): string | undefined {
  const repo = parseGitHubRepositoryUrl(url);
  return repo ? `${repo.owner}/${repo.name}`.toLowerCase() : undefined;
}

function isProjectReference(source: IEvidenceSource): boolean {
  return source.type === 'github' || source.type === 'project' || source.type === 'infra';
}

export class ClaimLineageResolver {
  async forUser(userId: Types.ObjectId, sources: IEvidenceSource[]) {
    const sessionIds = [...new Set(sources
      .filter(source => source.referenceType === 'resumeSession')
      .map(source => source.referenceId))];
    const [projects, stats, sessions] = await Promise.all([
      sources.some(isProjectReference)
        ? VerifiedProject.find({ userId, 'verification.status': 'verified' })
          .select('_id githubRepoId repoUrl').lean()
        : [],
      sources.some(source => source.type === 'dsa')
        ? PlatformStats.find({ userId, platformName: { $ne: 'github' } }).select('_id').lean()
        : [],
      sessionIds.length
        ? ResumeSession.find({
          userId,
          currentStage: 'COMPLETED',
          $or: [
            { sessionId: { $in: sessionIds } },
            { _id: { $in: sessionIds.filter(id => /^[a-f0-9]{24}$/i.test(id)) } },
          ],
        }).select('_id sessionId').lean()
        : [],
    ]);

    const projectIds = new Set(projects.map(project => String(project._id)));
    const githubIds = new Map(projects.map(project => [project.githubRepoId, String(project._id)]));
    const repositoryUrls = new Map(projects.map(project => [repositoryKey(project.repoUrl), String(project._id)]));
    repositoryUrls.delete(undefined);
    const platformIds = new Set(stats.map(stat => String(stat._id)));
    const resumeIds = new Set(sessions.map(session => String(session._id)));
    const resumeSessionIds = new Map(sessions.map(session => [session.sessionId, String(session._id)]));

    return (claimSources: IEvidenceSource[]): ResolvedEvidence[] => claimSources.flatMap<ResolvedEvidence>(source => {
      const { type, referenceId, referenceType } = source;
      const objectId = referenceId.toLowerCase();
      if (referenceType === 'resumeSession') {
        const sourceId = resumeIds.has(objectId) ? objectId : resumeSessionIds.get(referenceId);
        return sourceId ? [{ sourceModel: 'ResumeSession', sourceId }] : [];
      }

      if (type === 'dsa' && referenceType === 'platformStats' && platformIds.has(objectId)) {
        return [{ sourceModel: 'PlatformStats', sourceId: objectId }];
      }

      if (!isProjectReference(source)) return [];
      let sourceId: string | undefined;
      if (referenceType === 'verifiedProject') sourceId = projectIds.has(objectId) ? objectId : undefined;
      else if (referenceType === 'githubRepository') sourceId = githubIds.get(referenceId);
      else sourceId = repositoryUrls.get(repositoryKey(referenceId));
      return sourceId ? [{ sourceModel: 'VerifiedProject', sourceId }] : [];
    });
  }
}
