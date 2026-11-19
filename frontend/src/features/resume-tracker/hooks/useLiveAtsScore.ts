import { useEffect, useState } from 'react';
import { analyzeActionVerbs, analyzeQuantifiedImpact, countResumeWords, evaluateBulletEdits, type BulletEdit, type BulletScoringContext } from '@devtrack/ats-core';

export function previewBulletScore(bullets: readonly BulletEdit[], context: BulletScoringContext) {
  const text = bullets.map(bullet => bullet.editedText);
  return {
    ...evaluateBulletEdits(bullets, context), total: bullets.length,
    activeVerbs: analyzeActionVerbs(text).filter(Boolean).length,
    quantified: analyzeQuantifiedImpact(text).filter(Boolean).length,
    concise: text.filter(bullet => { const words = countResumeWords(bullet); return words >= 8 && words <= 40; }).length,
  };
}
export type BulletScorePreview = ReturnType<typeof previewBulletScore>;

export function useLiveAtsScore(bullets: readonly BulletEdit[], context: BulletScoringContext) {
  const [result, setResult] = useState(() => ({ bullets, context, score: previewBulletScore(bullets, context) }));
  useEffect(() => {
    const timer = window.setTimeout(() => setResult({ bullets, context, score: previewBulletScore(bullets, context) }), 300);
    return () => window.clearTimeout(timer);
  }, [bullets, context]);
  return { score: result.score, pending: result.bullets !== bullets || result.context !== context };
}
