import { Globe } from 'lucide-react';
import { postingUrlSchema } from '../jobTargetValidation';

export function DomainBadgePreview({ value }: { value: string }) {
  const result = postingUrlSchema.safeParse(value);
  if (!result.success) return null;
  const host = new URL(result.data).hostname.replace(/\.$/, '');
  return (
    <p className="flex min-w-0 items-center gap-2 rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-800" aria-live="polite">
      <Globe aria-hidden="true" className="shrink-0" size={16} />
      <span className="break-all">Posting domain: <strong>{host}</strong></span>
    </p>
  );
}
