/**
 * (h) The home screen is the child's hub and fits the screen: a 14" MacBook in Chrome shows ~1512×790 of the page, a
 * 1366×768 laptop ~1366×648. With the tallest home there is («Продолжить партию» + the four doors + the plan, which
 * names the last game that 02-game.spec.ts leaves behind in a full run):
 *  - nothing to scroll on the usual laptop windows, on an iPad on its side and upright;
 *  - on a phone the four doors are on the first screen, above Гамбитик's bar;
 *  - no door title runs out of its door, the parent's bigger text included (the doors then stand 2 × 2);
 *  - the grown-ups' door is there, with its name, and covers nothing.
 */
import type { Page } from '@playwright/test';
import { expect, expectSilentRun, test } from './fixtures.ts';
import { clickMove, ensureStudent, openApp, waitForGame, watchConsole } from './helpers.ts';

const ONE_SCREEN: readonly (readonly [number, number])[] = [
  [1512, 790], // 14" MacBook Pro, Chrome, Dock visible
  [1440, 790], // 13" MacBook Air
  [1536, 730], // 15" Windows laptop at 125 %
  [1366, 648], // 1366×768 laptop
  [1280, 640],
  [1180, 760], // iPad Air on its side
  [1024, 700], // iPad on its side
  [768, 1024], // iPad upright
];

interface HomeLayout {
  scrollHeight: number;
  doors: { name: string; fits: boolean; bottom: number; layout: string }[];
  /** what «Для взрослых» overlaps among the greeting, its question and «Продолжить партию» */
  parentOverlaps: string[];
  /** top of Гамбитик's bar on a phone; null elsewhere */
  barTop: number | null;
}

async function homeLayout(page: Page): Promise<HomeLayout> {
  return page.evaluate(() => {
    const bar = [...document.querySelectorAll('.gmb-dock[data-layout="bar"] .gmb-dock-mascot, .gmb-dock[data-layout="bar"] .gmb-round')];
    return {
      scrollHeight: document.documentElement.scrollHeight,
      doors: [...document.querySelectorAll<HTMLElement>('nav[aria-label="Главное меню"] > button')].map((door) => ({
        name: door.textContent ?? '',
        // a nowrap title wider than its door makes the door scrollable
        fits: door.scrollWidth <= door.clientWidth,
        bottom: door.getBoundingClientRect().bottom,
        layout: door.dataset.layout ?? '',
      })),
      parentOverlaps: (() => {
        const parent = [...document.querySelectorAll('header button')].find((b) => b.textContent?.includes('Для взрослых'));
        if (!parent) return ['(no button)'];
        const a = parent.getBoundingClientRect();
        return [...document.querySelectorAll('header h1, header p, main > button')]
          .filter((el) => {
            const b = el.getBoundingClientRect();
            return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
          })
          .map((el) => el.textContent ?? '');
      })(),
      barTop: bar.length > 0 ? Math.min(...bar.map((e) => e.getBoundingClientRect().top)) : null,
    };
  });
}

test('the home fits the screen, «Продолжить партию» included', async ({ page, request }) => {
  await ensureStudent(request);
  const guard = watchConsole(page);

  // an interrupted game: its tile is the tallest thing the home can show on top of the rest
  await openApp(page, '#/play?persona=petya&tc=training&color=w&exam=0');
  await waitForGame(page, (s) => s.phase === 'childTurn', 'engines ready', 45_000);
  await clickMove(page, page.getByTestId('trainer-board'), { from: 'e2', to: 'e4' });
  await waitForGame(page, (s) => s.phase === 'childTurn' && s.moves.length >= 2, 'the bot answers 1.e4');

  const home = async (width: number, height: number): Promise<HomeLayout> => {
    await page.setViewportSize({ width, height });
    await openApp(page, '#/');
    await expect(page.getByRole('button', { name: /Продолжить партию/ })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Главное меню' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Для взрослых' })).toBeVisible();
    await page.waitForTimeout(300);
    const layout = await homeLayout(page);
    expect(layout.doors).toHaveLength(4);
    for (const door of layout.doors) expect(door.fits, `${width}×${height}: «${door.name}» stays inside its door`).toBe(true);
    expect(layout.parentOverlaps, `${width}×${height}: «Для взрослых» covers nothing`).toEqual([]);
    return layout;
  };

  for (const [width, height] of ONE_SCREEN) {
    const layout = await home(width, height);
    expect(layout.scrollHeight, `${width}×${height}: the home needs no scrolling`).toBeLessThanOrEqual(height);
  }

  // a phone held upright: the doors come first, above Гамбитик's bar
  for (const [width, height] of [[390, 664], [360, 640]] as const) {
    const layout = await home(width, height);
    expect(layout.barTop, `${width}×${height}: Гамбитик stands in the bar`).not.toBeNull();
    for (const door of layout.doors) expect(door.bottom, `${width}×${height}: «${door.name}» is above the bar`).toBeLessThanOrEqual(layout.barTop ?? 0);
  }

  // the parent's biggest text: the doors stand 2 × 2 on a computer, and every title still fits
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('gambit.settings') ?? '{}') as Record<string, unknown>;
    localStorage.setItem('gambit.settings', JSON.stringify({ ...settings, fontScale: 1.3 }));
  });
  await page.reload();
  const bigText = await home(1512, 790);
  expect(bigText.doors.map((door) => door.layout)).toEqual(['row', 'row', 'row', 'row']);
  await home(360, 640);

  await expectSilentRun(page);
  guard.assertClean();
});
