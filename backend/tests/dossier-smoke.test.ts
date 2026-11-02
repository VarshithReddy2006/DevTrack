import { expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { ResumeSession } from '../src/db/models/resumeSession.model.js';
import { ResumeExportService } from '../src/modules/resume/export/ResumeExportService.js';

it('renders an actual PDF for a synthetic dossier', async () => {
  const report = {
    executiveSummary: { narrative: 'Synthetic report', engineeringMaturity: 'A', atsSurvivability: 'B', recruiterTrustLevel: 'C', infrastructureMaturity: 'D', operationalReadiness: 50 },
    roleAlignment: { backend: 1, platform: 2, devops: 3, ml: 4, fullstack: 5 },
    credibilityAnalysis: { unsupportedClaims: [], projectRankings: [] }, recommendations: [],
  };
  vi.spyOn(ResumeSession, 'findOne').mockResolvedValue({ reportState: { generated: true, reportData: report } } as never);
  try {
    const pdf = await new ResumeExportService().generateDossierPDF(new Types.ObjectId(), 'synthetic-session');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  } finally { vi.restoreAllMocks(); }
}, 60000);
