import type { ApiQuest } from '../services/questsService';

interface QuestItemCardProps {
  quest: ApiQuest;
  onClaim: (questId: string) => void;
  isClaiming: boolean;
  celebrating: boolean;
}

export function QuestItemCard({ quest, onClaim, isClaiming, celebrating }: QuestItemCardProps) {
  const progress = Math.min(100, Math.round((quest.currentCount / quest.targetCount) * 100));
  const canClaim = quest.completed && !quest.claimed && !isClaiming;

  return (
    <article className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      {celebrating && (
        <div aria-label="Reward claimed" className="pointer-events-none absolute inset-0 overflow-hidden" role="status">
          {[0, 1, 2, 3, 4].map((item) => (
            <span
              key={item}
              className="absolute top-0 h-2 w-2 animate-[quest-confetti_700ms_ease-out_forwards] rounded-sm bg-dt-primary"
              style={{ left: `${18 + item * 16}%`, animationDelay: `${item * 45}ms` }}
            />
          ))}
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-bold text-slate-800">{quest.title}</h3>
          <p className="mt-1 text-xs text-slate-500">{quest.kind === 'dsa_solve' ? 'Keep building your problem-solving streak.' : quest.kind === 'focus_minutes' ? 'Make focused progress today.' : 'Strengthen retention with a review.'}</p>
        </div>
        <span className="shrink-0 rounded-full bg-violet-50 px-2.5 py-1 text-xs font-bold text-violet-700">+{quest.xpReward} XP</span>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs font-semibold text-slate-500">
        <span>{quest.currentCount} / {quest.targetCount}</span>
        <span>{quest.claimed ? 'Claimed' : quest.completed ? 'Complete' : `${progress}%`}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label={`${quest.title} progress`} aria-valuemin={0} aria-valuemax={quest.targetCount} aria-valuenow={Math.min(quest.currentCount, quest.targetCount)}>
        <div className="h-full rounded-full bg-gradient-to-r from-dt-primary to-violet-400 transition-all" style={{ width: `${progress}%` }} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${quest.claimed ? 'bg-slate-100 text-slate-500' : quest.completed ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
          {quest.claimed ? 'Claimed' : quest.completed ? 'Ready to claim' : 'In progress'}
        </span>
        <button
          type="button"
          disabled={!canClaim}
          onClick={() => onClaim(quest.questId)}
          className="rounded-xl bg-dt-primary px-3 py-2 text-xs font-bold text-white transition hover:bg-violet-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
        >
          {quest.claimed ? 'Claimed' : isClaiming ? 'Claiming…' : quest.completed ? `Claim +${quest.xpReward} XP` : 'In progress'}
        </button>
      </div>
    </article>
  );
}
