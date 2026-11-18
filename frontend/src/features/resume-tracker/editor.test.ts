import { expect, it } from 'vitest';
import { editorDocument, parseEditorDocument, profileBullets } from './editor';

const baseline = [
  { section: 'Experience', bulletIndex: 1, originalText: '', editedText: 'Reduced latency by 20%.' },
  { section: 'experience', bulletIndex: 0, originalText: '', editedText: 'Built APIs.' },
  { section: 'Projects', bulletIndex: 0, originalText: '', editedText: 'Created a parser.' },
];

it('round-trips saved sections in server order and compares against the saved edited text', () => {
  const text = editorDocument(baseline);
  expect(text).toBe('# Experience\n- Built APIs.\n- Reduced latency by 20%.\n\n# Projects\n- Created a parser.');
  expect(parseEditorDocument(text.replace('Built APIs.', 'Built secure APIs.'), baseline)).toEqual([
    { section: 'Experience', bulletIndex: 0, originalText: 'Built APIs.', editedText: 'Built secure APIs.' },
    { section: 'Experience', bulletIndex: 1, originalText: 'Reduced latency by 20%.', editedText: 'Reduced latency by 20%.' },
    { section: 'Projects', bulletIndex: 0, originalText: 'Created a parser.', editedText: 'Created a parser.' },
  ]);
});

it('keeps repeated heading indexes unique and handles CRLF and new bullets', () => {
  expect(parseEditorDocument('# Projects\r\n1. Created a parser.\r\n# projects\r\n• Shipped a CLI.', baseline)).toMatchObject([
    { section: 'Projects', bulletIndex: 0, originalText: 'Created a parser.' },
    { section: 'Projects', bulletIndex: 1, originalText: '', editedText: 'Shipped a CLI.' },
  ]);
});

it('keeps the saved text as the baseline when a variant uses non-contiguous indexes', () => {
  const saved = [{ ...baseline[0], bulletIndex: 42 }];
  expect(parseEditorDocument(editorDocument(saved), saved)[0]).toMatchObject({ bulletIndex: 0, originalText: 'Reduced latency by 20%.' });
});

it('accepts the complete server-sized payload without truncating text or headings', () => {
  const saved = Array.from({ length: 200 }, (_, i) => ({ section: `${i}`.padEnd(50, 'x'), bulletIndex: 0, originalText: '', editedText: 'x'.repeat(1000) }));
  const parsed = parseEditorDocument(editorDocument(saved), saved);
  expect(parsed).toHaveLength(200);
  expect(parsed[199]).toMatchObject({ section: saved[199].section, editedText: saved[199].editedText, originalText: saved[199].editedText });
});

it.each([
  ['', /at least one/], ['# Experience\n- ', /1–1,000/],
  [`# ${'x'.repeat(51)}\n- text`, /1–50/],
  [`- ${'x'.repeat(1001)}`, /1–1,000/],
  [Array.from({ length: 201 }, () => '- text').join('\n'), /at most 200/],
])('rejects content outside the server limits without truncating it', (text, message) => {
  expect(() => parseEditorDocument(text, [])).toThrow(message);
});

it('loads the actual profile summary without inventing project bullets or truncating content', () => {
  expect(profileBullets('- Built APIs.\n\nReduced latency by 20%.').map(bullet => bullet.editedText)).toEqual(['Built APIs.', 'Reduced latency by 20%.']);
  expect(profileBullets('x'.repeat(1001))[0].editedText).toHaveLength(1001);
});
