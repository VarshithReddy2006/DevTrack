/** Same rule as SLUG_PATTERN in backend/src/db/models/usernameReservation.model.ts. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/** The server trims and lowercases the handle before checking it, so do the same here. */
export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

export type SlugCheck = { valid: true } | { valid: false; message: string };

export function validateSlug(input: string): SlugCheck {
  const slug = normalizeSlug(input);
  if (slug.length === 0) return { valid: false, message: 'Pick a handle for your public URL.' };
  if (slug.length < 3) return { valid: false, message: 'Handles need at least 3 characters.' };
  if (slug.length > 30) return { valid: false, message: 'Handles can be at most 30 characters.' };
  if (!SLUG_PATTERN.test(slug)) {
    return { valid: false, message: 'Use lowercase letters, numbers and hyphens, starting and ending with a letter or number.' };
  }
  return { valid: true };
}
