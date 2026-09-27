/** (e) The puzzles screen loads a puzzle and accepts the correct solution (read through the dev hook). */
import { expect, expectSilentRun, test } from './fixtures.ts';
import { clickMove, ensureStudent, expectBubbleClearOf, openApp, puzzleSnapshot, shot, watchConsole } from './helpers.ts';

test('a puzzle is solved with the correct line and the attempt is rated', async ({ page, request }) => {
  await ensureStudent(request);
  const before = (await (await request.get('/api/student')).json()) as { totals: { puzzlesAttempted: number } };
  const guard = watchConsole(page);
  await openApp(page);

  await page.getByRole('navigation', { name: 'Главное меню' }).getByRole('button', { name: /Задачи/ }).click();
  await expect(page).toHaveURL(/#\/puzzles$/);
  const board = page.getByRole('group', { name: 'Доска с задачей' });
  await expect(board.locator('[data-square]')).toHaveCount(64);

  await expect.poll(async () => (await puzzleSnapshot(page)).phase, { timeout: 20_000 }).toBe('solving');
  const first = await puzzleSnapshot(page);
  expect(first.status).toBe('playing');
  expect(first.total).toBeGreaterThanOrEqual(5);
  expect(first.puzzle).not.toBeNull();
  await shot(page, 'puzzles');
  await expectBubbleClearOf(page, { 'the puzzle board': board, '«Подсказка»': page.getByRole('button', { name: 'Подсказка' }).first(), '«Показать решение»': page.getByRole('button', { name: 'Показать решение' }) });

  // play the whole solution: the child's moves sit at the even indexes, the replies come by themselves
  for (let guardCount = 0; guardCount < 8; guardCount += 1) {
    const snapshot = await puzzleSnapshot(page);
    if (snapshot.phase === 'solved') break;
    expect(snapshot.phase).toBe('solving');
    const uci = snapshot.puzzle?.solutionUci[snapshot.solutionIndex];
    expect(uci, 'the next solution move').toBeTruthy();
    const move = { from: uci?.slice(0, 2) ?? '', to: uci?.slice(2, 4) ?? '', ...(uci && uci.length > 4 ? { promotion: uci[4] } : {}) };
    await clickMove(page, board, move);
    await expect
      .poll(async () => {
        const next = await puzzleSnapshot(page);
        return next.phase === 'solved' || (next.phase === 'solving' && next.solutionIndex > snapshot.solutionIndex);
      })
      .toBe(true);
  }

  await expect(page.getByText('Решено!')).toBeVisible();
  await expect(page.getByRole('button', { name: /Дальше|Итоги/ })).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, 'puzzles-solved');

  // the attempt reached the server and was counted
  await expect
    .poll(async () => ((await (await request.get('/api/student')).json()) as { totals: { puzzlesAttempted: number; puzzlesSolved: number } }).totals.puzzlesAttempted)
    .toBe(before.totals.puzzlesAttempted + 1);

  // a wrong move on the next puzzle is «Попробуй ещё», never a failure screen
  await page.getByRole('button', { name: /Дальше/ }).click();
  await expect.poll(async () => (await puzzleSnapshot(page)).phase, { timeout: 20_000 }).toBe('solving');
  await expect.poll(async () => (await puzzleSnapshot(page)).index).toBe(1);

  await expectSilentRun(page);
  guard.assertClean();
});
