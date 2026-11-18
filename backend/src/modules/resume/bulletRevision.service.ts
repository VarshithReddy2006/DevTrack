import { Types } from 'mongoose';
import jsonPatch from 'fast-json-patch';
import { ResumeBulletRevision, type IResumeBulletRevision } from '../../db/models/resumeBulletRevision.model.js';
import { ResumeVariant, type IBulletEdit } from '../../db/models/resumeVariant.model.js';
import { ResumeProfile } from '../../db/models/resumeProfile.model.js';
import { GenerateVariantRequestV2Schema } from './dto/index.js';
import { scoreBulletEdits } from './ats/bulletEditScoring.js';

export class BulletRevisionError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}

const notFound = () => new BulletRevisionError(404, 'RESUME_NOT_FOUND', 'Resume or revision not found');
const stale = () => new BulletRevisionError(409, 'REVISION_CONFLICT', 'Resume changed; reload before saving');
const clone = (edits: IBulletEdit[]): IBulletEdit[] => JSON.parse(JSON.stringify(edits));

function reconstruct(history: IResumeBulletRevision[], version: number): IBulletEdit[] {
  let state = clone(history[0]?.baseSnapshot ?? []);
  if (version === 0 && history[0]?.versionNumber === 1) return state;
  for (const revision of history) {
    state = jsonPatch.applyPatch(state, revision.patch, true, false).newDocument;
    if (revision.versionNumber === version) return state;
  }
  throw notFound();
}

export class BulletRevisionService {
  static async history(userId: string, resumeId: string) {
    // Read version and ledger from one snapshot during concurrent save/pruning.
    return ResumeVariant.db.transaction(async session => {
      const resume = await ResumeVariant.findOne({ _id: resumeId, userId }).session(session).lean();
      if (!resume) throw notFound();
      const revisions = await ResumeBulletRevision.find({ resumeId: resume._id, userId })
        .sort({ versionNumber: 1 }).session(session).lean();
      return { currentVersion: resume.bulletRevisionVersion ?? 0, revisions };
    }, { readConcern: { level: 'snapshot' } });
  }

  static async saveSection(userId: string, resumeId: string, sectionId: string, bullets: Omit<IBulletEdit, 'section'>[], expectedVersion: number) {
    const section = sectionId.trim().toLowerCase();
    return this.commit(userId, resumeId, expectedVersion, section, async before => {
      const kept = before.filter(bullet => bullet.section.toLowerCase() !== section);
      // Preserve the existing section order, including on restore and deletion.
      const position = before.findIndex(bullet => bullet.section.toLowerCase() === section);
      kept.splice(position < 0 ? kept.length : position, 0, ...bullets.map(bullet => ({ ...bullet, section })));
      return kept;
    });
  }

  // The existing variant-generation save creates a first whole-resume checkpoint.
  static async saveInitial(userId: string, resumeId: string, edits: IBulletEdit[]) {
    return this.commit(userId, resumeId, 0, '*', async () => edits);
  }

  static async restore(userId: string, resumeId: string, version: number, expectedVersion: number) {
    return this.commit(userId, resumeId, expectedVersion, undefined, async (before, history) => {
      // The first retained baseline lets a legacy variant undo its very first edit.
      if (version === 0) return reconstruct(history, 0);
      const target = history.find(revision => revision.versionNumber === version);
      if (!target) throw notFound();
      const state = reconstruct(history, version);
      if (target.sectionId === '*') return state;
      const kept = before.filter(bullet => bullet.section.toLowerCase() !== target.sectionId);
      const position = before.findIndex(bullet => bullet.section.toLowerCase() === target.sectionId);
      kept.splice(position < 0 ? kept.length : position, 0, ...state.filter(bullet => bullet.section.toLowerCase() === target.sectionId));
      return kept;
    }, version);
  }

  private static async commit(
    userId: string, resumeId: string, expectedVersion: number, sectionId: string | undefined,
    build: (before: IBulletEdit[], history: IResumeBulletRevision[]) => Promise<IBulletEdit[]>,
    restoredFrom?: number,
  ) {
    const owner = new Types.ObjectId(userId);
    const id = new Types.ObjectId(resumeId);
    return ResumeVariant.db.transaction(async session => {
      const resume = await ResumeVariant.findOne({ _id: id, userId: owner }).session(session);
      if (!resume) throw notFound();
      const current = resume.bulletRevisionVersion ?? 0;
      if (current !== expectedVersion) throw stale();
      const history = await ResumeBulletRevision.find({ resumeId: id, userId: owner })
        .sort({ versionNumber: 1 }).session(session).lean();
      const before = clone(resume.bulletEdits ?? []);
      const built = await build(before, history);
      const after = GenerateVariantRequestV2Schema.parse({ roleType: resume.roleType, bulletEdits: built }).bulletEdits ?? [];
      const patch = jsonPatch.compare(before, after);
      // A restore is always recorded, even when restoring the current content.
      if (!patch.length && restoredFrom === undefined) return resume;
      const profile = await ResumeProfile.findOne({ _id: resume.resumeProfileId, userId: owner }).session(session).lean();
      if (!profile) throw notFound();
      const atsScore = scoreBulletEdits(after, { targetRole: profile.targetRole, keywords: resume.prioritizedSkills });
      const versionNumber = current + 1;
      const updated = await ResumeVariant.findOneAndUpdate({
        _id: id, userId: owner,
        ...(current === 0 ? { $or: [{ bulletRevisionVersion: 0 }, { bulletRevisionVersion: { $exists: false } }] } : { bulletRevisionVersion: current }),
      }, { $set: { bulletEdits: after, atsScore, bulletRevisionVersion: versionNumber } }, { session, new: true, runValidators: true });
      if (!updated) throw stale();
      await ResumeBulletRevision.create([{
        userId: owner, resumeId: id, sectionId: sectionId ?? (restoredFrom === 0 ? '*' : history.find(revision => revision.versionNumber === restoredFrom)!.sectionId),
        versionNumber, patch, inversePatch: jsonPatch.compare(after, before), atsScore: atsScore.score,
        ...(history.length ? {} : { baseSnapshot: before }),
        ...(restoredFrom === undefined ? {} : { restoredFrom }),
      }], { session });
      if (history.length >= 50) {
        // Move the baseline forward before deleting its patch, keeping all retained
        // versions reconstructible. The ledger, resume and pruning commit together.
        const removeCount = history.length - 49;
        const baseSnapshot = reconstruct(history, history[removeCount - 1].versionNumber);
        await ResumeBulletRevision.updateOne({ _id: history[removeCount]._id }, { $set: { baseSnapshot } }, { session });
        await ResumeBulletRevision.deleteMany({ _id: { $in: history.slice(0, removeCount).map(revision => revision._id) } }, { session });
      }
      return updated;
    }, { readConcern: { level: 'snapshot' } });
  }
}
