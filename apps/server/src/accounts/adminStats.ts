/**
 * The owner's dashboard of the public site (`/admin`, docs/ACCOUNTS.md): how many children, who is here right now and
 * on which screen, games and puzzles per account and per hour. Only accounts named in GAMBIT_ADMIN_LOGINS may read it;
 * to everybody else `/api/admin/*` does not exist (404).
 *
 * «Who is here»: the page of a signed-in child reports its screen once a minute (`POST /api/presence`), kept in memory
 * only — a restart forgets it, nothing about it is written anywhere. The rest is read from the accounts' own databases,
 * read-only, and cached for a few seconds (the dashboard refreshes itself).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OPEN_INVITE_LABEL, SHARED_INVITE_LABEL } from './store.ts';
import type { AccountStore } from './store.ts';

/** the screens a page may report (the web router's route names) */
export const PRESENCE_SCREENS = ['home', 'new', 'play', 'review', 'puzzles', 'progress', 'path', 'settings', 'playground', 'auth'] as const;
export type PresenceScreen = (typeof PRESENCE_SCREENS)[number];

/** a child whose page reported within this long is «on the site now» */
export const ONLINE_MS = 2.5 * 60_000;

export class Presence {
  private readonly seen = new Map<string, { at: number; screen: PresenceScreen }>();
  private readonly now: () => number;
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  mark(accountId: string, screen: PresenceScreen): void {
    this.seen.set(accountId, { at: this.now(), screen });
    if (this.seen.size > 50_000) this.sweep();
  }

  /** the last report of an account (any age), or undefined */
  get(accountId: string): { at: number; screen: PresenceScreen } | undefined {
    return this.seen.get(accountId);
  }

  forget(accountId: string): void {
    this.seen.delete(accountId);
  }

  private sweep(): void {
    const since = this.now() - 24 * 3600_000;
    for (const [id, v] of this.seen) if (v.at < since) this.seen.delete(id);
  }
}

export interface AdminAccountRow {
  login: string;
  createdAt: string;
  lastLoginAt: string | null;
  /** ms since epoch of the last sign of life (page report, game, puzzle, sign-in) */
  lastActiveAt: number | null;
  online: boolean;
  screen: PresenceScreen | null;
  address: 'm' | 'f' | null;
  stage: number | null;
  puzzleRating: number | null;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  puzzles: number;
  puzzlesSolved: number;
  lastGameAt: string | null;
  /** an unfinished game waits in the account (closed tab, reload) */
  unfinishedGame: boolean;
  /** the invite code it signed up with (its label; null: an account created before invite labels were stored) */
  invite: string | null;
}

export interface AdminStats {
  generatedAt: string;
  totals: { accounts: number; online: number; playing: number; games: number; puzzles: number; puzzlesSolved: number; activeToday: number; maxAccounts: number };
  screens: Partial<Record<PresenceScreen, number>>;
  /** the last 48 hours, one bucket per hour (the bucket's start, ISO) */
  hourly: { hour: string; signups: number; games: number; puzzles: number }[];
  byTimeControl: Record<string, number>;
  byBot: Record<string, number>;
  /** the invite codes: the shared one of app.env and the families' own (admin.ts invite-new) */
  invites: { label: string; accounts: number; uses: number | null; maxUses: number | null; open: boolean }[];
  results: { wins: number; losses: number; draws: number };
  accounts: AdminAccountRow[];
}

const HOURS = 48;

interface GameRow {
  ended_at: string;
  persona_id: string;
  time_control_id: string;
  child_color: string;
  result: string;
}

function readAccountDb(dataDir: string, id: string) {
  const file = join(dataDir, 'users', id, 'app.sqlite');
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 1000');
    const games = db.prepare("SELECT ended_at, persona_id, time_control_id, child_color, result FROM game WHERE excluded IS NULL").all() as unknown as GameRow[];
    const puzzles = db.prepare('SELECT solved, created_at FROM puzzle_attempt').all() as unknown as { solved: number; created_at: string }[];
    const kv = (key: string): string | null => (db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
    let profile: { address?: unknown; stage?: unknown; puzzleRating?: { rating?: unknown } } = {};
    try {
      profile = JSON.parse(kv('student-profile') ?? '{}') as typeof profile;
    } catch {
      // an unreadable profile: the row shows dashes
    }
    return { games, puzzles, profile, unfinishedGame: kv('client:gambit.resumeGame') !== null };
  } finally {
    db.close();
  }
}

function outcome(g: GameRow): 'win' | 'loss' | 'draw' | null {
  if (g.result === '1/2-1/2') return 'draw';
  if (g.result === '1-0') return g.child_color === 'w' ? 'win' : 'loss';
  if (g.result === '0-1') return g.child_color === 'b' ? 'win' : 'loss';
  return null;
}

export function computeAdminStats(o: { store: AccountStore; dataDir: string; presence: Presence; maxAccounts: number; sharedInviteOpen?: boolean; openRegistration?: boolean; now?: number }): AdminStats {
  const now = o.now ?? Date.now();
  const hourStart = Math.floor(now / 3600_000) * 3600_000;
  const first = hourStart - (HOURS - 1) * 3600_000;
  const hourly = Array.from({ length: HOURS }, (_, i) => ({ hour: new Date(first + i * 3600_000).toISOString(), signups: 0, games: 0, puzzles: 0 }));
  const bucket = (iso: string | null | undefined): (typeof hourly)[number] | undefined => {
    if (iso === null || iso === undefined) return undefined;
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || t < first) return undefined;
    return hourly[Math.floor((t - first) / 3600_000)];
  };
  const dayAgo = now - 24 * 3600_000;
  const byTimeControl: Record<string, number> = {};
  const byBot: Record<string, number> = {};
  const results = { wins: 0, losses: 0, draws: 0 };
  const screens: AdminStats['screens'] = {};
  const totals = { accounts: 0, online: 0, playing: 0, games: 0, puzzles: 0, puzzlesSolved: 0, activeToday: 0, maxAccounts: o.maxAccounts };
  const accounts: AdminAccountRow[] = [];

  for (const a of o.store.list()) {
    totals.accounts++;
    const signup = bucket(a.created_at);
    if (signup !== undefined) signup.signups++;
    let data: ReturnType<typeof readAccountDb> = null;
    try {
      data = readAccountDb(o.dataDir, a.id);
    } catch {
      // a locked or damaged database: the account is still listed
    }
    const row: AdminAccountRow = {
      login: a.display,
      createdAt: a.created_at,
      lastLoginAt: a.last_login_at,
      lastActiveAt: null,
      online: false,
      screen: null,
      address: data?.profile.address === 'm' || data?.profile.address === 'f' ? data.profile.address : null,
      stage: typeof data?.profile.stage === 'number' ? data.profile.stage : null,
      puzzleRating: typeof data?.profile.puzzleRating?.rating === 'number' ? Math.round(data.profile.puzzleRating.rating) : null,
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      puzzles: 0,
      puzzlesSolved: 0,
      lastGameAt: null,
      unfinishedGame: data?.unfinishedGame ?? false,
      invite: a.invite_label,
    };
    let last = Math.max(Date.parse(a.last_login_at ?? '') || 0, Date.parse(a.created_at) || 0);
    for (const g of data?.games ?? []) {
      row.games++;
      const r = outcome(g);
      if (r === 'win') row.wins++;
      else if (r === 'loss') row.losses++;
      else if (r === 'draw') row.draws++;
      if (row.lastGameAt === null || g.ended_at > row.lastGameAt) row.lastGameAt = g.ended_at;
      last = Math.max(last, Date.parse(g.ended_at) || 0);
      byTimeControl[g.time_control_id] = (byTimeControl[g.time_control_id] ?? 0) + 1;
      byBot[g.persona_id] = (byBot[g.persona_id] ?? 0) + 1;
      const b = bucket(g.ended_at);
      if (b !== undefined) b.games++;
    }
    for (const p of data?.puzzles ?? []) {
      row.puzzles++;
      if (p.solved === 1) row.puzzlesSolved++;
      last = Math.max(last, Date.parse(p.created_at) || 0);
      const b = bucket(p.created_at);
      if (b !== undefined) b.puzzles++;
    }
    const seen = o.presence.get(a.id);
    if (seen !== undefined) last = Math.max(last, seen.at);
    row.lastActiveAt = last > 0 ? last : null;
    if (seen !== undefined && now - seen.at <= ONLINE_MS) {
      row.online = true;
      row.screen = seen.screen;
      totals.online++;
      if (seen.screen === 'play') totals.playing++;
      screens[seen.screen] = (screens[seen.screen] ?? 0) + 1;
    }
    if (last >= dayAgo) totals.activeToday++;
    totals.games += row.games;
    totals.puzzles += row.puzzles;
    totals.puzzlesSolved += row.puzzlesSolved;
    results.wins += row.wins;
    results.losses += row.losses;
    results.draws += row.draws;
    accounts.push(row);
  }
  const perInvite = new Map<string, number>();
  for (const a of accounts) perInvite.set(a.invite ?? '', (perInvite.get(a.invite ?? '') ?? 0) + 1);
  const invites: AdminStats['invites'] = [
    { label: SHARED_INVITE_LABEL, accounts: perInvite.get(SHARED_INVITE_LABEL) ?? 0, uses: null, maxUses: null, open: o.sharedInviteOpen ?? false },
    ...o.store.listInvites().map((i) => ({
      label: i.label,
      accounts: perInvite.get(i.label) ?? 0,
      uses: i.uses,
      maxUses: i.max_uses,
      open: i.disabled === 0 && (i.max_uses === null || i.uses < i.max_uses),
    })),
  ];
  if ((perInvite.get(OPEN_INVITE_LABEL) ?? 0) > 0) invites.unshift({ label: 'без кода (открытая регистрация)', accounts: perInvite.get(OPEN_INVITE_LABEL) ?? 0, uses: null, maxUses: null, open: o.openRegistration ?? false });
  if ((perInvite.get('') ?? 0) > 0) invites.push({ label: 'без метки', accounts: perInvite.get('') ?? 0, uses: null, maxUses: null, open: false });
  accounts.sort((x, y) => Number(y.online) - Number(x.online) || (y.lastActiveAt ?? 0) - (x.lastActiveAt ?? 0));
  return { generatedAt: new Date(now).toISOString(), totals, screens, hourly, byTimeControl, byBot, invites, results, accounts };
}
