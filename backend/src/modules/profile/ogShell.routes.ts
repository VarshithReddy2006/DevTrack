import { createHash } from 'node:crypto';
import type { IRouter } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { cacheManager } from '../../shared/cache/cacheManager.js';
import { PublicProfileService } from './publicProfile.service.js';

const CACHE_TTL_SECONDS = 300;
const CACHE_MAX_ENTRIES = 512;
const TEMPLATE_VERSION = 'v1';
const REDIRECT_SCRIPT_PATH = '/u/.well-known/portfolio-redirect.js';

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ENTITIES[character]);
}

function httpsImage(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {
    // A malformed image URL falls back to the portfolio preview.
  }
}

interface Shell {
  title: string;
  description: string;
  canonical: string;
  destination: string;
  image: string;
  isIndexable: boolean;
}

function renderShell(shell: Shell): string {
  const { isIndexable } = shell;
  const title = escapeHtml(shell.title);
  const description = escapeHtml(shell.description);
  const canonical = escapeHtml(shell.canonical);
  const destination = escapeHtml(shell.destination);
  const image = escapeHtml(shell.image);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="canonical" href="${canonical}">
  <meta name="description" content="${description}">
  <meta property="og:type" content="profile">
  <meta property="og:url" content="${canonical}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${image}">
  <meta name="twitter:card" content="summary_large_image">
  ${isIndexable ? '' : '<meta name="robots" content="noindex">'}
  <script src="${REDIRECT_SCRIPT_PATH}" defer></script>
</head>
<body>
  <a id="portfolio-link" href="${destination}">Open portfolio</a>
</body>
</html>`;
}

/**
 * `apiUrl` is the public origin of this API. With it, published profiles advertise their
 * generated card as og:image; without it the shell keeps the static preview image.
 */
export function registerPublicProfileShell(app: IRouter, frontendUrl: string, apiUrl?: string): void {
  // Use the configured frontend origin for canonical URLs and browser navigation.
  const frontend = URL.canParse(frontendUrl) ? new URL(frontendUrl) : undefined;
  const origin = frontend && /^https?:$/.test(frontend.protocol)
    ? frontend.origin
    : 'http://localhost:5173';
  const api = apiUrl && URL.canParse(apiUrl) && /^https?:$/.test(new URL(apiUrl).protocol) ? new URL(apiUrl).origin : undefined;
  const templates = new Map<string, { html: string; expiresAt: number }>();

  app.get(REDIRECT_SCRIPT_PATH, (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').type('js')
      .send("window.location.replace(document.getElementById('portfolio-link').href);");
  });

  app.get('/u/:username', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const username = req.params.username;
    if (typeof username !== 'string' || username.length < 3 || username.length > 30
        || /^[.]+$/.test(username) || /[/\\\u0000-\u001f\u007f]/.test(username)) {
      res.status(404).type('text').send('Public profile not found');
      return;
    }
    const normalized = username.toLowerCase();
    const slug = encodeURIComponent(normalized);
    const canonical = origin + '/u/' + slug;
    if (username !== normalized) {
      res.redirect(301, canonical);
      return;
    }

    // The database remains authoritative for every request, including 304s.
    const profile = await PublicProfileService.getPublishedPreview(normalized);
    if (!profile) {
      res.status(404).type('text').send('Public profile not found');
      return;
    }
    const shell: Shell = {
      title: profile.displayName + ' - DevTrack Portfolio',
      description: profile.description,
      canonical,
      destination: origin + '/portfolio/' + slug,
      image: httpsImage(profile.imageUrl) ?? (api ? api + profile.ogImagePath : origin + '/portfolio-preview.png'),
      isIndexable: profile.isIndexable,
    };

    const version = createHash('sha256').update(JSON.stringify([TEMPLATE_VERSION, shell])).digest('base64url');
    const tag = '"' + version + '"';
    res.set({
      'Cache-Control': 'public, max-age=0, must-revalidate',
      ETag: 'W/' + tag,
    });
    const validators = req.get('If-None-Match')?.split(',').map(value => value.trim());
    if (validators?.some(value => value === '*' || value.replace(/^W\//, '') === tag)) {
      res.status(304).end();
      return;
    }

    const cached = templates.get(version);
    if (cached && cached.expiresAt > Date.now()) {
      res.type('html').send(cached.html);
      return;
    }

    const cachedHtml = await cacheManager.getOrSet<unknown>(
      'cache:portfolio-shell:' + version,
      async () => renderShell(shell),
      CACHE_TTL_SECONDS,
    );
    const html = typeof cachedHtml === 'string' ? cachedHtml : renderShell(shell);
    templates.delete(version);
    templates.set(version, { html, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
    if (templates.size > CACHE_MAX_ENTRIES) {
      const eldest = templates.keys().next();
      if (!eldest.done) templates.delete(eldest.value);
    }
    res.type('html').send(html);
  }));
}
