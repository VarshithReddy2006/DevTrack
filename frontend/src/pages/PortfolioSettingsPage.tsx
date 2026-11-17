import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Globe } from 'lucide-react';
import { ConsentPanel, CONSENT_VERSION } from '../features/portfolio/components/ConsentPanel';
import { HandlePicker } from '../features/portfolio/components/HandlePicker';
import { PublishBar } from '../features/portfolio/components/PublishBar';
import { SectionToggles } from '../features/portfolio/components/SectionToggles';
import { usePublication } from '../features/portfolio/hooks/usePublication';
import { normalizeSlug, validateSlug } from '../features/portfolio/utils/slug';
import {
  PUBLICATION_SECTIONS,
  classifyPublishError,
  type PublicationSection,
  type PublicationSections,
} from '../services/publicationService';

const HIDDEN = Object.fromEntries(PUBLICATION_SECTIONS.map((section) => [section, false])) as PublicationSections;

const PortfolioSettingsPage: React.FC = () => {
  const { status, isLoading, isUnavailable, isError, refetch, publish, unpublish } = usePublication();
  const [slug, setSlug] = useState('');
  const [sections, setSections] = useState<PublicationSections>(HIDDEN);
  const [consent, setConsent] = useState(false);
  const [handleError, setHandleError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!status) return;
    setSections(status.sections);
    if (status.slug) setSlug(status.slug);
  }, [status]);

  const published = status?.published === true;
  const busy = publish.isPending || unpublish.isPending;
  const canPublish = validateSlug(slug).valid && (published || consent);
  const handleChanged = published && normalizeSlug(slug) !== status?.slug;

  const consentVersionToSend = published ? status?.consentVersion ?? CONSENT_VERSION : CONSENT_VERSION;

  const onSlugChange = (value: string) => {
    setSlug(value);
    setHandleError(null);
  };

  const onPublish = async () => {
    setHandleError(null);
    setNotice(null);
    try {
      await publish.mutateAsync({ slug: normalizeSlug(slug), sections, consentVersion: consentVersionToSend });
    } catch (error) {
      const failure = classifyPublishError(error);
      if (failure.kind === 'other') setNotice(failure.message);
      else setHandleError(failure.message);
    }
  };

  // Once published a section change is saved on the spot, so hiding something takes effect right away.
  const onToggle = async (section: PublicationSection, visible: boolean) => {
    const previous = sections;
    const next = { ...sections, [section]: visible };
    setSections(next);
    if (!published || !status?.slug) return;
    setNotice(null);
    try {
      await publish.mutateAsync({ slug: status.slug, sections: next, consentVersion: consentVersionToSend });
    } catch (error) {
      setSections(previous);
      setNotice(`Couldn't save that change. ${classifyPublishError(error).message}`);
    }
  };

  const onUnpublish = async () => {
    setNotice(null);
    try {
      await unpublish.mutateAsync();
      setConsent(false);
    } catch (error) {
      setNotice(`Couldn't unpublish. ${classifyPublishError(error).message}`);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-4 pb-16 md:px-0">
      <header className="flex flex-col gap-2">
        <Link to="/profile" className="inline-flex w-fit items-center gap-1 text-xs font-semibold text-indigo-700 hover:underline">
          <ArrowLeft size={12} aria-hidden="true" /> Back to profile
        </Link>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50">
            <Globe size={18} className="text-indigo-600" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-800">Portfolio Settings</h1>
            <p className="text-sm text-slate-500">Choose what, if anything, the public can see about you.</p>
          </div>
        </div>
      </header>

      {isLoading && (
        <div role="status" className="animate-pulse space-y-3">
          <span className="sr-only">Loading portfolio settings…</span>
          {[0, 1, 2].map((i) => <div key={i} className="h-20 rounded-xl border border-slate-200 bg-slate-100" />)}
        </div>
      )}

      {isUnavailable && (
        <p role="status" className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          Public portfolios aren’t available on this server yet, so there is nothing to publish.
        </p>
      )}

      {isError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          <span>We couldn’t load your portfolio settings.</span>
          <button type="button" onClick={() => void refetch()} className="rounded-lg border border-rose-300 bg-white px-3 py-1 text-xs font-semibold">
            Try again
          </button>
        </div>
      )}

      {status && (
        <>
          {notice && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{notice}</p>}
          <PublishBar
            published={published}
            slug={status.slug}
            canPublish={canPublish}
            handleChanged={handleChanged}
            busy={busy}
            onPublish={() => void onPublish()}
            onUnpublish={() => void onUnpublish()}
          />
          <HandlePicker value={slug} onChange={onSlugChange} serverError={handleError} disabled={busy} />
          <SectionToggles sections={sections} onToggle={(section, visible) => void onToggle(section, visible)} disabled={busy} />
          <ConsentPanel
            checked={consent}
            onChange={setConsent}
            acceptedVersion={published ? status.consentVersion : null}
            publishedAt={status.publishedAt}
          />
        </>
      )}
    </div>
  );
};

export default PortfolioSettingsPage;
