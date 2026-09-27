/**
 * The public site's accounts in a real browser (playwright.accounts.config.ts): sign-up with the invite code shows the
 * recovery code once and opens the child's own app; the phrase book written by the app goes to the account; signing
 * out removes it from the browser; a second child on the same browser starts clean and never sees the first one's;
 * the first child signs in again (any case of the nickname) and gets its phrase book back; a forgotten password is
 * replaced with the recovery code (a new code appears, the old password stops working); the account is deleted with
 * its data. Silent: the app never speaks under automation and the run has no keys and no paid voice.
 */
import type { Page } from '@playwright/test';
import { expect, expectSilentRun, test } from '../fixtures.ts';

const INVITE = 'e2e-invite-2026';
/** the answers the scenario expects the server to give (Chrome logs them as failed resource loads) */
const EXPECTED_STATUS = /Failed to load resource: the server responded with a status of 40[139]/;

function consoleGuard(page: Page): { assertClean(): void } {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !EXPECTED_STATUS.test(m.text()) && !/speech watchdog/i.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return { assertClean: () => expect(problems, 'browser console must stay free of errors').toEqual([]) };
}

async function passParentGate(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Эта страница — для мамы и папы' })).toBeVisible();
  const label = (await page.locator('label[for="parent-gate-answer"]').textContent()) ?? '';
  const [a, b] = (label.match(/\d+/g) ?? []).map(Number);
  await page.locator('#parent-gate-answer').fill(String((a ?? 0) + (b ?? 0)));
  await page.locator('form').getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Аккаунт' })).toBeVisible();
}

async function register(page: Page, o: { login: string; password: string; girl?: boolean; stage?: number }): Promise<string> {
  await page.getByRole('tab', { name: 'Новый ученик' }).click();
  await page.getByLabel('Ник').fill(o.login);
  await page.getByLabel('Пароль', { exact: true }).fill(o.password);
  await page.getByLabel('Пароль ещё раз').fill(o.password);
  await page.getByLabel('Код приглашения').fill(INVITE);
  await page.getByRole('button', { name: o.girl === true ? /Девочка/ : /Мальчик/ }).click();
  if (o.stage !== undefined) await page.getByLabel('Ступень').selectOption(String(o.stage));
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  const code = page.getByTestId('recovery-code');
  await expect(code).toBeVisible();
  const text = ((await code.textContent()) ?? '').trim();
  expect(text).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  await page.getByRole('button', { name: /Я записал\(а\) код/ }).click();
  return text;
}

async function signIn(page: Page, login: string, password: string): Promise<void> {
  await page.getByLabel('Ник').fill(login);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: 'Войти', exact: true }).last().click();
}

async function signOut(page: Page): Promise<void> {
  await page.goto('/#/settings');
  await passParentGate(page);
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible();
}

const local = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);
const api = (page: Page, path: string) => page.evaluate(async (p) => (await fetch(p)).json(), path);

test('sign-up, the child’s own data, a second child, sign-in again, recovery, deletion', async ({ page, request }) => {
  const guard = consoleGuard(page);

  // without a session: the door, and no child's data through the API
  expect((await request.get('/api/student')).status()).toBe(401);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible();

  // a wrong invite code is refused
  await page.getByRole('tab', { name: 'Новый ученик' }).click();
  await page.getByLabel('Ник').fill('Тигр');
  await page.getByLabel('Пароль', { exact: true }).fill('пароль-тигра-1');
  await page.getByLabel('Пароль ещё раз').fill('пароль-тигра-1');
  await page.getByLabel('Код приглашения').fill('не тот код');
  await page.getByRole('button', { name: /Мальчик/ }).click();
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByText('Код приглашения не подходит.', { exact: false })).toBeVisible();
  await page.getByRole('tab', { name: 'Войти' }).click();

  // 1. Тигр signs up: the recovery code once, then his home screen
  const tigrCode = await register(page, { login: 'Тигр', password: 'пароль-тигра-1', stage: 2 });
  await expect(page.getByRole('heading', { name: /^(Привет|Доброе утро|Добрый день|Добрый вечер), Тигр!$/ })).toBeVisible();
  expect(await api(page, '/api/student')).toMatchObject({ nickname: 'Тигр', address: 'm', stage: 2 });

  // the app's phrase book goes to his account
  await page.evaluate(() => localStorage.setItem('gambit.lessonBook', '{"e2e":"книга Тигра"}'));
  await expect.poll(async () => ((await api(page, '/api/account/state')) as { values: Record<string, string> }).values['gambit.lessonBook']).toBe('{"e2e":"книга Тигра"}');

  // 2. sign-out: his data leaves the browser
  await signOut(page);
  expect(await local(page, 'gambit.lessonBook')).toBeNull();
  expect((await request.get('/api/student')).status()).toBe(401);

  // 3. Лиса on the same browser: a clean start, nothing of Тигр
  await register(page, { login: 'Лиса', password: 'пароль-лисы-1', girl: true });
  await expect(page.getByRole('heading', { name: /Лиса!$/ })).toBeVisible();
  expect(await local(page, 'gambit.lessonBook')).toBeNull();
  expect(await api(page, '/api/student')).toMatchObject({ nickname: 'Лиса', address: 'f', stage: 1 });
  expect(await api(page, '/api/account/state')).toEqual({ values: {}, times: {} });
  expect(await api(page, '/api/games')).toEqual([]);
  await signOut(page);

  // 4. Тигр again (any case): his phrase book comes back from the account
  await signIn(page, 'тИГР', 'неправильный пароль');
  await expect(page.getByText('Неверный ник или пароль.')).toBeVisible();
  await signIn(page, 'тИГР', 'пароль-тигра-1');
  await expect(page.getByRole('heading', { name: /Тигр!$/ })).toBeVisible();
  expect(await local(page, 'gambit.lessonBook')).toBe('{"e2e":"книга Тигра"}');
  await signOut(page);

  // 5. a forgotten password: the recovery code sets a new one and shows a NEW code
  await page.getByRole('button', { name: 'Забыли пароль?' }).click();
  await page.getByLabel('Ник').fill('Тигр');
  await page.getByLabel('Код восстановления').fill(tigrCode.toLowerCase());
  await page.getByLabel('Новый пароль').fill('новый-пароль-тигра');
  await page.getByLabel('Пароль ещё раз').fill('новый-пароль-тигра');
  await page.getByRole('button', { name: 'Сменить пароль' }).click();
  const next = ((await page.getByTestId('recovery-code').textContent()) ?? '').trim();
  expect(next).not.toBe(tigrCode);
  await page.getByRole('button', { name: /Я записал\(а\) код/ }).click();
  await expect(page.getByRole('heading', { name: /Тигр!$/ })).toBeVisible();
  expect((await request.post('/api/auth/login', { data: { login: 'Тигр', password: 'пароль-тигра-1' } })).status()).toBe(401);

  // 6. deleting the account: the password, then everything is gone
  await page.goto('/#/settings');
  await passParentGate(page);
  await page.getByRole('button', { name: 'Удалить аккаунт…' }).click();
  await page.getByLabel('Пароль для подтверждения').fill('новый-пароль-тигра');
  await page.getByRole('button', { name: 'Удалить навсегда' }).click();
  await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible();
  expect(await local(page, 'gambit.lessonBook')).toBeNull();
  await signIn(page, 'Тигр', 'новый-пароль-тигра');
  await expect(page.getByText('Неверный ник или пароль.')).toBeVisible();

  await expectSilentRun(page);
  guard.assertClean();
});
