/**
 * (m) A phone held upright (iPhone 13 in Chromium: 390×664, touch): the page must stay put after a move, a dragged piece
 * must follow the finger, and Гамбитик must not cover the board. Here:
 *  - a move DRAGGED with the finger (real touch events) is played, and the dragged piece rides under the finger;
 *  - the page never scrolls during the game (it fits the screen), before or after the bot's reply;
 *  - Гамбитик stands in the bar at the bottom: his bar and bubble never cover the board or the button row;
 *  - no screen is wider than the phone (a wide page makes the phone zoom out).
 */
import type { CDPSession, Page } from '@playwright/test';
import { expect, expectSilentRun, test } from './fixtures.ts';
import { ensureStudent, gameState, openApp, square, waitForGame, watchConsole } from './helpers.ts';

test.use({
  viewport: { width: 390, height: 664 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});

async function center(page: Page, name: string): Promise<{ x: number; y: number }> {
  const box = await square(page, name).boundingBox();
  if (!box) throw new Error(`square ${name} is not on screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A finger drag from one square to another; returns where the dragged piece was half-way. */
async function touchDrag(page: Page, cdp: CDPSession, from: string, to: string): Promise<{ y: number } | null> {
  const a = await center(page, from);
  const b = await center(page, to);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', a.x, a.y);
  let midway: { y: number } | null = null;
  for (let i = 1; i <= 20; i += 1) {
    await touch('touchMove', a.x + ((b.x - a.x) * i) / 20, a.y + ((b.y - a.y) * i) / 20);
    await page.waitForTimeout(16);
    if (i === 10) {
      // react-chessboard draws the dragged piece as a second copy that follows the pointer
      midway = await page.evaluate((code) => {
        const copies = [...document.querySelectorAll(`[data-piece="${code}"]`)].map((e) => e.getBoundingClientRect());
        const moving = copies.find((r) => copies.filter((o) => Math.abs(o.y - r.y) < 1).length === 1);
        return moving ? { y: moving.y + moving.height / 2 } : null;
      }, 'wP');
    }
  }
  await touch('touchEnd', b.x, b.y);
  return midway;
}

async function rect(page: Page, selector: string): Promise<{ top: number; bottom: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} is not on screen`);
  return { top: box.y, bottom: box.y + box.height };
}

test('a phone: drag with the finger, the page stays put, Гамбитик never covers the board', async ({ page, context, request }) => {
  await ensureStudent(request);
  const guard = watchConsole(page);
  await openApp(page, '#/play?persona=petya&tc=training&color=w&coach=helper');
  const board = page.getByTestId('trainer-board');
  await expect(board).toBeVisible();
  await waitForGame(page, (s) => s.phase === 'childTurn', 'the child to move');

  // the game fits the phone: nothing to scroll
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(664);
  // Гамбитик is the bar at the bottom, clear of the board and of the button row
  await expect(page.locator('.gmb-dock[data-layout="bar"]')).toBeVisible();
  const boardBox = await rect(page, '[data-testid="trainer-board"]');
  const buttonsBottom = await page.evaluate(() =>
    Math.max(...[...document.querySelectorAll('div[class*="actions"][data-compact="true"] > button')].map((b) => b.getBoundingClientRect().bottom)),
  );
  // what is really drawn in the bar: his bubble (when he speaks), the round buttons, Гамбитик himself
  const barTop = await page.evaluate(() =>
    Math.min(...[...document.querySelectorAll('.gmb-bubble[data-visible="true"], .gmb-dock .gmb-round, .gmb-dock-mascot')].map((e) => e.getBoundingClientRect().top)),
  );
  expect(barTop, 'the bar starts below the board').toBeGreaterThanOrEqual(boardBox.bottom);
  expect(barTop, 'the bar starts below the buttons').toBeGreaterThanOrEqual(buttonsBottom);

  const cdp = await context.newCDPSession(page);
  const e2 = await center(page, 'e2');
  const e4 = await center(page, 'e4');
  const midway = await touchDrag(page, cdp, 'e2', 'e4');
  expect(midway, 'a dragged piece follows the finger').not.toBeNull();
  // half-way between e2 and e4 is e3: the piece is there, not left behind on e2
  expect(Math.abs((midway?.y ?? 0) - (e2.y + e4.y) / 2)).toBeLessThan(24);

  await waitForGame(page, (s) => s.moves.length >= 1, 'the dragged move');
  expect((await gameState(page)).moves[0]?.san).toBe('e4');
  expect(await page.evaluate(() => window.scrollY), 'no jump after the move').toBe(0);
  await waitForGame(page, (s) => s.moves.length >= 2 && s.phase === 'childTurn', 'the bot reply');
  expect(await page.evaluate(() => window.scrollY), 'no jump after the reply').toBe(0);

  // a second drag, a knight this time
  await touchDrag(page, cdp, 'g1', 'f3');
  await waitForGame(page, (s) => s.moves.length >= 3, 'the second dragged move');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await expectSilentRun(page);
  guard.assertClean();
});

test('a phone: no screen is wider than the phone, Гамбитик stands in the bar everywhere', async ({ page, request }) => {
  await ensureStudent(request);
  const guard = watchConsole(page);
  for (const hash of ['#/', '#/new', '#/puzzles', '#/progress', '#/path', '#/settings']) {
    await openApp(page, hash);
    await page.waitForTimeout(600);
    const width = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, window: window.innerWidth }));
    expect(width.page, `${hash} fits the phone's width`).toBeLessThanOrEqual(390);
    expect(width.window, `${hash}: the phone did not zoom out`).toBe(390);
    await expect(page.locator('.gmb-dock[data-layout="bar"]'), `${hash}: Гамбитик in the bar`).toBeVisible();
  }
  await expectSilentRun(page);
  guard.assertClean();
});
