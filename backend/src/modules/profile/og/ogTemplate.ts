// src/modules/profile/og/ogTemplate.ts — Element tree for the 1200x630 OG card.
// Plain objects in the shape satori reads (what JSX compiles to), so the backend needs no JSX
// toolchain. Every container uses flexbox because satori does not support other layouts.

import type { OgCard } from './ogCard.js';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

export interface OgNode {
  type: string;
  props: { style: Record<string, string | number>; children?: OgNode[] | string };
}

const COLORS = {
  background: '#0b1020',
  panel: '#151c33',
  border: '#27304f',
  text: '#f4f6ff',
  muted: '#9aa4c7',
  accent: '#6c8cff',
};

function el(style: Record<string, string | number>, children?: OgNode[] | string): OgNode {
  return { type: 'div', props: { style: { display: 'flex', boxSizing: 'border-box', ...style }, children } };
}

function monogram(card: OgCard): OgNode {
  const initial = (card.displayName[0] ?? '?').toUpperCase();
  return el({
    width: 120, height: 120, borderRadius: 60, backgroundColor: COLORS.accent,
    alignItems: 'center', justifyContent: 'center', fontSize: 60, fontWeight: 700, color: COLORS.background,
  }, initial);
}

function statTile(label: string, value: string): OgNode {
  return el({
    flexDirection: 'column', flex: 1, padding: 24, borderRadius: 16,
    backgroundColor: COLORS.panel, border: `2px solid ${COLORS.border}`,
  }, [
    el({ fontSize: 56, fontWeight: 700, color: COLORS.text }, value),
    el({ fontSize: 22, color: COLORS.muted, marginTop: 6 }, label),
  ]);
}

function chip(language: string): OgNode {
  return el({
    padding: '8px 18px', borderRadius: 999, marginRight: 12,
    backgroundColor: COLORS.panel, border: `2px solid ${COLORS.border}`, fontSize: 24, color: COLORS.text,
  }, language);
}

export function ogTemplate(card: OgCard): OgNode {
  const ellipsis = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  const body: OgNode[] = [
    el({ alignItems: 'center' }, [
      monogram(card),
      el({ flexDirection: 'column', marginLeft: 32, flex: 1 }, [
        el({ fontSize: 64, fontWeight: 700, color: COLORS.text, ...ellipsis }, card.displayName),
        el({ fontSize: 30, color: COLORS.muted, marginTop: 8 }, `@${card.username}  ·  ${card.levelName}`),
      ]),
    ]),
  ];

  if (card.stats.length) {
    body.push(el({ marginTop: 48 }, card.stats.flatMap((stat, index) => {
      const tile = statTile(stat.label, stat.value);
      return index === 0 ? [tile] : [el({ width: 20 }), tile];
    })));
  } else {
    body.push(el({ marginTop: 56, fontSize: 36, color: COLORS.muted }, 'Verified engineering portfolio'));
  }
  if (card.languages.length) body.push(el({ marginTop: 36 }, card.languages.map(chip)));

  return el({
    width: OG_WIDTH, height: OG_HEIGHT, flexDirection: 'column', justifyContent: 'space-between',
    padding: 64, backgroundColor: COLORS.background, fontFamily: 'Inter',
  }, [
    el({ flexDirection: 'column' }, body),
    el({ justifyContent: 'space-between', alignItems: 'center', fontSize: 26, color: COLORS.muted }, [
      el({ fontWeight: 700, color: COLORS.accent }, 'DevTrack'),
      el({}, 'Verified engineering profile'),
    ]),
  ]);
}
