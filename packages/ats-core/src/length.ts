export function countResumeWords(content: string): number {
  // Preserve the backend's existing metadata count for empty and padded content.
  return content.split(/\s+/).length;
}
