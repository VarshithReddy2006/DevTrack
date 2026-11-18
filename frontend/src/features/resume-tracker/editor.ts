import { renderBulletEdits, type BulletEdit } from '@devtrack/ats-core';

export function editorDocument(bullets: readonly BulletEdit[]) {
  return renderBulletEdits(bullets).split('\n').map(line => line && !line.startsWith('- ') ? `# ${line}` : line).join('\n') || '# Summary\n- ';
}

export function parseEditorDocument(value: string, baseline: readonly BulletEdit[]): BulletEdit[] {
  if (value.length > 212_000) throw new Error('Keep the resume within 200 bullets of 1,000 characters each.');
  let section = 'Summary';
  const result: BulletEdit[] = [];
  const sections = new Map<string, string>();
  const counts = new Map<string, number>();
  const originals = new Map<string, BulletEdit[]>();
  for (const bullet of baseline) {
    const key = bullet.section.toLowerCase();
    originals.set(key, [...(originals.get(key) ?? []), bullet]);
  }
  for (const bullets of originals.values()) bullets.sort((a, b) => a.bulletIndex - b.bulletIndex);
  for (const line of value.split(/\r\n?|\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (/^#{1,6}(?:\s|$)/.test(text)) {
      section = text.replace(/^#+\s*/, '').trim();
      if (!section || section.length > 50) throw new Error('Section headings need 1–50 characters.');
      continue;
    }
    const editedText = text.replace(/^(?:[-*+•]\s*|\d+[.)]\s+)/, '').trim();
    if (!editedText || editedText.length > 1000) throw new Error('Each bullet needs 1–1,000 characters on one line.');
    const key = section.toLowerCase();
    if (!sections.has(key)) sections.set(key, section);
    const bulletIndex = counts.get(key) ?? 0;
    counts.set(key, bulletIndex + 1);
    const originalText = originals.get(key)?.[bulletIndex]?.editedText ?? '';
    result.push({ section: sections.get(key)!, bulletIndex, originalText, editedText });
    if (result.length > 200) throw new Error('A variant can contain at most 200 bullets.');
  }
  if (!result.length) throw new Error('Add at least one bullet before saving.');
  return result;
}

export function profileBullets(summary: string): BulletEdit[] {
  return summary.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean).map((line, bulletIndex) => ({
    section: 'Summary', bulletIndex, originalText: line, editedText: line.replace(/^(?:[-*+•]\s+|\d+[.)]\s+)/, ''),
  }));
}
