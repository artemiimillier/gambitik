import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.ts';
import type { StudentUpdate } from '../api/client.ts';
import { SETTINGS_STORAGE_KEY } from '../coach/settings.ts';
import { PENDING_STUDENT_KEY, PROFILE_CACHE_KEY, createAppController, isServerUnreachable, parseCachedProfile, parsePendingUpdate } from './appStore.ts';
import type { AppApi } from './appStore.ts';
import { createMemoryStorage, sampleGame, sampleHealth, sampleProfile } from './testUtils.ts';

const networkError = (): ApiError => new ApiError({ status: 0, code: 'network', method: 'GET', path: '/x' });
const proxyError = (): ApiError => new ApiError({ status: 500, code: 'http-500', method: 'GET', path: '/x' });
const validationError = (): ApiError => new ApiError({ status: 400, code: 'invalid-body', method: 'PUT', path: '/student' });

function onlineApi(overrides: Partial<AppApi> = {}): AppApi {
  let profile = sampleProfile();
  return {
    getHealth: vi.fn(async () => sampleHealth()),
    getStudent: vi.fn(async () => profile),
    updateStudent: vi.fn(async (update: StudentUpdate) => {
      profile = { ...profile, ...update };
      return profile;
    }),
    listGames: vi.fn(async () => [sampleGame({ id: 'g2' }), sampleGame({ id: 'g1' })]),
    ...overrides,
  };
}

function offlineApi(): AppApi {
  return {
    getHealth: vi.fn(async () => Promise.reject(networkError())),
    getStudent: vi.fn(async () => Promise.reject(networkError())),
    updateStudent: vi.fn(async () => Promise.reject(networkError())),
    listGames: vi.fn(async () => Promise.reject(networkError())),
  };
}

describe('app controller: bootstrap', () => {
  it('loads health, profile and games, caches the profile', async () => {
    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ onboarded: true, voice: 'browser' }) });
    const app = createAppController({ api: onlineApi(), storage });
    expect(app.store.getState().phase).toBe('loading');

    await app.bootstrap();
    const state = app.store.getState();
    expect(state).toMatchObject({ phase: 'ready', serverOnline: true, profileFromServer: true, onboarded: true, pendingStudentUpdate: null });
    expect(state.profile?.nickname).toBe('Тигр');
    expect(state.health?.puzzles.count).toBe(402);
    expect(state.games.map((game) => game.id)).toEqual(['g2', 'g1']);
    expect(JSON.parse(storage.data.get(PROFILE_CACHE_KEY) ?? '{}')).toMatchObject({ nickname: 'Тигр' });
  });

  it('is idempotent', async () => {
    const api = onlineApi();
    const app = createAppController({ api, storage: null });
    await Promise.all([app.bootstrap(), app.bootstrap()]);
    await app.bootstrap();
    expect(api.getHealth).toHaveBeenCalledTimes(1);
  });

  it('with the server down uses the cached profile and reports offline', async () => {
    const storage = createMemoryStorage({ [PROFILE_CACHE_KEY]: JSON.stringify(sampleProfile({ nickname: 'Лиса', address: 'f' })) });
    const app = createAppController({ api: offlineApi(), storage });
    await app.bootstrap();
    expect(app.store.getState()).toMatchObject({ phase: 'ready', serverOnline: false, profileFromServer: false, health: null, games: [] });
    expect(app.store.getState().profile).toMatchObject({ nickname: 'Лиса', address: 'f' });
  });

  it('with the server down and nothing cached falls back to an empty stand-in (→ onboarding) and still becomes ready', async () => {
    const app = createAppController({ api: offlineApi(), storage: createMemoryStorage({ [PROFILE_CACHE_KEY]: '{"nickname":5}' }) });
    await app.bootstrap();
    expect(app.store.getState().phase).toBe('ready');
    expect(app.store.getState().profile).toMatchObject({ nickname: '', stage: 1 });
  });

  it('treats a failing dev proxy (HTTP 500 on /health) as offline', async () => {
    const app = createAppController({ api: onlineApi({ getHealth: vi.fn(async () => Promise.reject(proxyError())) }), storage: null });
    await app.bootstrap();
    expect(app.store.getState().serverOnline).toBe(false);
    expect(app.store.getState().profile?.nickname).toBe('Тигр'); // what did answer is still used
  });

  it('becomes ready even if a request throws something unexpected', async () => {
    const api = onlineApi({
      listGames: vi.fn(async () => {
        throw new TypeError('boom');
      }),
    });
    const app = createAppController({ api, storage: null });
    await app.bootstrap();
    expect(app.store.getState()).toMatchObject({ phase: 'ready', games: [] });
  });
});

describe('app controller: saving the student', () => {
  it('saves through the server and updates the cache', async () => {
    const storage = createMemoryStorage();
    const api = onlineApi();
    const app = createAppController({ api, storage });
    await app.bootstrap();

    const result = await app.saveStudent({ nickname: 'Лев', address: 'f' });
    expect(result.status).toBe('saved');
    expect(api.updateStudent).toHaveBeenCalledWith({ nickname: 'Лев', address: 'f' }, expect.anything());
    expect(app.store.getState().profile).toMatchObject({ nickname: 'Лев', address: 'f' });
    expect(JSON.parse(storage.data.get(PROFILE_CACHE_KEY) ?? '{}')).toMatchObject({ nickname: 'Лев' });
    expect(app.store.getState().pendingStudentUpdate).toBeNull();
  });

  it('defers the change while the server is away and sends it when the server is back', async () => {
    const storage = createMemoryStorage();
    const api = onlineApi();
    const app = createAppController({ api, storage, now: () => new Date('2026-09-21T12:00:00Z') });
    await app.bootstrap();

    vi.mocked(api.updateStudent).mockRejectedValueOnce(networkError());
    const first = await app.saveStudent({ nickname: 'Лев' });
    expect(first.status).toBe('deferred');
    expect(app.store.getState()).toMatchObject({ serverOnline: false, profileFromServer: false, pendingStudentUpdate: { nickname: 'Лев' } });
    expect(app.store.getState().profile?.nickname).toBe('Лев');
    expect(JSON.parse(storage.data.get(PENDING_STUDENT_KEY) ?? '{}')).toEqual({ nickname: 'Лев' });

    // a second offline edit is merged into the same pending patch
    vi.mocked(api.updateStudent).mockRejectedValueOnce(proxyError());
    await app.saveStudent({ address: 'f' });
    expect(app.store.getState().pendingStudentUpdate).toEqual({ nickname: 'Лев', address: 'f' });

    await app.refresh();
    expect(api.updateStudent).toHaveBeenLastCalledWith({ nickname: 'Лев', address: 'f' }, expect.anything());
    expect(app.store.getState()).toMatchObject({ serverOnline: true, profileFromServer: true, pendingStudentUpdate: null });
    expect(app.store.getState().profile).toMatchObject({ nickname: 'Лев', address: 'f' });
    expect(JSON.parse(storage.data.get(PENDING_STUDENT_KEY) ?? '{}')).toEqual({});
  });

  it('restores a pending change after a restart and keeps showing it while the server is still away', async () => {
    const storage = createMemoryStorage({
      [PROFILE_CACHE_KEY]: JSON.stringify(sampleProfile({ nickname: 'Старое' })),
      [PENDING_STUDENT_KEY]: JSON.stringify({ nickname: 'Новое' }),
    });
    const app = createAppController({ api: offlineApi(), storage });
    await app.bootstrap();
    expect(app.store.getState().pendingStudentUpdate).toEqual({ nickname: 'Новое' });
    expect(app.store.getState().profile?.nickname).toBe('Новое');
  });

  it('flushes a restored pending change on a start with the server up', async () => {
    const storage = createMemoryStorage({ [PENDING_STUDENT_KEY]: JSON.stringify({ nickname: 'Новое' }) });
    const api = onlineApi();
    const app = createAppController({ api, storage });
    await app.bootstrap();
    expect(api.updateStudent).toHaveBeenCalledWith({ nickname: 'Новое' }, expect.anything());
    expect(app.store.getState().profile?.nickname).toBe('Новое');
    expect(app.store.getState().pendingStudentUpdate).toBeNull();
  });

  it('reports a validation refusal without changing anything', async () => {
    const api = onlineApi();
    const app = createAppController({ api, storage: null });
    await app.bootstrap();
    vi.mocked(api.updateStudent).mockRejectedValueOnce(validationError());
    expect(await app.saveStudent({ nickname: '<x>' })).toEqual({ status: 'rejected' });
    expect(app.store.getState().profile?.nickname).toBe('Тигр');
    expect(app.store.getState().pendingStudentUpdate).toBeNull();
  });

  it('drops a pending patch the server will never accept instead of retrying forever', async () => {
    const storage = createMemoryStorage({ [PENDING_STUDENT_KEY]: JSON.stringify({ nickname: '<x>' }) });
    const api = onlineApi({ updateStudent: vi.fn(async () => Promise.reject(validationError())) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createAppController({ api, storage });
    await app.bootstrap();
    expect(app.store.getState().pendingStudentUpdate).toBeNull();
    expect(app.store.getState().profile?.nickname).toBe('Тигр');
    expect(warn).toHaveBeenCalled();
  });
});

describe('app controller: refresh and onboarding flag', () => {
  it('notices the server going away and coming back', async () => {
    const api = onlineApi();
    const app = createAppController({ api, storage: null });
    await app.bootstrap();

    vi.mocked(api.getHealth).mockRejectedValueOnce(networkError());
    vi.mocked(api.getStudent).mockRejectedValueOnce(networkError());
    vi.mocked(api.listGames).mockRejectedValueOnce(networkError());
    await app.refresh();
    expect(app.store.getState().serverOnline).toBe(false);
    expect(app.store.getState().profile?.nickname).toBe('Тигр'); // last known data stays
    expect(app.store.getState().health).not.toBeNull();
    expect(app.store.getState().games).toHaveLength(2);

    await app.refresh();
    expect(app.store.getState().serverOnline).toBe(true);
  });

  it('coalesces overlapping refreshes', async () => {
    const api = onlineApi();
    const app = createAppController({ api, storage: null });
    await app.bootstrap();
    await Promise.all([app.refresh(), app.refresh(), app.refresh()]);
    expect(api.getHealth).toHaveBeenCalledTimes(2); // bootstrap + one refresh
  });

  it('persists the onboarded flag next to the settings of other modules', () => {
    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voice: 'off', muted: true }) });
    const app = createAppController({ api: onlineApi(), storage });
    app.completeOnboarding();
    expect(app.store.getState().onboarded).toBe(true);
    expect(JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) ?? '{}')).toEqual({ voice: 'off', muted: true, onboarded: true });
  });
});

describe('helpers', () => {
  it('tells "server is away" from "server said no"', () => {
    expect(isServerUnreachable(networkError())).toBe(true);
    expect(isServerUnreachable(proxyError())).toBe(true);
    expect(isServerUnreachable(new ApiError({ status: 200, code: 'bad-json', method: 'GET', path: '/x' }))).toBe(true);
    expect(isServerUnreachable(new TypeError('x'))).toBe(true);
    expect(isServerUnreachable(validationError())).toBe(false);
    expect(isServerUnreachable(new ApiError({ status: 403, code: 'forbidden-origin', method: 'PUT', path: '/student' }))).toBe(false);
  });

  it('validates cached data defensively', () => {
    expect(parseCachedProfile(JSON.parse(JSON.stringify(sampleProfile())) as Record<string, unknown>)).toMatchObject({ nickname: 'Тигр' });
    expect(parseCachedProfile({})).toBeNull();
    expect(parseCachedProfile({ ...sampleProfile(), address: 'x' })).toBeNull();
    expect(parsePendingUpdate({ nickname: 'Лев', address: 'f', stage: 3, extra: 1 })).toEqual({ nickname: 'Лев', address: 'f', stage: 3 });
    expect(parsePendingUpdate({ nickname: '  ', address: 'q', stage: 0.5 })).toBeNull();
    expect(parsePendingUpdate({})).toBeNull();
  });
});
