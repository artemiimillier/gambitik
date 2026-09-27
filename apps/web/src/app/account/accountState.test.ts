/**
 * The browser's memory of the child on the public site (./accountState.ts): another child signing in on the same
 * browser never sees the previous child's data (caches included), the same child gets the newer copy of each key,
 * and every change of a child's key is sent to the account — debounced, and at once when the page hides.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_MARK_KEY, SYNC_KEYS, clearChildKeys, readMark, reconcile, startSync } from './accountState.ts';

/** A tiny Storage with its own prototype (the sync patches the prototype, as it does localStorage's). */
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  key(i: number): string | null {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, String(v));
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
  clear(): void {
    this.data.clear();
  }
  [name: string]: unknown;
}

afterEach(() => {
  vi.useRealTimers();
});

const TIGR = { login: 'Тигр', account: 'aaaa000000000001' };
const LISA = { login: 'Лиса', account: 'bbbb000000000002' };

describe('whose data is in this browser', () => {
  it('another child signs in: everything of the previous one goes (caches too), the server’s copy comes in', () => {
    const s = new MemoryStorage();
    s.setItem(ACCOUNT_MARK_KEY, JSON.stringify({ account: 'aaaa000000000001', login: 'Тигр', times: {} }));
    s.setItem('gambit.lessonBook', 'тигра книга');
    s.setItem('gambit.profile.cache', '{"nickname":"Тигр"}');
    s.setItem('gambit.studentCache', 'x');
    s.setItem('gambit.parentGate', 'open');
    s.setItem('gambit.e2eClips', '1');
    s.setItem('other.app', 'kept');
    const { push } = reconcile(s, LISA, { values: { 'gambit.lessonBook': 'лисы книга' }, times: { 'gambit.lessonBook': 50 } });
    expect(push).toEqual([]);
    expect(s.getItem('gambit.lessonBook')).toBe('лисы книга');
    expect(s.getItem('gambit.profile.cache')).toBeNull();
    expect(s.getItem('gambit.studentCache')).toBeNull();
    expect(s.getItem('gambit.parentGate')).toBeNull();
    // this browser's own switches and other apps' keys stay
    expect(s.getItem('gambit.e2eClips')).toBe('1');
    expect(s.getItem('other.app')).toBe('kept');
    expect(readMark(s)).toEqual({ account: LISA.account, login: 'Лиса', times: { 'gambit.lessonBook': 50 } });
  });

  it('the same account: per key the newer side wins — the server’s comes in, a newer local one goes out', () => {
    const s = new MemoryStorage();
    s.setItem(ACCOUNT_MARK_KEY, JSON.stringify({ account: TIGR.account, login: 'Тигр', times: { 'gambit.lessonBook': 100, 'gambit.settings': 300, 'gambit.day': 10 } }));
    s.setItem('gambit.lessonBook', 'старая');
    s.setItem('gambit.settings', 'новые здесь');
    s.setItem('gambit.day', 'сегодня');
    s.setItem('gambit.coachStyle', 'teacher'); // never synced before
    const { push } = reconcile(s, TIGR, {
      values: { 'gambit.lessonBook': 'новая с другого компьютера', 'gambit.settings': 'старые' },
      times: { 'gambit.lessonBook': 200, 'gambit.settings': 150, 'gambit.day': 20 },
    });
    expect(s.getItem('gambit.lessonBook')).toBe('новая с другого компьютера');
    expect(s.getItem('gambit.settings')).toBe('новые здесь');
    // removed on the other computer later than changed here: removed here too
    expect(s.getItem('gambit.day')).toBeNull();
    expect(push.sort()).toEqual(['gambit.coachStyle', 'gambit.settings']);
  });

  it('signing out removes the child’s keys only', () => {
    const s = new MemoryStorage();
    for (const k of SYNC_KEYS) s.setItem(k, 'x');
    s.setItem(ACCOUNT_MARK_KEY, '{}');
    s.setItem('gambit.e2eVoice', '1');
    clearChildKeys(s);
    expect(s.length).toBe(1);
    expect(s.getItem('gambit.e2eVoice')).toBe('1');
  });
});

describe('two tabs, two children', () => {
  it('a deleted nickname taken again by another child is another account: the old data does not come along', () => {
    const s = new MemoryStorage();
    s.setItem(ACCOUNT_MARK_KEY, JSON.stringify({ account: TIGR.account, login: 'Тигр', times: { 'gambit.unsavedGames': 5 } }));
    s.setItem('gambit.unsavedGames', '[старая партия]');
    const { push } = reconcile(s, { login: 'Тигр', account: 'cccc000000000003' }, { values: {}, times: {} });
    expect(push).toEqual([]);
    expect(s.getItem('gambit.unsavedGames')).toBeNull();
  });

  it('a tab of the child who signed out stops sending (and asks to reload) once another child signed in here', async () => {
    vi.useFakeTimers();
    const s = new MemoryStorage();
    s.setItem(ACCOUNT_MARK_KEY, JSON.stringify({ account: TIGR.account, login: 'Тигр', times: {} }));
    const puts: string[] = [];
    let reloads = 0;
    const sync = startSync(s, TIGR, { put: async (k) => (puts.push(k), true), onForeign: () => reloads++ });
    try {
      s.setItem('gambit.lessonBook', 'тигр');
      await vi.advanceTimersByTimeAsync(1_600);
      expect(puts).toEqual(['gambit.lessonBook']);
      // another tab: Лиса signed in, her mark replaced his
      s.setItem(ACCOUNT_MARK_KEY, JSON.stringify({ account: LISA.account, login: 'Лиса', times: {} }));
      s.setItem('gambit.resumeGame', 'партия Тигра из старой вкладки');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(puts).toEqual(['gambit.lessonBook']);
      expect(reloads).toBe(1);
      // and the mark stays hers
      expect(readMark(s)?.account).toBe(LISA.account);
    } finally {
      sync.stop();
    }
  });
});

describe('sending changes to the account', () => {
  it('a change of a child’s key goes out 1.5 s after the last change, with its time; other keys never', async () => {
    vi.useFakeTimers();
    const s = new MemoryStorage();
    const puts: [string, string | null, number][] = [];
    let now = 1_000;
    const sync = startSync(s, TIGR, { put: async (k, v, at) => (puts.push([k, v, at]), true), now: () => now });
    try {
      s.setItem('gambit.lessonBook', 'v1');
      now = 1_500;
      s.setItem('gambit.lessonBook', 'v2');
      s.setItem('gambit.profile.cache', 'not synced');
      s.setItem('unrelated', 'x');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(puts).toEqual([]);
      await vi.advanceTimersByTimeAsync(600);
      expect(puts).toEqual([['gambit.lessonBook', 'v2', 1_500]]);
      now = 2_000;
      s.removeItem('gambit.lessonBook');
      await sync.flush();
      expect(puts[1]).toEqual(['gambit.lessonBook', null, 2_000]);
      expect(readMark(s)?.times['gambit.lessonBook']).toBe(2_000);
    } finally {
      sync.stop();
    }
    // stopped: the storage is plain again
    s.setItem('gambit.settings', 'after stop');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(puts).toHaveLength(2);
  });

  it('a failed send is tried again later', async () => {
    vi.useFakeTimers();
    const s = new MemoryStorage();
    let fails = 1;
    const puts: string[] = [];
    const sync = startSync(s, TIGR, {
      put: async (k) => {
        puts.push(k);
        return fails-- <= 0;
      },
    });
    try {
      s.setItem('gambit.settings', '{}');
      await vi.advanceTimersByTimeAsync(1_600);
      expect(puts).toEqual(['gambit.settings']);
      await vi.advanceTimersByTimeAsync(15_100);
      expect(puts).toEqual(['gambit.settings', 'gambit.settings']);
    } finally {
      sync.stop();
    }
  });
});
