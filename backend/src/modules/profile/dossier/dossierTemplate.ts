// src/modules/profile/dossier/dossierTemplate.ts — One A4 page. Every value is escaped, there are
// no scripts, no external fonts and no images, so the renderer needs no network access at all.

import { escapeHtml } from '../../resume/export/renderExportPdf.js';
import type { DossierData } from './dossierData.js';

const e = (value: string | number | null | undefined) => escapeHtml(String(value ?? '-'));
const n = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function renderDossierHtml(data: DossierData, generatedOn: string): string {
  const platforms = data.platforms.length
    ? data.platforms.map(p => `<tr><td>${e(p.platform)}</td><td>${n(p.solved)}</td><td>${p.rating === null ? '-' : n(p.rating)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">No platforms connected</td></tr>';
  const projects = data.projects.length
    ? data.projects.map(p => `<tr><td>${e(p.name)}<div class="muted">${e(p.repo)}</div></td><td>${e(p.language || '-')}</td><td>${n(p.stars)}</td><td>${e(p.verifiedOn)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">No verified repositories</td></tr>';
  const c = data.consistency;

  return `<!doctype html>
<html lang="en">
<head>
<title>Verified Developer Dossier</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14mm 16mm; font: 11px/1.45 Helvetica, Arial, sans-serif; color: #111827; }
  h1 { margin: 0; font-size: 24px; }
  h2 { margin: 18px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #4338ca; border-bottom: 1px solid #e5e7eb; padding-bottom: 3px; }
  .muted { color: #6b7280; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #4338ca; padding-bottom: 8px; }
  .grid { display: flex; gap: 8px; }
  .tile { flex: 1; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px; }
  .tile b { display: block; font-size: 18px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  th { font-size: 10px; text-transform: uppercase; color: #6b7280; }
  .foot { margin-top: 18px; font-size: 9.5px; color: #6b7280; }
</style>
</head>
<body>
  <div class="head">
    <div><h1>${e(data.displayName)}</h1><div class="muted">@${e(data.username)} &middot; ${e(data.levelName)}${data.joinedOn ? ` &middot; on DevTrack since ${e(data.joinedOn)}` : ''}</div></div>
    <div><b>Verified Developer Dossier</b><div class="muted">Generated ${e(generatedOn)}</div></div>
  </div>

  <h2>Platform ratings</h2>
  <table><tr><th>Platform</th><th>Problems solved</th><th>Rating</th></tr>${platforms}</table>
  <div class="grid" style="margin-top:8px">
    <div class="tile"><b>${n(data.totalSolved)}</b>problems solved</div>
    <div class="tile"><b>${n(data.contestsParticipated)}</b>contests</div>
    <div class="tile"><b>${data.bestContestRating === null ? '-' : n(data.bestContestRating)}</b>best contest rating</div>
  </div>

  <h2>Verified repositories</h2>
  <table><tr><th>Project</th><th>Language</th><th>Stars</th><th>Verified</th></tr>${projects}</table>
  <p class="muted">GitHub ${data.github.verified ? 'account verified' : 'not verified'} &middot; ${n(data.github.contributionsLast365)} contributions in the last year &middot; ${n(data.github.totalContributions)} in total${data.github.languages.length ? ` &middot; ${e(data.github.languages.join(', '))}` : ''}</p>

  <h2>Focus consistency</h2>
  <div class="grid">
    <div class="tile"><b>${n(c.currentStreak)}</b>day streak (best ${n(c.longestStreak)})</div>
    <div class="tile"><b>${n(c.activeDaysLast30)}</b>active days, 30d</div>
    <div class="tile"><b>${n(c.activeDaysLast90)}</b>active days, 90d</div>
    <div class="tile"><b>${n(c.activeDaysLast365)}</b>active days, 365d</div>
  </div>
  <p class="muted">Weekly consistency ${n(c.weeklyScore)}% &middot; monthly ${n(c.monthlyScore)}% &middot; trend ${e(c.trend)}</p>

  <p class="foot">Figures come from platform connections verified by DevTrack at the time this document was generated. This file is a snapshot of those figures and is not a credential on its own.</p>
</body>
</html>`;
}
