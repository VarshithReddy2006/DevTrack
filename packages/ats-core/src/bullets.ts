const bulletMarker = /^\s*(?:[-*+]|\d+[.)])\s+|^\s*[•●▪◦]\s*/;

export function splitBullets(content: string): string[] {
  return content.split(/\r\n?|\n/)
    .filter(line => bulletMarker.test(line))
    .map(line => line.replace(bulletMarker, '').trim())
    .filter(Boolean);
}
