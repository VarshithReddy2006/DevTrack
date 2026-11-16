// ============================================================================
// CrashFeedbackDialog.tsx — "Report an issue" form shown from the error fallback
// ============================================================================

import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Modal } from '../ui';
import { sendCrashFeedback } from '../../lib/sentry';

const MAX_LENGTH = 1000;

interface CrashFeedbackDialogProps {
  open: boolean;
  /** Sentry event id of the crash the note is about. */
  eventId: string;
  onClose: () => void;
}

type Status = 'idle' | 'sent' | 'failed';

export function CrashFeedbackDialog({ open, eventId, onClose }: CrashFeedbackDialogProps) {
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const fieldId = useId();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setStatus(sendCrashFeedback(message, eventId) ? 'sent' : 'failed');
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Report an issue"
      description="Tell us what you were doing when this happened. Please leave out passwords and personal details."
      size="sm"
    >
      {status === 'sent' ? (
        <div className="space-y-4">
          <p role="status" className="text-sm text-zinc-700">Thanks, your report was sent.</p>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor={fieldId} className="block text-sm font-medium text-zinc-700 mb-1">
              What were you doing?
            </label>
            <textarea
              id={fieldId}
              value={message}
              maxLength={MAX_LENGTH}
              rows={4}
              onChange={(event) => setMessage(event.target.value)}
              className="w-full rounded-lg border border-zinc-200 p-2 text-sm text-zinc-900"
            />
          </div>
          {status === 'failed' && (
            <p role="alert" className="text-sm text-rose-600">
              We could not send the report. Please try again.
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!message.trim()}>Send report</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
