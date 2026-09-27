/**
 * Accounts of the public site (server: apps/server/src/accounts): sign-up with the invite code, sign-in, sign-out,
 * recovery with the one-time code, deleting the account; and the browser's memory of the child kept with the account
 * (`/api/account/state`). The family server has no `/api/auth` (404): then `getMe()` says accounts are off and the app
 * works exactly as the family app without accounts.
 */
import type { PowAnswer } from './pow.ts';
import { API_BASE } from '@gambit/shared';
import { pageAccountHeader } from '../../api/client.ts';

export interface AccountUser {
  login: string;
  /** the account's opaque id (the page repeats it on every request) */
  account: string;
}

export type MeInfo = { accounts: false } | { accounts: true; registration: boolean; invite: boolean; user: AccountUser | null };

export interface AuthFailure {
  ok: false;
  /** the server's code: bad-credentials, bad-invite, login-taken, password-short, too-many-attempts, network … */
  code: string;
  retryAfter?: number;
}

export type AuthResult<T> = ({ ok: true } & T) | AuthFailure;

async function post<T>(path: string, body: unknown): Promise<AuthResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    return { ok: false, code: 'network' };
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: unknown; retryAfter?: unknown };
    return { ok: false, code: typeof d.error === 'string' ? d.error : `http-${res.status}`, ...(typeof d.retryAfter === 'number' ? { retryAfter: d.retryAfter } : {}) };
  }
  return { ok: true, ...(data as T) };
}

/** Accounts on? Who is signed in? The family server says `accounts: false`; no answer at all = the family app without accounts. */
export async function getMe(): Promise<MeInfo | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/me`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (res.status === 404) return { accounts: false };
    if (!res.ok) return null;
    const d = (await res.json()) as Partial<{ accounts: boolean; registration: boolean; invite: boolean; user: Partial<AccountUser> | null }>;
    if (d.accounts !== true) return { accounts: false };
    const u = d.user;
    const user = u && typeof u.login === 'string' && typeof u.account === 'string' ? { login: u.login, account: u.account } : null;
    // an older server says nothing about the code: it needs one
    return { accounts: true, registration: d.registration === true, invite: d.invite !== false, user };
  } catch {
    return null;
  }
}

export interface RegisterInput {
  login: string;
  password: string;
  invite: string;
  /** the solved task of ./pow.ts (none: the server gave none) */
  pow?: PowAnswer;
  /** the hidden field (./AuthScreen.tsx): a person leaves it empty */
  website?: string;
  address: 'm' | 'f';
  stage: number;
}

export function register(input: RegisterInput): Promise<AuthResult<{ user: AccountUser; recoveryCode: string }>> {
  return post('/auth/register', input);
}

export function signIn(login: string, password: string): Promise<AuthResult<{ user: AccountUser }>> {
  return post('/auth/login', { login, password });
}

export function signOut(): Promise<AuthResult<object>> {
  return post('/auth/logout', {});
}

export function recover(login: string, recoveryCode: string, password: string): Promise<AuthResult<{ user: AccountUser; recoveryCode: string }>> {
  return post('/auth/recover', { login, recoveryCode, password });
}

export function deleteAccount(password: string): Promise<AuthResult<object>> {
  return post('/auth/delete', { password });
}

// ───────────────────────── the browser's memory of the child ─────────────────────────

export interface ServerState {
  values: Record<string, string>;
  /** when each key was last changed (a removed key keeps its time) */
  times: Record<string, number>;
}

export async function getState(): Promise<ServerState | null> {
  try {
    const res = await fetch(`${API_BASE}/account/state`, { headers: { Accept: 'application/json', ...pageAccountHeader() }, credentials: 'same-origin' });
    if (!res.ok) return null;
    const d = (await res.json()) as Partial<ServerState>;
    return { values: d.values ?? {}, times: d.times ?? {} };
  } catch {
    return null;
  }
}

/** `keepalive`: the page may be closing (the browser finishes the request after it). */
export async function putState(key: string, value: string | null, at: number, o: { keepalive?: boolean } = {}): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/account/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...pageAccountHeader() },
      body: JSON.stringify({ key, value, at }),
      credentials: 'same-origin',
      ...(o.keepalive === true ? { keepalive: true } : {}),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Russian words for an auth failure (the form shows them). */
export function authErrorRu(f: AuthFailure): string {
  switch (f.code) {
    case 'bad-credentials':
      return 'Неверный ник или пароль.';
    case 'bad-challenge':
      return 'Не получилось проверить браузер. Нажмите ещё раз.';
    case 'bad-invite':
      return 'Код приглашения не подходит. Спросите его у того, кто дал ссылку.';
    case 'registration-closed':
      return 'Регистрация сейчас закрыта.';
    case 'login-taken':
      return 'Такой ник уже занят — придумайте другой.';
    case 'bad-login':
      return 'Ник: от 2 до 24 букв или цифр (можно пробел, точку, дефис).';
    case 'password-short':
      return 'Пароль слишком короткий: нужно не меньше 8 символов.';
    case 'password-long':
      return 'Пароль слишком длинный.';
    case 'password-common':
      return 'Такой пароль угадывают первым. Лучше несколько слов, например «красный конь прыгает».';
    case 'registration-full':
      return 'Мест для новых учеников сейчас нет.';
    case 'busy':
      return 'Сервер занят. Попробуйте через несколько секунд.';
    case 'too-many-requests':
      return 'Слишком много действий подряд. Подождите минуту.';
    case 'bad-recovery':
      return 'Ник или код восстановления не подходят.';
    case 'too-many-attempts':
      return `Слишком много попыток. Попробуйте через ${Math.max(1, Math.ceil((f.retryAfter ?? 60) / 60))} мин.`;
    case 'network':
      return 'Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.';
    default:
      return 'Не получилось. Попробуйте ещё раз.';
  }
}
