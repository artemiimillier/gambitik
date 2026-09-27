/** Progress, «Путь пешки», settings and the review opened from the game list: load, look right, log no errors. */
import { expect, expectSilentRun, test } from './fixtures.ts';
import { ensureStudent, openApp, shot, watchConsole } from './helpers.ts';

test.beforeEach(async ({ request }) => {
  await ensureStudent(request);
});

test('progress screen shows the numbers and the recent games', async ({ page }) => {
  const guard = watchConsole(page);
  await openApp(page, '#/progress');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('успехи');
  await expect(page.getByText(/Рейтинг в задачах|рейтинг/i).first()).toBeVisible();
  await page.waitForTimeout(1_500); // the lazy chart chunk
  await shot(page, 'progress');
  await expectSilentRun(page);
  guard.assertClean();
});

test('curriculum screen shows the ten stages and opens a concept card', async ({ page }) => {
  const guard = watchConsole(page);
  await openApp(page, '#/path');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Путь пешки');
  await page.waitForTimeout(1_000);
  await shot(page, 'curriculum');

  // a concept card: explanation, question and a playable example board
  await page.getByRole('button', { name: 'Незащищённая фигура' }).last().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-square]')).toHaveCount(64);
  await page.waitForTimeout(500);
  await shot(page, 'concept-card');
  await expectSilentRun(page);
  guard.assertClean();
});

test('settings stand behind the parent gate; behind it: the free voices (no live AI), sounds, stage and AI status', async ({ page }) => {
  const guard = watchConsole(page);
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Настройки');
  // the gate first: nothing of the real page is reachable for a child who just taps around
  await expect(page.getByRole('heading', { name: 'Эта страница — для мамы и папы' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Голос Гамбитика' })).toHaveCount(0);
  await shot(page, 'settings-gate');

  // a short tap is not enough …
  const hold = page.getByRole('button', { name: /Нажать и держать 3 секунды/ });
  await hold.click();
  await expect(page.getByRole('heading', { name: 'Голос Гамбитика' })).toHaveCount(0);
  // … a wrong answer neither, the right sum is: «сколько будет 27 + 48?»
  const label = (await page.locator('label[for="parent-gate-answer"]').textContent()) ?? '';
  const [a, b] = (label.match(/\d+/g) ?? []).map(Number);
  expect(Number.isFinite(a) && Number.isFinite(b), `a sum in «${label}»`).toBe(true);
  await page.locator('#parent-gate-answer').fill('1');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByText('Не сходится. Попробуйте ещё раз.')).toBeVisible();
  await page.locator('#parent-gate-answer').fill(String((a ?? 0) + (b ?? 0)));
  await page.getByRole('button', { name: 'Войти' }).click();

  // the real page. The e2e server runs without GAMBIT_RUNTIME_AI (docs/TEACHING.md §4.4): three free voices, the line
  // that the live voice is off, no microphone / conversation / OpenAI voice sections; the stage and who writes the reviews
  await expect(page.getByRole('heading', { name: 'Голос Гамбитика' })).toBeVisible();
  const voiceTiles = page.getByRole('group', { name: 'Голос в партии' });
  await expect(voiceTiles.getByRole('button')).toHaveCount(3);
  for (const option of ['Записанный голос', 'Голос компьютера — черновик', 'Без голоса']) {
    await expect(voiceTiles.getByRole('button', { name: new RegExp(option) })).toBeVisible();
  }
  // the stored default «auto» speaks with the recorded voice: that tile is pressed
  await expect(voiceTiles.getByRole('button', { name: /Записанный голос/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Живой голос выключен: в партии ребёнка ИИ не используется.')).toBeVisible();
  // nothing of the live voice
  for (const gone of ['Авто', 'Живой голос — слушает и говорит одновременно', 'Всегда слушает', 'По кнопке']) {
    await expect(page.getByRole('button', { name: new RegExp(gone) })).toHaveCount(0);
  }
  await expect(page.getByRole('radiogroup', { name: 'Голос Гамбитика' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Каким голосом говорит Гамбитик' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Микрофон', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Разговор с живым голосом' })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: /Разговор включается сам/ })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Как часто Гамбитик говорит сам' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Лимит живого голоса в день' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Послушать голос/ })).toHaveCount(0);
  // a tile writes the choice (the automated coach stays on its silent layer whatever is chosen) and back
  await voiceTiles.getByRole('button', { name: /Голос компьютера — черновик/ }).click();
  await expect(voiceTiles.getByRole('button', { name: /Голос компьютера — черновик/ })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gambit.settings') ?? '{}').voice)).toBe('browser');
  await voiceTiles.getByRole('button', { name: /Записанный голос/ }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gambit.settings') ?? '{}').voice)).toBe('clips');
  // «Звуки»: the parent's permanent «Всегда без звука» (off by default; the game's «Звук» button only mutes until midnight)
  await expect(page.getByRole('switch', { name: /Всегда без звука/ })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('heading', { name: 'Ступень обучения' })).toBeVisible();
  // the key line stays honest: a key in .env is not used in the child's game
  await expect(page.getByText(/ключ/i).first()).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, 'settings');
  await page.getByRole('heading', { name: 'Голос Гамбитика' }).scrollIntoViewIfNeeded();
  await shot(page, 'settings-voice');
  await page.getByRole('switch', { name: /Всегда без звука/ }).scrollIntoViewIfNeeded();
  await shot(page, 'settings-sounds');

  // the pass lasts for this tab: coming back does not ask again
  await openApp(page, '#/');
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { name: 'Голос Гамбитика' })).toBeVisible();
  await expectSilentRun(page);
  guard.assertClean();
});

test('the playground pages (mascot, ui kit) open without errors', async ({ page }) => {
  const guard = watchConsole(page);
  await openApp(page, '#/playground');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForTimeout(500);
  await openApp(page, '#/playground?tool=ui');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForTimeout(500);
  await expectSilentRun(page);
  guard.assertClean();
});

test('the plan names the last game, and its «Разбор» opens the review', async ({ page, request }) => {
  const games = (await (await request.get('/api/games?limit=1')).json()) as { id: string }[];
  test.skip(games.length === 0, 'no game was saved in this run (run 02-game.spec.ts first)');
  const guard = watchConsole(page);
  await openApp(page);
  const plan = page.getByRole('region', { name: 'План на сегодня' });
  // today's game (02-game.spec.ts) is named in «Партия»; an older one would be named in «Разбор»
  await expect(plan).toContainText(/Победа над |Сыграна с |Ничья с |Прошлая партия с /);
  await plan.getByRole('button', { name: /Разбор/ }).click();
  await expect(page).toHaveURL(/#\/review\//);
  await expect(page.locator('[data-square]').first()).toBeVisible();
  await expectSilentRun(page);
  guard.assertClean();
});
