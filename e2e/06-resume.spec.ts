/**
 * A game in progress survives a closed tab / a reload / «Домой». The home screen offers «Продолжить партию»,
 * the game screen asks «Продолжить партию?» and restores the board; «Новая партия» starts from scratch.
 */
import { expect, expectSilentRun, test } from './fixtures.ts';
import { clickMove, ensureStudent, gameState, openApp, shot, waitForGame, watchConsole } from './helpers.ts';

test('an interrupted game is offered again and can be continued or replaced', async ({ page, request }) => {
  await ensureStudent(request);
  const guard = watchConsole(page);
  await openApp(page, '#/play?persona=petya&tc=training&color=w&exam=0');
  const board = page.getByTestId('trainer-board');
  await waitForGame(page, (s) => s.phase === 'childTurn', 'engines ready', 45_000);
  await clickMove(page, board, { from: 'e2', to: 'e4' });
  const played = await waitForGame(page, (s) => s.phase === 'childTurn' && s.moves.length >= 2, 'the bot answers 1.e4');
  const fen = played.fen;

  // the tab is «closed»: a reload drops every bit of in-memory state
  await page.reload();
  const dialog = page.getByRole('dialog', { name: 'Продолжить партию?' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(300);
  await shot(page, 'game-resume');
  await dialog.getByRole('button', { name: 'Продолжить' }).click();
  const resumed = await waitForGame(page, (s) => s.phase === 'childTurn', 'the restored game', 45_000);
  expect(resumed.fen, 'the position is back').toBe(fen);
  expect(resumed.moves.length).toBe(played.moves.length);
  expect(resumed.resumed).toBe(true);

  // leaving through the home screen: the tile is there and leads to the same question
  await openApp(page, '#/');
  const tile = page.getByRole('button', { name: /Продолжить партию/ });
  await expect(tile).toBeVisible();
  await shot(page, 'home-resume');
  await tile.click();
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Новая партия' }).click();
  const fresh = await waitForGame(page, (s) => s.phase === 'childTurn', 'a new game', 45_000);
  expect(fresh.moves.length).toBe(0);
  expect(fresh.resumed).toBe(false);

  // the new game replaced the snapshot: nothing is offered after it is left at move 0
  await expectSilentRun(page);
  guard.assertClean();
});
