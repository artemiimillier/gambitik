/**
 * Accounts of the public site: what this browser remembers about the child (localStorage `gambit.*` — the lesson's
 * phrase book, the voice and sound settings, the teacher's cards, the clips heard lately, a game to resume, games and
 * thoughts not sent yet) belongs to the ACCOUNT, not to the browser:
 *  - it is kept on the server too (`/api/account/state`), so it follows the child to another browser;
 *  - when another account signs in here, everything of the previous child is removed first (caches of the server's
 *    data too), so two children on one computer never see each other's;
 *  - a key changed here is sent to the server (1.5 s later, or at once when the page is hidden); at start the newer
 *    side of each key wins (a time per key: `gambit.account.times` here, `times` on the server).
 * The family server has no accounts: none of this runs there and localStorage is used as usual.
 */
import type { AccountUser, ServerState } from './accountApi.ts';

/** The child's keys kept with the account (the server allows exactly these: apps/server/src/routes/accountState.ts). */
export const SYNC_KEYS: readonly string[] = [
  'gambit.settings',
  'gambit.lessonBook',
  'gambit.teacher.concepts',
  'gambit.coachStyle',
  'gambit.day',
  'gambit.clipRecency',
  'gambit.clipStats',
  'gambit.clipMisses',
  'gambit.sound.alwaysMuted',
  'gambit.sound.mutedUntil',
  'gambit.sfx.muted',
  'gambit.resumeGame',
  'gambit.unsentThoughts',
  'gambit.unsavedGames',
];

const SYNCED = new Set(SYNC_KEYS);
/** «this site has accounts» (then a server that does not answer is waited for, never replaced by the family app) */
export const ACCOUNTS_SITE_KEY = 'gambit.site.accounts';
/** this browser's own switches (the tests', the site's kind), never a child's */
const DEVICE_KEYS: ReadonlySet<string> = new Set(['gambit.e2eClips', 'gambit.e2eVoice', ACCOUNTS_SITE_KEY]);
/** whose data this browser holds now, and when each key was changed here */
export const ACCOUNT_MARK_KEY = 'gambit.account';

export interface AccountMark {
  /** the account's opaque id — who the data belongs to (a nickname may be deleted and taken again by another child) */
  account: string;
  login: string;
  times: Record<string, number>;
}

export function readMark(storage: Storage): AccountMark | null {
  try {
    const raw = storage.getItem(ACCOUNT_MARK_KEY);
    if (raw === null) return null;
    const m = JSON.parse(raw) as Partial<AccountMark>;
    if (typeof m.login !== 'string' || typeof m.account !== 'string') return null;
    const times: Record<string, number> = {};
    for (const [k, v] of Object.entries(m.times ?? {})) if (SYNCED.has(k) && typeof v === 'number' && Number.isFinite(v)) times[k] = v;
    return { account: m.account, login: m.login, times };
  } catch {
    return null;
  }
}

function writeMark(storage: Storage, mark: AccountMark): void {
  try {
    storage.setItem(ACCOUNT_MARK_KEY, JSON.stringify(mark));
  } catch {
    // a full or blocked storage: the data itself still syncs
  }
}

/** Removes every `gambit.*` key of this browser but its own switches — everything of the child who used it. */
export function clearChildKeys(storage: Storage): void {
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k !== null && k.startsWith('gambit.') && !DEVICE_KEYS.has(k)) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
  } catch {
    // nothing more can be done in a blocked storage
  }
}

/**
 * At start, signed in as `login`, with the server's copy: another child's (or nobody's) data here is removed and the
 * server's taken; the same child's is merged key by key, the newer side winning. Returns the keys whose local copy is
 * newer (to send).
 */
export function reconcile(storage: Storage, user: AccountUser, server: ServerState): { push: string[] } {
  const mark = readMark(storage);
  const push: string[] = [];
  if (mark === null || mark.account !== user.account) {
    clearChildKeys(storage);
    const times: Record<string, number> = {};
    for (const key of SYNC_KEYS) {
      const value = server.values[key];
      try {
        if (value !== undefined) storage.setItem(key, value);
      } catch {
        // too big for this browser: it stays on the server
      }
      const at = server.times[key];
      if (typeof at === 'number') times[key] = at;
    }
    writeMark(storage, { account: user.account, login: user.login, times });
    return { push };
  }
  for (const key of SYNC_KEYS) {
    const localAt = mark.times[key];
    const serverAt = server.times[key];
    const hasLocal = storage.getItem(key) !== null;
    if (serverAt !== undefined && (localAt === undefined || serverAt > localAt)) {
      const value = server.values[key];
      try {
        if (value === undefined) storage.removeItem(key);
        else storage.setItem(key, value);
      } catch {
        // stays on the server
      }
      mark.times[key] = serverAt;
    } else if (localAt !== undefined ? serverAt === undefined || localAt > serverAt : hasLocal) {
      // changed here later (or never sent): the server gets this copy
      push.push(key);
      if (localAt === undefined) mark.times[key] = Date.now();
    }
  }
  writeMark(storage, { account: user.account, login: user.login, times: mark.times });
  return { push };
}

export interface SyncDeps {
  put: (key: string, value: string | null, at: number, o?: { keepalive?: boolean }) => Promise<boolean>;
  now?: () => number;
  delayMs?: number;
  /** this browser now holds another account's data (another tab signed in): this page must stop and reload */
  onForeign?: () => void;
}

export interface StateSync {
  /** sends every pending key now (before signing out) */
  flush(o?: { keepalive?: boolean }): Promise<void>;
  stop(): void;
}

/**
 * Watches this browser's writes of the child's keys (every module writes localStorage as usual) and sends
 * each changed key to the account, 1.5 s after its last change; everything pending goes at once when the page is
 * hidden or closed (`keepalive`).
 */
export function startSync(storage: Storage, user: AccountUser, deps: SyncDeps): StateSync {
  const now = deps.now ?? (() => Date.now());
  const delay = deps.delayMs ?? 1500;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Set<string>();
  /** another account took this browser over (another tab): nothing more is sent from this page */
  let foreign = false;

  const send = async (key: string, keepalive = false): Promise<void> => {
    const t = timers.get(key);
    if (t !== undefined) clearTimeout(t);
    timers.delete(key);
    if (foreign || !pending.has(key)) return;
    pending.delete(key);
    const mark = readMark(storage);
    const at = mark?.times[key] ?? now();
    let value: string | null = null;
    try {
      value = storage.getItem(key);
    } catch {
      value = null;
    }
    const ok = await deps.put(key, value, at, keepalive ? { keepalive: true } : {});
    if (!ok && !keepalive) {
      // try again later (a network hiccup); a newer change reschedules it anyway
      pending.add(key);
      timers.set(
        key,
        setTimeout(() => void send(key), 15_000),
      );
    }
  };

  const touched = (key: string): void => {
    if (foreign || !SYNCED.has(key)) return;
    const found = readMark(storage);
    if (found !== null && found.account !== user.account) {
      // another tab signed another child in: this page's writes are not this account's any more — stop, never rewrite
      foreign = true;
      pending.clear();
      deps.onForeign?.();
      return;
    }
    const mark = found ?? { account: user.account, login: user.login, times: {} };
    mark.times[key] = now();
    writeMark(storage, mark);
    pending.add(key);
    const t = timers.get(key);
    if (t !== undefined) clearTimeout(t);
    timers.set(
      key,
      setTimeout(() => void send(key), delay),
    );
  };

  const proto = Object.getPrototypeOf(storage) as Storage;
  const setItem = proto.setItem;
  const removeItem = proto.removeItem;
  proto.setItem = function patchedSetItem(this: Storage, key: string, value: string): void {
    setItem.call(this, key, value);
    if (this === storage) touched(key);
  };
  proto.removeItem = function patchedRemoveItem(this: Storage, key: string): void {
    removeItem.call(this, key);
    if (this === storage) touched(key);
  };

  const flush = async (o: { keepalive?: boolean } = {}): Promise<void> => {
    await Promise.all([...pending].map((key) => send(key, o.keepalive === true)));
  };
  const onHide = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') void flush({ keepalive: true });
  };
  const onPageHide = (): void => void flush({ keepalive: true });
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHide);
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);

  return {
    flush,
    stop() {
      proto.setItem = setItem;
      proto.removeItem = removeItem;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHide);
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
    },
  };
}
