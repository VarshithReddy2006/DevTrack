// src/shared/regex.ts — helpers for building RegExp from user supplied text

/**
 * Escape regex metacharacters so user input is matched literally
 * when it is interpolated into a RegExp or a Mongo $regex.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
