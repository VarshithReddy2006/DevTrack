// src/modules/profile/og/ogRenderer.ts — satori (element tree to SVG) then resvg (SVG to PNG).
// This is CPU heavy, so it only runs inside the render worker pool (WORKER_TYPE=render).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import type { OgCard } from './ogCard.js';
import { OG_HEIGHT, OG_WIDTH, ogTemplate } from './ogTemplate.js';

export type OgRenderer = (card: OgCard) => Promise<Buffer>;

// assets/ sits next to src/ and dist/, so the same relative path works from both.
const fontUrl = (file: string) => fileURLToPath(new URL(`../../../../assets/fonts/${file}`, import.meta.url));

let fonts: Promise<{ name: string; data: Buffer; weight: 400 | 700; style: 'normal' }[]> | undefined;

function loadFonts() {
  fonts ??= Promise.all([
    readFile(fontUrl('Inter-Regular-latin.woff')),
    readFile(fontUrl('Inter-Bold-latin.woff')),
  ]).then(([regular, bold]) => [
    { name: 'Inter', data: regular, weight: 400 as const, style: 'normal' as const },
    { name: 'Inter', data: bold, weight: 700 as const, style: 'normal' as const },
  ]).catch(error => {
    fonts = undefined; // let the next job retry instead of caching the failure
    throw error;
  });
  return fonts;
}

export const renderOgPng: OgRenderer = async card => {
  // satori reads the same plain-object element shape React uses; its types expect ReactNode.
  const svg = await satori(ogTemplate(card) as unknown as Parameters<typeof satori>[0], {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: await loadFonts(),
  });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } }).render().asPng();
  return Buffer.from(png);
};
