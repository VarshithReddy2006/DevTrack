import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import path from 'node:path';

const fixture = path.resolve(process.cwd(), 'e2e/fixtures/sample-resume.pdf');
const auth = { Authorization: 'Bearer devtrack-e2e-token' };

async function upload(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto('/resume');
  await expect(page.getByRole('button', { name: 'Choose Resume' })).toBeVisible();
  const response = page.waitForResponse(reply =>
    reply.request().method() === 'POST' && reply.url().endsWith('/api/resume/upload'));
  await page.locator('#resume-upload').setInputFiles(file);
  const uploadReply = await response;
  expect(uploadReply.status()).toBe(200);
  const body = await uploadReply.json();
  expect(body.data.sessionId).toMatch(/^[a-f0-9]{32}$/);
  return body.data.sessionId as string;
}

async function savedSession(request: APIRequestContext, sessionId: string) {
  const reply = await request.get(`/api/resume/session/${sessionId}`, { headers: auth });
  expect(reply.ok()).toBe(true);
  return (await reply.json()).data;
}

test('an authenticated upload reaches a persisted ATS analysis and dossier', async ({ page, request }) => {
  const sessionId = await upload(page, fixture);

  await expect(page).toHaveURL(new RegExp(`/resume/analysis/${sessionId}$`), { timeout: 120_000 });
  await expect.poll(async () => {
    const session = await savedSession(request, sessionId);
    return session.currentStage;
  }, { timeout: 30_000 }).toBe('COMPLETED');

  const session = await savedSession(request, sessionId);
  expect(session.uploadMetadata.originalFilename).toBe('sample-resume.pdf');
  expect(session.parsedContent.text).toContain('Alex Example');
  expect(session.atsState.analyzed).toBe(true);
  expect(session.atsState.atsScore).toBeGreaterThan(0);
  expect(session.reportState.generated).toBe(true);
  expect(session.reportState.reportData.finalVerdict).toBeTruthy();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Resume Analysis Complete' })).toBeVisible();
  expect((await savedSession(request, sessionId)).reportState.generated).toBe(true);
});

test('a parser failure is persisted and shown as an actionable error', async ({ page, request }) => {
  const sessionId = await upload(page, {
    name: 'broken.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\ninvalid document body\n'),
  });

  await expect.poll(async () => {
    const session = await savedSession(request, sessionId);
    return session.currentStage;
  }, { timeout: 60_000 }).toBe('FAILED');
  const session = await savedSession(request, sessionId);
  expect(session.failureState.failed).toBe(true);
  expect(session.failureState.failureReason).toMatch(/PDF parsing failed|Parsing failed/);
  await expect(page.getByRole('alert')).toContainText(/PDF parsing failed|Parsing failed/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Check status again' })).toBeVisible();
  await expect(page).toHaveURL('/resume');
});
