import type { IPublicProfile } from '../../db/models/publicProfile.model.js';
import type { IUserSettings } from '../../db/models/userSettings.model.js';

/**
 * Which parts of a published profile may be shown. A section needs the owner's publication
 * opt-in and must not be switched off in privacy settings. Everything public, including the
 * OG image, goes through this one rule.
 */
export function visibleSections(
  profile: Pick<IPublicProfile, 'sections'>,
  privacy?: Partial<IUserSettings['privacy']>,
) {
  const { sections } = profile;
  return {
    streak: sections?.streak === true && privacy?.showStreak !== false,
    github: sections?.github === true && privacy?.showGithub !== false,
    dsa: sections?.dsa === true && privacy?.showDsaProgress !== false,
    projects: sections?.projects === true && privacy?.showProjects !== false,
    activity: sections?.activity === true && privacy?.showActivity !== false,
  };
}
