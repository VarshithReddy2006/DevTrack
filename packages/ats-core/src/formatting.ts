import type { FormattingWarning, ParserWarning } from './types.js';

export function validateParserSafety(content: string): ParserWarning[] {
  const warnings: ParserWarning[] = [];

  // Check for multi-column layout indicators
  if (hasMultiColumnLayout(content)) {
    warnings.push({
      severity: 'critical',
      message: 'Multi-column layout detected',
      section: 'layout',
      suggestion: 'Use single-column layout for better ATS compatibility',
    });
  }

  // Check for tables
  if (hasTables(content)) {
    warnings.push({
      severity: 'warning',
      message: 'Tables detected in content',
      section: 'formatting',
      suggestion: 'Replace tables with simple text formatting',
    });
  }

  // Check for special characters
  if (hasSpecialCharacters(content)) {
    warnings.push({
      severity: 'info',
      message: 'Special characters detected',
      section: 'content',
      suggestion: 'Minimize use of special characters and symbols',
    });
  }

  // Check for images/graphics references
  if (hasGraphics(content)) {
    warnings.push({
      severity: 'critical',
      message: 'Graphics or images detected',
      section: 'content',
      suggestion: 'Remove all images and graphics for ATS compatibility',
    });
  }

  return warnings;
}

export function validateFormatting(content: string): FormattingWarning[] {
  const warnings: FormattingWarning[] = [];

  // Check for inconsistent heading styles
  if (hasInconsistentHeadings(content)) {
    warnings.push({
      type: 'heading_inconsistency',
      message: 'Inconsistent heading styles detected',
      location: 'document',
      impact: 'medium',
    });
  }

  // Check for excessive formatting
  if (hasExcessiveFormatting(content)) {
    warnings.push({
      type: 'excessive_formatting',
      message: 'Excessive text formatting detected',
      location: 'document',
      impact: 'low',
    });
  }

  // Check for non-standard fonts
  if (hasNonStandardFonts(content)) {
    warnings.push({
      type: 'font_issue',
      message: 'Non-standard fonts may not parse correctly',
      location: 'document',
      impact: 'medium',
    });
  }

  return warnings;
}

function hasMultiColumnLayout(content: string): boolean {
  // Check for excessive horizontal spacing or consecutive blocks of white space
  const lines = content.split('\n');
  let multiColumnLineCount = 0;
  for (const line of lines) {
    if (line.includes('\t\t') || /\s{4,}/.test(line)) {
      multiColumnLineCount++;
      if (multiColumnLineCount >= 3) return true;
    }
  }
  return false;
}

function hasTables(content: string): boolean {
  const lines = content.split('\n');
  let tableLineCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('-')) {
      return true;
    }
    if ((trimmed.match(/\|/g) || []).length >= 2) {
      tableLineCount++;
      if (tableLineCount >= 2) return true;
    }
  }
  if (/\+[-+=]+\+/.test(content) || /\|[-+=]+\|/.test(content)) {
    return true;
  }
  return false;
}

function hasSpecialCharacters(content: string): boolean {
  return /[★☆●○■□▪▫◆◇]/.test(content);
}

function hasGraphics(content: string): boolean {
  const lower = content.toLowerCase();
  const graphicKeywords = ['[image]', '[graphic]', '[logo]', '<img>', '<svg>', 'chart:', 'graph:'];
  if (graphicKeywords.some(kw => lower.includes(kw))) {
    return true;
  }
  if (/\.(png|jpe?g|gif|svg|webp)\b/i.test(content)) {
    return true;
  }
  return false;
}

function hasInconsistentHeadings(content: string): boolean {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const headings: string[] = [];
  const standardSectionRegex = /\b(summary|profile|about|objective|experience|work history|employment|projects|portfolio|skills|technologies|education|certifications)\b/i;

  for (const line of lines) {
    if (line.length < 50 && standardSectionRegex.test(line)) {
      headings.push(line);
    }
  }

  if (headings.length < 2) return false;

  let hasAllCaps = false;
  let hasMixedCase = false;

  for (const h of headings) {
    const cleaned = h.replace(/[^a-zA-Z\s]/g, '').trim();
    if (cleaned.length === 0) continue;
    if (cleaned === cleaned.toUpperCase()) {
      hasAllCaps = true;
    } else {
      hasMixedCase = true;
    }
  }

  return hasAllCaps && hasMixedCase;
}

function hasExcessiveFormatting(content: string): boolean {
  const boldItalicMatches = content.match(/(\*\*|\*|__|_)/g) || [];
  return boldItalicMatches.length > 15;
}

function hasNonStandardFonts(content: string): boolean {
  const lower = content.toLowerCase();
  const badFonts = ['comic sans', 'wingdings', 'webdings', 'zapf dingbats', 'impact', 'papyrus'];
  return badFonts.some(font => lower.includes(font));
}
