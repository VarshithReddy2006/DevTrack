import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import fs from 'node:fs/promises';
import { ResumeExport } from '../../../db/models/resumeExport.model.js';
import { ResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import { DossierExportSchema, ExportResumeSchema } from '../dto/index.js';
import { resetBrowserPool } from './browserPool.js';
import { ResumeExportService } from './ResumeExportService.js';

const mocks = vi.hoisted(() => ({
  pdf: vi.fn(),
  setContent: vi.fn(),
  close: vi.fn(),
  contextClose: vi.fn(),
  createBrowserContext: vi.fn(),
  pageClose: vi.fn(),
  javascript: vi.fn(),
  intercept: vi.fn(),
  on: vi.fn(),
  launch: vi.fn(),
}));
vi.mock('puppeteer', () => ({ default: { launch: mocks.launch } }));

const owner = new Types.ObjectId();
const report = {
  executiveSummary: { narrative: '<script>bad()</script>', engineeringMaturity: 'A', atsSurvivability: 'B', recruiterTrustLevel: 'C', infrastructureMaturity: 'D', operationalReadiness: 50 },
  roleAlignment: { backend: 1, platform: 2, devops: 3, ml: 4, fullstack: 5 },
  credibilityAnalysis: { unsupportedClaims: ['<img src=x>'], projectRankings: [] },
  recommendations: [],
};

beforeEach(async () => {
  await resetBrowserPool();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.pdf.mockResolvedValue(Buffer.from('%PDF-1.4 synthetic'));
  mocks.setContent.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.contextClose.mockResolvedValue(undefined);
  mocks.pageClose.mockResolvedValue(undefined);
  const makePage = () => ({
    close: mocks.pageClose,
    setJavaScriptEnabled: mocks.javascript,
    setRequestInterception: mocks.intercept,
    on: mocks.on,
    setContent: mocks.setContent,
    pdf: mocks.pdf,
  });
  mocks.createBrowserContext.mockImplementation(async () => ({
    newPage: async () => makePage(),
    close: mocks.contextClose,
  }));
  mocks.launch.mockResolvedValue({
    connected: true,
    on: vi.fn(),
    off: vi.fn(),
    createBrowserContext: mocks.createBrowserContext,
    newPage: async () => makePage(),
    close: mocks.close,
  });
});

describe('dossier PDF export', () => {
  it('requires a nonempty session ID', () => {
    expect(DossierExportSchema.safeParse({ sessionId: '  ' }).success).toBe(false);
    expect(DossierExportSchema.parse({ sessionId: ' session-a ' })).toEqual({ sessionId: 'session-a' });
  });

  it('uses the owner and completed stage, escapes report text, and returns PDF bytes', async () => {
    const find = vi.spyOn(ResumeSession, 'findOne').mockResolvedValue({ reportState: { generated: true, reportData: report } } as never);
    const pdf = await new ResumeExportService().generateDossierPDF(owner, 'session-a');
    expect(find).toHaveBeenCalledWith({ userId: owner, sessionId: 'session-a', currentStage: 'COMPLETED' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const html = mocks.setContent.mock.calls[0][0];
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(mocks.intercept).toHaveBeenCalledWith(true);
    expect(mocks.createBrowserContext).toHaveBeenCalledOnce();
    expect(mocks.pageClose).toHaveBeenCalledOnce();
    expect(mocks.contextClose).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it.each([null, { reportState: { generated: false } }, { reportState: { generated: true } }])('rejects unavailable or incomplete reports without rendering', async session => {
    vi.spyOn(ResumeSession, 'findOne').mockResolvedValue(session as never);
    await expect(new ResumeExportService().generateDossierPDF(owner, 'foreign-or-missing')).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('reuses the warm browser across concurrent renders using isolated contexts', async () => {
    vi.spyOn(ResumeSession, 'findOne').mockResolvedValue({ reportState: { generated: true, reportData: report } } as never);
    const service = new ResumeExportService();
    let complete!: (pdf: Buffer) => void;
    const pending = new Promise<Buffer>(resolve => { complete = resolve; });
    mocks.pdf.mockReturnValueOnce(pending).mockReturnValueOnce(pending);

    const first = service.generateDossierPDF(owner, 'session-a');
    const second = service.generateDossierPDF(owner, 'session-b');
    await vi.waitFor(() => expect(mocks.createBrowserContext).toHaveBeenCalledTimes(2));
    expect(mocks.launch).toHaveBeenCalledOnce();

    complete(Buffer.from('%PDF-1.4 synthetic'));
    await Promise.all([first, second]);
    expect(mocks.contextClose).toHaveBeenCalledTimes(2);

    await expect(service.generateDossierPDF(owner, 'session-d')).resolves.toBeInstanceOf(Buffer);
    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(mocks.createBrowserContext).toHaveBeenCalledTimes(3);
  });

  it('propagates renderer failures and closes the page and context while keeping the warm browser alive', async () => {
    vi.spyOn(ResumeSession, 'findOne').mockResolvedValue({ reportState: { generated: true, reportData: report } } as never);
    mocks.pdf.mockRejectedValue(new Error('renderer failed'));
    await expect(new ResumeExportService().generateDossierPDF(owner, 'session-a')).rejects.toThrow('renderer failed');
    expect(mocks.pageClose).toHaveBeenCalledOnce();
    expect(mocks.contextClose).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
  });
});

describe('profile resume export', () => {
  const profileId = new Types.ObjectId();
  const profile = { summary: 'R&D <em>engineer</em>', selectedSkills: ['TypeScript', 'C++'] };
  const service = new ResumeExportService();

  beforeEach(() => {
    vi.spyOn(ResumeProfile, 'findOne').mockResolvedValue(profile as never);
    vi.spyOn(ResumeExport, 'create').mockResolvedValue({} as never);
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    vi.spyOn(fs, 'rm').mockResolvedValue(undefined);
  });

  it('escapes profile text, disables script, and blocks subresource requests', async () => {
    await service.export({ userId: owner, resumeProfileId: profileId, exportType: 'pdf' });
    expect(ResumeProfile.findOne).toHaveBeenCalledWith({ _id: profileId, userId: owner });
    const html = mocks.setContent.mock.calls[0][0];
    expect(html).toContain('R&amp;D &lt;em&gt;engineer&lt;/em&gt;');
    expect(html).toContain("default-src 'none'");
    expect(mocks.javascript).toHaveBeenCalledWith(false);
    expect(mocks.intercept).toHaveBeenCalledWith(true);

    const [event, handler] = mocks.on.mock.calls[0];
    expect(event).toBe('request');
    const abort = vi.fn().mockResolvedValue(undefined);
    handler({ abort });
    expect(abort).toHaveBeenCalledOnce();
    expect(fs.writeFile).toHaveBeenCalledWith(expect.stringMatching(/\.pdf$/), Buffer.from('%PDF-1.4 synthetic'), { flag: 'wx' });
  });

  it.each([
    ['txt', 'Resume\n\nSummary\nR&D <em>engineer</em>\n\nSkills\nTypeScript, C++\n'],
    ['json', JSON.stringify({ summary: profile.summary, skills: profile.selectedSkills }, null, 2) + '\n'],
    ['md', '# Resume\n\n## Summary\n\n    R&D <em>engineer</em>\n\n## Skills\n\n    TypeScript, C++\n'],
  ] as const)('writes valid %s and records the file size', async (exportType, content) => {
    expect(ExportResumeSchema.parse({ exportType }).exportType).toBe(exportType);
    await service.export({ userId: owner, resumeProfileId: profileId, exportType });
    expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('.' + exportType), content, { flag: 'wx' });
    const record = expect.objectContaining({
      userId: owner,
      resumeProfileId: profileId,
      exportType,
      metadata: expect.objectContaining({ fileSize: Buffer.byteLength(content) }),
    });
    expect(ResumeExport.create).toHaveBeenCalledWith(record);
    const values = vi.mocked(ResumeExport.create).mock.calls[0][0];
    expect(new ResumeExport(values).validateSync()).toBeUndefined();
  });

  it('propagates a page load timeout and leaves no file or export record', async () => {
    mocks.setContent.mockRejectedValueOnce(new Error('page load timed out'));
    await expect(service.export({ userId: owner, resumeProfileId: profileId, exportType: 'pdf' }))
      .rejects.toThrow('page load timed out');
    expect(mocks.pageClose).toHaveBeenCalledOnce();
    expect(mocks.contextClose).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(ResumeExport.create).not.toHaveBeenCalled();
  });

  it('removes the file if saving the export record fails', async () => {
    vi.mocked(ResumeExport.create).mockRejectedValueOnce(new Error('record write failed'));
    await expect(service.export({ userId: owner, resumeProfileId: profileId, exportType: 'txt' }))
      .rejects.toThrow('record write failed');
    const [fullPath] = vi.mocked(fs.writeFile).mock.calls[0];
    expect(fs.rm).toHaveBeenCalledWith(fullPath, { force: true });
  });
});
