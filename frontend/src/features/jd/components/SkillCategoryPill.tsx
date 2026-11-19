import type { SkillCategory } from '../skillGap.types';

export function SkillCategoryPill({ category }: { category: SkillCategory }) {
  return <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">{category}</span>;
}
