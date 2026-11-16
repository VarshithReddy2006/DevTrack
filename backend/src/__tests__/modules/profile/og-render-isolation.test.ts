import { expect, it, vi } from 'vitest';

const loaded = vi.hoisted(() => ({ satori: false, resvg: false }));
vi.mock('satori', () => { loaded.satori = true; return { default: vi.fn() }; });
vi.mock('@resvg/resvg-js', () => { loaded.resvg = true; return { Resvg: vi.fn() }; });

it('keeps satori and resvg out of the API process: they load only when a render runs', async () => {
  // Everything the API imports to serve og.png and the share shell.
  await import('../../../modules/profile/profile.routes.js');
  await import('../../../modules/profile/ogImage.controller.js');
  await import('../../../modules/profile/ogImage.service.js');
  await import('../../../modules/profile/ogShell.routes.js');
  expect(loaded).toEqual({ satori: false, resvg: false });

  await import('../../../modules/profile/og/ogRenderer.js');
  expect(loaded).toEqual({ satori: true, resvg: true });
});
