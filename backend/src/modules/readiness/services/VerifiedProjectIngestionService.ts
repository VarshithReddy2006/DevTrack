import { clerkClient } from '@clerk/express';
import { Types } from 'mongoose';
import { PlatformStats } from '../../../db/models/platformStats.model.js';
import { Project } from '../../../db/models/project.model.js';
import { User } from '../../../db/models/user.model.js';
import { VerifiedProject } from '../../../db/models/verifiedProject.model.js';
import { getReadinessProjectsQueue } from '../../../shared/jobs/queueFactory.js';
import { logger } from '../../../shared/logger.js';
import { fetchGitHubRepositoryEvidence, parseGitHubRepositoryUrl } from '../../projects/project-github-sync.js';

async function getGitHubContributor(userId: string) {
  const user = await User.findById(userId).select('clerkId').lean();
  if (!user) return undefined;
  const clerkUser = await clerkClient.users.getUser(user.clerkId);
  const account = clerkUser.externalAccounts.find(account =>
    (account.provider === 'github' || account.provider === 'oauth_github')
    && account.verification?.status === 'verified' && account.username && account.providerUserId
  );
  return account?.username ? { id: account.providerUserId, username: account.username } : undefined;
}

type RepositoryLink = { repoUrl: string; projectId?: Types.ObjectId; discoveredBySync?: boolean };

export const VerifiedProjectIngestionService = {
  async ingest(userId: string, projectId?: Types.ObjectId): Promise<string | undefined> {
    const projects = await Project.find({
      userId,
      ...(projectId ? { _id: projectId } : {}),
      repoUrl: { $type: 'string' },
    }).sort({ _id: 1 }).select('repoUrl').lean();
    const links: RepositoryLink[] = projects.flatMap(project =>
      project.repoUrl ? [{ repoUrl: project.repoUrl, projectId: project._id }] : []
    );

    const stats = projectId ? null : await PlatformStats.findOne({ userId, platformName: 'github' })
      .select('username rawData.repository_urls').lean();
    const urls = stats?.rawData?.repository_urls;
    if (!links.length && (!Array.isArray(urls) || !urls.length)) return;

    const contributor = await getGitHubContributor(userId);
    if (contributor && Array.isArray(urls) && stats?.username.toLowerCase() === contributor.username.toLowerCase()) {
      for (const url of urls) {
        if (typeof url === 'string') links.push({ repoUrl: url });
      }
    }

    const syncedUrls = new Set(links.filter(link => !link.projectId)
      .map(link => link.repoUrl.toLowerCase()));
    const seen = new Set<string>();
    const failures: unknown[] = [];
    for (const link of links) {
      const repository = parseGitHubRepositoryUrl(link.repoUrl);
      if (!repository) continue;
      const key = `${repository.owner}/${repository.name}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const discoveredBySync = syncedUrls.has(link.repoUrl.toLowerCase())
          || syncedUrls.has(`https://github.com/${key}`);
        if (!projectId && await VerifiedProject.exists({
          userId, repoFullName: key,
          'provenance.checkedAccountId': contributor?.id ?? null,
          ...(discoveredBySync ? { 'provenance.discoveredBySync': true } : {}),
          'provenance.checkedAt': { $gte: new Date(Date.now() - 86_400_000) },
          ...(link.projectId ? { projectId: link.projectId } : {}),
        })) continue;
        await this.ingestRepository(userId, { ...link, discoveredBySync }, repository, contributor);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'GitHub repository evidence ingestion failed');
    return contributor?.id;
  },

  async ingestRepository(
    userId: string,
    link: RepositoryLink,
    repository: NonNullable<ReturnType<typeof parseGitHubRepositoryUrl>>,
    contributor: Awaited<ReturnType<typeof getGitHubContributor>>,
  ): Promise<void> {
    const lookupStartedAt = new Date();
    const evidence = await fetchGitHubRepositoryEvidence(repository, contributor);
    if (!evidence) {
      await VerifiedProject.deleteOne({
        userId,
        repoFullName: `${repository.owner}/${repository.name}`.toLowerCase(),
        'provenance.source': 'github',
        'provenance.checkedAt': { $lte: lookupStartedAt },
      });
      return;
    }
    const filter = { userId, githubRepoId: evidence.githubRepoId };
    const checkedAt = new Date();
    const isVerified = Boolean(evidence.contributorId && !evidence.isFork && !evidence.isArchived);
    if (link.projectId && !await Project.exists({ _id: link.projectId, userId, repoUrl: link.repoUrl })) return;

    const evidenceUpdate = {
      repoFullName: evidence.repoFullName.toLowerCase(),
      repoUrl: evidence.repoUrl,
      name: evidence.name,
      description: evidence.description,
      techStack: Object.keys(evidence.languages),
      'metrics.primaryLanguage': evidence.primaryLanguage,
      'metrics.languages': evidence.languages,
      'metrics.repoAgeInDays': evidence.repoAgeInDays,
      'metrics.stars': evidence.stars,
      'metrics.forks': evidence.forks,
      'metrics.totalCommitCount': evidence.totalCommitCount,
      'metrics.userCommitCount': evidence.userCommitCount,
      'metrics.lastCommitAt': evidence.lastCommitAt,
      'verification.status': isVerified ? 'verified' : 'pending',
      'verification.verifiedAt': isVerified ? checkedAt : null,
      'verification.checks.notFork': !evidence.isFork,
      'verification.checks.notEmpty': evidence.totalCommitCount > 0,
      'verification.checks.notArchived': !evidence.isArchived,
      'verification.checks.userIsContributor': Boolean(evidence.contributorId),
      'provenance.source': 'github',
      'provenance.checkedAt': checkedAt,
      'provenance.contributorId': evidence.contributorId ?? null,
      'provenance.checkedAccountId': contributor?.id ?? null,
      'provenance.isFork': evidence.isFork,
      'provenance.isArchived': evidence.isArchived,
      'provenance.fileCount': evidence.fileCount,
      'provenance.files': evidence.files,
      'provenance.hasTests': evidence.hasTests,
      'provenance.hasCI': evidence.hasCI,
      ...(link.projectId ? { projectId: link.projectId, 'provenance.linkedRepoUrl': link.repoUrl } : {}),
      ...(link.discoveredBySync ? { 'provenance.discoveredBySync': true } : {}),
    };

    // Existing records may have been verified or rejected through a separate process.
    const automated = { ...filter, 'provenance.source': 'github' };
    try {
      await VerifiedProject.updateOne(automated, { $set: evidenceUpdate }, {
        upsert: true, runValidators: true,
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      // Another sync inserted the repository, or the unique key belongs to a legacy record.
      await VerifiedProject.updateOne(automated, { $set: evidenceUpdate }, { runValidators: true });
    }
  },

  async ingestAfterChange(userId: string, projectId: Types.ObjectId): Promise<void> {
    try {
      await this.ingest(userId, projectId);
    } catch (error) {
      logger.warn('GitHub repository evidence refresh failed', { userId, projectId, error });
    }
    await this.queueRefresh(userId);
  },

  async queueRefresh(userId: string): Promise<void> {
    try {
      await getReadinessProjectsQueue().add('refresh-project-readiness', { userId });
    } catch (error) {
      logger.warn('Project readiness enqueue failed', { userId, error });
    }
  },
};
