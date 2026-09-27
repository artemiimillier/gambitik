/**
 * Accounts (GAMBIT_ACCOUNTS=1): `DATA_DIR/accounts.db` — who may sign in, and the open sessions. Nothing about a child
 * but the login (a nickname — never a real name, never an e-mail: data minimisation, docs/ACCOUNTS.md) and
 * hashes. The child's own data lives apart, one folder per account: `DATA_DIR/users/<id>/` (./users.ts).
 *
 *   account  id (16 hex = the folder name), login (the nickname for lookup: NFC, lower case, «ё» as «е», single spaces),
 *            display (as typed), pass_hash, recovery_hash (./password.ts), created_at, last_login_at, pass_changed_at
 *   session  token_hash (sha256 of the cookie's random token — the token itself is never stored), account_id,
 *            created_at, expires_at, seen_at (ms)
 *   device   a «known device»: token_hash (sha256 of the random token of a long-lived
 *            cookie that a browser gets on a successful sign-in / sign-up / recovery), account_id, created_at, seen_at
 *            (ms). A sign-in from a known device of THAT account is not held back by the per-login limit, so a stranger
 *            who knows the nickname cannot lock the child out. At most MAX_DEVICES_PER_ACCOUNT per account (the
 *            least recently used go), forgotten after DEVICE_TTL_MS unused, all of them on recovery and on the owner's
 *            reset-password, with the account on its deletion (cascade).
 */
import { createHash, randomBytes } from 'node:crypto';
import { openDb } from '../storage/db.ts';
import type { Db } from '../storage/db.ts';

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE account (
    id              TEXT PRIMARY KEY,
    login           TEXT NOT NULL UNIQUE,
    display         TEXT NOT NULL,
    pass_hash       TEXT NOT NULL,
    recovery_hash   TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    last_login_at   TEXT,
    pass_changed_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE session (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    seen_at    INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX session_account ON session (account_id);
  `,
  // 2: known devices — IF NOT EXISTS: harmless on a database that already has them
  `
  CREATE TABLE IF NOT EXISTS device (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    seen_at    INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS device_account ON device (account_id, seen_at);
  `,
  // 3: the owner's invite codes, one per family (or group): which code an account came with, how often a code may be
  // used, switched off at any time. Only the sha256 of a code (in its compared form, routes.ts inviteForm) is kept.
  `
  CREATE TABLE IF NOT EXISTS invite (
    label      TEXT PRIMARY KEY,
    code_hash  TEXT NOT NULL UNIQUE,
    max_uses   INTEGER,
    uses       INTEGER NOT NULL DEFAULT 0,
    disabled   INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
    created_at TEXT NOT NULL
  ) STRICT;
  ALTER TABLE account ADD COLUMN invite_label TEXT;
  `,
];

export interface InviteRow {
  label: string;
  code_hash: string;
  max_uses: number | null;
  uses: number;
  disabled: number;
  created_at: string;
}

/** the label of the shared code GAMBIT_INVITE_CODE (app.env) in the account rows and the dashboard */
export const SHARED_INVITE_LABEL = 'общий';
/** the label of the accounts made by the open registration (GAMBIT_OPEN_REGISTRATION, no code) */
export const OPEN_INVITE_LABEL = 'открытая';

export interface AccountRow {
  id: string;
  login: string;
  display: string;
  pass_hash: string;
  recovery_hash: string;
  created_at: string;
  last_login_at: string | null;
  pass_changed_at: string;
  /** the label of the invite code the account signed up with (null: an account created before invite labels were stored) */
  invite_label: string | null;
}

/** An account id: 16 lower-case hex digits — the name of its folder `DATA_DIR/users/<id>/`. */
export const ACCOUNT_ID_RE = /^[0-9a-f]{16}$/;

/** A login as typed → its display form (trimmed, single spaces) and its lookup key; null = not a valid login. */
export function parseLogin(raw: unknown): { display: string; key: string } | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const display = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  // 2–24 letters / digits (any alphabet), inner spaces, «.», «_», «-»; starts and ends with a letter or digit
  if (!/^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]{0,22}[\p{L}\p{N}])?$/u.test(display) || [...display].length < 2) return null;
  return { display, key: display.toLowerCase().replaceAll('ё', 'е') };
}

/** a session ends this long after its sign-in, however often it is used */
export const SESSION_MAX_AGE_MS = 90 * 24 * 3600_000;

/** the newest this many known devices of an account are remembered */
export const MAX_DEVICES_PER_ACCOUNT = 10;
/** a known device not used for a sign-in this long is forgotten (the cookie lives as long) */
export const DEVICE_TTL_MS = 365 * 24 * 3600_000;

/** A device token as the cookie may carry it (the store's own are 43 base64url characters). */
const DEVICE_TOKEN_RE = /^[\w-]{20,100}$/;

/** sha256 of a session token (the cookie carries the token, the database only its hash). */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AccountStore {
  readonly db: Db;
  private readonly now: () => number;

  constructor(path: string, o: { now?: () => number } = {}) {
    this.db = openDb(path);
    this.now = o.now ?? (() => Date.now());
    const version = this.db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.tx(() => {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Creates an account; null when the login is taken. */
  create(o: { display: string; key: string; passHash: string; recoveryHash: string }): AccountRow | null {
    const id = randomBytes(8).toString('hex');
    const at = this.iso();
    try {
      this.db.run(
        'INSERT INTO account (id, login, display, pass_hash, recovery_hash, created_at, pass_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        o.key,
        o.display,
        o.passHash,
        o.recoveryHash,
        at,
        at,
      );
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) return null;
      throw error;
    }
    return this.byId(id) ?? null;
  }

  byLogin(key: string): AccountRow | undefined {
    return this.db.get<AccountRow>('SELECT * FROM account WHERE login = ?', key);
  }

  byId(id: string): AccountRow | undefined {
    return this.db.get<AccountRow>('SELECT * FROM account WHERE id = ?', id);
  }

  list(): AccountRow[] {
    return this.db.all<AccountRow>('SELECT * FROM account ORDER BY created_at');
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM account')?.n ?? 0;
  }

  setPassword(id: string, passHash: string): void {
    this.db.run('UPDATE account SET pass_hash = ?, pass_changed_at = ? WHERE id = ?', passHash, this.iso(), id);
  }

  setRecovery(id: string, recoveryHash: string): void {
    this.db.run('UPDATE account SET recovery_hash = ? WHERE id = ?', recoveryHash, id);
  }

  /**
   * Recovery: the new password and code — only while the account still has the code that was checked (two requests
   * with one code: one wins), every session closed. False = the code changed meanwhile.
   */
  replaceRecovered(id: string, checkedRecoveryHash: string, passHash: string, recoveryHash: string): boolean {
    return this.db.tx(() => {
      const changed = this.db.run('UPDATE account SET pass_hash = ?, recovery_hash = ?, pass_changed_at = ? WHERE id = ? AND recovery_hash = ?', passHash, recoveryHash, this.iso(), id, checkedRecoveryHash).changes;
      if (changed !== 1) return false;
      this.db.run('DELETE FROM session WHERE account_id = ?', id);
      // whoever held the code may not be the child: the devices the account knew stop being «known»
      this.db.run('DELETE FROM device WHERE account_id = ?', id);
      return true;
    });
  }

  touchLogin(id: string): void {
    this.db.run('UPDATE account SET last_login_at = ? WHERE id = ?', this.iso(), id);
  }

  // ───────────────────────── invite codes ─────────────────────────

  /** A new invite code row; false when the label or the code exists. */
  addInvite(label: string, codeHash: string, maxUses: number | null): boolean {
    try {
      this.db.run('INSERT INTO invite (label, code_hash, max_uses, created_at) VALUES (?, ?, ?, ?)', label, codeHash, maxUses, this.iso());
      return true;
    } catch {
      return false;
    }
  }

  listInvites(): InviteRow[] {
    return this.db.all<InviteRow>('SELECT * FROM invite ORDER BY created_at');
  }

  /** Switches a code off (or on again); false = no such label. */
  setInviteDisabled(label: string, disabled: boolean): boolean {
    return this.db.run('UPDATE invite SET disabled = ? WHERE label = ?', disabled ? 1 : 0, label).changes > 0;
  }

  /** Is any code of the table usable now? (sign-up is open with it even without GAMBIT_INVITE_CODE) */
  hasOpenInvite(): boolean {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM invite WHERE disabled = 0 AND (max_uses IS NULL OR uses < max_uses)')?.n !== 0;
  }

  /**
   * Takes one use of the code with this hash: its label, or null (unknown, switched off, used up). Taken before the
   * account is made (two sign-ups at once cannot both take the last use); `releaseInvite` gives it back on failure.
   */
  claimInvite(codeHash: string): string | null {
    const row = this.db.get<{ label: string }>('SELECT label FROM invite WHERE code_hash = ? AND disabled = 0', codeHash);
    if (row === undefined) return null;
    const ok = this.db.run('UPDATE invite SET uses = uses + 1 WHERE label = ? AND disabled = 0 AND (max_uses IS NULL OR uses < max_uses)', row.label).changes > 0;
    return ok ? row.label : null;
  }

  releaseInvite(label: string): void {
    this.db.run('UPDATE invite SET uses = MAX(0, uses - 1) WHERE label = ?', label);
  }

  setInviteLabel(accountId: string, label: string): void {
    this.db.run('UPDATE account SET invite_label = ? WHERE id = ?', label, accountId);
  }

  /** Removes the account and (cascade) every session of it. */
  delete(id: string): void {
    this.db.run('DELETE FROM account WHERE id = ?', id);
  }

  // ───────────────────────── sessions ─────────────────────────

  /** A new session: the random token for the cookie (never stored), its hash in the table. */
  openSession(accountId: string, ttlMs: number): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const expiresAt = now + ttlMs;
    this.db.run('INSERT INTO session (token_hash, account_id, created_at, expires_at, seen_at) VALUES (?, ?, ?, ?, ?)', tokenHash(token), accountId, this.iso(), expiresAt, now);
    return { token, expiresAt };
  }

  /**
   * The account of a live session (and its expiry), or null. Sliding: a session seen after a day gets a fresh
   * `ttlMs` (at most once a day, so a busy child does not write on every request) — but never past
   * `SESSION_MAX_AGE_MS` after its sign-in.
   */
  findSession(token: string, ttlMs: number): { accountId: string; expiresAt: number; renewed: boolean } | null {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const hash = tokenHash(token);
    const row = this.db.get<{ account_id: string; expires_at: number; seen_at: number; created_at: string }>('SELECT account_id, expires_at, seen_at, created_at FROM session WHERE token_hash = ?', hash);
    const now = this.now();
    if (row === undefined) return null;
    const born = Date.parse(row.created_at);
    if (row.expires_at <= now || !Number.isFinite(born) || now - born > SESSION_MAX_AGE_MS) {
      this.db.run('DELETE FROM session WHERE token_hash = ?', hash);
      return null;
    }
    if (now - row.seen_at > 24 * 3600_000) {
      const expiresAt = Math.min(now + ttlMs, born + SESSION_MAX_AGE_MS);
      this.db.run('UPDATE session SET seen_at = ?, expires_at = ? WHERE token_hash = ?', now, expiresAt, hash);
      return { accountId: row.account_id, expiresAt, renewed: true };
    }
    return { accountId: row.account_id, expiresAt: row.expires_at, renewed: false };
  }

  closeSession(token: string): void {
    this.db.run('DELETE FROM session WHERE token_hash = ?', tokenHash(token));
  }

  closeAllSessions(accountId: string): void {
    this.db.run('DELETE FROM session WHERE account_id = ?', accountId);
  }

  purgeExpired(): number {
    this.db.run('DELETE FROM device WHERE seen_at <= ?', this.now() - DEVICE_TTL_MS);
    return this.db.run('DELETE FROM session WHERE expires_at <= ?', this.now()).changes;
  }

  // ───────────────────────── known devices ─────────────────────────

  /** A new known device of the account: the random token for the cookie (never stored); the oldest beyond the cap go. */
  rememberDevice(accountId: string): string {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    this.db.tx(() => {
      this.db.run('INSERT INTO device (token_hash, account_id, created_at, seen_at) VALUES (?, ?, ?, ?)', tokenHash(token), accountId, this.iso(), now);
      this.db.run(
        `DELETE FROM device WHERE account_id = ? AND token_hash NOT IN
           (SELECT token_hash FROM device WHERE account_id = ? ORDER BY seen_at DESC, created_at DESC LIMIT ?)`,
        accountId,
        accountId,
        MAX_DEVICES_PER_ACCOUNT,
      );
    });
    return token;
  }

  /** The account a device token belongs to (null: unknown, malformed or unused for too long). Reads only. */
  deviceAccount(token: string): string | null {
    if (typeof token !== 'string' || !DEVICE_TOKEN_RE.test(token)) return null;
    const row = this.db.get<{ account_id: string; seen_at: number }>('SELECT account_id, seen_at FROM device WHERE token_hash = ?', tokenHash(token));
    if (row === undefined || row.seen_at <= this.now() - DEVICE_TTL_MS) return null;
    return row.account_id;
  }

  /** A known device signed in again: it is the account's most recently used one. */
  touchDevice(token: string): void {
    this.db.run('UPDATE device SET seen_at = ? WHERE token_hash = ?', this.now(), tokenHash(token));
  }

  /** Every known device of the account is forgotten (recovery, the owner's reset-password). */
  forgetDevices(accountId: string): void {
    this.db.run('DELETE FROM device WHERE account_id = ?', accountId);
  }

  countDevices(accountId: string): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM device WHERE account_id = ?', accountId)?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
