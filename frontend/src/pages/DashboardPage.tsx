import React from 'react';
import { Flame } from 'lucide-react';
import { useDashboardData } from '../hooks/useDashboardData';
import { fetchDsaContests } from '../services/dsaService';
import { useLogout } from '../hooks/useLogout';
import { type ApiDsaContestEntry } from '../types/api.types';
import { DashboardHeader } from '../components/dashboard/DashboardHeader';
import { StatsGrid } from '../components/dashboard/StatsGrid';
import { AnnouncementSection } from '../components/dashboard/AnnouncementSection';
import { ActionsPanel } from '../components/dashboard/ActionsPanel';
import { GithubOverviewCard } from '../components/dashboard/GithubOverviewCard';
import { DashboardSkeleton } from '../components/skeletons/DashboardSkeleton';
import { WeeklyMomentumBar } from '../features/gamification/components/WeeklyMomentumBar';
import { ProjectsMomentumList } from '../components/dashboard/ProjectsMomentumList';
import { DailyChallengeCard } from '../components/dashboard/DailyChallengeCard';
import { useDailyChallenge } from '../hooks/useDailyChallenge';
import { ErrorBoundary } from '../components/ui/ErrorBoundary';
import { RetentionBanner } from '../components/dashboard/RetentionBanner';
import { TieredQuestsDrawer } from '../features/quests/components/TieredQuestsDrawer';

// removed unused transformRecentActivities

const SectionHeader: React.FC<{ icon: string; title: string; subtitle: string }> = ({ icon, title, subtitle }) => (
  <div className="flex items-center gap-3 px-0.5 mb-0">
    <div className="w-9 h-9 rounded-[10px] bg-gradient-to-br from-dt-primary/8 to-dt-primary/4 flex items-center justify-center border border-dt-primary/10 shadow-[0_2px_8px_rgba(124,92,252,0.08)] shrink-0 backdrop-blur-sm">
      <span className="text-[16px]">{icon}</span>
    </div>
    <div className="min-w-0">
      <h2 className="text-[13px] font-extrabold text-dt-text tracking-[0.08em] uppercase truncate">{title}</h2>
      <p className="text-[11px] font-semibold text-dt-textSecondary/80 truncate leading-tight">{subtitle}</p>
    </div>
  </div>
);

const DashboardPage: React.FC = () => {
  const { data, loading, error } = useDashboardData();
  const { challenge } = useDailyChallenge();
  const { logout, isLoggingOut } = useLogout('/login');
  const [contests, setContests] = React.useState<{ name: string; platform: string; time: string }[]>([]);
  const [questsOpen, setQuestsOpen] = React.useState(false);

  const lastSevenDays = React.useMemo(() => {
    const days = [];
    const weekdayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;
      
      const historyDay = data?.streakData?.streakHistory?.find((h: any) => h.date === dateStr);
      const isActive = (historyDay ? historyDay.count > 0 : false) || (dateStr === new Date().toISOString().split('T')[0] && data?.streakData?.isActiveToday);
      
      days.push({
        label: weekdayNames[d.getDay()],
        isActive: !!isActive,
      });
    }
    return days;
  }, [data?.streakData]);

  React.useEffect(() => {
    const loadContests = async () => {
      try {
        const response = await fetchDsaContests({ pageSize: 10 });
        if (response.success) {
          const allContests = response.data.contests;
          const sevenDaysAgo = new Date();
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

          const recent = allContests
            .filter((c: ApiDsaContestEntry) => new Date(c.participatedAt) >= sevenDaysAgo)
            .map((c: ApiDsaContestEntry) => ({
              name: c.contestName,
              platform: c.platform,
              time: new Date(c.participatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            }));
          setContests(recent);
        }
      } catch (err) {
        console.error('Failed to fetch contests:', err);
      }
    };
    loadContests();
  }, []);

  if (loading) {
    return (
      <div className="dt-fade-in max-w-[1400px] mx-auto w-full">
        <DashboardSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] dt-fade-in">
        <div className="text-center bg-white border border-red-100 rounded-3xl p-10 shadow-xl max-w-md w-full mx-4">
          <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center text-2xl mx-auto mb-6 border border-red-100">
            !
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2 tracking-tight">Sync Failed</h2>
          <p className="text-[14px] text-gray-500 mb-8 max-w-sm mx-auto leading-relaxed">{error}</p>
          <div className="flex flex-col gap-3">
            <button
              onClick={() => window.location.reload()}
              className="w-full py-3 rounded-xl bg-dt-primary text-white font-semibold hover:bg-dt-primary/90 transition-all shadow-md shadow-dt-primary/20"
            >
              Try Again
            </button>
            <button
              type="button"
              onClick={logout}
              disabled={isLoggingOut}
              aria-busy={isLoggingOut}
              className="w-full py-3 rounded-xl bg-gray-50 text-red-500 font-semibold hover:bg-red-50 transition-all border border-gray-200 hover:border-red-100 disabled:opacity-50 disabled:cursor-wait"
            >
              {isLoggingOut ? 'Signing out…' : 'Log Out'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="flex flex-col gap-10 max-w-[1600px] mx-auto w-full dt-stagger pb-16 px-4 lg:px-8 relative">
        {/* Calm Operational Background */}
        <div className="fixed inset-0 pointer-events-none overflow-hidden -z-10 bg-[#FAFAFC] dark:bg-[#09090B] transition-colors duration-300" />

        {/* ==========================================
            SECTION 1 — HERO HEADER
            ========================================== */}
        <section>
          <DashboardHeader onOpenQuests={() => setQuestsOpen(true)} />
          <TieredQuestsDrawer open={questsOpen} onClose={() => setQuestsOpen(false)} />
        </section>

        {/* ==========================================
            SECTION 1A — RETENTION INTELLIGENCE BANNER
            ========================================== */}
        <section>
          <RetentionBanner />
        </section>

        {/* ==========================================
            SECTION 1B — STATS GRID (FULL WIDTH)
            ========================================== */}
        <section>
          <StatsGrid stats={data?.stats} platformStats={data?.platformStats} />
        </section>

        {/* ==========================================
            SECTION 2 — DAILY PROGRESSION ZONE
            ========================================== */}
        <section>
          <div className="flex flex-col gap-4">
            <SectionHeader
              icon="🔥"
              title="Daily Progression"
              subtitle="Streak, goals, and momentum tracking"
            />
            
            {/* TOP ROW: Streak + Daily Challenge */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
              {/* Consistency & Trajectory Card */}
              <div className="h-full">
                <div className="bg-white border border-slate-200/60 rounded-[20px] p-5 shadow-sm relative overflow-hidden group h-full flex flex-col justify-between">
                  <div className="absolute top-4 right-4 px-2.5 py-1 rounded-md bg-slate-100 border border-slate-200">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                      PEAK: {data?.streakData?.longestStreak || 0}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center shrink-0">
                      <Flame className="w-5 h-5 text-indigo-500" />
                    </div>
                    <div>
                      <div className="text-3xl font-black text-slate-800 tabular-nums leading-none tracking-tight">
                        {data?.streakData?.currentStreak || 0}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1 font-semibold uppercase tracking-wider">
                        Consistency Score
                      </div>
                    </div>
                  </div>

                  {/* Week Activity */}
                  <div className="flex items-center gap-2 mb-3">
                    {lastSevenDays.map((day, i) => (
                      <div key={i} className="flex-1 aspect-square max-w-[36px] rounded-full flex items-center justify-center relative">
                        <div
                          className={[
                            'absolute inset-0 rounded-full flex items-center justify-center text-[11px] font-bold transition-all duration-300',
                            day.isActive
                              ? 'bg-indigo-500 text-white shadow-sm'
                              : 'bg-slate-100 text-slate-400',
                          ].join(' ')}
                        >
                          {day.label}
                        </div>
                      </div>
                    ))}
                  </div>

                  {data?.streakData?.isActiveToday && (
                    <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div>
                      <span className="text-[12px] text-slate-600 font-medium">
                        Active today. Momentum preserved.
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Daily Challenge Card (Center - Extra Width) */}
              <div className="h-full">
                <DailyChallengeCard 
                  challenge={challenge} 
                />
              </div>
            </div>

            {/* BOTTOM ROW: Weekly Momentum Bar */}
            <div className="mt-2">
              <WeeklyMomentumBar weeklyXpData={data?.stats?.weeklyXPHistory} />
            </div>
          </div>
        </section>

        {/* ==========================================
            SECTION 3 — GITHUB INTEGRATION
            ========================================== */}
        <section>
          <GithubOverviewCard data={data} />
        </section>

        {/* ==========================================
            SECTION 4 — BOTTOM GRID
            ========================================== */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 pb-8">
          {/* LEFT: Project Momentum */}
          <div className="flex flex-col gap-4">
            <SectionHeader
              icon="💻"
              title="Project Momentum"
              subtitle="Sprint velocity and tasks"
            />
            <ProjectsMomentumList />
          </div>
          
          {/* CENTER: Upcoming Contests */}
          <div className="flex flex-col gap-4">
            <SectionHeader
              icon="🏆"
              title="Upcoming Contests"
              subtitle="Competition schedule"
            />
            <AnnouncementSection contests={contests} />
          </div>
          
          {/* RIGHT: Quick Actions */}
          <div className="flex flex-col gap-4 md:col-span-2 lg:col-span-1">
            <SectionHeader
              icon="⚡"
              title="Quick Actions"
              subtitle="Rapid navigation"
            />
            <ActionsPanel />
          </div>
        </section>
      </div>
    </ErrorBoundary>
  );
};

export default DashboardPage;
