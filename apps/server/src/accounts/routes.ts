/**
 * Accounts (GAMBIT_ACCOUNTS=1): sign-up with the owner's invite code, sign-in, sign-out, recovery without e-mail, and
 * deleting an account with all its data. Login + password only — one account is one child (a nickname, «мальчик /
 * девочка», a stage), never a real name or an e-mail (data minimisation, docs/ACCOUNTS.md).
 *
 *   GET  /api/auth/me        { accounts: true, registration, user: { login, account } | null } (`account`: an opaque id
 *                            the web sends back as `X-Gambit-Account`, so a tab of another child is told, not obeyed)
 *   POST /api/auth/register  { login, password, invite, address, stage } → { user, recoveryCode } + the session cookie
 *   POST /api/auth/login     { login, password } → { user } + the session cookie
 *   POST /api/auth/logout    → the session is closed, the cookie cleared
 *   POST /api/auth/recover   { login, recoveryCode, password } → { user, recoveryCode } (a NEW code; every session closed)
 *   POST /api/auth/delete    { password } (signed in) → the account, its sessions and its folder are gone
 *
 * The session: a random 256-bit token in an HttpOnly, SameSite=Lax cookie (Secure and `__Host-` behind TLS), only its
 * sha256 in the database; 30 days, renewed once a day while used, 90 days at most; a new sign-in in the same browser
 * closes the old session. CSRF: SameSite plus the server's Origin check and JSON-only bodies (security.ts).
 * Guessing: every attempt is counted BEFORE its slow check (./limiter.ts, per address and per
 * login; parallel requests cannot slip past the count) and taken back when it succeeds; at most 2 checks per address at
 * once and a bounded queue for the scrypt work (./password.ts) — beyond it 503 `busy`; an unknown login costs the same
 * scrypt as a known one and gets the same answer. The invite code is compared in constant time (sha256 of both sides).
 * An IPv6 address is counted by its /64 AND its /48; an attempt the server never checked (503 busy, too many at once,
 * a failed sign-up) is taken back; the invite code is compared before the site-wide count of wrong codes, which then
 * refuses only wrong codes. A «known device» — a browser the account signed in from before, proven by a long-lived
 * HttpOnly cookie — is not held back by the per-login limit: a stranger who knows the nickname cannot keep the child
 * out by guessing every 15 minutes.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { SMALL_BODY_LIMIT, jsonBody, limitBody } from '../routes/validation.ts';
import type { Presence } from './adminStats.ts';
import type { ProofOfWork } from './pow.ts';
import { ALL } from './limiter.ts';
import type { LimitName, RateLimiter } from './limiter.ts';
import { HashBusy, dummySecretHash, hashSecret, newRecoveryCode, normalizeRecoveryCode, passwordProblem, verifySecret } from './password.ts';
import { DEVICE_TTL_MS, OPEN_INVITE_LABEL, SHARED_INVITE_LABEL, parseLogin } from './store.ts';
import type { AccountRow, AccountStore } from './store.ts';
import type { UserContexts } from './users.ts';

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** the highest stage a new account may start at (the curriculum has 10) */
export const MAX_START_STAGE = 10;
/** password checks one address may run at once (the rest: 429) */
export const AUTH_CONCURRENCY_PER_IP = 2;
/** the header the web repeats the signed-in account in (`/me` gives it) */
export const ACCOUNT_HEADER = 'x-gambit-account';

export interface AccountsOptions {
  /** GAMBIT_INVITE_CODE; null = sign-up closed (sign-in still works) */
  inviteCode: string | null;
  /** behind TLS: the cookie is `Secure` and named `__Host-gambit` */
  cookieSecure: boolean;
  /** GAMBIT_TRUST_PROXY=1: the client's address comes from the proxy (X-Forwarded-For / X-Real-IP), else the socket */
  trustProxy: boolean;
  /** GAMBIT_MAX_ACCOUNTS: sign-up closes when this many accounts exist */
  maxAccounts: number;
  /** GAMBIT_OPEN_REGISTRATION: sign-up without an invite code */
  openRegistration: boolean;
  sessionTtlMs?: number;
}

export interface AccountsRuntime {
  store: AccountStore;
  users: UserContexts;
  limiter: RateLimiter;
  options: AccountsOptions;
  log: (message: string) => void;
  /** less than DISK_FREE_MIN free under DATA_DIR: accounts write nothing new (checked at most once a minute) */
  diskLow: () => boolean;
  /** DATA_DIR (the owner's dashboard reads the accounts' databases from it) */
  dataDir: string;
  /** who is on the site now and on which screen (memory only, ./adminStats.ts) */
  presence: Presence;
  /** the login keys (parseLogin) of GAMBIT_ADMIN_LOGINS: they may open /admin */
  adminKeys: ReadonlySet<string>;
  /** the proof of work before a sign-up; null = off (GAMBIT_POW_BITS=0) */
  pow: ProofOfWork | null;
}

export type AuthEnv = { Variables: { account: AccountRow } };

export function cookieName(o: Pick<AccountsOptions, 'cookieSecure'>): string {
  return o.cookieSecure ? '__Host-gambit' : 'gambit_session';
}

/** The known-device cookie: kept on sign-out, unlike the session. */
export function deviceCookieName(o: Pick<AccountsOptions, 'cookieSecure'>): string {
  return o.cookieSecure ? '__Host-gambit-device' : 'gambit_device';
}

/** a browser keeps the device tokens of this many accounts (brothers and sisters on one tablet), newest first */
export const MAX_DEVICE_TOKENS_PER_BROWSER = 5;

const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;

/** An address as a limit key: IPv4 whole, IPv6 by its /64 (one household or one server gets one budget, not 2⁶⁴). */
export function ipKey(ip: string): string {
  const plain = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (!isIPv6(plain)) return plain;
  // expand «::» to the full eight groups, then keep the first four
  const [head = '', tail = ''] = plain.split('::');
  const h = head === '' ? [] : head.split(':');
  const t = tail === '' ? [] : tail.split(':');
  const groups = plain.includes('::') ? [...h, ...new Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/**
 * The second tier of an address key: an IPv6 /64 key → its /48 (`2001:db8:1::/48`).
 * One customer of a provider often holds a whole /48 — 65 536 /64s, each with its own budget; the /48 caps them all
 * together. IPv4 (and 'unknown') has no second tier: null.
 */
export function netKey(key: string): string | null {
  if (!key.endsWith('::/64')) return null;
  return `${key.slice(0, -'::/64'.length).split(':').slice(0, 3).join(':')}::/48`;
}

/** The doors whose attempts are counted per address (and per IPv6 /48). */
type Door = 'login' | 'invite' | 'register' | 'recover';

/** One address's counters at one door: the /64 (or IPv4) key and its /48, checked, counted and taken back together. */
function addressLimits(limiter: RateLimiter, door: Door, ip: string) {
  const ipRule: LimitName = `${door}Ip`;
  const netRule: LimitName = `${door}Net`;
  const net = netKey(ip);
  return {
    blocked: (): number | null => limiter.blocked(ipRule, ip) ?? (net !== null ? limiter.blocked(netRule, net) : null),
    hit: (): void => {
      limiter.hit(ipRule, ip);
      if (net !== null) limiter.hit(netRule, net);
    },
    unhit: (): void => {
      limiter.unhit(ipRule, ip);
      if (net !== null) limiter.unhit(netRule, net);
    },
  };
}

/**
 * The client's address for the limits (never stored, never logged with anything about the child). Behind the proxy:
 * the LAST X-Forwarded-For entry (Traefik appends the address it saw; a value the client sent itself comes before it
 * or is dropped), else X-Real-IP; otherwise the socket's.
 */
export function clientIp(c: Context, o: Pick<AccountsOptions, 'trustProxy'>): string {
  if (o.trustProxy) {
    const forwarded = (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
    const last = forwarded[forwarded.length - 1];
    if (last !== undefined && IP_RE.test(last)) return ipKey(last);
    const real = (c.req.header('x-real-ip') ?? '').trim();
    if (IP_RE.test(real)) return ipKey(real);
  }
  try {
    return ipKey(getConnInfo(c).remote.address ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

/**
 * An invite code as it is compared: letter case, spaces and dashes do not matter (a phone capitalises the first
 * letter; `deploy/docker-ssh/set-invite.sh --generate` prints `XXXXX-XXXXX-XXXXX-XXXXX`, typed with or without the
 * dashes). Never stricter than an exact comparison: a code typed exactly is always accepted.
 */
export function inviteForm(code: string): string {
  return code.normalize('NFKC').toUpperCase().replace(/[\s\-‐-―_]/gu, '');
}

/** How a family's invite code is kept in accounts.db: sha256 of its compared form (never the code itself). */
export function inviteHash(code: string): string {
  return createHash('sha256').update(inviteForm(code)).digest('hex');
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a.normalize('NFC')).digest();
  const hb = createHash('sha256').update(b.normalize('NFC')).digest();
  return timingSafeEqual(ha, hb);
}

const loginField = z.string().min(1).max(64);
const passwordField = z.string().min(1).max(512);
const registerSchema = z.object({
  login: loginField,
  password: passwordField,
  // the open registration sends no code; an older cached page may still send one
  invite: z.string().max(200).default(''),
  /** the proof of work of ./pow.ts */
  pow: z.object({ challenge: z.string().max(200), nonce: z.string().max(64) }).optional(),
  /** a field no person sees: a script that fills every field fills it too */
  website: z.string().max(500).optional(),
  address: z.enum(['m', 'f']),
  stage: z.number().int().min(1).max(MAX_START_STAGE),
});
const loginSchema = z.object({ login: loginField, password: passwordField });
const recoverSchema = z.object({ login: loginField, recoveryCode: z.string().max(64), password: passwordField });
const deleteSchema = z.object({ password: passwordField });

function tooMany(c: Context, seconds: number) {
  c.header('Retry-After', String(seconds));
  return c.json({ error: 'too-many-attempts', retryAfter: seconds }, 429);
}

function busy(c: Context) {
  c.header('Retry-After', '5');
  return c.json({ error: 'busy', retryAfter: 5 }, 503);
}

function setSessionCookie(c: Context, rt: AccountsRuntime, token: string, ttl: number): void {
  setCookie(c, cookieName(rt.options), token, { path: '/', httpOnly: true, secure: rt.options.cookieSecure, sameSite: 'Lax', maxAge: Math.floor(ttl / 1000) });
}

/** The device tokens the browser holds (at most MAX_DEVICE_TOKENS_PER_BROWSER, `.`-separated; malformed ones dropped). */
function deviceTokens(c: Context, rt: AccountsRuntime): string[] {
  const raw = getCookie(c, deviceCookieName(rt.options)) ?? '';
  return raw
    .split('.')
    .filter((t) => /^[\w-]{20,100}$/.test(t))
    .slice(0, MAX_DEVICE_TOKENS_PER_BROWSER);
}

/** Is this browser a known device of the account? (A token of another account proves nothing about this one.) */
function knownDevice(c: Context, rt: AccountsRuntime, accountId: string): boolean {
  return deviceTokens(c, rt).some((t) => rt.store.deviceAccount(t) === accountId);
}

/**
 * After a successful sign-in / sign-up / recovery: the browser is (still) a known device of the account — its token
 * is refreshed, or a new one is added in front of the tokens of the other accounts it knows (the ones the server
 * forgot are dropped). The cookie: HttpOnly, SameSite=Lax, Secure + `__Host-` behind TLS, as long as the server
 * remembers the device.
 */
function markDevice(c: Context, rt: AccountsRuntime, accountId: string): void {
  const held = deviceTokens(c, rt);
  const owners = held.map((t) => rt.store.deviceAccount(t));
  const own = held.find((_, i) => owners[i] === accountId);
  let tokens: string[];
  if (own !== undefined) {
    rt.store.touchDevice(own);
    tokens = [own, ...held.filter((t, i) => t !== own && owners[i] !== null)];
  } else {
    tokens = [rt.store.rememberDevice(accountId), ...held.filter((_, i) => owners[i] !== null)];
  }
  setCookie(c, deviceCookieName(rt.options), tokens.slice(0, MAX_DEVICE_TOKENS_PER_BROWSER).join('.'), {
    path: '/',
    httpOnly: true,
    secure: rt.options.cookieSecure,
    sameSite: 'Lax',
    maxAge: Math.floor(DEVICE_TTL_MS / 1000),
  });
}

function startSession(c: Context, rt: AccountsRuntime, account: AccountRow): void {
  // a sign-in in a browser that still holds a session: that older session ends (no forgotten live tokens)
  const old = getCookie(c, cookieName(rt.options));
  if (old !== undefined) rt.store.closeSession(old);
  const ttl = rt.options.sessionTtlMs ?? SESSION_TTL_MS;
  const { token } = rt.store.openSession(account.id, ttl);
  setSessionCookie(c, rt, token, ttl);
  rt.store.touchLogin(account.id);
  markDevice(c, rt, account.id);
}

function endSession(c: Context, rt: AccountsRuntime): void {
  const token = getCookie(c, cookieName(rt.options));
  if (token !== undefined) rt.store.closeSession(token);
  deleteCookie(c, cookieName(rt.options), { path: '/', secure: rt.options.cookieSecure, httpOnly: true, sameSite: 'Lax' });
}

/** The signed-in account of a request (and a renewed cookie when the session was extended), or null. */
export function sessionAccount(c: Context, rt: AccountsRuntime): AccountRow | null {
  const token = getCookie(c, cookieName(rt.options));
  if (token === undefined) return null;
  const ttl = rt.options.sessionTtlMs ?? SESSION_TTL_MS;
  const found = rt.store.findSession(token, ttl);
  if (found === null) return null;
  const account = rt.store.byId(found.accountId);
  if (account === undefined) return null;
  if (found.renewed) setSessionCookie(c, rt, token, ttl);
  return account;
}

/**
 * Every `/api` route but the auth and health ones: 401 `auth-required` without a live session, 401 `account-changed`
 * when the page speaks for another account than the cookie's (a tab of the child who signed out in another tab).
 */
export function requireSession(rt: AccountsRuntime): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const account = sessionAccount(c, rt);
    if (account === null) return c.json({ error: 'auth-required' }, 401);
    const claimed = c.req.header(ACCOUNT_HEADER);
    if (claimed !== undefined && claimed !== account.id) return c.json({ error: 'account-changed' }, 401);
    c.set('account', account);
    return next();
  };
}

const userOf = (a: AccountRow) => ({ login: a.display, account: a.id });

/**
 * One log line per sign-up / sign-in outcome: `[accounts] register → 201`,
 * `→ 403 bad-invite`, `→ 429 too-many-attempts`, `→ 400 password-short`, `→ 400 invalid-body` … — so the owner can see
 * whether a family's failing phone reached the server at all, and what it was told. Only the route, the status and the
 * error code: never the nickname, the password, the invite code or the address.
 */
function outcomeLog(rt: AccountsRuntime, route: 'register' | 'login'): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const status = c.res.status;
    let code = '';
    if (status >= 400) {
      try {
        const body = (await c.res.clone().json()) as { error?: unknown };
        if (typeof body.error === 'string' && /^[a-z0-9-]{1,40}$/.test(body.error)) code = ` ${body.error}`;
      } catch {
        // not JSON: the status says enough
      }
    }
    rt.log(`[accounts] ${route} → ${status}${code}`);
  };
}

export function authRoutes(rt: AccountsRuntime) {
  const { store, limiter } = rt;
  /** sign-up is open with the shared code of app.env or with any usable family code */
  const registrationOpen = (): boolean => rt.options.openRegistration || rt.options.inviteCode !== null || store.hasOpenInvite();
  /** password checks running per address right now */
  const inFlight = new Map<string, number>();
  /** Runs one slow auth step for an address: ≤ AUTH_CONCURRENCY_PER_IP at once; null = refused (too many at once). */
  const guarded = async <T>(ip: string, work: () => Promise<T>): Promise<T | null> => {
    const n = inFlight.get(ip) ?? 0;
    if (n >= AUTH_CONCURRENCY_PER_IP) return null;
    inFlight.set(ip, n + 1);
    try {
      return await work();
    } finally {
      const left = (inFlight.get(ip) ?? 1) - 1;
      if (left <= 0) inFlight.delete(ip);
      else inFlight.set(ip, left);
    }
  };

  /** The sign-up after its invite code was accepted: limits, the form, the hashes, the account and its folder. */
  const signUp = async (c: Context, ip: string, body: z.infer<typeof registerSchema>, inviteLabel: string): Promise<Response> => {
    const register = addressLimits(limiter, 'register', ip);
    const wait = register.blocked() ?? limiter.blocked('registerAll', ALL);
    if (wait !== null) return tooMany(c, wait);
    // a form mistake (a bad nick, a short password) costs nothing: otherwise retries after such mistakes would spend
    // the whole site's hour of sign-ups and close sign-up for everyone
    if (store.count() >= rt.options.maxAccounts) return c.json({ error: 'registration-full' }, 403);
    const login = parseLogin(body.login);
    if (login === null) return c.json({ error: 'bad-login' }, 400);
    const weak = passwordProblem(body.password);
    if (weak !== null) return c.json({ error: `password-${weak}` }, 400);
    if (store.byLogin(login.key) !== undefined) {
      // «is this nick taken?» — counted per address only, so it cannot be asked without end
      register.hit();
      return c.json({ error: 'login-taken' }, 409);
    }
    // counted now, before the slow part: parallel sign-ups cannot pass the limits together
    register.hit();
    limiter.hit('registerAll', ALL);
    // a sign-up the server never made (busy, too many at once, a failed folder) costs the family nothing (L2)
    const takeBack = (): void => {
      register.unhit();
      limiter.unhit('registerAll', ALL);
    };
    const recoveryCode = newRecoveryCode();
    let hashes: [string, string] | null;
    try {
      hashes = await guarded(ip, () => Promise.all([hashSecret(body.password), hashSecret(recoveryCode)]));
    } catch (error) {
      takeBack();
      if (error instanceof HashBusy) return busy(c);
      throw error;
    }
    if (hashes === null) {
      takeBack();
      return tooMany(c, 2);
    }
    const [passHash, recoveryHash] = hashes;
    const account = store.create({ ...login, passHash, recoveryHash });
    if (account === null) {
      // taken meanwhile (two sign-ups of one nick at once): like a taken nick, counted per address only
      limiter.unhit('registerAll', ALL);
      return c.json({ error: 'login-taken' }, 409);
    }
    try {
      await rt.users.init(account.id, { nickname: login.display, address: body.address, stage: body.stage });
    } catch (error) {
      // no half-made account: the row goes, the folder goes
      store.delete(account.id);
      await rt.users.remove(account.id).catch(() => undefined);
      takeBack();
      throw error;
    }
    store.setInviteLabel(account.id, inviteLabel);
    rt.log(`[accounts] new account ${account.id}`);
    startSession(c, rt, account);
    return c.json({ user: userOf(account), recoveryCode }, 201);
  };

  return (
    new Hono()
      .use('/register', outcomeLog(rt, 'register'))
      .use('/login', outcomeLog(rt, 'login'))
      .get('/me', (c) => {
        const account = sessionAccount(c, rt);
        return c.json({ accounts: true, registration: registrationOpen(), invite: !rt.options.openRegistration, user: account === null ? null : userOf(account) });
      })
      // a fresh proof-of-work task for the sign-up form (./pow.ts); pow null = none needed
      .get('/challenge', (c) => {
        c.header('Cache-Control', 'no-store');
        return c.json({ pow: rt.pow === null ? null : rt.pow.issue() });
      })
      .post('/register', limitBody(SMALL_BODY_LIMIT), jsonBody(registerSchema), async (c) => {
        const ip = clientIp(c, rt.options);
        const body = c.req.valid('json');
        if (!registrationOpen()) return c.json({ error: 'registration-closed' }, 403);
        // an address that sent too many wrong codes waits, whatever it sends now (else it could go on guessing)
        const invite = addressLimits(limiter, 'invite', ip);
        const inviteWait = invite.blocked();
        if (inviteWait !== null) return tooMany(c, inviteWait);
        // no person fills the hidden field; the answer tells a script nothing new
        if ((body.website ?? '') !== '') {
          invite.hit();
          return c.json({ error: 'bad-challenge' }, 403);
        }
        // the proof of work: an unsolved or foreign task counts like a wrong code (a script cannot try without end)
        const powCheck = rt.pow === null ? 'ok' : rt.pow.check(body.pow?.challenge, body.pow?.nonce);
        if (powCheck !== 'ok') {
          if (powCheck === 'bad' || powCheck === 'weak') invite.hit();
          return c.json({ error: 'bad-challenge' }, 403);
        }
        // The code is compared FIRST: the site-wide count of wrong codes only stops further WRONG codes (refusing
        // everyone would let 30 addresses × 10 wrong codes close sign-up for every family for an hour). A right code is
        // never refused by it.
        // the shared code of app.env, else a family's own code of the table (admin.ts invite-new): its label goes with
        // the account, and one use of it is taken now (given back if the sign-up is not made)
        // the open registration needs no code at all (a code an older cached page may send is not looked at)
        const open = rt.options.openRegistration;
        const shared = !open && rt.options.inviteCode !== null && sameSecret(inviteForm(body.invite), inviteForm(rt.options.inviteCode));
        let familyInvite: string | null = null;
        if (!open && !shared && inviteForm(body.invite) !== '') familyInvite = store.claimInvite(inviteHash(body.invite));
        if (!open && !shared && familyInvite === null) {
          const allWait = limiter.blocked('inviteAll', ALL);
          if (allWait !== null) return tooMany(c, allWait);
          invite.hit();
          limiter.hit('inviteAll', ALL);
          return c.json({ error: 'bad-invite' }, 403);
        }
        // one solved task = one account (two sign-ups at once with one task: the second is refused)
        const challenge = rt.pow === null ? null : (body.pow?.challenge ?? '');
        if (challenge !== null && rt.pow !== null && !rt.pow.claim(challenge)) {
          if (familyInvite !== null) store.releaseInvite(familyInvite);
          return c.json({ error: 'bad-challenge' }, 403);
        }
        // a use of a family's code and the task are kept only by an account that was made
        let made = false;
        try {
          const res = await signUp(c, ip, body, familyInvite ?? (open ? OPEN_INVITE_LABEL : SHARED_INVITE_LABEL));
          made = res.status === 201;
          return res;
        } finally {
          if (!made && familyInvite !== null) store.releaseInvite(familyInvite);
          if (!made && challenge !== null) rt.pow?.release(challenge);
        }
      })
      .post('/login', limitBody(SMALL_BODY_LIMIT), jsonBody(loginSchema), async (c) => {
        const ip = clientIp(c, rt.options);
        const body = c.req.valid('json');
        const login = parseLogin(body.login);
        const key = login?.key ?? '';
        const account = key === '' ? undefined : store.byLogin(key);
        // a known device of this account is held back by the address limits only (M3): the per-login limit is there
        // against strangers, and a stranger could otherwise keep the child out by guessing
        const perLogin = key !== '' && !(account !== undefined && knownDevice(c, rt, account.id));
        const address = addressLimits(limiter, 'login', ip);
        const wait = address.blocked() ?? (perLogin ? limiter.blocked('loginAccount', key) : null);
        if (wait !== null) return tooMany(c, wait);
        // counted BEFORE the check (taken back on success): parallel guesses cannot all slip through
        address.hit();
        if (perLogin) limiter.hit('loginAccount', key);
        // never checked (busy, too many at once): the attempt is taken back
        const takeBack = (): void => {
          address.unhit();
          if (perLogin) limiter.unhit('loginAccount', key);
        };
        let ok: boolean | null;
        try {
          // the same scrypt work for an unknown login: the answer and its timing do not tell which logins exist
          ok = await guarded(ip, async () => verifySecret(body.password, account?.pass_hash ?? (await dummySecretHash())));
        } catch (error) {
          takeBack();
          if (error instanceof HashBusy) return busy(c);
          throw error;
        }
        if (ok === null) {
          takeBack();
          return tooMany(c, 2);
        }
        if (account === undefined || !ok) return c.json({ error: 'bad-credentials' }, 401);
        address.unhit();
        if (perLogin) limiter.reset('loginAccount', key);
        startSession(c, rt, account);
        return c.json({ user: userOf(account) });
      })
      .post('/logout', (c) => {
        endSession(c, rt);
        return c.json({ ok: true });
      })
      .post('/recover', limitBody(SMALL_BODY_LIMIT), jsonBody(recoverSchema), async (c) => {
        const ip = clientIp(c, rt.options);
        const body = c.req.valid('json');
        const login = parseLogin(body.login);
        const key = login?.key ?? '';
        const address = addressLimits(limiter, 'recover', ip);
        const wait = address.blocked() ?? (key !== '' ? limiter.blocked('recoverAccount', key) : null);
        if (wait !== null) return tooMany(c, wait);
        const weak = passwordProblem(body.password);
        if (weak !== null) return c.json({ error: `password-${weak}` }, 400);
        address.hit();
        if (key !== '') limiter.hit('recoverAccount', key);
        const takeBack = (): void => {
          address.unhit();
          if (key !== '') limiter.unhit('recoverAccount', key);
        };
        const code = normalizeRecoveryCode(body.recoveryCode);
        const account = key === '' ? undefined : store.byLogin(key);
        const recoveryCode = newRecoveryCode();
        let result: { ok: boolean; passHash?: string; recoveryHash?: string } | null;
        try {
          result = await guarded(ip, async () => {
            const ok = await verifySecret(code ?? '', account?.recovery_hash ?? (await dummySecretHash()));
            if (!ok || account === undefined || code === null) return { ok: false };
            const [passHash, recoveryHash] = await Promise.all([hashSecret(body.password), hashSecret(recoveryCode)]);
            return { ok: true, passHash, recoveryHash };
          });
        } catch (error) {
          takeBack();
          if (error instanceof HashBusy) return busy(c);
          throw error;
        }
        if (result === null) {
          takeBack();
          return tooMany(c, 2);
        }
        if (!result.ok || account === undefined || result.passHash === undefined || result.recoveryHash === undefined) return c.json({ error: 'bad-recovery' }, 401);
        // one use only: the update holds only while the code it checked is still the account's (two requests at once)
        const used = store.replaceRecovered(account.id, account.recovery_hash, result.passHash, result.recoveryHash);
        if (!used) return c.json({ error: 'bad-recovery' }, 401);
        address.unhit();
        limiter.reset('recoverAccount', key);
        limiter.reset('loginAccount', key);
        rt.log(`[accounts] password recovered for ${account.id}`);
        startSession(c, rt, account);
        return c.json({ user: userOf(account), recoveryCode });
      })
      .post('/delete', limitBody(SMALL_BODY_LIMIT), jsonBody(deleteSchema), async (c) => {
        const account = sessionAccount(c, rt);
        if (account === null) return c.json({ error: 'auth-required' }, 401);
        const ip = clientIp(c, rt.options);
        const address = addressLimits(limiter, 'login', ip);
        const perLogin = !knownDevice(c, rt, account.id);
        const wait = address.blocked() ?? (perLogin ? limiter.blocked('loginAccount', account.login) : null);
        if (wait !== null) return tooMany(c, wait);
        address.hit();
        if (perLogin) limiter.hit('loginAccount', account.login);
        const takeBack = (): void => {
          address.unhit();
          if (perLogin) limiter.unhit('loginAccount', account.login);
        };
        let ok: boolean | null;
        try {
          ok = await guarded(ip, () => verifySecret(c.req.valid('json').password, account.pass_hash));
        } catch (error) {
          takeBack();
          if (error instanceof HashBusy) return busy(c);
          throw error;
        }
        if (ok === null) {
          takeBack();
          return tooMany(c, 2);
        }
        if (!ok) return c.json({ error: 'bad-credentials' }, 401);
        address.unhit();
        if (perLogin) limiter.reset('loginAccount', account.login);
        // the row first: no request can open the account's context again while its folder is removed
        store.delete(account.id);
        rt.presence.forget(account.id);
        await rt.users.remove(account.id);
        rt.log(`[accounts] account ${account.id} deleted with its data`);
        deleteCookie(c, cookieName(rt.options), { path: '/', secure: rt.options.cookieSecure, httpOnly: true, sameSite: 'Lax' });
        return c.json({ ok: true });
      })
  );
}
