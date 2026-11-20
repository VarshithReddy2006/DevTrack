import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { fetchStreakData } from '../../../services/dashboardService';
import { fetchDueCards, MAX_DUE_CARDS, submitRevisionReview, type ReviewRating, type RevisionCard } from '../../../services/revisionService';
import { cardMatchesTopic, topicLabel } from '../topics';
import { Flashcard } from './Flashcard';
import { RatingBar } from './RatingBar';
import { RevisionStatsPanel } from './RevisionStatsPanel';
import { CardSummaryModal } from './CardSummaryModal';
import { summarizeSession, type SessionReview } from '../sessionSummary';

type LoadState = 'loading' | 'ready' | 'error';

interface RevisionReviewDeckProps {
  /** Only review due cards tagged with this topic. */
  topic?: string | null;
}

export function RevisionReviewDeck({ topic = null }: RevisionReviewDeckProps) {
  const [limit, setLimit] = useState(10);
  const [cards, setCards] = useState<RevisionCard[]>([]);
  const [position, setPosition] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [streak, setStreak] = useState<number | null>(null);
  const submissionLock = useRef(false);
  const [reviews, setReviews] = useState<SessionReview[]>([]);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const summaryButton = useRef<HTMLButtonElement>(null);
  const session = useRef(0);

  const loadCards = useCallback(async (signal?: AbortSignal) => {
    const currentSession = ++session.current;
    setLoadState('loading');
    setError('');
    setReviews([]);
    setSummaryOpen(false);
    try {
      // The due endpoint has no topic filter, so a topic deck is drawn from the
      // largest due batch the API allows and then trimmed to the deck size.
      const due = await fetchDueCards(topic ? MAX_DUE_CARDS : limit, signal);
      if (signal?.aborted || currentSession !== session.current) return;
      setCards(topic ? due.filter((item) => cardMatchesTopic(item, topic)).slice(0, limit) : due);
      setPosition(0);
      setFeedback('');
      setLoadState('ready');
    } catch (cause) {
      if (signal?.aborted || currentSession !== session.current) return;
      setError((cause as { message?: string }).message || 'Could not load due cards.');
      setLoadState('error');
    }
  }, [limit, topic]);

  useEffect(() => {
    const controller = new AbortController();
    void loadCards(controller.signal);
    return () => { controller.abort(); session.current += 1; };
  }, [loadCards]);

  useEffect(() => {
    if (loadState === 'ready' && cards.length > 0 && position === cards.length) {
      // The final rating button is removed on completion. Restore focus to a
      // persistent summary trigger when the shared modal closes.
      summaryButton.current?.focus();
      setSummaryOpen(true);
    }
  }, [loadState, cards.length, position]);

  useEffect(() => {
    let active = true;
    void fetchStreakData().then((result) => {
      if (active) setStreak(result.data.currentStreak);
    }).catch(() => { /* The deck remains usable if streak data is unavailable. */ });
    return () => { active = false; };
  }, []);

  const card = cards[position];
  const rate = useCallback(async (rating: ReviewRating) => {
    if (!card || submissionLock.current) return;
    submissionLock.current = true;
    setSubmitting(true);
    setError('');
    setFeedback('');
    const currentSession = session.current;
    try {
      const updated = await submitRevisionReview(card, rating);
      if (currentSession !== session.current) return;
      const reviewedAt = Date.now();
      setReviews(current => [...current, { rating, before: card, after: updated, reviewedAt }]);
      setFeedback(`Review recorded. XP reward requested. Next review in ${updated.intervalDays} day${updated.intervalDays === 1 ? '' : 's'}.`);
      setPosition((current) => current + 1);
    } catch (cause) {
      if (currentSession !== session.current) return;
      const apiError = cause as { message?: string; code?: string; statusCode?: number };
      if (apiError.statusCode === 409 || apiError.code === 'REVISION_CARD_STALE') {
        setError('This card changed in another session. Refresh the deck before rating again.');
      } else {
        setError(apiError.message || 'The review could not be saved. Try again.');
      }
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
    }
  }, [card]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-dt-textSecondary">{topic ? `Reviewing due ${topicLabel(topic)} problems.` : 'Review due problems at your own pace.'}</p>
        <label className="flex items-center gap-2 text-sm text-dt-textSecondary">Deck size
          <select value={limit} disabled={submitting} onChange={(event) => setLimit(Number(event.target.value))} className="rounded-lg border border-dt-primary/20 bg-dt-surface px-3 py-2 text-dt-text" aria-label="Daily review limit">
            {[5, 10, 20, 50].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>

      <RevisionStatsPanel dueCount={cards.length} completedCount={position} streak={streak} />

      {loadState === 'loading' && <div role="status" className="dt-card p-8 text-dt-textSecondary">Loading due cards…</div>}
      {loadState === 'error' && <div role="alert" className="dt-card p-6"><p className="text-red-600">{error}</p><button type="button" onClick={() => void loadCards()} className="dt-btn dt-btn-secondary dt-btn-sm mt-3">Try again</button></div>}
      {loadState === 'ready' && !card && (
        <div className="dt-card p-10 text-center" role="status">
          <p className="text-3xl" aria-hidden="true">✦</p>
          <h2 className="mt-3 text-xl font-bold text-dt-text">Deck complete</h2>
          <p className="mt-2 text-sm text-dt-textSecondary">{cards.length === 0 ? (topic ? `No ${topicLabel(topic)} problems are due right now.` : 'No problems are due right now.') : `You reviewed all ${cards.length} cards in this deck.`}</p>
          {reviews.length > 0 && <button ref={summaryButton} type="button" onClick={() => setSummaryOpen(true)} className="dt-btn dt-btn-primary mt-5 mr-3">View session summary</button>}
          <button type="button" onClick={() => void loadCards()} className="dt-btn dt-btn-secondary dt-btn-sm mt-5">Check for more due cards</button>
        </div>
      )}
      {loadState === 'ready' && card && (
        <>
          <div className="flex items-center justify-between text-sm text-dt-textSecondary"><span>Card {position + 1} of {cards.length}</span><span>{Math.round((position / cards.length) * 100)}% complete</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-dt-primary/10"><div className="h-full rounded-full bg-dt-primary transition-all" style={{ width: `${(position / cards.length) * 100}%` }} /></div>
          <AnimatePresence mode="wait"><motion.div key={card._id} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -18 }} transition={{ duration: 0.18 }}><Flashcard card={card} /></motion.div></AnimatePresence>
          <RatingBar onRate={(rating) => void rate(rating)} disabled={submitting} />
          {error && <p role="alert" className="text-sm text-red-600">{error} <button type="button" onClick={() => void loadCards()} className="underline">Refresh deck</button></p>}
        </>
      )}
      {feedback && <p role="status" className="rounded-lg bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">✦ {feedback}</p>}
      <CardSummaryModal summary={summarizeSession(reviews)} open={summaryOpen} onClose={() => setSummaryOpen(false)} />
    </div>
  );
}
