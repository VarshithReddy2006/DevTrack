import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import { DossierExportSchema } from '../dto/index.js';
import { ResumeExportService } from './ResumeExportService.js';

const mocks = vi.hoisted(() => ({ pdf: vi.fn(), setContent: vi.fn(), close: vi.fn(), intercept: vi.fn(), on: vi.fn(), launch: vi.fn() }));
vi.mock('puppeteer', () => ({ default: { launch: mocks.launch } }));

const owner = new Types.ObjectId();
const report = {
  executiveSummary: { narrative: '<script>bad()</script>', engineeringMaturity: 'A', atsSurvivability: 'B', recruiterTrustLevel: 'C', infrastructureMaturity: 'D', operationalReadiness: 50 },
  roleAlignment: { backend: 1, platform: 2, devops: 3, ml: 4, fullstack: 5 },
  credibilityAnalysis: { unsupportedClaims: ['<img src=x>'], projectRankings: [] },
  recommendations: [],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.pdf.mockResolvedValue(Buffer.from('%PDF-1.4 synthetic'));
  mocks.setContent.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.launch.mockResolvedValue({ newPage: async () => ({ setRequestInterception: mocks.intercept, on: mocks.on, setContent: mocks.setContent, pdf: mocks.pdf }), close: mocks.close });
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
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each([null, { reportState: { generated: false } }, { reportState: { generated: true } }])('rejects unavailable or incomplete reports without rendering', async session => {
    vi.spyOn(ResumeSession, 'findOne').mockResolvedValue(session as never);
    await expect(new ResumeExportService().generateDossierPDF(owner, 'foreign-or-missing')).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('propagates renderer failures and closes the browser', async () => {
    vi.spyOn(ResumeSession, 'findOne').mockResolvedValue({ reportState: { generated: true, reportData: report } } as never);
    mocks.pdf.mockRejectedValue(new Error('renderer failed'));
    await expect(new ResumeExportService().generateDossierPDF(owner, 'session-a')).rejects.toThrow('renderer failed');
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
