import { PDFParse } from 'pdf-parse';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { promises as fs } from 'fs';
import { logger } from '../../../shared/logger.js';
import { layoutPageToText, type PositionedTextItem } from './pdf-layout.js';

export interface IParsedPDF {
  text: string;
  pages: number;
  metadata: {
    [key: string]: any;
  };
}

// A section heading is a short, standalone line. Anything longer is body text that
// just happens to contain a section word ("...expanded team competencies and skills").
const MAX_HEADING_LENGTH = 50;
const MAX_HEADING_WORDS = 5;
// Words allowed next to the section keyword ("Work Experience", "Skills and Tools").
const MAX_EXTRA_HEADING_WORDS = 2;
const BULLET_OR_NUMBER_PREFIX = /^([-*•·▪●◦–—]|\d)/;
const SENTENCE_TERMINATOR = /[.;,!?]$/;
const CONNECTOR_WORDS = new Set(['and', 'of', 'the', '&']);

/**
 * PDFParser
 * 
 * Extracts text, sections, heading structure, bullet hierarchy, links, and formatting patterns from PDF files
 */
export class PDFParser {
  /**
   * Parse PDF file
   */
  async parse(filePath: string): Promise<IParsedPDF> {
    logger.info(`[PDFParser] Parsing PDF: ${filePath}`);

    try {
      const dataBuffer = await fs.readFile(filePath);
      const parser = new PDFParse({ data: new Uint8Array(dataBuffer) });

      try {
        const textResult = await parser.getText();
        const infoResult = await parser.getInfo();
        const text = await this.applyColumnLayout(dataBuffer, textResult.text, textResult.pages);

        const result: IParsedPDF = {
          text,
          pages: infoResult.total || 1,
          metadata: {
            info: infoResult.info || {},
            version: '2.0',
          },
        };

        logger.info(`[PDFParser] Parsed ${infoResult.total || 1} pages, ${text.length} characters`);

        return result;
      } finally {
        await parser.destroy().catch((err: any) => {
          logger.warn('[PDFParser] Error destroying parser:', err);
        });
      }
    } catch (error) {
      logger.error('[PDFParser] Error parsing PDF:', error);
      throw new Error(`PDF parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Re-read the text of side-by-side (two column) pages in column order.
   * Single column pages and any failure keep the text pdf-parse returned.
   */
  private async applyColumnLayout(
    dataBuffer: Buffer,
    text: string,
    pages: { num: number; text: string }[] | undefined
  ): Promise<string> {
    if (!pages || pages.length === 0) return text;

    try {
      const layouts = new Map<number, string>();
      const doc = await getDocument({ data: new Uint8Array(dataBuffer), verbosity: 0 }).promise;
      try {
        for (const { num } of pages) {
          const page = await doc.getPage(num);
          const viewport = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          const items: PositionedTextItem[] = [];
          for (const item of content.items) {
            if (!('str' in item)) continue;
            const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
            items.push({ str: item.str, x, y, width: item.width, height: item.height });
          }
          page.cleanup();

          const layout = layoutPageToText(items);
          if (layout !== null) layouts.set(num, layout);
        }
      } finally {
        await doc.destroy();
      }

      if (layouts.size === 0) return text;

      // Swap the reordered page text into the original output, keeping page markers as is.
      let out = '';
      let cursor = 0;
      for (const page of pages) {
        const at = text.indexOf(page.text, cursor);
        if (at < 0) return text;
        out += text.slice(cursor, at) + (layouts.get(page.num) ?? page.text);
        cursor = at + page.text.length;
      }
      return out + text.slice(cursor);
    } catch (error) {
      logger.warn('[PDFParser] Column layout detection failed, using default text order:', error as any);
      return text;
    }
  }

  /**
   * Check whether a line is shaped like a section heading: short, not a bullet or
   * numbered item, no sentence punctuation at the end, and consistently cased
   * (Title Case / UPPER CASE, or all lowercase).
   */
  isSectionHeading(line: string): boolean {
    const normalized = line.replace(/\s+/g, ' ').trim().replace(/:$/, '').trim();
    if (normalized.length === 0 || normalized.length >= MAX_HEADING_LENGTH) return false;
    if (BULLET_OR_NUMBER_PREFIX.test(normalized) || SENTENCE_TERMINATOR.test(normalized)) return false;

    const words = normalized.split(' ');
    if (words.length > MAX_HEADING_WORDS) return false;

    const cased = words.filter(word => !CONNECTOR_WORDS.has(word.toLowerCase()) && /[A-Za-z]/.test(word));
    const startsUpper = (word: string) => /^[^A-Za-z]*[A-Z]/.test(word);
    return cased.every(startsUpper) || cased.every(word => !startsUpper(word));
  }

  /**
   * A heading line must be mostly the section keyword, not a short sentence that
   * contains it ("Experience with React" is not an Experience heading).
   */
  private isKeywordHeading(line: string, pattern: RegExp): boolean {
    if (!this.isSectionHeading(line) || !pattern.test(line)) return false;

    const rest = line
      .replace(pattern, ' ')
      .split(/[^A-Za-z]+/)
      .filter(word => word.length > 0 && !CONNECTOR_WORDS.has(word.toLowerCase()));
    return rest.length <= MAX_EXTRA_HEADING_WORDS;
  }

  /**
   * Extract sections from parsed text
   */
  extractSections(text: string): { [key: string]: string } {
    const sections: { [key: string]: string } = {};
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    let currentSection = 'header';
    let currentContent: string[] = [];

    const sectionPatterns = {
      summary: /\b(summary|profile|about|objective|professional summary)\b/i,
      experience: /\b(experience|work history|employment|career history|work experience)\b/i,
      projects: /\b(projects|portfolio|personal projects|project experience)\b/i,
      skills: /\b(skills|technologies|technical skills|competencies|core skills)\b/i,
      education: /\b(education|academic|studies|academic background)\b/i,
      certifications: /\b(certifications|certificates|credentials)\b/i,
    };

    for (const line of lines) {
      let foundSection = false;

      for (const [sectionName, pattern] of Object.entries(sectionPatterns)) {
        if (this.isKeywordHeading(line, pattern)) {
          // Save previous section
          if (currentContent.length > 0) {
            sections[currentSection] = currentContent.join('\n');
          }

          // Start new section
          currentSection = sectionName;
          currentContent = [];
          foundSection = true;
          break;
        }
      }

      if (!foundSection) {
        currentContent.push(line);
      }
    }

    // Save last section
    if (currentContent.length > 0) {
      sections[currentSection] = currentContent.join('\n');
    }

    return sections;
  }

  /**
   * Extract heading structure
   */
  extractHeadings(text: string): string[] {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const headings: string[] = [];

    const headingPatterns = [
      /\b(summary|profile|about|objective)\b/i,
      /\b(experience|work history|employment)\b/i,
      /\b(projects|portfolio)\b/i,
      /\b(skills|technologies|technical skills)\b/i,
      /\b(education|academic)\b/i,
      /\b(certifications|certificates)\b/i,
    ];

    for (const line of lines) {
      for (const pattern of headingPatterns) {
        if (this.isKeywordHeading(line, pattern)) {
          headings.push(line);
          break;
        }
      }
    }

    return headings;
  }

  /**
   * Extract bullet hierarchy
   */
  extractBullets(text: string): { level: number; text: string }[] {
    const lines = text.split('\n');
    const bullets: { level: number; text: string }[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Check for bullet points
      if (trimmed.startsWith('•') || trimmed.startsWith('-') || trimmed.startsWith('*')) {
        bullets.push({ level: 0, text: trimmed.substring(1).trim() });
      } else if (/^\d+\./.test(trimmed)) {
        bullets.push({ level: 0, text: trimmed.replace(/^\d+\.\s*/, '') });
      } else if (trimmed.startsWith('\t')) {
        const level = (trimmed.match(/^\t*/)?.[0]?.length || 0);
        bullets.push({ level, text: trimmed.replace(/^\t*/, '') });
      }
    }

    return bullets;
  }

  /**
   * Extract links
   */
  extractLinks(text: string): string[] {
    const urlPattern = /(https?:\/\/)?(www\.)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/\S*)?/g;
    const matches = text.match(urlPattern) || [];
    return matches;
  }

  /**
   * Extract formatting patterns
   */
  extractFormattingPatterns(text: string): { [key: string]: boolean } {
    return {
      hasUppercaseHeadings: /^[A-Z\s]+$/.test(text.split('\n')[0] || ''),
      hasBulletPoints: /[•\-*]/.test(text),
      hasNumbering: /^\d+\./m.test(text),
      hasEmail: /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text),
      hasPhone: /^[\d\s()+-]{7,20}$/m.test(text),
    };
  }
}
