/**
 * App-level state of the shell: server health, the student profile, the recent games.
 *
 * The local server may be down (the parent closed the Terminal window, the laptop just woke up).
 * The trainer must stay usable, so:
 *   - the last known profile is cached in localStorage and used as a stand-in;
 *   - profile edits made while the server is away are kept as a pending patch and sent later;
 *   - `serverOnline` drives the «сервер не отвечает» banner.
 *
 * Plain factory with injected dependencies (unit-testable without a DOM); the app uses the
 * `appStore` / `useAppStore` singletons at the bottom.
 */
import { create } from 'zustand';
import type { GameListItem, HealthInfo, StudentProfile } from '@gambit/shared';
import { getHealth, getStudent, isApiError, listGames, updateStudent } from '../api/client.ts';
import type { RequestOptions, StudentUpdate } from '../api/client.ts';
import { getBrowserStorage, loadShellSettings, readJsonObject, saveShellSettings, writeJson } from './shellSettings.ts';
import type { KeyValueStorage } from './shellSettings.ts';

export const PROFILE_CACHE_KEY = 'gambit.profile.cache';
export const PENDING_STUDENT_KEY = 'gambit.student.pending';
export const RECENT_GAMES_LIMIT = 12;

export interface AppApi {
  getHealth(options?: RequestOptions): Promise<HealthInfo>;
  getStudent(options?: RequestOptions): Promise<StudentProfile>;
  updateStudent(update: StudentUpdate, options?: RequestOptions): Promise<StudentProfile>;
  listGames(limit?: number, options?: RequestOptions): Promise<GameListItem[]>;
}

export interface AppState {
  phase: 'loading' | 'ready';
  serverOnline: boolean;
  health: HealthInfo | null;
  /** never null once `phase === 'ready'` (a local stand-in is used when nothing else is known) */
  profile: StudentProfile | null;
  /** false = cached copy or local stand-in */
  profileFromServer: boolean;
  /** newest first */
  games: GameListItem[];
  /** onboarding was finished on this computer */
  onboarded: boolean;
  /** profile edits waiting for the server to come back */
  pendingStudentUpdate: StudentUpdate | null;
}

export const INITIAL_APP_STATE: AppState = {
  phase: 'loading',
  serverOnline: true,
  health: null,
  profile: null,
  profileFromServer: false,
  games: [],
  onboarded: false,
  pendingStudentUpdate: null,
};

export type SaveStudentResult =
  | { status: 'saved'; profile: StudentProfile }
  /** the server is away: the change is applied locally and will be sent later */
  | { status: 'deferred'; profile: StudentProfile }
  /** the server refused the values (validation) — nothing was changed */
  | { status: 'rejected' };

export interface AppStoreDeps {
  api: AppApi;
  storage: KeyValueStorage | null;
  now?: () => Date;
  /** no request of the shell may hang the start-up; default 5000 */
  requestTimeoutMs?: number;
}

export type AppStateStore = ReturnType<typeof createAppStateStore>;

export interface AppController {
  store: AppStateStore;
  /** First load. Safe to call more than once (the same promise is returned). */
  bootstrap(): Promise<void>;
  /** Re-reads health; when the server is (back) online also the profile, the games and the pending patch. */
  refresh(): Promise<void>;
  saveStudent(patch: StudentUpdate): Promise<SaveStudentResult>;
  completeOnboarding(): void;
}

export function createAppStateStore() {
  return create<AppState>()(() => ({ ...INITIAL_APP_STATE }));
}

/** Stand-in used only when the server is away and nothing was cached: an empty nickname triggers onboarding. */
export function localStandInProfile(now: Date): StudentProfile {
  return {
    nickname: '',
    address: 'm',
    stage: 1,
    totals: { games: 0, wins: 0, losses: 0, draws: 0, puzzlesAttempted: 0, puzzlesSolved: 0, minutesPlayed: 0 },
    puzzleRating: { rating: 600, rd: 300, vol: 0.06, attempts: 0, solved: 0, lastSeen: null },
    themeSkills: {},
    recentAccuracy: [],
    weaknesses: [],
    strengths: [],
    bestWin: null,
    updatedAt: now.toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Minimal shape check of a cached profile — enough for the shell's own reads. */
export function parseCachedProfile(raw: Record<string, unknown>): StudentProfile | null {
  if (typeof raw.nickname !== 'string' || (raw.address !== 'm' && raw.address !== 'f')) return null;
  if (typeof raw.stage !== 'number' || !isRecord(raw.totals) || !isRecord(raw.puzzleRating) || !isRecord(raw.themeSkills)) return null;
  if (!Array.isArray(raw.recentAccuracy) || !Array.isArray(raw.weaknesses) || !Array.isArray(raw.strengths)) return null;
  return raw as unknown as StudentProfile;
}

export function parsePendingUpdate(raw: Record<string, unknown>): StudentUpdate | null {
  const update: StudentUpdate = {};
  if (typeof raw.nickname === 'string' && raw.nickname.trim() !== '') update.nickname = raw.nickname;
  if (raw.address === 'm' || raw.address === 'f') update.address = raw.address;
  if (typeof raw.stage === 'number' && Number.isInteger(raw.stage) && raw.stage >= 1) update.stage = raw.stage;
  return Object.keys(update).length === 0 ? null : update;
}

/** A failure that says "the server is not there", as opposed to "the server said no". */
export function isServerUnreachable(error: unknown): boolean {
  if (!isApiError(error)) return true; // an unexpected throw: be conservative, keep the child's data
  // status 0 = fetch failed; 5xx = the Vite dev proxy (or the server itself) could not answer
  return error.status === 0 || error.status >= 500 || error.code === 'bad-json';
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

export function createAppController(deps: AppStoreDeps): AppController {
  const { api, storage } = deps;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.requestTimeoutMs ?? 5000;
  const store = createAppStateStore();
  let bootstrapPromise: Promise<void> | null = null;
  let refreshing: Promise<void> | null = null;

  const options = (): RequestOptions => ({ signal: timeoutSignal(timeoutMs) });

  function setProfileFromServer(profile: StudentProfile): void {
    writeJson(storage, PROFILE_CACHE_KEY, profile);
    store.setState({ profile, profileFromServer: true });
  }

  function setPending(update: StudentUpdate | null): void {
    writeJson(storage, PENDING_STUDENT_KEY, update ?? {});
    store.setState({ pendingStudentUpdate: update });
  }

  function applyLocally(profile: StudentProfile, patch: StudentUpdate): StudentProfile {
    return { ...profile, ...patch, updatedAt: now().toISOString() };
  }

  /** Sends the waiting profile edits; returns false when the server is still away. */
  async function flushPending(): Promise<boolean> {
    const pending = store.getState().pendingStudentUpdate;
    if (!pending) return true;
    try {
      setProfileFromServer(await api.updateStudent(pending, options()));
      setPending(null);
      return true;
    } catch (error) {
      if (isServerUnreachable(error)) return false;
      // the server will never accept this patch — drop it rather than retry forever
      console.warn('[shell] pending profile update was refused by the server', error);
      setPending(null);
      return true;
    }
  }

  async function loadAll(): Promise<void> {
    const [health, student, games] = await Promise.allSettled([api.getHealth(options()), api.getStudent(options()), api.listGames(RECENT_GAMES_LIMIT, options())]);

    const online = health.status === 'fulfilled';
    store.setState({ serverOnline: online, health: online ? health.value : store.getState().health });

    if (student.status === 'fulfilled') {
      setProfileFromServer(student.value);
    } else if (store.getState().profile === null) {
      const cached = parseCachedProfile(readJsonObject(storage, PROFILE_CACHE_KEY));
      store.setState({ profile: cached ?? localStandInProfile(now()), profileFromServer: false });
    }
    if (games.status === 'fulfilled') store.setState({ games: games.value });

    const pending = store.getState().pendingStudentUpdate;
    if (pending) {
      const flushed = online && (await flushPending());
      const profile = store.getState().profile;
      // still waiting: keep showing what the child typed, not the stale server copy
      if (!flushed && profile) store.setState({ profile: { ...profile, ...pending } });
    }
  }

  function bootstrap(): Promise<void> {
    bootstrapPromise ??= (async () => {
      store.setState({
        onboarded: loadShellSettings(storage).onboarded,
        pendingStudentUpdate: parsePendingUpdate(readJsonObject(storage, PENDING_STUDENT_KEY)),
      });
      try {
        await loadAll();
      } finally {
        if (store.getState().profile === null) store.setState({ profile: localStandInProfile(now()), profileFromServer: false });
        store.setState({ phase: 'ready' });
      }
    })();
    return bootstrapPromise;
  }

  function refresh(): Promise<void> {
    if (bootstrapPromise === null) return bootstrap();
    refreshing ??= (async () => {
      try {
        await bootstrapPromise;
        await loadAll();
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function saveStudent(patch: StudentUpdate): Promise<SaveStudentResult> {
    const before = store.getState().profile ?? localStandInProfile(now());
    const merged: StudentUpdate = { ...(store.getState().pendingStudentUpdate ?? {}), ...patch };
    try {
      const profile = await api.updateStudent(merged, options());
      setProfileFromServer(profile);
      setPending(null);
      store.setState({ serverOnline: true });
      return { status: 'saved', profile };
    } catch (error) {
      if (!isServerUnreachable(error)) return { status: 'rejected' };
      const profile = applyLocally(before, merged);
      setPending(merged);
      store.setState({ profile, profileFromServer: false, serverOnline: false });
      return { status: 'deferred', profile };
    }
  }

  function completeOnboarding(): void {
    saveShellSettings(storage, { onboarded: true });
    store.setState({ onboarded: true });
  }

  return { store, bootstrap, refresh, saveStudent, completeOnboarding };
}

// ───────────────────────── app singletons ─────────────────────────

/** Resolved on every access, so importing this module never touches localStorage (tests, SSR). */
const lazyBrowserStorage: KeyValueStorage = {
  getItem: (key) => getBrowserStorage()?.getItem(key) ?? null,
  setItem: (key, value) => getBrowserStorage()?.setItem(key, value),
};

export const appController: AppController = createAppController({
  api: { getHealth, getStudent, updateStudent, listGames },
  storage: lazyBrowserStorage,
});

export const useAppStore: AppStateStore = appController.store;

/**
 * Keeps `serverOnline` fresh: a quick re-check while the server is away, a lazy one while it is
 * there, plus a check whenever the window gets the focus back. Returns the stop function.
 */
export function startHealthPolling(controller: AppController = appController, intervals = { onlineMs: 60_000, offlineMs: 10_000 }): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    const delay = controller.store.getState().serverOnline ? intervals.onlineMs : intervals.offlineMs;
    timer = setTimeout(() => void tick(), delay);
  };
  const tick = async (): Promise<void> => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (stopped) return;
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') await controller.refresh();
    schedule();
  };
  const onFocus = (): void => void tick();

  schedule();
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
  }
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
    }
  };
}
