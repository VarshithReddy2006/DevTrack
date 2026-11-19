import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { PageShell } from '../components/layout/PageShell';
import { ProfileHeader } from '../components/profile/ProfileHeader';
import { PersonalInfoCard } from '../components/profile/PersonalInfoCard';
import { CareerGoalsCard } from '../components/profile/CareerGoalsCard';
import { CPProfilesCard } from '../components/profile/CPProfilesCard';
import { LeetCodeStatsCard, CodeforcesStatsCard, CodeChefStatsCard, GithubStatsCard } from '../components/profile/PlatformStatsCard';
import { ProfileAchievementsCard } from '../components/profile/ProfileAchievementsCard';
import { SocialProfilesCard } from '../components/profile/SocialProfilesCard';
import { useProfileStore } from '../store/profileStore';
import { useLogout } from '../hooks/useLogout';
import { useDashboardData } from '../hooks/useDashboardData';
import { Icon } from '../components/shared/Icon';
import { getPublicProfile } from '../services/profileService';
import '../components/profile/ProfilePage.css';
import { DEFAULT_PROFILE, EMPTY_PLATFORM_STATE } from '../types/profile.types';
import { PUBLICATION_SECTIONS, type PublicPortfolioTheme, type PublicationSection } from '../services/publicationService';

interface ProfilePageProps {
  isPublicView?: boolean;
}

const ProfilePage: React.FC<ProfilePageProps> = ({ isPublicView = false }) => {
  const { username } = useParams<{ username: string }>();
  const { logout, isLoggingOut } = useLogout('/');
  const {
    profile,
    leetcode,
    codeforces,
    codechef,
    github,
    syncState,
    syncMessage,
    lastSyncedAt,
    isDirty,
    isSaving,
    saveError,
    isLoading: isProfileLoading,
    fetchProfile,
    saveProfile,
    updateField,
    addTechStack,
    removeTechStack,
    fetchAllPlatforms,
    populateFromDashboard,
  } = useProfileStore();

  const { data: dashboard, loading: dashLoading } = useDashboardData();
  const [publicProfile, setPublicProfile] = React.useState<any>(null);
  const [isPublicLoading, setIsPublicLoading] = React.useState(isPublicView);

  React.useEffect(() => {
    if (isPublicView && username) {
      setIsPublicLoading(true);
      getPublicProfile(username)
        .then(res => setPublicProfile(res.data.data))
        .catch(err => console.error('Failed to load public profile:', err))
        .finally(() => setIsPublicLoading(false));
    } else if (!isPublicView) {
      fetchProfile();
    }
  }, [isPublicView, username, fetchProfile]);

  React.useEffect(() => {
    if (!isPublicView && dashboard?.platformStats) {
      populateFromDashboard(dashboard.platformStats, dashboard.githubStats);
    }
  }, [isPublicView, dashboard?.platformStats, dashboard?.githubStats, populateFromDashboard]);

  // Derived active values depending on view mode
  const activeProfile = React.useMemo(() => {
    if (isPublicView && publicProfile) {
      return {
        ...DEFAULT_PROFILE,
        fullName: publicProfile.identity?.displayName || publicProfile.username,
        bio: '',
        role: publicProfile.identity?.levelName || 'Engineer',
      };
    }
    return profile;
  }, [isPublicView, publicProfile, profile]);

  const activeLeetcode = React.useMemo(() => {
    if (isPublicView && publicProfile) {
      const lc = publicProfile.dsa?.platformBreakdown?.find((p: any) => p.platform === 'leetcode');
      const state = EMPTY_PLATFORM_STATE<any>();
      if (lc) {
        state.data = { solvedProblem: lc.solved, contestRating: lc.rating || 0 };
      }
      return state;
    }
    return leetcode;
  }, [isPublicView, publicProfile, leetcode]);

  const activeCodeforces = React.useMemo(() => {
    if (isPublicView && publicProfile) {
      const cf = publicProfile.dsa?.platformBreakdown?.find((p: any) => p.platform === 'codeforces');
      const state = EMPTY_PLATFORM_STATE<any>();
      if (cf) {
        state.data = { totalSolved: cf.solved, maxRating: cf.rating || 0 };
      }
      return state;
    }
    return codeforces;
  }, [isPublicView, publicProfile, codeforces]);
  
  const activeCodechef = isPublicView ? EMPTY_PLATFORM_STATE<any>() : codechef;

  const activeGithub = React.useMemo(() => {
    if (isPublicView && publicProfile) {
      const gh = publicProfile.github;
      const state = EMPTY_PLATFORM_STATE<any>();
      if (gh && gh.isVerified) {
        state.data = { publicRepos: gh.verifiedProjectCount };
      }
      return state;
    }
    return github;
  }, [isPublicView, publicProfile, github]);

  const totalSolved = React.useMemo(() => {
    if (isPublicView && publicProfile) return publicProfile.dsa?.totalSolved || 0;
    let total = 0;
    if (activeLeetcode.data) total += activeLeetcode.data.solvedProblem;
    if (activeCodeforces.data) total += activeCodeforces.data.totalSolved;
    if (activeCodechef.data) total += activeCodechef.data.totalProblemsSolved;
    if (activeGithub.data) total += activeGithub.data.publicRepos;
    return total;
  }, [isPublicView, publicProfile, activeLeetcode, activeCodeforces, activeCodechef, activeGithub]);

  const bestRating = React.useMemo(() => {
    if (isPublicView && publicProfile) return publicProfile.dsa?.bestContestRating || 0;
    const ratings: number[] = [];
    if (activeLeetcode.data?.contestRating) ratings.push(activeLeetcode.data.contestRating);
    if (activeCodeforces.data?.maxRating) ratings.push(activeCodeforces.data.maxRating);
    if (activeCodechef.data?.highestRating) ratings.push(activeCodechef.data.highestRating);
    return ratings.length > 0 ? Math.max(...ratings) : 0;
  }, [isPublicView, publicProfile, activeLeetcode, activeCodeforces, activeCodechef]);

  const currentStreak = isPublicView ? (publicProfile?.consistency?.currentStreak || 0) : (dashboard?.streak ?? 0);

  const handleCancel = () => {
    fetchProfile();
  };

  const hasAnyStats = activeLeetcode.data || activeCodeforces.data || activeCodechef.data || activeGithub.data || (isPublicView && publicProfile);
  const isLoading = isPublicView ? isPublicLoading : (dashLoading || activeLeetcode.loading || activeCodeforces.loading || activeCodechef.loading || activeGithub.loading || isProfileLoading);
  const portfolioTheme: PublicPortfolioTheme = publicProfile?.settings?.theme ?? 'modern-dark';
  const portfolioSections = publicProfile?.sections ?? Object.fromEntries(PUBLICATION_SECTIONS.map((section) => [section, true]));
  const sectionOrder: PublicationSection[] = publicProfile?.settings?.sectionOrder?.length === PUBLICATION_SECTIONS.length
    ? publicProfile.settings.sectionOrder
    : [...PUBLICATION_SECTIONS];
  const renderPublicSection = (section: PublicationSection) => {
    if (portfolioSections[section] !== true) return null;
    if (section === 'streak') return <ProfileHeader key={section} fullName={activeProfile.fullName} bio={activeProfile.bio} totalSolved={totalSolved} currentStreak={currentStreak} bestRating={bestRating} />;
    if (section === 'dsa') return <section key={section} aria-labelledby="public-dsa-heading" className="profile-public-section"><h3 id="public-dsa-heading">DSA telemetry</h3><div className="platform-stats-grid">{sortedPlatforms.filter((platform) => platform.id !== 'github').map((platform) => platform.component)}</div></section>;
    if (section === 'github') return <section key={section} aria-labelledby="public-github-heading" className="profile-public-section"><h3 id="public-github-heading">GitHub telemetry</h3><div className="platform-stats-grid">{sortedPlatforms.filter((platform) => platform.id === 'github').map((platform) => platform.component)}</div></section>;
    if (section === 'projects') return <section key={section} aria-labelledby="public-projects-heading" className="profile-card profile-public-section"><h3 id="public-projects-heading">Verified projects</h3><p>{Array.isArray(publicProfile?.projects) ? publicProfile.projects.length : 0} verified projects are included in this portfolio.</p></section>;
    return <section key={section} aria-labelledby="public-activity-heading" className="profile-card profile-public-section"><h3 id="public-activity-heading">Activity</h3><p>{Array.isArray(publicProfile?.activityHeatmap?.weeks) ? publicProfile.activityHeatmap.weeks.filter((day: { count?: number }) => (day.count ?? 0) > 0).length : 0} active days are represented in the public snapshot.</p></section>;
  };

  // ─── Telemetry Sorting Logic (Increasing Order) ──────────────────────────
  const sortedPlatforms = React.useMemo(() => {
    const platforms = [
      { id: 'leetcode', solved: activeLeetcode.data?.solvedProblem || 0, component: <LeetCodeStatsCard key="lc" state={activeLeetcode as any} username={activeLeetcode.data?.username || activeProfile.leetcodeUsername || 'user'} /> },
      { id: 'codeforces', solved: activeCodeforces.data?.totalSolved || 0, component: <CodeforcesStatsCard key="cf" state={activeCodeforces as any} username={activeCodeforces.data?.handle || activeProfile.codeforcesUsername || 'user'} /> },
      { id: 'codechef', solved: activeCodechef.data?.totalProblemsSolved || 0, component: <CodeChefStatsCard key="cc" state={activeCodechef as any} username={activeCodechef.data?.name || activeProfile.codechefUsername || 'user'} /> },
      { id: 'github', solved: activeGithub.data?.publicRepos || 0, component: <GithubStatsCard key="gh" state={activeGithub as any} username={activeGithub.data?.username || (activeProfile.githubUrl ? activeProfile.githubUrl.split('/').pop() : 'user') || 'user'} /> }
    ];

    // Filter out platforms without data and not loading
    const activePlats = platforms.filter(p => {
      const state = p.id === 'leetcode' ? activeLeetcode : p.id === 'codeforces' ? activeCodeforces : p.id === 'codechef' ? activeCodechef : activeGithub;
      return state.data || state.loading;
    });

    return activePlats.sort((a, b) => a.solved - b.solved);
  }, [activeLeetcode, activeCodeforces, activeCodechef, activeGithub, activeProfile]);

  if (isPublicView && !publicProfile && !isPublicLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center text-slate-400 font-bold uppercase tracking-widest text-sm">
        Profile Not Found
      </div>
    );
  }

  return (
    <div className={`${isPublicView ? 'profile-page-container px-4 py-6 sm:px-8' : 'profile-page-container'} ${isPublicView ? `portfolio-theme-${portfolioTheme}` : ''}`} style={isPublicView && isPublicLoading ? { visibility: 'hidden' } : undefined} aria-busy={isPublicView ? isPublicLoading : undefined}>
      <div className="profile-page-glow" />

      <PageShell
        title={isPublicView ? "Verified Proof-of-Work" : "Engineering Profile"}
        subtitle={isPublicView ? "Immutable activity metrics & telemetry" : "Manage your operational identity and platform telemetry"}
        status="success"
        error={null}
      >
        <div className="mx-auto w-full max-w-[1000px] profile-content-wrapper">
          <div className="flex flex-col gap-8">
            {/* ─── 1. Identity Panel ───────────────────────────────────── */}
            {isPublicView ? sectionOrder.map(renderPublicSection) : (
              <ProfileHeader
                fullName={activeProfile.fullName}
                bio={activeProfile.bio}
                totalSolved={totalSolved}
                currentStreak={currentStreak}
                bestRating={bestRating}
              />
            )}

            {/* ─── 2. Badge Ecosystem ──────────────────────────────────── */}
            {!isPublicView && <ProfileAchievementsCard />}

            {/* ─── 3 + 4. Settings Matrix and Connectivity Row (owner only) ───
                Public viewers, signed in or not, only get the read-only stats. */}
            {!isPublicView && (
              <>
                <Link to="/profile/portfolio" className="text-sm font-semibold text-indigo-600 hover:underline">
                  Manage your public portfolio
                </Link>
                <div className="profile-grid">
                  <PersonalInfoCard profile={activeProfile} onUpdate={updateField} />
                  <CareerGoalsCard
                    profile={activeProfile}
                    onUpdate={updateField}
                    onAddTech={addTechStack}
                    onRemoveTech={removeTechStack}
                  />
                </div>

                <div className="profile-grid">
                  <CPProfilesCard
                    profile={activeProfile}
                    leetcode={activeLeetcode as any}
                    codeforces={activeCodeforces as any}
                    codechef={activeCodechef as any}
                    onUpdate={updateField}
                    onFetchAll={fetchAllPlatforms}
                    syncState={syncState}
                    syncMessage={syncMessage}
                    lastSyncedAt={lastSyncedAt}
                  />
                  <SocialProfilesCard profile={activeProfile} onUpdate={updateField} />
                </div>
              </>
            )}

            {/* ─── 5. Platform Telemetry (Sorted) ───────────────────────── */}
            {!isPublicView && (hasAnyStats || isLoading) && (
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
              >
                <h3 className="text-sm font-black text-slate-400 uppercase tracking-[0.1em] mb-4 flex items-center gap-2 ml-1">
                  <Icon name="chart-bar" size={14} />
                  Advanced Telemetry Matrix
                </h3>
                <div className="platform-stats-grid">
                  {sortedPlatforms.map(p => p.component)}
                </div>
              </motion.div>
            )}

            {/* ─── 6. Empty State ───────────────────────────────────────── */}
            {!isPublicView && !hasAnyStats && !isLoading && (
              <div className="flex flex-col items-center justify-center py-16 bg-slate-50/50 rounded-[32px] border border-dashed border-slate-200">
                <Icon name="chart-bar" size={32} className="text-slate-300 mb-3" />
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">No telemetry nodes active</p>
              </div>
            )}
          </div>
        </div>

        {/* ─── 7. Global Action Bar (Sticky) ─────────────────────────── */}
        {!isPublicView && (
          <div className="profile-sticky-footer">
            {saveError && <p role="alert" className="text-sm text-red-600 mb-2">{saveError}</p>}
            <motion.div
              className="profile-action-bar"
              initial={{ y: 50, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.4, type: 'spring', damping: 25 }}
            >
            <div className="profile-action-bar__left">
              <button
                type="button"
                onClick={logout}
                disabled={isLoggingOut}
                aria-busy={isLoggingOut}
                aria-label={isLoggingOut ? 'Signing out' : 'Terminate Session'}
                className="profile-btn-terminate disabled:opacity-50 disabled:cursor-wait"
              >
                <Icon name="log-out" size={16} />
                <span>{isLoggingOut ? 'Signing out…' : 'Terminate Session'}</span>
              </button>
            </div>

            <div className="profile-action-bar__right">
              <AnimatePresence>
                {isDirty && (
                  <motion.button
                    type="button"
                    className="profile-btn-cancel"
                    onClick={handleCancel}
                    disabled={isSaving}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                  >
                    Discard Changes
                  </motion.button>
                )}
              </AnimatePresence>
              <button
                type="button"
                className="profile-btn-commit"
                onClick={saveProfile}
                disabled={!isDirty || isSaving}
              >
                {isSaving ? 'Syncing...' : 'Commit Changes'}
              </button>
            </div>
          </motion.div>
        </div>
        )}
      </PageShell>
    </div>
  );
};

export default ProfilePage;
