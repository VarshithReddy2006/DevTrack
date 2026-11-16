/**
 * Column-aware text ordering for PDF pages.
 *
 * pdf-parse hands text back in content-stream order and its public API does not
 * expose item positions, so on a side-by-side layout the left and right column
 * can end up on the same output line. These helpers take positioned text items
 * (top-left origin, in points), look for a vertical gutter and, if there is one,
 * return the page text with the left column first and then the right column.
 */

export interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TextLine {
  y: number;
  items: PositionedTextItem[];
}

// A gutter has to be at least this wide (points) to count as a column break.
const MIN_GUTTER_WIDTH = 12;
// Both columns need at least this many lines, otherwise it is not a column layout.
const MIN_LINES_PER_COLUMN = 3;
// The right-hand column has to be running text: most of its lines need at least this
// many words. This keeps a single column resume with right-aligned dates or
// locations ("Jan 2020 - Present") from being read as two columns.
const MIN_WORDS_PER_TEXT_LINE = 3;
// Share of items allowed to cross the gutter (full-width header lines).
const MAX_SPANNING_RATIO = 0.15;
// Only look for the gutter in the middle part of the text block.
const GUTTER_SEARCH_MARGIN = 0.1;
const MIN_ITEMS = 6;

function groupIntoLines(items: PositionedTextItem[]): TextLine[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: TextLine[] = [];

  for (const item of sorted) {
    const current = lines[lines.length - 1];
    const tolerance = Math.max(2, item.height * 0.5);
    if (current && Math.abs(item.y - current.y) <= tolerance) {
      current.items.push(item);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
  }
  return lines;
}

function lineToString(line: TextLine): string {
  let text = '';
  let previousRight: number | undefined;
  for (const item of line.items) {
    if (previousRight !== undefined && item.x - previousRight > Math.max(1, item.height * 0.2)) {
      text += ' ';
    }
    text += item.str;
    previousRight = item.x + item.width;
  }
  return text.trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(word => /[A-Za-z]{2,}/.test(word)).length;
}

/**
 * Find the x range of the gutter between two columns, or null for a single column page.
 */
function findGutter(items: PositionedTextItem[]): { start: number; end: number } | null {
  if (items.length < MIN_ITEMS) return null;

  const minX = Math.min(...items.map(i => i.x));
  const maxX = Math.max(...items.map(i => i.x + i.width));
  const extent = maxX - minX;
  if (extent <= 0) return null;

  // Coverage of every whole point across the text block, via a difference array.
  const size = Math.ceil(extent) + 2;
  const diff = new Array<number>(size + 1).fill(0);
  for (const item of items) {
    const from = Math.max(0, Math.floor(item.x - minX));
    const to = Math.min(size - 1, Math.ceil(item.x + item.width - minX));
    diff[from] += 1;
    diff[to] -= 1;
  }

  const tolerance = Math.max(1, Math.floor(items.length * MAX_SPANNING_RATIO));
  const searchFrom = Math.floor(extent * GUTTER_SEARCH_MARGIN);
  const searchTo = Math.ceil(extent * (1 - GUTTER_SEARCH_MARGIN));

  let best: { start: number; end: number } | null = null;
  let runStart = -1;
  let coverage = 0;
  for (let x = 0; x <= searchTo + 1; x++) {
    coverage += diff[x] ?? 0;
    const open = x >= searchFrom && x <= searchTo && coverage <= tolerance;
    if (open && runStart < 0) runStart = x;
    if (!open && runStart >= 0) {
      if (x - runStart >= MIN_GUTTER_WIDTH && (!best || x - runStart > best.end - best.start)) {
        best = { start: runStart, end: x };
      }
      runStart = -1;
    }
  }
  if (!best) return null;

  return { start: best.start + minX, end: best.end + minX };
}

/**
 * Return the page text in column reading order (left column, then right column,
 * full-width lines kept in place), or null when the page is not a two-column layout.
 */
export function layoutPageToText(items: PositionedTextItem[]): string | null {
  const usable = items.filter(item => item.str.trim().length > 0);
  const gutter = findGutter(usable);
  if (!gutter) return null;

  const middle = (gutter.start + gutter.end) / 2;
  const spanning = usable.filter(i => i.x < middle && i.x + i.width > middle);
  const columns = usable.filter(i => !spanning.includes(i));
  const left = columns.filter(i => i.x + i.width / 2 < middle);
  const right = columns.filter(i => i.x + i.width / 2 >= middle);

  const leftLines = groupIntoLines(left);
  const rightLines = groupIntoLines(right);
  if (leftLines.length < MIN_LINES_PER_COLUMN || rightLines.length < MIN_LINES_PER_COLUMN) {
    return null;
  }
  const textLines = rightLines.filter(line => wordCount(lineToString(line)) >= MIN_WORDS_PER_TEXT_LINE);
  if (textLines.length < MIN_LINES_PER_COLUMN || textLines.length * 2 < rightLines.length) {
    return null;
  }

  // Full-width lines (name/title header, etc.) split the page into bands. Inside a
  // band the left column is read before the right column.
  const spanLines = groupIntoLines(spanning);
  const bandOf = (item: PositionedTextItem) => spanLines.filter(s => s.y <= item.y).length;
  const out: string[] = [];

  for (let band = 0; band <= spanLines.length; band++) {
    for (const side of [left, right]) {
      const bandItems = side.filter(item => bandOf(item) === band);
      for (const line of groupIntoLines(bandItems)) {
        out.push(lineToString(line));
      }
    }
    if (band < spanLines.length) {
      out.push(lineToString(spanLines[band]));
    }
  }

  return out.filter(line => line.length > 0).join('\n');
}
