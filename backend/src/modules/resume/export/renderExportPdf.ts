import type { Page } from 'puppeteer';
import { logger } from '../../../shared/logger.js';
import { browserPool } from './browserPool.js';

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const RENDER_TIMEOUT_MS = 15_000;
const SECURITY_META = `<meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => HTML_ENTITIES[character]!);
}

export interface RenderPdfOptions {
  /** Print only the first page, so a one-page document can never spill onto a second. */
  singlePage?: boolean;
}

export async function renderExportPdf(html: string, options: RenderPdfOptions = {}): Promise<Buffer> {
  return browserPool.withPage(async (page: Page) => {
    await page.setJavaScriptEnabled(false);
    page.on('request', request => {
      void request.abort().catch(error => logger.warn('[ResumeExportService] Could not abort PDF request', { error: String(error) }));
    });
    await page.setRequestInterception(true);
    await page.setContent(html.replace('<head>', `<head>\n  ${SECURITY_META}`), {
      waitUntil: 'load',
      timeout: RENDER_TIMEOUT_MS,
    });
    const pdf = Buffer.from(await page.pdf({
      format: 'A4',
      printBackground: true,
      ...(options.singlePage ? { pageRanges: '1' } : {}),
      timeout: RENDER_TIMEOUT_MS,
    }));
    if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid export PDF');
    return pdf;
  });
}
