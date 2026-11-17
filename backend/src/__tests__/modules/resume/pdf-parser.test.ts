import { describe, it, expect, vi } from 'vitest';
import { PDFParser } from '../../../modules/resume/parsing/pdf-parser.js';
import { promises as fs } from 'fs';

const mockGetText = vi.fn().mockResolvedValue({ text: 'Parsed Resume Text' });
const mockGetInfo = vi.fn().mockResolvedValue({ total: 2, info: { Title: 'Resume' } });
const mockDestroy = vi.fn().mockResolvedValue(undefined);
const mockGetDocument = vi.fn();

vi.mock('pdf-parse', () => {
  class MockPDFParse {
    getText = mockGetText;
    getInfo = mockGetInfo;
    destroy = mockDestroy;
  }
  return {
    PDFParse: MockPDFParse
  };
});

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}));

vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn().mockResolvedValue(Buffer.from('dummy')),
  },
}));

vi.mock('../../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('PDFParser', () => {
  it('should parse PDF successfully using modern PDFParse API', async () => {
    const parser = new PDFParser();
    const result = await parser.parse('dummy/path/resume.pdf');

    expect(fs.readFile).toHaveBeenCalledWith('dummy/path/resume.pdf');
    expect(mockGetText).toHaveBeenCalled();
    expect(mockGetInfo).toHaveBeenCalled();
    expect(mockDestroy).toHaveBeenCalled();

    expect(result).toEqual({
      text: 'Parsed Resume Text',
      pages: 2,
      metadata: {
        info: { Title: 'Resume' },
        version: '2.0',
      },
    });
  });

  it('should extract sections correctly', () => {
    const parser = new PDFParser();
    const text = 'John Doe\nSummary\nI am a software engineer.\nExperience\nWorked at TechCorp.';
    const sections = parser.extractSections(text);

    expect(sections.summary).toBe('I am a software engineer.');
    expect(sections.experience).toBe('Worked at TechCorp.');
  });

  it('should extract heading structure correctly', () => {
    const parser = new PDFParser();
    const text = 'John Doe\nSummary\nSome text\nExperience\nSome work';
    const headings = parser.extractHeadings(text);

    expect(headings).toContain('Summary');
    expect(headings).toContain('Experience');
  });

  it('should extract bullets correctly', () => {
    const parser = new PDFParser();
    const text = '• First bullet\n- Second bullet\n1. Numbered bullet\n\tTab bullet';
    const bullets = parser.extractBullets(text);

    expect(bullets[0]).toEqual({ level: 0, text: 'First bullet' });
    expect(bullets[1]).toEqual({ level: 0, text: 'Second bullet' });
    expect(bullets[2]).toEqual({ level: 0, text: 'Numbered bullet' });
  });

  it('should extract links correctly', () => {
    const parser = new PDFParser();
    const text = 'Visit http://google.com or https://github.com/user';
    const links = parser.extractLinks(text);

    expect(links).toContain('http://google.com');
    expect(links).toContain('https://github.com/user');
  });

  it('should extract formatting patterns correctly', () => {
    const parser = new PDFParser();
    const text = 'SUMMARY\n• Bullet\n1. Number\ntest@email.com\n123-456-7890';
    const patterns = parser.extractFormattingPatterns(text);

    expect(patterns.hasUppercaseHeadings).toBe(true);
    expect(patterns.hasBulletPoints).toBe(true);
    expect(patterns.hasNumbering).toBe(true);
    expect(patterns.hasEmail).toBe(true);
  });
  describe('section heading detection', () => {
    it('does not start a section from a bullet that mentions a section word', () => {
      const parser = new PDFParser();
      const text = [
        'John Doe',
        'Work Experience',
        'Backend Engineer, Acme Corp',
        '- Mentored junior engineers and expanded team competencies in cloud technologies and full-stack skills',
        '• Shipped the billing service and improved education platform uptime',
        'Led a squad that owns the experience layer of the product.',
        'Education',
        'B.Tech Computer Science',
      ].join('\n');

      const sections = parser.extractSections(text);

      expect(Object.keys(sections)).toEqual(['header', 'experience', 'education']);
      expect(sections.experience).toContain('Mentored junior engineers');
      expect(sections.experience).toContain('billing service');
      expect(sections.experience).toContain('experience layer');
      expect(sections.education).toBe('B.Tech Computer Science');
      expect(sections.skills).toBeUndefined();
    });

    it.each([
      ['Work Experience', 'experience'],
      ['WORK EXPERIENCE', 'experience'],
      ['Technical Skills', 'skills'],
      ['Skills & Technologies', 'skills'],
      ['skills', 'skills'],
      ['Education:', 'education'],
      ['PROJECTS', 'projects'],
      ['Professional Summary', 'summary'],
      ['Certifications', 'certifications'],
    ])('still detects the heading "%s"', (heading, section) => {
      const parser = new PDFParser();

      const sections = parser.extractSections(`Jane Doe\n${heading}\nsome content`);

      expect(sections.header).toBe('Jane Doe');
      expect(sections[section]).toBe('some content');
    });

    it('rejects lines that are not heading shaped', () => {
      const parser = new PDFParser();
      const notHeadings = [
        'Experience with React and Node.js',
        'Skills in cloud',
        'Skills.',
        'Experience, projects and skills',
        '1. Skills',
        '2020 Experience',
        '* Education',
        '– Projects',
        'Led Skills Workshops Across Teams',
        'Developed the skills matrix for the whole organisation',
      ];

      for (const line of notHeadings) {
        expect(Object.keys(parser.extractSections(`Name\n${line}\ntext`))).toEqual(['header']);
      }
    });

    it('treats isSectionHeading as a structural check', () => {
      const parser = new PDFParser();

      expect(parser.isSectionHeading('Work Experience')).toBe(true);
      expect(parser.isSectionHeading('  WORK   EXPERIENCE  ')).toBe(true);
      expect(parser.isSectionHeading('Skills:')).toBe(true);
      expect(parser.isSectionHeading('')).toBe(false);
      expect(parser.isSectionHeading('- Skills')).toBe(false);
      expect(parser.isSectionHeading('Skills,')).toBe(false);
      expect(parser.isSectionHeading('a b c d e f')).toBe(false);
      expect(parser.isSectionHeading('A'.repeat(50))).toBe(false);
    });

    it('keeps multi-line entries together inside a section', () => {
      const parser = new PDFParser();
      const text = [
        'Experience',
        'Backend Engineer, Acme Corp',
        'Built payment APIs that handle',
        'two million requests a day and improved skills',
        'of the whole team through weekly reviews',
        'Skills',
        'Go',
      ].join('\n');

      const sections = parser.extractSections(text);

      expect(sections.experience).toBe(
        [
          'Backend Engineer, Acme Corp',
          'Built payment APIs that handle',
          'two million requests a day and improved skills',
          'of the whole team through weekly reviews',
        ].join('\n')
      );
      expect(sections.skills).toBe('Go');
    });

    it('does not report bullets as headings', () => {
      const parser = new PDFParser();
      const text = 'Experience\n- Improved team skills and education\nSkills\nGo';

      expect(parser.extractHeadings(text)).toEqual(['Experience', 'Skills']);
    });
  });

  describe('multi-column pages', () => {
    const item = (str: string, x: number, y: number) => ({
      str,
      transform: [1, 0, 0, 1, x, 800 - y],
      width: str.length * 5,
      height: 11,
    });

    const fakeDocument = (items: ReturnType<typeof item>[]) => ({
      numPages: 1,
      getPage: vi.fn().mockResolvedValue({
        getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, 800 - y] }),
        getTextContent: vi.fn().mockResolvedValue({ items }),
        cleanup: vi.fn(),
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    // pdf-parse output when the two columns are glued together row by row
    const interleaved =
      'Skills Work Experience\n' +
      'Python Backend Engineer at Acme Corp\n' +
      'Go Built payment APIs for users\n' +
      'SQL Mentored junior engineers on cloud skills\n' +
      'Docker Led migration to PostgreSQL';
    const pageMarker = '\n-- 1 of 1 --\n\n';

    const twoColumnItems = [
      item('Skills', 50, 100),
      item('Work Experience', 300, 100),
      item('Python', 50, 118),
      item('Backend Engineer at Acme Corp', 300, 118),
      item('Go', 50, 136),
      item('Built payment APIs for users', 300, 136),
      item('SQL', 50, 154),
      item('Mentored junior engineers on cloud skills', 300, 154),
      item('Docker', 50, 172),
      item('Led migration to PostgreSQL', 300, 172),
    ];

    it('returns two-column pages in reading order', async () => {
      mockGetText.mockResolvedValueOnce({
        text: interleaved + pageMarker,
        pages: [{ num: 1, text: interleaved }],
      });
      mockGetDocument.mockReturnValueOnce({ promise: Promise.resolve(fakeDocument(twoColumnItems)) });

      const result = await new PDFParser().parse('dummy/two-column.pdf');

      expect(result.text).toBe(
        [
          'Skills',
          'Python',
          'Go',
          'SQL',
          'Docker',
          'Work Experience',
          'Backend Engineer at Acme Corp',
          'Built payment APIs for users',
          'Mentored junior engineers on cloud skills',
          'Led migration to PostgreSQL',
        ].join('\n') + pageMarker
      );

      const parser = new PDFParser();
      const sections = parser.extractSections(result.text);
      expect(sections.skills).toBe('Python\nGo\nSQL\nDocker');
      expect(sections.experience).toContain('Led migration to PostgreSQL');
    });

    it('keeps a full-width header line above the columns', async () => {
      mockGetText.mockResolvedValueOnce({
        text: 'Jane Doe Software Engineer and Backend Developer\n' + interleaved + pageMarker,
        pages: [{ num: 1, text: 'Jane Doe Software Engineer and Backend Developer\n' + interleaved }],
      });
      mockGetDocument.mockReturnValueOnce({
        promise: Promise.resolve(
          fakeDocument([item('Jane Doe Software Engineer and Backend Developer', 50, 60), ...twoColumnItems])
        ),
      });

      const result = await new PDFParser().parse('dummy/header.pdf');

      expect(result.text.split('\n').slice(0, 3)).toEqual([
        'Jane Doe Software Engineer and Backend Developer',
        'Skills',
        'Python',
      ]);
      expect(result.text.indexOf('Docker')).toBeLessThan(result.text.indexOf('Work Experience'));
    });

    it('leaves a single column page untouched', async () => {
      const singleColumn = 'Work Experience\nBackend Engineer at Acme Corp Jan 2020 - Present\nBuilt payment APIs\nEducation\nMIT 2018 - 2022\nProjects';
      mockGetText.mockResolvedValueOnce({
        text: singleColumn + pageMarker,
        pages: [{ num: 1, text: singleColumn }],
      });
      mockGetDocument.mockReturnValueOnce({
        promise: Promise.resolve(
          fakeDocument([
            item('Work Experience', 50, 100),
            item('Backend Engineer at Acme Corp', 50, 118),
            item('Jan 2020 - Present', 450, 118),
            item('Built payment APIs', 50, 136),
            item('Education', 50, 154),
            item('MIT', 50, 172),
            item('2018 - 2022', 450, 172),
            item('Projects', 50, 190),
          ])
        ),
      });

      const result = await new PDFParser().parse('dummy/single.pdf');

      expect(result.text).toBe(singleColumn + pageMarker);
    });

    it('falls back to the default text when layout reading fails', async () => {
      mockGetText.mockResolvedValueOnce({
        text: interleaved + pageMarker,
        pages: [{ num: 1, text: interleaved }],
      });
      mockGetDocument.mockImplementationOnce(() => ({ promise: Promise.reject(new Error('bad pdf')) }));

      const result = await new PDFParser().parse('dummy/broken.pdf');

      expect(result.text).toBe(interleaved + pageMarker);
    });
  });
});
