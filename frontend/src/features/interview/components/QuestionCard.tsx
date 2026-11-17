export function QuestionCard({ prompt, index }: { prompt: string; index: number }) {
  return (
    <section className="rounded-2xl border border-violet-200 bg-violet-50 p-5 sm:p-6" aria-labelledby="interview-question">
      <h2 id="interview-question" className="text-sm font-semibold text-violet-800">Question {index + 1} of 5</h2>
      <p className="mt-3 whitespace-pre-wrap break-words text-lg font-medium leading-relaxed text-slate-900">{prompt}</p>
    </section>
  );
}
