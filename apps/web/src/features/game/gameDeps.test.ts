/** The browser wiring must never let POST /games hang the result card. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameRecord } from '@gambit/shared';

vi.mock('../../engine/index.ts', () => ({
  createJudgeEngine: () => ({ dispose: () => undefined }),
  createBotEngine: () => ({ dispose: () => undefined }),
}));
vi.mock('../../coach/index.ts', () => ({ coach: {} }));
vi.mock('../../ui/index.ts', () => ({ celebrate: () => Promise.resolve(), playSound: () => undefined }));

const saveGame = vi.fn();
vi.mock('../../api/client.ts', () => ({
  getStudent: () => Promise.reject(new Error('not used')),
  saveGame: (...args: unknown[]) => saveGame(...args) as unknown,
}));

afterEach(() => {
  saveGame.mockReset();
});

describe('createBrowserGameDeps().saveGame', () => {
  it('bounds POST /games with AbortSignal.timeout(SAVE_GAME_TIMEOUT_MS) and surfaces the timeout as a rejection', async () => {
    const { createBrowserGameDeps, SAVE_GAME_TIMEOUT_MS } = await import('./gameDeps.ts');
    expect(SAVE_GAME_TIMEOUT_MS).toBe(8000);

    // AbortSignal.timeout is native (fake timers do not drive it): hand out a controllable signal instead
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    saveGame.mockImplementation((_record: GameRecord, options?: { signal?: AbortSignal }) => {
      // a server that accepted the connection and never answers
      return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason as Error)));
    });

    const deps = createBrowserGameDeps();
    const outcome = deps.saveGame({ id: 'g1' } as GameRecord).then(
      () => 'saved',
      (error: unknown) => (error instanceof Error ? error.name : 'unknown'),
    );
    expect(timeout).toHaveBeenCalledWith(SAVE_GAME_TIMEOUT_MS);
    expect(saveGame.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });

    controller.abort(new DOMException('timed out', 'TimeoutError'));
    expect(await outcome).toBe('TimeoutError');
    timeout.mockRestore();
  });
});

describe('offlineProfile', () => {
  const storageOf = (entries: Record<string, unknown>) => {
    const data = new Map(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]));
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) };
  };
  const profile = { nickname: 'Тигр', address: 'm', stage: 2 };

  it('prefers the shell cache and lays the pending offline edit over it', async () => {
    const { offlineProfile, STUDENT_CACHE_KEY } = await import('./gameDeps.ts');
    const storage = storageOf({
      [STUDENT_CACHE_KEY]: { ...profile, nickname: 'Старое имя' },
      'gambit.profile.cache': profile,
      'gambit.student.pending': { nickname: 'Львица', address: 'f', stage: 99 },
    });
    expect(offlineProfile(storage)).toMatchObject({ nickname: 'Львица', address: 'f', stage: 2 });
  });

  it('falls back to the game cache, and to null when nothing usable is stored', async () => {
    const { offlineProfile, STUDENT_CACHE_KEY } = await import('./gameDeps.ts');
    expect(offlineProfile(storageOf({ [STUDENT_CACHE_KEY]: profile, 'gambit.profile.cache': 'junk' }))).toMatchObject({ nickname: 'Тигр' });
    expect(offlineProfile(storageOf({}))).toBeNull();
    expect(offlineProfile(null)).toBeNull();
  });
});

describe('createBrowserGameDeps() and the conversational coach', () => {
  it('leaves the long-silence nudge to the coach controller (it hears the child itself) — never two nudges', async () => {
    const { createBrowserGameDeps } = await import('./gameDeps.ts');
    expect(createBrowserGameDeps().timings?.silenceNudgeMs).toBe(0);
  });
});
