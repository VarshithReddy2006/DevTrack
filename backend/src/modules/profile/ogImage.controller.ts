// src/modules/profile/ogImage.controller.ts — GET /api/v1/profile/public/:username/og.png
// The API never renders. A cache miss queues a job for the render pool and waits briefly for
// the artifact; a profile that is not published answers exactly like an unknown handle.

import type { Request, Response } from 'express';
import { commonErrors, errorResponse } from '../../shared/response.js';
import { enqueueOgRender } from './workers/ogRender.worker.js';
import { findCachedOgImage, loadOgCard } from './ogImage.service.js';

export const OG_WAIT_MS = 8000;
const POLL_MS = 150;
const RETRY_AFTER_SECONDS = 5;

/** Seams for tests: how a render is requested and how long the request waits for it. */
export const ogImageDeps = {
  enqueue: enqueueOgRender,
  waitMs: OG_WAIT_MS,
  pollMs: POLL_MS,
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitForImage(userId: string, contentHash: string): Promise<Buffer | null> {
  const deadline = Date.now() + ogImageDeps.waitMs;
  while (Date.now() < deadline) {
    await sleep(ogImageDeps.pollMs);
    const image = await findCachedOgImage(userId, contentHash);
    if (image) return image;
  }
  return null;
}

export async function getPublicOgImage(req: Request, res: Response): Promise<void> {
  const param = req.params.username;
  const username = Array.isArray(param) ? param[0] : param;
  const source = typeof username === 'string' && username ? await loadOgCard({ slug: username.toLowerCase() }) : null;
  if (!source) {
    commonErrors.notFound(res, 'Public Profile');
    return;
  }

  const userId = String(source.userId);
  const tag = `"${source.contentHash}"`;
  res.set({ ETag: tag, 'Cache-Control': 'public, max-age=300, must-revalidate' });
  // The visibility check above ran for this request, so a stale validator never outlives unpublishing.
  if (req.get('If-None-Match')?.split(',').some(value => value.trim().replace(/^W\//, '') === tag)) {
    res.status(304).end();
    return;
  }

  let image = await findCachedOgImage(userId, source.contentHash);
  if (!image) {
    await ogImageDeps.enqueue(userId, source.contentHash);
    image = await waitForImage(userId, source.contentHash);
  }
  if (!image) {
    res.set({ 'Cache-Control': 'no-store', 'Retry-After': String(RETRY_AFTER_SECONDS) });
    errorResponse(res, 'Image is being generated, try again shortly', 'RENDER_PENDING', 503);
    return;
  }
  res.type('png').send(image);
}
