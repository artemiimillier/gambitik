/** (a) First run: onboarding → home. */
import { expect, expectSilentRun, test } from './fixtures.ts';
import { HOME_GREETING, NICKNAME, openApp, shot, watchConsole } from './helpers.ts';

test('onboarding leads a new child to the home screen', async ({ page, request }) => {
  // the server's default profile («Шахматист») + an empty localStorage = first run
  const reset = await request.put('/api/student', { data: { nickname: 'Шахматист' } });
  expect(reset.ok()).toBe(true);

  const guard = watchConsole(page);
  await openApp(page);

  await expect(page.getByRole('heading', { name: 'Как тебя зовут?' })).toBeVisible();
  // the bundled font really renders the Cyrillic headlines (no fallback face)
  await expect.poll(() => page.evaluate(() => document.fonts.check('800 24px "Nunito Variable"', 'Привет'))).toBe(true);
  await shot(page, 'onboarding-name');
  await page.getByLabel('Твоё имя или прозвище').fill(NICKNAME);
  await page.getByRole('button', { name: 'Дальше' }).click();

  await expect(page.getByRole('heading', { name: 'Ты мальчик или девочка?' })).toBeVisible();
  await page.getByRole('button', { name: 'Мальчик' }).click();

  await expect(page.getByRole('heading', { name: `Приятно познакомиться, ${NICKNAME}!` })).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, 'onboarding-welcome');
  await page.getByRole('button', { name: 'Поехали!' }).click();

  await expect(page.getByRole('heading', { name: HOME_GREETING })).toBeVisible();
  const menu = page.getByRole('navigation', { name: 'Главное меню' });
  for (const tile of ['Играть', 'Задачи', 'Путь пешки', 'Мои успехи']) {
    await expect(menu.getByRole('button', { name: new RegExp(tile) })).toBeVisible();
  }

  // the profile really went to the server
  const student = await (await request.get('/api/student')).json();
  expect(student.nickname).toBe(NICKNAME);
  expect(student.address).toBe('m');

  // a reload keeps the child on the home screen (no second onboarding)
  await page.reload();
  await expect(page.getByRole('heading', { name: HOME_GREETING })).toBeVisible();

  await page.waitForTimeout(800); // let the mascot settle for the picture
  await shot(page, 'home');
  await expectSilentRun(page);
  guard.assertClean();
});
