const errorCopy: Record<string, { title: string; description: string; actionLabel: string }> = {
  BAD_REQUEST: { title: 'Check your request', description: 'Review the information you entered and try again.', actionLabel: 'Review input' },
  VALIDATION_ERROR: { title: 'Some fields need attention', description: 'Correct the highlighted fields before submitting again.', actionLabel: 'Review fields' },
  UNAUTHORIZED: { title: 'Sign in again', description: 'Your session may have expired. Sign in to continue.', actionLabel: 'Sign in' },
  FORBIDDEN: { title: 'Access restricted', description: 'Your account does not have permission for this action.', actionLabel: 'Go back' },
  NOT_FOUND: { title: 'Item unavailable', description: 'Check the link or return to the list to find the item.', actionLabel: 'Go back' },
  CONFLICT: { title: 'This item has changed', description: 'Refresh to get the latest version before trying again.', actionLabel: 'Refresh' },
  INTERNAL_ERROR: { title: 'Something went wrong', description: 'Try again in a moment.', actionLabel: 'Try again' },
  FEATURE_DISABLED: { title: 'Feature unavailable', description: 'This feature is currently unavailable for your account.', actionLabel: 'Back to dashboard' },
  TRANSACTIONS_UNAVAILABLE: { title: 'Changes are temporarily unavailable', description: 'Wait a moment before trying to save again.', actionLabel: 'Try again' },
  IDEMPOTENCY_CONFLICT: { title: 'A previous request conflicts', description: 'Refresh to check whether your earlier request succeeded before submitting again.', actionLabel: 'Refresh' },
  AI_QUOTA_EXCEEDED: { title: 'AI usage limit reached', description: 'Try again after your AI usage limit resets.', actionLabel: 'Go back' },
  FOCUS_SESSION_ALREADY_OPEN: { title: 'A focus session is already open', description: 'Resume or end your current session before starting another.', actionLabel: 'Return to session' },
  HEARTBEAT_TOO_FREQUENT: { title: 'Focus update sent too soon', description: 'Wait before sending another session update.', actionLabel: 'Go back' },
  REVISION_CARD_STALE: { title: 'This card has already changed', description: 'Reload your revision deck to see the latest card state.', actionLabel: 'Reload deck' },
  RATE_LIMIT_EXCEEDED: { title: 'Too many requests', description: 'Wait briefly before trying again.', actionLabel: 'Try again' },
};

export function getErrorCopy(code?: string) {
  return code && Object.hasOwn(errorCopy, code) ? errorCopy[code] : errorCopy.INTERNAL_ERROR;
}
