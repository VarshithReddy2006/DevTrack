import puppeteer from 'puppeteer';
import { logger } from '../../../shared/logger.js';

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const RENDER_TIMEOUT_MS = 15_000;
const MAX_ACTIVE_RENDERS = 2;
const SECURITY_META = `<meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`;

let activeRenders = 0;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => HTML_ENTITIES[character]!);
}

export async function renderExportPdf(html: string): Promise<Buffer> {
  if (activeRenders >= MAX_ACTIVE_RENDERS) {
    throw Object.assign(new Error('PDF renderer is busy. Try again shortly.'), { statusCode: 503 });
  }

  activeRenders++;
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox'],
      timeout: RENDER_TIMEOUT_MS,
      protocolTimeout: RENDER_TIMEOUT_MS,
    });
    try {
      const page = await browser.newPage();
      try {
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
          timeout: RENDER_TIMEOUT_MS,
        }));
        if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid export PDF');
        return pdf;
      } finally {
        await page.close().catch(error => logger.warn('[ResumeExportService] Could not close PDF page', { error: String(error) }));
      }
    } finally {
      await browser.close().catch(error => logger.warn('[ResumeExportService] Could not close PDF browser', { error: String(error) }));
    }
  } finally {
    activeRenders--;
  }
}
