import { useState } from 'react';

export function MissingKeywords({ keywords }: { keywords: { keyword: string; category: string }[] }) {
  const [feedback, setFeedback] = useState('');
  const groups = new Map<string, Set<string>>();
  for (const { category, keyword } of keywords) {
    const group = groups.get(category) ?? new Set<string>();
    group.add(keyword);
    groups.set(category, group);
  }

  async function copy(keyword: string) {
    try {
      await navigator.clipboard.writeText(keyword);
      setFeedback(`Copied ${keyword}.`);
    } catch {
      setFeedback(`Couldn’t copy ${keyword}.`);
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby="missing-keywords">
      <h2 id="missing-keywords" className="text-lg font-semibold">Missing keywords</h2>
      {!groups.size && <p className="text-sm text-slate-600">No missing keywords identified.</p>}
      {[...groups].map(([category, terms]) => (
        <div key={category}>
          <h3 className="mb-2 text-sm font-medium text-slate-700">{category}</h3>
          <ul className="flex flex-wrap gap-2">
            {[...terms].map(keyword => (
              <li key={keyword}>
                <button type="button" aria-label={`Copy ${keyword}`} onClick={() => void copy(keyword)}
                  className="break-all rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-sm text-violet-800 hover:bg-violet-100">
                  {keyword}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p role="status" className="text-sm text-slate-700">{feedback}</p>
    </section>
  );
}
