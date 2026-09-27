/**
 * Accounts (GAMBIT_ACCOUNTS=1) over HTTP, on a throw-away DATA_DIR with no network: sign-up needs the invite code, the
 * session cookie is HttpOnly + SameSite=Lax (+ Secure behind TLS), a wrong or unknown login gets the same answer and
 * the attempt limits hold, and — the point of it all — one child's data (profile, games, journal, progress, the
 * browser's state) is never reachable from another account, not even by id. Also: recovery without e-mail, sign-out,
 * deleting an account with its folder, the recorder staying off, and the family server (accounts off) unchanged.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GameListItem, StudentProfile } from '@gambit/shared';
import { createApp } from '../app.ts';
import type { AdminStats } from './adminStats.ts';
import { inviteHash } from './routes.ts';
import { leadingZeroBits } from './pow.ts';
import { loadConfig } from '../config.ts';
import type { ServerConfig } from '../config.ts';
import { createServerContext } from '../context.ts';
import { TEST_HOST, TEST_ORIGIN, sampleGameRecord } from '../testing/fixtures.ts';
import { RateLimiter } from './limiter.ts';
import { hashSecret, newInviteCode, newRecoveryCode, normalizeRecoveryCode, passwordProblem, verifySecret } from './password.ts';
import { createAccountsRuntime } from './runtime.ts';
import { AccountStore, parseLogin } from './store.ts';

const INVITE = 'шахматы-2026';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function site(o: { invite?: string | null; cookieSecure?: boolean; limiter?: RateLimiter; maxAccounts?: number; adminLogins?: string[]; open?: boolean; powBits?: number; config?: Partial<ServerConfig> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'gambit-accounts-'));
  const config = loadConfig(
    {},
    {
      dataDir,
      puzzlesDbPath: join(dataDir, 'build', 'puzzles.sqlite'),
      starterPuzzlesPath: join(dataDir, 'no-starter.json'),
      webDistDir: join(dataDir, 'no-dist'),
      runtimeAi: false,
      codexBin: null,
      openaiApiKey: null,
      log: false,
      accounts: { enabled: true, inviteCode: o.invite === undefined ? INVITE : o.invite, trustProxy: true, cookieSecure: o.cookieSecure ?? false, maxAccounts: o.maxAccounts ?? 300, adminLogins: o.adminLogins ?? [], openRegistration: o.open ?? false, powBits: o.powBits ?? 0 },
      ...o.config,
    },
  );
  const failingFetch: typeof fetch = () => Promise.reject(new Error('network access is not allowed in tests'));
  const safe: ServerConfig = { ...config, clipGen: { ...config.clipGen, bin: null } };
  const ctx = await createServerContext(safe, { fetchImpl: failingFetch });
  const rt = createAccountsRuntime(safe, ctx, { overrides: { fetchImpl: failingFetch }, ...(o.limiter ? { limiter: o.limiter } : {}) });
  const app = createApp(ctx, rt);
  cleanups.push(async () => {
    await rt.close();
    await ctx.idle();
    await ctx.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A browser: its own cookie jar (the session cookie as `cookie`, the known-device cookie as `device`) and address. */
  const browser = (ip = '203.0.113.7') => {
    let cookie: string | null = null;
    let device: string | null = null;
    const request = async (path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}): Promise<Response> => {
      const method = init.method ?? (init.json !== undefined ? 'POST' : 'GET');
      const headers: Record<string, string> = { host: TEST_HOST, 'x-real-ip': ip };
      if (method !== 'GET') headers.origin = TEST_ORIGIN;
      if (init.json !== undefined) headers['content-type'] = 'application/json';
      const jar = [cookie, device].filter((v) => v !== null);
      if (jar.length > 0) headers.cookie = jar.join('; ');
      const res = await app.request(path, { method, headers: { ...headers, ...init.headers }, body: init.json === undefined ? undefined : JSON.stringify(init.json) });
      for (const set of res.headers.getSetCookie()) {
        const pair = set.split(';')[0] ?? '';
        const value = /=$/.test(pair) || /Max-Age=0/i.test(set) ? null : pair;
        if (/^(?:__Host-gambit-device|gambit_device)=/.test(pair)) device = value;
        else cookie = value;
      }
      return res;
    };
    return {
      request,
      get cookie() {
        return cookie;
      },
      set cookie(v: string | null) {
        cookie = v;
      },
      get device() {
        return device;
      },
      set device(v: string | null) {
        device = v;
      },
      register: (login: string, password = 'пароль-длинный-1', extra: Record<string, unknown> = {}) =>
        request('/api/auth/register', { json: { login, password, invite: INVITE, address: 'm', stage: 1, ...extra } }),
      login: (login: string, password: string) => request('/api/auth/login', { json: { login, password } }),
    };
  };
  return { app, ctx, rt, dataDir, browser };
}

describe('secrets', () => {
  it('scrypt with a random salt: the same password hashes differently, verifies, and a wrong one or a bad row does not', async () => {
    const a = await hashSecret('секретный пароль');
    const b = await hashSecret('секретный пароль');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
    expect(await verifySecret('секретный пароль', a)).toBe(true);
    expect(await verifySecret('секретный парол', a)).toBe(false);
    expect(await verifySecret('x', 'plain-text')).toBe(false);
    expect(await verifySecret('x', 'scrypt$1073741824$8$1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
  });

  it('password length rules; recovery codes: 16 unambiguous symbols, typed any way', () => {
    expect(passwordProblem('1234567')).toBe('short');
    expect(passwordProblem('x'.repeat(129))).toBe('long');
    // the first guesses are refused
    for (const weak of ['12345678', '87654321', 'abcdefgh', 'aaaaaaaa', 'abababab', 'qwerty123', 'Пароль123', 'йцукенгш', 'Шахматы123', '20122015']) {
      expect(passwordProblem(weak), weak).toBe('common');
    }
    expect(passwordProblem('красный конь прыгает')).toBeNull();
    expect(passwordProblem('Tigr-2026-lion')).toBeNull();
    const code = newRecoveryCode();
    expect(code).toMatch(/^[ACDEFGHJKMNPQRTUVWXY3469]{4}(-[ACDEFGHJKMNPQRTUVWXY3469]{4}){3}$/);
    expect(normalizeRecoveryCode(code.toLowerCase().replaceAll('-', ' '))).toBe(code);
    expect(normalizeRecoveryCode('0000-0000-0000-0000')).toBeNull();
  });

  it('logins: a nickname of 2–24 letters or digits; «Тигр», «ТИГР» and «тигр» are one login; «ё» is «е»', () => {
    expect(parseLogin('  Тигр  ')).toEqual({ display: 'Тигр', key: 'тигр' });
    expect(parseLogin('Ёжик')?.key).toBe('ежик');
    expect(parseLogin('a')).toBeNull();
    expect(parseLogin('<script>')).toBeNull();
    expect(parseLogin('x'.repeat(25))).toBeNull();
    expect(parseLogin('Маша Петрова 2')?.display).toBe('Маша Петрова 2');
  });

  it('the store keeps only hashes: no password, recovery code or session token in the database file', async () => {
    const s = await site();
    const b = s.browser();
    const res = await b.register('Тигр', 'очень-секретный-пароль');
    const { recoveryCode } = (await res.json()) as { recoveryCode: string };
    const token = decodeURIComponent((b.cookie ?? '').split('=')[1] ?? '');
    const store = new AccountStore(join(s.dataDir, 'accounts.db'));
    const dump = JSON.stringify([store.list(), store.db.all('SELECT * FROM session')]);
    store.close();
    expect(dump).not.toContain('очень-секретный-пароль');
    expect(dump).not.toContain(recoveryCode);
    expect(token.length).toBeGreaterThan(30);
    expect(dump).not.toContain(token);
  });
});

describe('sign-up, sign-in, sessions', () => {
  it('nothing but health and auth answers without a session', async () => {
    const s = await site();
    const b = s.browser();
    expect((await b.request('/api/health')).status).toBe(200);
    expect(await (await b.request('/api/auth/me')).json()).toEqual({ accounts: true, registration: true, invite: true, user: null });
    for (const path of ['/api/student', '/api/games', '/api/progress', '/api/account/state', '/api/voice/clips/status', '/api/puzzles/next']) {
      const res = await b.request(path);
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({ error: 'auth-required' });
    }
  });

  it('sign-up needs the invite code (and is closed without one); the profile gets the nickname, gender and stage', async () => {
    const closed = await site({ invite: null });
    expect((await closed.browser().register('Тигр')).status).toBe(403);
    const s = await site();
    const b = s.browser();
    const wrong = await b.request('/api/auth/register', { json: { login: 'Тигр', password: 'пароль-длинный-1', invite: 'не тот', address: 'f', stage: 3 } });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: 'bad-invite' });
    const res = await b.request('/api/auth/register', { json: { login: 'Лиса', password: 'пароль-длинный-1', invite: ` ${INVITE} `, address: 'f', stage: 3 } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { login: string; account: string }; recoveryCode: string };
    expect(body.user).toEqual({ login: 'Лиса', account: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(normalizeRecoveryCode(body.recoveryCode)).toBe(body.recoveryCode);
    const profile = (await (await b.request('/api/student')).json()) as StudentProfile;
    expect(profile).toMatchObject({ nickname: 'Лиса', address: 'f', stage: 3 });
    expect(await (await b.request('/api/auth/me')).json()).toEqual({ accounts: true, registration: true, invite: true, user: { login: 'Лиса', account: body.user.account } });
    // the same login in another case is taken
    expect((await s.browser('198.51.100.1').register('ЛИСА')).status).toBe(409);
    // weak passwords and bad logins
    expect((await s.browser('198.51.100.2').register('Волк', 'short')).status).toBe(400);
    expect((await s.browser('198.51.100.3').register('<b>')).status).toBe(400);
  });

  it('the session cookie: HttpOnly, SameSite=Lax, path /, 30 days; Secure and __Host- behind TLS', async () => {
    const plain = await site();
    const res = await plain.browser().register('Тигр');
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/^gambit_session=[\w-]{40,};/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Path=\//);
    expect(set).toMatch(/Max-Age=2592000/);
    expect(set).not.toMatch(/Secure/);
    const tls = await site({ cookieSecure: true });
    const set2 = (await tls.browser().register('Тигр')).headers.get('set-cookie') ?? '';
    expect(set2).toMatch(/^__Host-gambit=/);
    expect(set2).toMatch(/Secure/);
  });

  it('a wrong password and an unknown login get the same answer; a good one opens a session; sign-out closes it', async () => {
    const s = await site();
    await s.browser().register('Тигр', 'правильный-пароль');
    const b = s.browser('192.0.2.10');
    const wrong = await b.login('Тигр', 'неправильный');
    const unknown = await b.login('Никто', 'неправильный');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect(b.cookie).toBeNull();
    const ok = await b.login('тИгР', 'правильный-пароль');
    expect(ok.status).toBe(200);
    expect((await b.request('/api/student')).status).toBe(200);
    const old = b.cookie;
    expect((await b.request('/api/auth/logout', { json: {} })).status).toBe(200);
    expect(b.cookie).toBeNull();
    // the old cookie is dead on the server too
    b.cookie = old;
    expect((await b.request('/api/student')).status).toBe(401);
  });

  it('guessing is limited: 10 failures per login, 20 per address — 429 with Retry-After, even for the right password', async () => {
    let now = Date.parse('2026-09-26T12:00:00Z');
    const limiter = new RateLimiter({ now: () => now });
    const s = await site({ limiter });
    await s.browser().register('Тигр', 'правильный-пароль');
    // from many addresses at one login
    for (let i = 0; i < 10; i++) expect((await s.browser(`10.0.0.${i}`).login('Тигр', `guess-${i}`)).status).toBe(401);
    const locked = await s.browser('10.0.1.1').login('Тигр', 'правильный-пароль');
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    // 15 minutes later the child can sign in again
    now += 15 * 60_000 + 1000;
    expect((await s.browser('10.0.1.1').login('Тигр', 'правильный-пароль')).status).toBe(200);
    // one address guessing many logins
    const attacker = s.browser('10.9.9.9');
    for (let i = 0; i < 20; i++) expect((await attacker.login(`user${i}`, 'x')).status).toBe(401);
    expect((await attacker.login('Тигр', 'правильный-пароль')).status).toBe(429);
  });

  it('a foreign page cannot sign in or post for the child (Origin check), and bodies must be JSON', async () => {
    const s = await site();
    const b = s.browser();
    await b.register('Тигр', 'правильный-пароль');
    const csrf = await b.request('/api/auth/logout', { json: {}, headers: { origin: 'https://evil.example' } });
    expect(csrf.status).toBe(403);
    const form = await s.app.request('/api/auth/login', { method: 'POST', headers: { host: TEST_HOST, origin: TEST_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: 'login=Тигр&password=x' });
    expect(form.status).toBe(415);
  });
});

describe('one child never sees another', () => {
  it('profile, games, journal, progress and the browser state belong to the account only — even by id', async () => {
    const s = await site();
    const tigr = s.browser('198.51.100.10');
    const lisa = s.browser('198.51.100.11');
    await tigr.register('Тигр', 'пароль-тигра-123', { address: 'm', stage: 2 });
    await lisa.register('Лиса', 'пароль-лисы-123', { address: 'f', stage: 1 });
    const saved = await tigr.request('/api/games', { json: sampleGameRecord() });
    expect(saved.status).toBe(201);
    const { id } = (await saved.json()) as { id: string };
    // Тигр sees his game
    expect(((await (await tigr.request('/api/games')).json()) as GameListItem[]).map((g) => g.id)).toContain(id);
    expect((await tigr.request(`/api/games/${id}`)).status).toBe(200);
    // Лиса sees nothing of it: not in her list, not by id, not its journal
    expect(await (await lisa.request('/api/games')).json()).toEqual([]);
    expect((await lisa.request(`/api/games/${id}`)).status).toBe(404);
    expect((await lisa.request(`/api/games/${id}/journal`)).status).toBe(404);
    expect((await lisa.request(`/api/games/${id}/review`)).status).toBe(404);
    expect((await lisa.request(`/api/games/${id}/thoughts`, { json: { thoughts: [{ id: 't1', text: 'чужая мысль', at: new Date().toISOString() }] } })).status).not.toBe(200);
    // profiles and progress are each child's own
    expect(((await (await lisa.request('/api/student')).json()) as StudentProfile).nickname).toBe('Лиса');
    expect(((await (await tigr.request('/api/student')).json()) as StudentProfile).totals.games).toBe(1);
    expect(((await (await lisa.request('/api/student')).json()) as StudentProfile).totals.games).toBe(0);
    await lisa.request('/api/student', { method: 'PUT', json: { nickname: 'Лиса Патрикеевна' } });
    expect(((await (await tigr.request('/api/student')).json()) as StudentProfile).nickname).toBe('Тигр');
    // the browser's memory (the phrase book) too
    expect((await tigr.request('/api/account/state', { method: 'PUT', json: { key: 'gambit.lessonBook', value: '{"tigr":1}', at: 1000 } })).status).toBe(200);
    expect(await (await tigr.request('/api/account/state')).json()).toEqual({ values: { 'gambit.lessonBook': '{"tigr":1}' }, times: { 'gambit.lessonBook': 1000 } });
    expect(await (await lisa.request('/api/account/state')).json()).toEqual({ values: {}, times: {} });
    // on disk: every file of a child lives in its own folder, none at the top of DATA_DIR
    const users = readdirSync(join(s.dataDir, 'users'));
    expect(users).toHaveLength(2);
    const top = readdirSync(s.dataDir).filter((f) => f.startsWith('games'));
    expect(top).toEqual([]);
  });

  it('the browser state takes only its own keys and sizes', async () => {
    const s = await site();
    const b = s.browser();
    await b.register('Тигр');
    expect((await b.request('/api/account/state', { method: 'PUT', json: { key: 'gambit.somethingElse', value: 'x' } })).status).toBe(400);
    expect((await b.request('/api/account/state', { method: 'PUT', json: { key: 'gambit.settings', value: 'x'.repeat(300 * 1024) } })).status).toBe(413);
    expect((await b.request('/api/account/state', { method: 'PUT', json: { key: 'gambit.settings', value: '{"voice":"clips"}' } })).status).toBe(200);
    expect((await b.request('/api/account/state', { method: 'PUT', json: { key: 'gambit.settings', value: null, at: 5 } })).status).toBe(200);
    // removed, and the removal remembered with its time
    expect(await (await b.request('/api/account/state')).json()).toEqual({ values: {}, times: { 'gambit.settings': 5 } });
  });
});

describe('abuse limits and hardening', () => {
  it('parallel wrong passwords cannot slip past the limit — and the right one is then locked too', async () => {
    const s = await site();
    await s.browser().register('Тигр', 'правильный-пароль');
    // from many addresses at once (from one address, all but 2 at a time are refused unchecked — and not counted: L2)
    const answers = await Promise.all(Array.from({ length: 30 }, (_, i) => s.browser(`10.1.${i}.1`).login('Тигр', `guess-${i}`)));
    const statuses = answers.map((r) => r.status);
    expect(statuses.filter((x) => x === 401).length).toBeLessThanOrEqual(10);
    expect(statuses.every((x) => x === 401 || x === 429)).toBe(true);
    expect((await s.browser('10.1.99.2').login('Тигр', 'правильный-пароль')).status).toBe(429);
  });

  it('parallel sign-ups from one address stop at the limit (20 an hour)', async () => {
    const s = await site();
    const answers = await Promise.all(Array.from({ length: 30 }, (_, i) => s.browser('10.2.2.2').register(`Ученик${i}`, 'пароль-длинный-1')));
    expect(answers.filter((r) => r.status === 201).length).toBeLessThanOrEqual(20);
    expect(answers.some((r) => r.status === 429)).toBe(true);
  });

  it('form mistakes do not spend the sign-up limits: many children at once still get in', async () => {
    const limiter = new RateLimiter({ rules: { registerIp: { max: 2, windowMs: 3600_000 }, registerAll: { max: 3, windowMs: 3600_000 } } });
    const s = await site({ limiter });
    for (let i = 0; i < 10; i++) {
      expect((await s.browser(`10.6.${i}.1`).register(`Ученик${i}`, 'short')).status).toBe(400);
      expect((await s.browser(`10.6.${i}.1`).register('<b>')).status).toBe(400);
    }
    for (let i = 0; i < 2; i++) expect((await s.browser(`10.7.${i}.1`).register(`Ребёнок${i}`)).status).toBe(201);
    // a taken nick is counted per address only
    expect((await s.browser('10.8.0.1').register('Ребёнок0')).status).toBe(409);
    expect((await s.browser('10.8.0.1').register('Ребёнок1')).status).toBe(409);
    expect((await s.browser('10.8.0.1').register('Ребёнок0')).status).toBe(429);
    // the whole site's hour is spent by successful sign-ups only
    expect((await s.browser('10.9.0.1').register('Ребёнок2')).status).toBe(201);
    expect((await s.browser('10.9.0.2').register('Ещё')).status).toBe(429);
  });

  it('a flood of sign-ins from many addresses gets 503 busy beyond the queue, instead of stalling the server', async () => {
    const s = await site();
    const answers = await Promise.all(Array.from({ length: 60 }, (_, i) => s.browser(`10.3.${i}.1`).login(`никто${i}`, 'x-x-x-x-x')));
    const statuses = answers.map((r) => r.status);
    expect(statuses.filter((x) => x === 503).length).toBeGreaterThan(0);
    expect(statuses.every((x) => x === 401 || x === 503)).toBe(true);
    expect(answers.find((r) => r.status === 503)?.headers.get('retry-after')).toBe('5');
  });

  it('a page that speaks for another account (a tab of the child who signed out) is told, not obeyed', async () => {
    const s = await site();
    const b = s.browser();
    const { user } = (await (await b.register('Тигр')).json()) as { user: { account: string } };
    expect((await b.request('/api/student', { headers: { 'x-gambit-account': user.account } })).status).toBe(200);
    const other = await b.request('/api/games', { json: sampleGameRecord(), headers: { 'x-gambit-account': '0123456789abcdef' } });
    expect(other.status).toBe(401);
    expect(await other.json()).toEqual({ error: 'account-changed' });
    expect(await (await b.request('/api/games')).json()).toEqual([]);
  });

  it('recovery: two requests with one code at once — exactly one wins', async () => {
    const s = await site();
    const { recoveryCode } = (await (await s.browser().register('Тигр', 'старый-пароль-1')).json()) as { recoveryCode: string };
    const [a, b] = await Promise.all([
      s.browser('10.4.0.1').request('/api/auth/recover', { json: { login: 'Тигр', recoveryCode, password: 'новый-пароль-1' } }),
      s.browser('10.4.0.2').request('/api/auth/recover', { json: { login: 'Тигр', recoveryCode, password: 'новый-пароль-2' } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });

  it('open registration: no invite code, but a solved task, one account per task, and the hidden field stops scripts', async () => {
    const s = await site({ invite: null, open: true, powBits: 8 });
    expect(await (await s.browser().request('/api/auth/me')).json()).toMatchObject({ registration: true, invite: false });
    const task = async () => {
      const { pow } = (await (await s.browser().request('/api/auth/challenge')).json()) as { pow: { challenge: string; difficulty: number } };
      expect(pow.difficulty).toBe(8);
      let n = 0;
      while (leadingZeroBits(createHash('sha256').update(`${pow.challenge}:${n.toString(36)}`).digest()) < 8) n++;
      return { challenge: pow.challenge, nonce: n.toString(36) };
    };
    const reg = (ip: string, login: string, extra: Record<string, unknown>) =>
      s.browser(ip).request('/api/auth/register', { json: { login, password: 'пароль-длинный-1', address: 'm', stage: 1, ...extra } });
    // no task, a wrong nonce, a forged task: refused
    expect((await reg('10.30.0.1', 'Тигр', {})).status).toBe(403);
    const t1 = await task();
    expect((await reg('10.30.0.1', 'Тигр', { pow: { challenge: t1.challenge, nonce: 'zzzz-not-it' } })).status).toBe(403);
    expect((await reg('10.30.0.1', 'Тигр', { pow: { challenge: `${t1.challenge.slice(0, -2)}AA`, nonce: t1.nonce } })).status).toBe(403);
    // the hidden field filled: a script
    expect((await reg('10.30.0.2', 'Тигр', { pow: t1, website: 'http://spam' })).status).toBe(403);
    // a form mistake keeps the task usable; the account takes it, a second account cannot
    expect((await reg('10.30.0.3', 'Тигр', { pow: t1, password: 'short' })).status).toBe(400);
    const ok = await reg('10.30.0.3', 'Тигр', { pow: t1 });
    expect(ok.status).toBe(201);
    expect((await reg('10.30.0.4', 'Лиса', { pow: t1 })).status).toBe(403);
    expect((await reg('10.30.0.4', 'Лиса', { pow: await task(), invite: 'что угодно' })).status).toBe(201);
    expect(s.rt.store.byLogin('тигр')?.invite_label).toBe('открытая');
  });

  it('families’ own invite codes: a label goes with the account, a limited code is used up, a closed one refused, a failed sign-up gives the use back', async () => {
    const s = await site({ invite: null, adminLogins: ['Хозяин'] });
    expect(await (await s.browser().request('/api/auth/me')).json()).toMatchObject({ registration: false });
    const code = newInviteCode();
    expect(s.rt.store.addInvite('Ивановы', inviteHash(code), 2)).toBe(true);
    expect(await (await s.browser().request('/api/auth/me')).json()).toMatchObject({ registration: true });
    const reg = (b: ReturnType<typeof s.browser>, login: string, invite: string, password = 'пароль-длинный-1') =>
      b.request('/api/auth/register', { json: { login, password, invite, address: 'm', stage: 1 } });
    // a form mistake does not spend the code
    expect((await reg(s.browser('10.20.0.1'), 'Тигр', code, 'short')).status).toBe(400);
    // typed the phone way: lower case, no dashes
    expect((await reg(s.browser('10.20.0.2'), 'Тигр', code.toLowerCase().replaceAll('-', ''))).status).toBe(201);
    expect((await reg(s.browser('10.20.0.3'), 'Лиса', code)).status).toBe(201);
    expect((await reg(s.browser('10.20.0.4'), 'Волк', code)).status).toBe(403);
    expect(s.rt.store.byLogin('тигр')?.invite_label).toBe('Ивановы');
    const other = newInviteCode();
    s.rt.store.addInvite('Школа', inviteHash(other), null);
    s.rt.store.setInviteDisabled('Школа', true);
    expect((await reg(s.browser('10.20.0.5'), 'Сова', other)).status).toBe(403);
    s.rt.store.setInviteDisabled('Школа', false);
    expect((await reg(s.browser('10.20.0.6'), 'Сова', other)).status).toBe(201);
    expect(s.rt.store.listInvites().map((i) => [i.label, i.uses])).toEqual([['Ивановы', 2], ['Школа', 1]]);
  });

  it('the shared code of app.env still works and is labelled «общий»', async () => {
    const s = await site();
    await s.browser().register('Тигр');
    expect(s.rt.store.byLogin('тигр')?.invite_label).toBe('общий');
  });

  it('the owner’s dashboard: only GAMBIT_ADMIN_LOGINS read it; the others (and strangers) get 404/401; presence counts who plays', async () => {
    const s = await site({ adminLogins: ['Хозяин'] });
    const owner = s.browser('10.10.0.1');
    const kid = s.browser('10.10.0.2');
    await owner.register('хозяин');
    await kid.register('Тигр', 'пароль-длинный-1', { address: 'f', stage: 3 });
    expect((await s.browser('10.10.0.3').request('/api/admin/stats')).status).toBe(401);
    expect((await kid.request('/api/admin/stats')).status).toBe(404);
    expect((await kid.request('/api/presence', { json: { screen: 'play' } })).status).toBe(204);
    expect((await kid.request('/api/presence', { json: { screen: '../etc' } })).status).toBe(400);
    expect((await kid.request('/api/games', { json: sampleGameRecord() })).status).toBe(201);
    const res = await owner.request('/api/admin/stats');
    expect(res.status).toBe(200);
    const stats = (await res.json()) as AdminStats;
    expect(stats.totals).toMatchObject({ accounts: 2, online: 1, playing: 1, games: 1 });
    const tigr = stats.accounts.find((a) => a.login === 'Тигр');
    expect(tigr).toMatchObject({ online: true, screen: 'play', games: 1, address: 'f', stage: 3 });
    expect(stats.hourly.reduce((n, h) => n + h.signups, 0)).toBe(2);
    expect(JSON.stringify(stats)).not.toMatch(/pass|hash|recovery/i);
    // the page itself is static and says nothing without the stats
    const page = await s.browser('10.10.0.4').request('/admin');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('/admin/admin.js');
  });

  it('one account’s changes are limited per minute; sign-up closes at the maximum number of accounts', async () => {
    let now = Date.parse('2026-09-26T12:00:00Z');
    const limiter = new RateLimiter({ now: () => now, rules: { writeAccount: { max: 3, windowMs: 60_000 } } });
    const s = await site({ limiter, maxAccounts: 1 });
    const b = s.browser();
    await b.register('Тигр');
    for (let i = 0; i < 3; i++) expect((await b.request('/api/account/state', { method: 'PUT', json: { key: 'gambit.day', value: String(i) } })).status).toBe(200);
    const fourth = await b.request('/api/account/state', { method: 'PUT', json: { key: 'gambit.day', value: '4' } });
    expect(fourth.status).toBe(429);
    // reading is not held back by the write budget (it has its own: 600 a minute)
    expect((await b.request('/api/student')).status).toBe(200);
    now += 61_000;
    expect((await b.request('/api/account/state', { method: 'PUT', json: { key: 'gambit.day', value: '5' } })).status).toBe(200);
    const full = await s.browser('10.5.0.1').register('Лиса');
    expect(full.status).toBe(403);
    expect(await full.json()).toEqual({ error: 'registration-full' });
  });

  it('a stranger learns only that the site is up; the recorder’s spend is nobody’s business', async () => {
    const s = await site({ config: { publicHosts: ['gambitik.example.org'] } });
    const stranger = await s.app.request('/api/health', { headers: { host: 'gambitik.example.org' } });
    expect(await stranger.json()).toEqual({ ok: true });
    // the server itself (loopback: the deploy's check) sees everything
    expect(Object.keys((await (await s.app.request('/api/health', { headers: { host: TEST_HOST } })).json()) as object)).toContain('build');
    const b = s.browser();
    await b.register('Тигр');
    const status = (await (await b.request('/api/voice/clips/status')).json()) as { spent: { totalMilli: number }; caps: { totalMilli: number }; enabled: boolean };
    expect(status).toMatchObject({ enabled: false, spent: { totalMilli: 0 }, caps: { totalMilli: 0 } });
  });

  it('the address for the limits is the proxy’s last X-Forwarded-For entry; IPv6 counts by its /64', async () => {
    const { ipKey } = await import('./routes.ts');
    expect(ipKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(ipKey('198.51.100.4')).toBe('198.51.100.4');
    let now = Date.parse('2026-09-26T12:00:00Z');
    const limiter = new RateLimiter({ now: () => now });
    const s = await site({ limiter });
    await s.browser().register('Тигр', 'правильный-пароль');
    // the client puts a fake first address; the proxy appends the real one: the limit follows the real one
    for (let i = 0; i < 20; i++) {
      const r = await s.app.request('/api/auth/login', { method: 'POST', headers: { host: TEST_HOST, origin: TEST_ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': `1.1.1.${i}, 198.51.100.77` }, body: JSON.stringify({ login: `u${i}`, password: 'x' }) });
      expect(r.status).toBe(401);
    }
    const blocked = await s.app.request('/api/auth/login', { method: 'POST', headers: { host: TEST_HOST, origin: TEST_ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9, 198.51.100.77' }, body: JSON.stringify({ login: 'Тигр', password: 'правильный-пароль' }) });
    expect(blocked.status).toBe(429);
    now += 1;
  });
});

describe('the account contexts', () => {
  it('a context in use is never closed under its request, even when the cache is over its size', async () => {
    const s = await site();
    const { UserContexts, accountApp } = await import('./users.ts');
    const { createApi } = await import('../app.ts');
    const users = new UserContexts({
      config: s.ctx.config,
      shared: { content: s.ctx.content, puzzles: s.ctx.puzzles, clipGen: s.ctx.clipGen },
      buildApi: (c) => accountApp(c, createApi),
      log: () => undefined,
      maxOpen: 1,
      overrides: { fetchImpl: () => Promise.reject(new Error('no network')) },
    });
    cleanups.push(() => users.closeAll());
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const a = users.use('aaaaaaaaaaaaaaaa', async ({ ctx }) => {
      await held;
      // still open: the profile can be read after B came and went
      return ctx.student.getProfile().nickname;
    });
    await new Promise((r) => setTimeout(r, 20));
    await users.use('bbbbbbbbbbbbbbbb', async ({ ctx }) => ctx.student.getProfile());
    await users.use('cccccccccccccccc', async ({ ctx }) => ctx.student.getProfile());
    release();
    await expect(a).resolves.toEqual(expect.any(String));
    expect(users.openCount).toBeLessThanOrEqual(2);
  });
});

describe('the family server (accounts off)', () => {
  it('no sign-in: the child’s API answers without a session, and /api/auth/me says there are no accounts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gambit-family-'));
    const config = loadConfig({}, { dataDir, puzzlesDbPath: join(dataDir, 'p.sqlite'), starterPuzzlesPath: join(dataDir, 'none.json'), webDistDir: join(dataDir, 'no-dist'), runtimeAi: false, codexBin: null, openaiApiKey: null, log: false });
    expect(config.accounts.enabled).toBe(false);
    const ctx = await createServerContext({ ...config, clipGen: { ...config.clipGen, bin: null } }, { fetchImpl: () => Promise.reject(new Error('no network')) });
    const app = createApp(ctx);
    cleanups.push(async () => {
      await ctx.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    const me = await app.request('/api/auth/me', { headers: { host: TEST_HOST } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ accounts: false });
    expect((await app.request('/api/student', { headers: { host: TEST_HOST } })).status).toBe(200);
    expect((await app.request('/api/auth/login', { method: 'POST', headers: { host: TEST_HOST, origin: TEST_ORIGIN, 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
  });
});

describe('recovery, deletion, the recorder', () => {
  it('recovery with the code: a new password and a NEW code; the old ones and every session stop working', async () => {
    const s = await site();
    const phone = s.browser('198.51.100.20');
    const { recoveryCode } = (await (await phone.register('Тигр', 'старый-пароль-1')).json()) as { recoveryCode: string };
    const laptop = s.browser('198.51.100.21');
    expect((await laptop.request('/api/auth/recover', { json: { login: 'Тигр', recoveryCode: 'AAAA-AAAA-AAAA-AAAA', password: 'новый-пароль-1' } })).status).toBe(401);
    const res = await laptop.request('/api/auth/recover', { json: { login: 'тигр', recoveryCode: recoveryCode.toLowerCase(), password: 'новый-пароль-1' } });
    expect(res.status).toBe(200);
    const next = ((await res.json()) as { recoveryCode: string }).recoveryCode;
    expect(next).not.toBe(recoveryCode);
    expect((await phone.request('/api/student')).status).toBe(401);
    expect((await laptop.request('/api/student')).status).toBe(200);
    expect((await s.browser('198.51.100.22').login('Тигр', 'старый-пароль-1')).status).toBe(401);
    expect((await s.browser('198.51.100.23').login('Тигр', 'новый-пароль-1')).status).toBe(200);
    // the old code was used up
    expect((await s.browser('198.51.100.24').request('/api/auth/recover', { json: { login: 'Тигр', recoveryCode, password: 'ещё-один-пароль' } })).status).toBe(401);
  });

  it('deleting an account needs its password and removes it, its sessions and its whole folder', async () => {
    const s = await site();
    const b = s.browser();
    await b.register('Тигр', 'пароль-тигра-123');
    await b.request('/api/games', { json: sampleGameRecord() });
    const dirs = readdirSync(join(s.dataDir, 'users'));
    expect(dirs).toHaveLength(1);
    const dir = join(s.dataDir, 'users', dirs[0]!);
    expect((await b.request('/api/auth/delete', { json: { password: 'не тот' } })).status).toBe(401);
    expect(existsSync(dir)).toBe(true);
    const old = b.cookie;
    expect((await b.request('/api/auth/delete', { json: { password: 'пароль-тигра-123' } })).status).toBe(200);
    expect(existsSync(dir)).toBe(false);
    b.cookie = old;
    expect((await b.request('/api/student')).status).toBe(401);
    expect((await s.browser('198.51.100.30').login('Тигр', 'пароль-тигра-123')).status).toBe(401);
    // the nickname is free again, with a clean profile
    const again = s.browser('198.51.100.31');
    expect((await again.register('Тигр', 'другой-пароль-1')).status).toBe(201);
    expect(((await (await again.request('/api/student')).json()) as StudentProfile).totals.games).toBe(0);
  });

  it('the public site never records a phrase and nobody can switch recording on', async () => {
    const s = await site();
    const b = s.browser();
    await b.register('Тигр');
    expect((await b.request('/api/voice/clips/request', { json: { sentences: [] } })).status).toBe(503);
    expect((await b.request('/api/voice/clips/settings', { method: 'PUT', json: { enabled: true, dailyCapMilli: 1000 } })).status).toBe(403);
  });
});

describe('abuse limits and hardening: many addresses, known devices, diagnostics', () => {
  it('every rule forgets on its own; the «everyone» key and live keys of other rules survive a flood', () => {
    let now = 0;
    const limiter = new RateLimiter({ now: () => now, maxKeys: 100, rules: { inviteAll: { max: 2, windowMs: 3600_000 } } });
    limiter.hit('inviteAll', '*');
    limiter.hit('inviteAll', '*');
    limiter.hit('loginAccount', 'тигр');
    // an old, expired key goes before a live one
    limiter.hit('loginIp', 'old');
    now += 16 * 60_000;
    for (let i = 0; i < 500; i++) limiter.hit('loginIp', `10.0.${i >> 8}.${i & 255}`);
    expect(limiter.size('loginIp')).toBeLessThanOrEqual(100);
    expect(limiter.blocked('inviteAll', '*')).not.toBeNull();
    expect(limiter.size('loginAccount')).toBe(1);
    // a flood of the «everyone» rule's own keys does not drop '*' either
    for (let i = 0; i < 500; i++) limiter.hit('inviteAll', `k${i}`);
    expect(limiter.blocked('inviteAll', '*')).not.toBeNull();
  });

  it('wrong codes from many addresses never lock sign-up for a family with the right code', async () => {
    const limiter = new RateLimiter({ rules: { inviteAll: { max: 3, windowMs: 3600_000 } } });
    const s = await site({ limiter });
    const bad = (ip: string) => s.browser(ip).request('/api/auth/register', { json: { login: 'Вор', password: 'пароль-длинный-1', invite: 'не-тот-код', address: 'm', stage: 1 } });
    for (let i = 0; i < 3; i++) expect((await bad(`10.20.${i}.1`)).status).toBe(403);
    // the site-wide count is spent: further WRONG codes wait …
    expect((await bad('10.20.9.1')).status).toBe(429);
    // … the right one does not
    expect((await s.browser('10.21.0.1').register('Тигр')).status).toBe(201);
    // an address that guessed too often still waits, whatever it sends (else it could go on guessing)
    const own = new RateLimiter({ rules: { inviteIp: { max: 1, windowMs: 3600_000 } } });
    const t = await site({ limiter: own });
    expect((await t.browser('10.22.0.1').request('/api/auth/register', { json: { login: 'Вор', password: 'пароль-длинный-1', invite: 'нет', address: 'm', stage: 1 } })).status).toBe(403);
    expect((await t.browser('10.22.0.1').register('Лиса')).status).toBe(429);
  });

  it('IPv6 addresses count per /64 and together per /48', async () => {
    const { netKey, ipKey } = await import('./routes.ts');
    expect(netKey(ipKey('2001:db8:1:2:3:4:5:6'))).toBe('2001:db8:1::/48');
    expect(netKey(ipKey('2001:db8::1'))).toBe('2001:db8:0::/48');
    expect(netKey('198.51.100.4')).toBeNull();
    const limiter = new RateLimiter({ rules: { loginIp: { max: 2, windowMs: 900_000 }, loginNet: { max: 5, windowMs: 900_000 } } });
    const s = await site({ limiter });
    // five different /64s of one /48: each has budget left, the /48 does not
    for (let i = 0; i < 5; i++) expect((await s.browser(`2001:db8:7:${i}::1`).login(`u${i}`, 'x')).status).toBe(401);
    expect((await s.browser('2001:db8:7:99::1').login('u9', 'x')).status).toBe(429);
    // another /48 is not touched
    expect((await s.browser('2001:db8:8:1::1').login('u9', 'x')).status).toBe(401);
  });

  it('an attempt refused unchecked (too many at once from the address, or 503 busy) is not spent', async () => {
    const limiter = new RateLimiter({ rules: { loginIp: { max: 3, windowMs: 900_000 } } });
    const s = await site({ limiter });
    const b = s.browser('10.30.0.1');
    const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => b.login(`никто${i}`, 'x-x-x-x-x')));
    expect(answers.filter((r) => r.status === 429).length).toBeGreaterThan(0);
    // only the checked ones were counted: the address still has its third try
    expect((await b.login('никто', 'x-x-x-x-x')).status).toBe(401);
    expect((await b.login('никто', 'x-x-x-x-x')).status).toBe(429);

    const one = new RateLimiter({ rules: { loginIp: { max: 1, windowMs: 900_000 } } });
    const t = await site({ limiter: one });
    const flood = await Promise.all(Array.from({ length: 60 }, (_, i) => t.browser(`10.31.${i}.1`).login(`никто${i}`, 'x-x-x-x-x')));
    const busyIndex = flood.findIndex((r) => r.status === 503);
    expect(busyIndex).toBeGreaterThanOrEqual(0);
    // the busy address kept its only try; an address that was checked has spent it
    expect((await t.browser(`10.31.${busyIndex}.1`).login('никто', 'x-x-x-x-x')).status).toBe(401);
    const checked = flood.findIndex((r) => r.status === 401);
    expect((await t.browser(`10.31.${checked}.1`).login('никто', 'x-x-x-x-x')).status).toBe(429);
  });

  it('a known device signs in while strangers guess the nickname; the device cookie is HttpOnly, Lax, long-lived', async () => {
    const limiter = new RateLimiter();
    const s = await site({ limiter });
    const home = s.browser('203.0.113.50');
    const set = (await home.register('Тигр', 'правильный-пароль')).headers.getSetCookie();
    const deviceSet = set.find((v) => v.startsWith('gambit_device=')) ?? '';
    expect(deviceSet).toMatch(/HttpOnly/);
    expect(deviceSet).toMatch(/SameSite=Lax/);
    expect(deviceSet).toMatch(/Max-Age=31536000/);
    expect((await home.request('/api/auth/logout', { json: {} })).status).toBe(200);
    expect(home.device).not.toBeNull();
    // a stranger locks the nickname from many addresses
    for (let i = 0; i < 10; i++) expect((await s.browser(`10.40.${i}.1`).login('Тигр', `guess-${i}`)).status).toBe(401);
    expect((await s.browser('10.40.99.1').login('Тигр', 'правильный-пароль')).status).toBe(429);
    // the child's own browser still gets in (and a wrong password there does not add to the lock)
    expect((await home.login('Тигр', 'не-тот')).status).toBe(401);
    expect((await home.login('Тигр', 'правильный-пароль')).status).toBe(200);
    // a device token of ANOTHER account proves nothing for this one
    const other = s.browser('203.0.113.51');
    await other.register('Лиса');
    expect((await other.login('Тигр', 'правильный-пароль')).status).toBe(429);
    // one browser keeps both children's devices: the sister signs in there too, the brother is still known
    expect((await home.register('Сестра')).status).toBe(201);
    expect(home.device?.split('=')[1]?.split('.').length).toBe(2);
    expect((await home.login('Тигр', 'правильный-пароль')).status).toBe(200);
    // behind TLS: Secure and __Host-
    const tls = await site({ cookieSecure: true });
    const set2 = (await tls.browser().register('Тигр')).headers.getSetCookie();
    expect(set2.find((v) => v.startsWith('__Host-gambit-device='))).toMatch(/Secure/);
  });

  it('at most 10 known devices per account; recovery forgets them all', async () => {
    const s = await site();
    const { recoveryCode } = (await (await s.browser('203.0.113.60').register('Тигр', 'правильный-пароль')).json()) as { recoveryCode: string };
    for (let i = 0; i < 12; i++) expect((await s.browser(`203.0.114.${i}`).login('Тигр', 'правильный-пароль')).status).toBe(200);
    const id = s.rt.store.byLogin('тигр')!.id;
    expect(s.rt.store.countDevices(id)).toBe(10);
    const b = s.browser('203.0.115.1');
    expect((await b.request('/api/auth/recover', { json: { login: 'Тигр', recoveryCode, password: 'новый-пароль-1' } })).status).toBe(200);
    // only the recovering browser is known now
    expect(s.rt.store.countDevices(id)).toBe(1);
  });

  it('diagnostics: one line per sign-up / sign-in outcome — never the nickname, password, code or address', async () => {
    const s = await site();
    const lines: string[] = [];
    s.rt.log = (m) => lines.push(m);
    const b = s.browser('198.51.100.99');
    await b.request('/api/auth/register', { json: { login: 'Тигр', password: 'пароль-длинный-1', invite: 'неверный-код', address: 'm', stage: 1 } });
    await b.register('Тигр', 'short');
    await b.register('Тигр', 'пароль-длинный-1');
    await b.login('Тигр', 'неправильный-пароль');
    await b.login('Тигр', 'пароль-длинный-1');
    await b.request('/api/auth/login', { json: { nope: 1 } });
    const outcomes = lines.filter((l) => / → /.test(l));
    expect(outcomes).toEqual([
      '[accounts] register → 403 bad-invite',
      '[accounts] register → 400 password-short',
      '[accounts] register → 201',
      '[accounts] login → 401 bad-credentials',
      '[accounts] login → 200',
      '[accounts] login → 400 invalid-body',
    ]);
    const all = lines.join('\n');
    for (const secret of ['Тигр', 'тигр', 'пароль', 'неверный-код', '198.51.100.99']) expect(all).not.toContain(secret);
  });

  it('the public site\'s pages may talk to this server only (no OpenAI in connect-src)', async () => {
    const s = await site();
    const csp = (await s.app.request('/api/auth/me', { headers: { host: TEST_HOST } })).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("connect-src 'self';");
    expect(csp).not.toContain('openai');
  });

  it('one account\'s reads and recounts are limited per minute', async () => {
    let now = Date.parse('2026-09-26T12:00:00Z');
    const limiter = new RateLimiter({ now: () => now, rules: { readAccount: { max: 5, windowMs: 60_000 }, recountAccount: { max: 2, windowMs: 60_000 } } });
    const s = await site({ limiter });
    const b = s.browser();
    await b.register('Тигр');
    expect((await b.request('/api/games', { json: sampleGameRecord() })).status).toBe(201);
    const id = sampleGameRecord().id;
    for (let i = 0; i < 5; i++) expect((await b.request('/api/games?limit=500')).status).toBe(200);
    const sixth = await b.request('/api/progress');
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(0);
    // the recorded phrases have their own budget (a new phone fetches the hot set at once)
    expect((await b.request('/api/voice/clips/overlay/index.json')).status).not.toBe(429);
    // another child is not touched
    const other = s.browser('203.0.113.8');
    await other.register('Лиса');
    expect((await other.request('/api/student')).status).toBe(200);
    // recounts: two a minute here
    expect((await b.request(`/api/games/${id}/excluded`, { method: 'PUT', json: { excluded: 'adult' } })).status).toBe(200);
    expect((await b.request('/api/student/reset-progress', { json: { confirm: true } })).status).not.toBe(429);
    expect((await b.request(`/api/games/${id}/excluded`, { method: 'PUT', json: { excluded: null } })).status).toBe(429);
    // other changes still go through
    expect((await b.request('/api/account/state', { method: 'PUT', json: { key: 'gambit.day', value: '1' } })).status).toBe(200);
    now += 61_000;
    expect((await b.request('/api/student')).status).toBe(200);
    expect((await b.request(`/api/games/${id}/excluded`, { method: 'PUT', json: { excluded: null } })).status).toBe(200);
  });

  it('a generated invite code is taken in any letter case, with or without its dashes', async () => {
    const { inviteForm } = await import('./routes.ts');
    expect(inviteForm(' Acdef-GHJKM ')).toBe('ACDEFGHJKM');
    const s = await site({ invite: 'ACDEF-GHJKM-NPQRT-UVWXY' });
    const b = s.browser('10.50.0.1');
    expect((await b.register('Тигр', 'пароль-длинный-1', { invite: 'acdefghjkmnpqrtuvwxy' })).status).toBe(201);
    expect((await s.browser('10.50.0.2').register('Лиса', 'пароль-длинный-1', { invite: 'ACDEF-GHJKM-NPQRT-UVWXA' })).status).toBe(403);
  });
});
