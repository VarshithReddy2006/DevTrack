import { expect, test } from '@playwright/test';

const headers = { Authorization: 'Bearer devtrack-e2e-token' };
const resumeText = '# Experience\n- Built Node.js APIs serving 20 users.\n# Skills\n- Docker and Node.js\n# Projects\n- Created a service with Docker.\n# Education\n- B.Tech Computer Science';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => {
  const response = await request.put('http://127.0.0.1:3001/api/resume-intelligence/profile', {
    headers, data: { targetRole: 'Backend Engineer', summary: 'Built Node.js APIs.', selectedSkills: ['Docker', 'Node.js'] },
  });
  expect(response.ok()).toBe(true);
});

test('edits locally, saves through the real API and restores the persisted variant on reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/resume');
  await page.getByRole('link', { name: 'Edit resume bullets' }).click();
  const editor = page.getByRole('textbox', { name: 'Resume bullets' });
  await expect(editor).toBeVisible();
  const resumeRequests: string[] = [];
  // Shell XP polling is independent; typing must not call the resume/scoring API.
  const listener = (request: { url(): string }) => { if (new URL(request.url()).pathname.startsWith('/api/resume')) resumeRequests.push(request.url()); };
  page.on('request', listener);
  await editor.fill(resumeText);
  await expect(page.getByRole('button', { name: 'Save as variant' })).toBeEnabled();
  expect(resumeRequests).toEqual([]);
  page.off('request', listener);
  await expect(page.locator('.bullet-action-verb').first()).toBeVisible();
  await expect(page.locator('.bullet-metric').first()).toHaveText('20');
  await expect(page.locator('ins')).not.toHaveCount(0);
  const preview = Number(await page.getByLabel('ATS score').textContent());
  await page.getByRole('button', { name: 'Save as variant' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  let release!: () => void;
  let sent!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { sent = resolve; });
  await page.route('**/api/resume-intelligence/variants', async route => {
    if (route.request().method() === 'POST') { sent(); await released; }
    await route.continue();
  });
  const saving = page.waitForResponse(response => response.url().endsWith('/resume-intelligence/variants') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save variant', exact: true }).click();
  await pending;
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByLabel('Resume source')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  release();
  const response = await saving;
  expect(response.ok()).toBe(true);
  const saved = (await response.json()).data;
  expect(saved.bulletEdits.map((bullet: { editedText: string }) => bullet.editedText)).toContain('Built Node.js APIs serving 20 users.');
  expect(saved.atsScore.score).toBe(preview);
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  await page.reload();
  await expect(editor).toContainText('Built Node.js APIs serving 20 users.');
  await expect(page.getByLabel('ATS score')).toHaveText(String(saved.atsScore.score));
  await page.screenshot({ path: 'test-results/resume-editor-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('keeps edits when navigation is cancelled, including native browser back', async ({ page }) => {
  await page.goto('/resume');
  await page.getByRole('link', { name: 'Edit resume bullets' }).click();
  const editor = page.getByRole('textbox', { name: 'Resume bullets' });
  await editor.fill(resumeText + '\n- Shipped another change.');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('link', { name: 'Back to Resume Intelligence' }).click();
  await expect(editor).toContainText('Shipped another change.');
  page.once('dialog', dialog => dialog.dismiss());
  await page.evaluate(() => window.history.back());
  await expect(page).toHaveURL(/\/resume\/editor$/);
  await expect(editor).toContainText('Shipped another change.');
  await Promise.all([
    page.waitForEvent('dialog').then(async dialog => { expect(dialog.type()).toBe('beforeunload'); await dialog.dismiss(); }),
    page.evaluate(() => window.location.reload()),
  ]);
  await expect(editor).toContainText('Shipped another change.');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('link', { name: 'Back to Resume Intelligence' }).click();
  await expect(page).toHaveURL(/\/resume$/);
});

test('preserves a failed-save draft and supports a mobile keyboard-accessible dialog', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/resume/editor');
  const editor = page.getByRole('textbox', { name: 'Resume bullets' });
  await editor.fill(resumeText + '\n- Reduced latency by 30%.');
  await expect(page.getByRole('button', { name: 'Save as variant' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save as variant' }).click();
  await expect(page.getByLabel('Variant role')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as variant' })).toBeFocused();
  await page.route('**/api/resume-intelligence/variants', async route => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 503, json: { success: false, message: 'Temporary test outage.' } });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Save as variant' }).click();
  await page.getByRole('button', { name: 'Save variant', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Temporary test outage.');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toContainText('Reduced latency by 30%.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/resume-editor-mobile.png', fullPage: true });
});
