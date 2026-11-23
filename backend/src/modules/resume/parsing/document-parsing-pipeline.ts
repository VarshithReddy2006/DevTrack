// src/modules/resume-intelligence/parsing/document-parsing-pipeline.ts
import { PDFParser } from './pdf-parser.js';
import { NonRetryableResumeOcrError } from './ocr-fallback.js';
import { DOCXParser } from './docx-parser.js';
import { TextParser } from './text-parser.js';
import { logger } from '../../../shared/logger.js';

export interface IParsedDocument {
  sessionId: string;
  originalFilename: string;
  fileType: 'pdf' | 'docx' | 'txt' | 'md';
  text: string;
  sections: { [key: string]: string };
  headings: string[];
  bullets: { level: number; text: string }[];
  links: string[];
  metadata: {
    pages?: number;
    isMarkdown?: boolean;
    [key: string]: any;
  };
  parsingDiagnostics: {
    confidence: number;
    warnings: string[];
    errors: string[];
  };
  extractedAt: Date;
}

export interface IParsingResult {
  success: boolean;
  document?: IParsedDocument;
  error?: string;
  retryable?: false;
}

/**
 * DocumentParsingPipeline
 * 
 * Orchestrates file-type routing, extraction normalization, text cleaning, 
 * formatting preservation, parsing diagnostics, and extraction confidence calculation
 */
export class DocumentParsingPipeline {
  private pdfParser: PDFParser;
  private docxParser: DOCXParser;
  private textParser: TextParser;

  constructor() {
    this.pdfParser = new PDFParser();
    this.docxParser = new DOCXParser();
    this.textParser = new TextParser();
  }

  /**
   * Parse document based on file type
   */
  async parse(
    sessionId: string,
    filePath: string,
    originalFilename: string
  ): Promise<IParsingResult> {
    logger.info(`[DocumentParsingPipeline] Parsing document: ${originalFilename}`);

    try {
      const fileType = this.detectFileType(originalFilename);
      const warnings: string[] = [];
      const errors: string[] = [];

      let parsedDocument: IParsedDocument;

      switch (fileType) {
        case 'pdf':
          parsedDocument = await this.parsePDF(sessionId, filePath, originalFilename, warnings, errors);
          break;
        case 'docx':
          parsedDocument = await this.parseDOCX(sessionId, filePath, originalFilename, warnings, errors);
          break;
        case 'txt':
        case 'md':
          parsedDocument = await this.parseText(sessionId, filePath, originalFilename, warnings, errors);
          break;
        default:
          throw new Error(`Unsupported file type: ${fileType}`);
      }

      // Calculate extraction confidence
      const confidence = this.calculateExtractionConfidence(parsedDocument, warnings, errors);

      parsedDocument.parsingDiagnostics = {
        confidence,
        warnings,
        errors,
      };

      logger.info(`[DocumentParsingPipeline] Parsing complete: ${originalFilename}, confidence: ${confidence}%`);

      return {
        success: true,
        document: parsedDocument,
      };
    } catch (error) {
      logger.error('[DocumentParsingPipeline] Parsing error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown parsing error',
        ...(error instanceof NonRetryableResumeOcrError ? { retryable: false as const } : {}),
      };
    }
  }

  /**
   * Detect file type from filename
   */
  private detectFileType(filename: string): 'pdf' | 'docx' | 'txt' | 'md' {
    const ext = filename.toLowerCase().split('.').pop();
    
    switch (ext) {
      case 'pdf':
        return 'pdf';
      case 'docx':
        return 'docx';
      case 'txt':
        return 'txt';
      case 'md':
        return 'md';
      default:
        throw new Error(`Unknown file extension: ${ext}`);
    }
  }

  /**
   * Parse PDF
   */
  private async parsePDF(
    sessionId: string,
    filePath: string,
    originalFilename: string,
    warnings: string[],
    errors: string[]
  ): Promise<IParsedDocument> {
    const pdfResult = await this.pdfParser.parse(filePath);
    
    const text = this.cleanText(pdfResult.text);
    const sections = this.pdfParser.extractSections(text);
    const headings = this.pdfParser.extractHeadings(text);
    const bullets = this.pdfParser.extractBullets(text);
    const links = this.pdfParser.extractLinks(text);
    const formattingPatterns = this.pdfParser.extractFormattingPatterns(text);

    // Add warnings for formatting issues
    if (!formattingPatterns.hasBulletPoints) {
      warnings.push('No bullet points detected - may affect ATS parsing');
    }
    if (!formattingPatterns.hasEmail) {
      warnings.push('No email detected in document');
    }
    if (!formattingPatterns.hasPhone) {
      warnings.push('No phone number detected in document');
    }

    return {
      sessionId,
      originalFilename,
      fileType: 'pdf',
      text,
      sections,
      headings,
      bullets,
      links,
      metadata: {
        pages: pdfResult.pages,
        ...pdfResult.metadata,
      },
      parsingDiagnostics: {
        confidence: 0,
        warnings,
        errors,
      },
      extractedAt: new Date(),
    };
  }

  /**
   * Parse DOCX
   */
  private async parseDOCX(
    sessionId: string,
    filePath: string,
    originalFilename: string,
    warnings: string[],
    errors: string[]
  ): Promise<IParsedDocument> {
    const docxResult = await this.docxParser.parse(filePath);
    
    const text = this.cleanText(docxResult.text);

    return {
      sessionId,
      originalFilename,
      fileType: 'docx',
      text,
      sections: docxResult.sections,
      headings: docxResult.headings,
      bullets: docxResult.bullets,
      links: docxResult.links,
      metadata: {},
      parsingDiagnostics: {
        confidence: 0,
        warnings,
        errors,
      },
      extractedAt: new Date(),
    };
  }

  /**
   * Parse Text (TXT/MD)
   */
  private async parseText(
    sessionId: string,
    filePath: string,
    originalFilename: string,
    warnings: string[],
    errors: string[]
  ): Promise<IParsedDocument> {
    const textResult = await this.textParser.parse(filePath);
    
    const text = this.cleanText(textResult.text);

    return {
      sessionId,
      originalFilename,
      fileType: textResult.isMarkdown ? 'md' : 'txt',
      text,
      sections: textResult.sections,
      headings: textResult.headings,
      bullets: textResult.bullets,
      links: textResult.links,
      metadata: {
        isMarkdown: textResult.isMarkdown,
      },
      parsingDiagnostics: {
        confidence: 0,
        warnings,
        errors,
      },
      extractedAt: new Date(),
    };
  }

  /**
   * Clean and normalize text
   */
  private cleanText(text: string): string {
    return text
      .replace(/\r\n/g, '\n') // Normalize line endings
      .replace(/\n{3,}/g, '\n\n') // Remove excessive blank lines
      .replace(/[^\x20-\x7E\n]/g, '') // Remove non-ASCII characters (optional)
      .trim();
  }

  /**
   * Calculate extraction confidence
   */
  private calculateExtractionConfidence(
    document: IParsedDocument,
    warnings: string[],
    errors: string[]
  ): number {
    let confidence = 100;

    // Deduct for errors
    confidence -= errors.length * 20;

    // Deduct for warnings
    confidence -= warnings.length * 5;

    // Check for essential sections
    const essentialSections = ['experience', 'skills', 'education'];
    const missingEssential = essentialSections.filter(section => !document.sections[section]);
    confidence -= missingEssential.length * 10;

    // Check for content quality
    if (document.text.length < 500) {
      confidence -= 20;
      warnings.push('Document text is very short (< 500 characters)');
    }

    if (document.headings.length < 3) {
      confidence -= 10;
      warnings.push('Few headings detected - may affect section extraction');
    }

    return Math.max(0, Math.min(100, confidence));
  }
}
