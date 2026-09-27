/**
 * The production path: the Hono server alone serves the built SPA, the Stockfish files and the API.
 * No dev hook here (it is compiled out) — the test reads the DOM like a child would.
 */
import { expect, expectSilentRun, test } from '../fixtures.ts';
import { HOME_GREETING, NICKNAME, clickMove, ensureStudent, watchConsole } from '../helpers.ts';

test('pnpm start serves the SPA, the engine and the API from one port', async ({ page, request }) => {
  const health = await request.get('/api/health');
  expect(health.ok()).toBe(true);
  const info = (await health.json()) as { ok: boolean; llm: { openaiKey: boolean; codexCli: boolean }; puzzles: { count: number }; clipGen?: { state: string; overlay: boolean } };
  expect(info.ok).toBe(true);
  expect(info.llm.openaiKey || info.llm.codexCli, 'the smoke server must not have paid providers').toBe(false);
  // «Дозапись голоса»: never a paid recording from a test run, and the recorded overlay is not served (the config's env)
  expect(info.clipGen, 'the smoke server must not record new phrases (GAMBIT_CLIP_GEN=0)').toEqual({ state: 'off', overlay: false });
  expect((await request.post('/api/voice/clips/request', { data: { sentences: [{ parts: [{ pool: 'v3.whole.castle', n: 16 }] }] } })).status()).toBe(503);
  expect(info.puzzles.count).toBeGreaterThan(0);

  // static files: the SPA shell, the engine (JS + WASM with the right type), an SPA fallback, a JSON 404
  const index = await request.get('/');
  expect(index.headers()['content-type']).toContain('text/html');
  const indexHtml = await index.text();
  expect(indexHtml).toContain('<div id="root">');
  // a strict CSP as a response header AND inside the built page; the engine (wasm) and the blob worker
  // must still work under it — any violation is a console error and fails the guard below
  const csp = index.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).toContain("frame-ancestors 'none'");
  // Vite writes the quotes of the attribute value as &#39; — the browser decodes them
  expect(indexHtml.replaceAll('&#39;', "'")).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval';/);
  const wasm = await request.get('/engine/stockfish-19-lite-single.wasm');
  expect(wasm.ok()).toBe(true);
  expect(wasm.headers()['content-type']).toContain('application/wasm');
  expect((await request.get('/engine/stockfish-19-lite-single.js')).ok()).toBe(true);
  expect((await request.get('/some/deep/link')).headers()['content-type']).toContain('text/html');
  const missing = await request.get('/api/nope');
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toEqual({ error: 'not-found' });

  await ensureStudent(request);
  const guard = watchConsole(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: HOME_GREETING })).toBeVisible();
  expect(await page.evaluate(() => '__gambit' in window), 'the dev hook is not part of the production bundle').toBe(false);
  expect(await page.evaluate(() => '__gambitVoiceProbe' in window), 'the voice probe needs an explicit opt-in').toBe(false);
  expect(await page.evaluate(() => document.fonts.check('700 20px "Nunito Variable"')), 'Nunito is bundled and loaded').toBe(true);

  // a real game on the built bundle: the engine worker starts, the bot answers 1.e4
  await page.goto('/#/play?persona=petya&tc=training&color=w&exam=0');
  const board = page.getByTestId('trainer-board');
  await expect(board.locator('[data-square]')).toHaveCount(64);
  await expect(page.getByRole('status').filter({ hasText: 'Твой ход!' })).toBeVisible({ timeout: 45_000 });
  await clickMove(page, board, { from: 'e2', to: 'e4' });
  const firstRow = page.getByRole('group', { name: 'Ходы партии' }).or(page.locator('[aria-label="Ходы партии"]')).locator('li').first();
  await expect(firstRow).toContainText('e4');
  await expect(page.getByRole('status').filter({ hasText: 'Твой ход!' })).toBeVisible({ timeout: 20_000 });
  await expect(firstRow.locator('span').nth(2)).not.toBeEmpty();

  // the developer showcase is not shipped: its address shows the home screen
  await page.goto('/#/playground');
  await expect(page.getByRole('heading', { name: HOME_GREETING })).toBeVisible();

  await expectSilentRun(page);
  guard.assertClean();
});
