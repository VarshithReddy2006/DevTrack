import { useEffect, useMemo, useState } from 'react';
import { Drawer } from '../../../components/ui/Drawer';
import { useClaimQuest } from '../hooks/useClaimQuest';
import { useQuests } from '../hooks/useQuests';
import { QuestItemCard } from './QuestItemCard';

type Cadence = 'daily' | 'weekly';

function formatRemaining(expiresAt: string, serverOffset: number, now: number) {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - (now + serverOffset)) / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  return days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m ${remainingSeconds}s`;
}

export function TieredQuestsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, isLoading, isError } = useQuests();
  const claimQuest = useClaimQuest();
  const [cadence, setCadence] = useState<Cadence>('daily');
  const [now, setNow] = useState(() => Date.now());
  const [celebratingId, setCelebratingId] = useState<string | null>(null);
  const [claimedIds, setClaimedIds] = useState<Set<string>>(() => new Set());
  const serverTime = data?.serverTime;
  const serverOffset = useMemo(() => serverTime ? Date.parse(serverTime) - Date.now() : 0, [serverTime]);
  const quests = useMemo(() => data?.quests.filter((quest) => quest.cadence === cadence) ?? [], [data?.quests, cadence]);
  const resetAt = quests[0]?.expiresAt;

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const handleClaim = (questId: string) => {
    claimQuest.mutate(questId, {
      onSuccess: () => {
        setClaimedIds((current) => new Set(current).add(questId));
        setCelebratingId(questId);
        window.setTimeout(() => setCelebratingId(null), 800);
      },
    });
  };

  return (
    <Drawer open={open} onClose={onClose} title="Tiered Quests" className="bg-slate-50 text-slate-900">
      <div className="p-5">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-dt-primary">League rewards</p>
            <p className="mt-1 text-xs text-slate-500">{data?.leagueTrophies ?? 0} league trophies</p>
          </div>
          {resetAt && <p className="text-right text-xs font-semibold text-slate-500">Resets in<br /><span className="text-slate-800">{formatRemaining(resetAt, serverOffset, now)}</span></p>}
        </div>
        <div className="mb-5 grid grid-cols-2 rounded-xl bg-slate-200/70 p-1" role="tablist" aria-label="Quest cadence">
          {(['daily', 'weekly'] as const).map((item) => (
            <button key={item} type="button" role="tab" aria-selected={cadence === item} onClick={() => setCadence(item)} className={`rounded-lg px-3 py-2 text-xs font-bold transition ${cadence === item ? 'bg-white text-dt-primary shadow-sm' : 'text-slate-500'}`}>
              {item === 'daily' ? 'Daily Quests' : 'Weekly Quests'}
            </button>
          ))}
        </div>
        {isLoading && <p className="py-8 text-center text-sm text-slate-500">Loading quests…</p>}
        {isError && <p className="py-8 text-center text-sm text-red-500">Unable to load quests. Please try again.</p>}
        {!isLoading && !isError && quests.length === 0 && <p className="py-8 text-center text-sm text-slate-500">No quests available.</p>}
        <div className="space-y-3">
          {quests.map((quest) => {
            const displayQuest = claimedIds.has(quest.questId) ? { ...quest, claimed: true } : quest;
            return <QuestItemCard key={quest.questId} quest={displayQuest} onClaim={handleClaim} isClaiming={claimQuest.isPending && claimQuest.variables === quest.questId} celebrating={celebratingId === quest.questId} />;
          })}
        </div>
      </div>
      <style>{'@keyframes quest-confetti { 0% { transform: translateY(0) rotate(0); opacity: 1; } 100% { transform: translateY(150px) rotate(180deg); opacity: 0; } }'}</style>
    </Drawer>
  );
}
