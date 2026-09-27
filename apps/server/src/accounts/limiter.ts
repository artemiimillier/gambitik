/**
 * Accounts: how often a door may be knocked at — in memory, per key (an address — IPv6 by its /64 —, a login, an
 * account, or everyone at once), sliding windows. An attempt is counted BEFORE its slow check and taken back when it
 * succeeds (`unhit`), so parallel requests cannot slip past a limit. A restart forgets it.
 *
 *   login     20 sign-in attempts per address / 15 min, 100 per IPv6 /48; 10 per
 *             login / 15 min — a browser the account signed in from before (a «known device», ./store.ts) is not held
 *             back by the per-login limit, so a stranger who knows the nickname cannot lock the child out
 *   invite    10 wrong invite codes per address / hour (50 per /48); 300 wrong codes per hour in all — that one only
 *             stops further WRONG codes: the right code is never refused by it
 *   register  20 sign-ups per address / hour (a class or a family behind one address; 100 per /48), 300 per hour in
 *             all; a form mistake (bad nick, weak password) is not counted, a taken nick only per address
 *   recover   10 recovery attempts per address / 15 min (50 per /48), 5 per login / hour
 *   write     180 changes per minute per account, 150 saved games per day per account (the disk is everyone's)
 *   read      600 reads per minute per account (the recorded phrases apart: 3000); 8 recounts (a game marked «играл взрослый», «Начать прогресс заново»)
 *             per minute per account — each rereads every game of the child
 * An attempt the server never checked (503 busy, too many at once from the address, a failed sign-up) is taken back.
 */
export interface LimitRule {
  max: number;
  windowMs: number;
}

export const LIMIT_RULES = {
  loginIp: { max: 20, windowMs: 15 * 60_000 },
  /** IPv6: one /48 (a whole site's or a provider customer's network — up to 65 536 /64s) gets 5× one /64's budget */
  loginNet: { max: 100, windowMs: 15 * 60_000 },
  loginAccount: { max: 10, windowMs: 15 * 60_000 },
  inviteIp: { max: 10, windowMs: 60 * 60_000 },
  inviteNet: { max: 50, windowMs: 60 * 60_000 },
  /** wrong invite codes from everyone together: only further WRONG codes are refused once it is spent (H2) */
  inviteAll: { max: 300, windowMs: 60 * 60_000 },
  registerIp: { max: 20, windowMs: 60 * 60_000 },
  registerNet: { max: 100, windowMs: 60 * 60_000 },
  registerAll: { max: 300, windowMs: 60 * 60_000 },
  recoverIp: { max: 10, windowMs: 15 * 60_000 },
  recoverNet: { max: 50, windowMs: 15 * 60_000 },
  recoverAccount: { max: 5, windowMs: 60 * 60_000 },
  /** a signed-in account's changes (saves, state, attempts …) per minute: a flood cannot fill the disk */
  writeAccount: { max: 180, windowMs: 60_000 },
  /** games saved by one account per day */
  gamesAccount: { max: 150, windowMs: 24 * 3600_000 },
  /** a signed-in account's reads per minute (the web makes a few dozen at start, then a handful a minute) */
  readAccount: { max: 600, windowMs: 60_000 },
  /**
   * the recorded phrases (`GET /api/voice/clips/overlay/*`, a file each, immutable, kept by the browser): a new phone
   * fetches the hot set at once, so they have their own, wider budget instead of the reads'
   */
  clipAccount: { max: 3000, windowMs: 60_000 },
  /** recounts per minute (a game marked «играл взрослый» / unmarked, «Начать прогресс заново»): each rereads every game */
  recountAccount: { max: 8, windowMs: 60_000 },
} as const satisfies Record<string, LimitRule>;

export type LimitName = keyof typeof LIMIT_RULES;

/**
 * at most this many keys are remembered per rule: memory stays bounded under a flood. Each rule has its own map:
 * a flood of one rule's keys (addresses guessing logins) can never push out another
 * rule's keys (a login's failures, an account's writes).
 */
export const MAX_KEYS = 20_000;

/** the key of «everyone at once» (inviteAll, registerAll): never evicted, whatever the flood */
export const ALL = '*';

export class RateLimiter {
  /** one map per rule: key → the times of its recent knocks (oldest first) */
  private readonly hits = new Map<LimitName, Map<string, number[]>>();
  private readonly now: () => number;
  private readonly rules: Record<LimitName, LimitRule>;
  private readonly maxKeys: number;

  constructor(o: { now?: () => number; rules?: Partial<Record<LimitName, LimitRule>>; maxKeys?: number } = {}) {
    this.now = o.now ?? (() => Date.now());
    this.rules = { ...LIMIT_RULES, ...o.rules };
    this.maxKeys = o.maxKeys ?? MAX_KEYS;
  }

  private map(rule: LimitName): Map<string, number[]> {
    let m = this.hits.get(rule);
    if (m === undefined) {
      m = new Map();
      this.hits.set(rule, m);
    }
    return m;
  }

  private recent(rule: LimitName, key: string): number[] {
    const m = this.map(rule);
    const { windowMs } = this.rules[rule];
    const since = this.now() - windowMs;
    const list = (m.get(key) ?? []).filter((t) => t > since);
    if (list.length === 0) m.delete(key);
    else m.set(key, list);
    return list;
  }

  /** null = allowed; else the seconds until one more try is allowed. Counts nothing. */
  blocked(rule: LimitName, key: string): number | null {
    const list = this.recent(rule, key);
    const { max, windowMs } = this.rules[rule];
    if (list.length < max) return null;
    const oldest = list[list.length - max] ?? this.now();
    return Math.max(1, Math.ceil((oldest + windowMs - this.now()) / 1000));
  }

  /** Counts one knock. */
  hit(rule: LimitName, key: string): void {
    const m = this.map(rule);
    const list = this.recent(rule, key);
    list.push(this.now());
    // re-inserted: the Map's order is «least recently knocked first»
    m.delete(key);
    m.set(key, list);
    if (m.size > this.maxKeys) this.evict(rule, m);
  }

  /**
   * Over the cap: the keys whose window has passed go first (they block nothing any more), then — only if the flood
   * is all live — the least recently knocked ones, down to 90 % of the cap (so the sweep does not run on every knock).
   * The «everyone» key `*` is never dropped: a flood of addresses must not reset the site-wide limits.
   */
  private evict(rule: LimitName, m: Map<string, number[]>): void {
    const since = this.now() - this.rules[rule].windowMs;
    for (const [k, list] of m) {
      if (k !== ALL && (list[list.length - 1] ?? 0) <= since) m.delete(k);
    }
    let drop = m.size - Math.floor(this.maxKeys * 0.9);
    if (drop <= 0) return;
    for (const k of m.keys()) {
      if (drop <= 0) break;
      if (k === ALL) continue;
      m.delete(k);
      drop--;
    }
  }

  /** Forgets a key (a successful sign-in clears its login's failures). */
  reset(rule: LimitName, key: string): void {
    this.hits.get(rule)?.delete(key);
  }

  /**
   * Takes back the latest knock of a key: an attempt is counted BEFORE its slow check (so parallel requests cannot all
   * slip through before the first one is counted) and taken back when it succeeded — or
   * when it was never checked at all (the server was busy).
   */
  unhit(rule: LimitName, key: string): void {
    const m = this.hits.get(rule);
    const list = m?.get(key);
    if (m === undefined || list === undefined) return;
    list.pop();
    if (list.length === 0) m.delete(key);
  }

  /** how many keys a rule remembers now (tests) */
  size(rule: LimitName): number {
    return this.hits.get(rule)?.size ?? 0;
  }
}
