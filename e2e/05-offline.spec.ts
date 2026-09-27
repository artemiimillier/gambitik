/**
 * The server is down when the game ends: the record is parked in the browser and delivered at the next start
 * of the app — «Партии и успехи сохранятся, когда сервер снова заработает».
 */
import { expect, expectSilentRun, test } from './fixtures.ts';
import { clickMove, ensureStudent, gameState, openApp, pickSafeMove, waitForGame, watchConsole } from './helpers.ts';

test('a game finished while the server is unreachable is saved later', async ({ page, request }) => {
  await ensureStudent(request);
  const before = ((await (await request.get('/api/games?limit=200')).json()) as { id: string }[]).map((g) => g.id);

  const guard = watchConsole(page);
  await page.route('**/api/games', (route) => (route.request().method() === 'POST' ? route.abort('connectionrefused') : route.continue()));
  await openApp(page, '#/play?persona=petya&tc=training&color=w&exam=0');
  const board = page.getByTestId('trainer-board');
  await waitForGame(page, (s) => s.phase === 'childTurn', 'engines ready', 45_000);

  for (let i = 0; i < 3; i += 1) {
    const state = await gameState(page);
    if (state.phase !== 'childTurn') break;
    const move = i === 0 ? { from: 'e2', to: 'e4', san: 'e4' } : pickSafeMove(state.fen);
    await clickMove(page, board, move);
    const after = await waitForGame(
      page,
      (s) => s.phase === 'gameOver' || s.phase === 'coachIntervention' || (s.phase === 'childTurn' && s.moves.length >= state.moves.length + 2),
      `the answer to ${move.san}`,
    );
    if (after.phase === 'coachIntervention') {
      await page.getByRole('button', { name: 'Оставлю свой ход' }).click();
      await waitForGame(page, (s) => s.phase === 'gameOver' || s.phase === 'childTurn', 'the bot after a declined offer');
    }
  }

  await page.getByRole('button', { name: 'Сдаться' }).click();
  await page.getByRole('button', { name: 'Да, сдаюсь' }).click();
  // the diary question comes before the record is written; the child may always skip it
  await page.getByRole('form', { name: 'Дневник партии' }).getByRole('button', { name: 'Пропустить' }).click({ timeout: 60_000 });
  await expect(page.getByText('Партия сохранена на этом компьютере')).toBeVisible({ timeout: 90_000 });
  const parked = await gameState(page);
  expect(parked.ending?.save).toBe('local');
  const gameId = parked.record?.id;
  expect(gameId).toBeTruthy();
  expect(before).not.toContain(gameId);
  await expect(page.getByRole('button', { name: 'Разбор партии' })).toHaveCount(0);

  // the server is «back»: the next start of the app delivers the parked game
  await page.unroute('**/api/games');
  await openApp(page, '#/');
  await page.reload();
  await expect
    .poll(async () => ((await (await request.get('/api/games?limit=200')).json()) as { id: string }[]).map((g) => g.id), { timeout: 20_000 })
    .toContain(gameId);
  expect(await page.evaluate(() => localStorage.getItem('gambit.unsavedGames'))).toBeNull();

  // the only console errors allowed here are the two refused POSTs (first try + one retry)
  const unexpected = guard.problems.filter((p) => !/ERR_CONNECTION_REFUSED|Failed to load resource/i.test(p));
  expect(unexpected).toEqual([]);
  await expectSilentRun(page);
});
