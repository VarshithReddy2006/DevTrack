import { Project } from '../../../db/models/project.model.js';
import { VerifiedProject } from '../../../db/models/verifiedProject.model.js';
import { VerifiedProjectIngestionService } from './VerifiedProjectIngestionService.js';

/**
 * Verified projects that currently count toward readiness, shaped for the intelligence engines.
 *
 * A record counts when it is verified and either has no provenance (legacy rows) or its
 * provenance still points at the user's current GitHub contributor and a live sync/link.
 * Every readiness engine reads projects through here so they agree on what "active" means.
 */
export async function getActiveVerifiedProjects(userId: string): Promise<any[]> {
  const contributorId = await VerifiedProjectIngestionService.ingest(userId);
  const records = await VerifiedProject.find({ userId, 'verification.status': 'verified' }).lean();

  const linkedIds = records.flatMap(record =>
    record.provenance?.linkedRepoUrl && record.projectId ? [record.projectId] : []
  );
  const links = linkedIds.length
    ? await Project.find({ userId, _id: { $in: linkedIds } }).select('repoUrl').lean()
    : [];
  const repoByProjectId = new Map(links.map(link => [String(link._id), link.repoUrl]));

  return records
    .filter(record => {
      const source = record.provenance;
      if (!source) return true;
      return Boolean(contributorId && source.contributorId === contributorId
        && (source.discoveredBySync || (source.linkedRepoUrl
          && repoByProjectId.get(String(record.projectId)) === source.linkedRepoUrl)));
    })
    .map(project => ({
      ...project,
      commitCount: project.metrics?.userCommitCount ?? 0,
      lastCommitAt: project.metrics?.lastCommitAt,
      isFork: project.provenance?.isFork ?? project.verification.checks?.notFork === false,
      fileCount: project.provenance?.fileCount ?? 0,
      files: project.provenance?.files ?? [],
      fileStructure: project.provenance?.files ?? [],
      hasDocumentation: project.provenance?.files?.some(file => /(^|\/)readme/i.test(file)) ?? false,
      hasTests: project.provenance?.hasTests ?? false,
    }));
}
