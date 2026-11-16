import { describe, it, expect } from 'vitest';
import { layoutPageToText, type PositionedTextItem } from '../../../modules/resume/parsing/pdf-layout.js';

const item = (str: string, x: number, y: number): PositionedTextItem => ({
  str,
  x,
  y,
  width: str.length * 5,
  height: 11,
});

const column = (x: number, y: number, lines: string[]) =>
  lines.map((line, index) => item(line, x, y + index * 18));

describe('layoutPageToText', () => {
  const left = ['Skills', 'Python', 'Go', 'SQL'];
  const right = [
    'Work Experience',
    'Backend Engineer at Acme Corp',
    'Built payment APIs for users',
    'Led migration to PostgreSQL',
  ];

  it('reads the left column before the right column', () => {
    // items come in row order, the way an interleaving extractor would see them
    const items = left.flatMap((_, row) => [column(50, 100, left)[row], column(300, 100, right)[row]]);

    expect(layoutPageToText(items)).toBe([...left, ...right].join('\n'));
  });

  it('does not care about the order of the input items', () => {
    const items = [...column(300, 100, right), ...column(50, 100, left)].reverse();

    expect(layoutPageToText(items)).toBe([...left, ...right].join('\n'));
  });

  it('keeps a full-width header line in place and reads columns below it', () => {
    const header = item('Jane Doe - Software Engineer and Backend Developer', 50, 60);
    const items = [...column(300, 100, right), header, ...column(50, 100, left)];

    expect(layoutPageToText(items)).toBe([header.str, ...left, ...right].join('\n'));
  });

  it('puts a full-width line between two column blocks', () => {
    const footer = item('References available on request from the candidate', 50, 400);
    const items = [...column(50, 100, left), ...column(300, 100, right), footer];

    expect(layoutPageToText(items)).toBe([...left, ...right, footer.str].join('\n'));
  });

  it('works when the columns have a different number of lines', () => {
    const longRight = [...right, 'Mentored junior engineers on cloud skills', 'Wrote internal tooling in Python'];

    expect(layoutPageToText([...column(50, 100, left), ...column(300, 100, longRight)])).toBe(
      [...left, ...longRight].join('\n')
    );
  });

  it('returns null for a single column page', () => {
    const lines = [...left, ...right];

    expect(layoutPageToText(column(50, 100, lines))).toBeNull();
  });

  it('returns null for a single column page with right-aligned dates', () => {
    const items = [
      item('Work Experience', 50, 100),
      item('Backend Engineer at Acme Corp', 50, 118),
      item('Jan 2020 - Present', 450, 118),
      item('Intern at Foo Labs', 50, 136),
      item('Jun 2019 - Dec 2019', 450, 136),
      item('Mentored junior engineers', 50, 154),
      item('Staff Engineer at Bar Inc', 50, 172),
      item('Mar 2023 - Present', 450, 172),
    ];

    expect(layoutPageToText(items)).toBeNull();
  });

  it('returns null when there is too little text to tell', () => {
    expect(layoutPageToText([])).toBeNull();
    expect(layoutPageToText([item('Skills', 50, 100), item('Work Experience', 300, 100)])).toBeNull();
  });

  it('ignores whitespace-only items', () => {
    const spaces = left.map((_, row) => item(' ', 80, 100 + row * 18));

    expect(layoutPageToText([...column(50, 100, left), ...spaces, ...column(300, 100, right)])).toBe(
      [...left, ...right].join('\n')
    );
  });

  it('joins items on the same line with a space only where there is a gap', () => {
    const wordy = (y: number) => [
      { str: 'Hello', x: 300, y, width: 25, height: 11 },
      { str: 'world', x: 330, y, width: 25, height: 11 },
      { str: 'again and again', x: 355, y, width: 75, height: 11 },
    ];
    const items = [
      ...column(50, 100, left),
      ...[100, 118, 136, 154].flatMap(wordy),
    ];

    expect(layoutPageToText(items)?.split('\n').slice(4)).toEqual(Array(4).fill('Hello worldagain and again'));
  });
});
