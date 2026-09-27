/**
 * «Дозапись голоса» over HTTP: refusals first (automation, off — nothing is read, queued or run), strict ids-only
 * bodies, the parent's settings, the overlay files (strict paths, no way out of the folder, size caps) served whether
 * or not recording is on, and the health codes. The only Higgsfield here is a fake runner.
 */
import { chmodSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClipGenRequestResult, ClipGenStatus, HealthInfo } from '@gambit/shared';
import type { ClipGenConfig } from '../config.ts';
import { createEnvTestServer, createTestServer } from '../testing/fixtures.ts';
import type { TestServer } from '../testing/fixtures.ts';
import { VOICE_KEY } from '../voiceGen/bridge.ts';
import { FakeHiggsfield, fakeFinish, tempDir, writeLibrary } from '../voiceGen/testkit.ts';
import type { ClipGenOverrides } from '../voiceGen/service.ts';
import { CLIP_REQUESTS_PER_MINUTE } from './clips.ts';

const cleanups: (() => void)[] = [];
const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.cleanup();
  while (cleanups.length > 0) cleanups.pop()?.();
});

const BODY = { sentences: [{ parts: [{ pool: 'v3.whole.castle', n: 16 }] }], kind: 'teachTurn' };

/** A server with recording enabled and pinned to its own DATA_DIR, on a fake Higgsfield account. */
async function recorder(o: { clipGen?: Partial<ClipGenConfig>; overrides?: ClipGenOverrides; parentOn?: boolean } = {}): Promise<{ server: TestServer; hf: FakeHiggsfield; overlayDir: string }> {
  const dataDir = tempDir('gambit-clips-data-', cleanups);
  const overlayDir = tempDir('gambit-clips-overlay-', cleanups);
  const hf = new FakeHiggsfield();
  const server = await createTestServer(
    {
      dataDir,
      clipGen: { enabled: true, budgetMilli: 20_000, dailyMaxMilli: 10_000, dataDirPin: dataDir, bin: null, overlayDir, overlayProblem: null, ...o.clipGen },
    },
    {
      clipGen: { runCli: hf.runCli, protocol: hf.protocol(), finish: fakeFinish(overlayDir).finish, toolsProblem: async () => null, tempRoots: [], staticLibraryDir: null, toolsLedgerFile: null, timers: false, sleep: async () => undefined, ...o.overrides },
    },
  );
  servers.push(server);
  server.ctx.clipGen.setSettings({ enabled: o.parentOn !== false, dailyCapMilli: 10_000 });
  return { server, hf, overlayDir };
}

describe('POST /api/voice/clips/request', () => {
  it('an automation-driven browser is refused before anything else — the runner is never called', async () => {
    const { server, hf } = await recorder();
    const res = await server.request('/api/voice/clips/request', { method: 'POST', json: BODY, headers: { 'x-gambit-automation': '1' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'automation' });
    // not even a malformed body gets further
    expect((await server.request('/api/voice/clips/request', { method: 'POST', json: { text: 'Привет' }, headers: { 'x-gambit-automation': '1' } })).status).toBe(503);
    await server.ctx.clipGen.runQueue();
    expect(hf.calls).toEqual([]);
    expect(hf.creates).toEqual([]);
    expect(server.ctx.clipGen.queueLength()).toBe(0);
  });

  it("the flag off: 503 clip-gen-off; the status still answers and health says off (the parent's switch itself is on by default)", async () => {
    const server = await createTestServer();
    servers.push(server);
    const res = await server.request('/api/voice/clips/request', { method: 'POST', json: BODY });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'clip-gen-off' });
    const status = (await (await server.request('/api/voice/clips/status')).json()) as ClipGenStatus;
    expect(status).toMatchObject({ health: { state: 'off', overlay: false }, enabled: true, queue: 0, busy: false, overlay: null, spent: { todayMilli: 0, totalMilli: 0, prefetchMilli: 0 }, givenUp: 0 });
    expect(((await (await server.request('/api/health')).json()) as HealthInfo).clipGen).toEqual({ state: 'off', overlay: false });
  });

  it('a test server never gets a real Higgsfield binary, whatever the config says', async () => {
    const server = await createTestServer({ clipGen: { enabled: true, budgetMilli: 1_000, dailyMaxMilli: 1_000, dataDirPin: null, bin: '/usr/bin/true', overlayDir: null, overlayProblem: null } });
    servers.push(server);
    expect(server.ctx.config.clipGen.bin).toBeNull();
  });

  it('records ids; a text, a name or any extra field is a 400', async () => {
    const { server, hf } = await recorder();
    const res = await server.request('/api/voice/clips/request', { method: 'POST', json: BODY });
    expect(res.status).toBe(202);
    const result = (await res.json()) as ClipGenRequestResult;
    expect(result).toMatchObject({ results: [{ outcome: 'queued', keys: ['line:v3.whole.castle#16'] }], health: { state: 'ready', overlay: true } });
    await server.ctx.clipGen.runQueue();
    expect(hf.creates.map((j) => j.prompt)).toEqual(['Время для рокировки!']);
    for (const bad of [
      { sentences: [{ parts: [{ pool: 'v3.whole.castle', n: 16, text: 'Привет, Маша!' }] }] },
      { sentences: [{ parts: [{ pool: 'v3.whole.castle', n: 16 }] }], text: 'x' },
      { sentences: [] },
      { sentences: [{ text: 'Скажи это' }] },
    ]) {
      const r = await server.request('/api/voice/clips/request', { method: 'POST', json: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(hf.creates).toHaveLength(1);
  });

  it('records a whole catalogue sentence by ids (a greeting); its text or any extra field is a 400; a refused id is «invalid»', async () => {
    const { server, hf } = await recorder();
    const res = await server.request('/api/voice/clips/request', { method: 'POST', json: { sentences: [{ line: { id: 'greet.hello.day', n: 1 } }, { line: { id: 'generic.greeting', n: 1 } }], kind: 'greeting' } });
    expect(res.status).toBe(202);
    expect(((await res.json()) as ClipGenRequestResult).results).toEqual([
      { outcome: 'queued', keys: ['line:greet.hello.day#1'] },
      { outcome: 'invalid', keys: [] },
    ]);
    await server.ctx.clipGen.runQueue();
    expect(hf.creates.map((j) => j.prompt)).toEqual(['Добрый день!']);
    for (const bad of [{ sentences: [{ line: { id: 'greet.hello.day', n: 1, text: 'Привет, Маша!' } }] }, { sentences: [{ line: { id: 'greet.hello.day', n: 2 }, text: 'x' }] }]) {
      const r = await server.request('/api/voice/clips/request', { method: 'POST', json: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(hf.creates).toHaveLength(1);
  });

  it(`at most ${CLIP_REQUESTS_PER_MINUTE} requests a minute`, async () => {
    const { server } = await recorder({ parentOn: false });
    for (let i = 0; i < CLIP_REQUESTS_PER_MINUTE; i++) expect((await server.request('/api/voice/clips/request', { method: 'POST', json: BODY })).status).toBe(202);
    const res = await server.request('/api/voice/clips/request', { method: 'POST', json: BODY });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'clip-gen-rate' });
  });
});

describe('PUT /api/voice/clips/settings', () => {
  it("stores the parent's switch and cap (never above CLIP_GEN_DAILY_MAX); automation stores nothing", async () => {
    const { server } = await recorder({ parentOn: false, clipGen: { dailyMaxMilli: 6_000 } });
    const auto = await server.request('/api/voice/clips/settings', { method: 'PUT', json: { enabled: true, dailyCapMilli: 3_000 }, headers: { 'x-gambit-automation': '1' } });
    expect(auto.status).toBe(200);
    expect(((await auto.json()) as ClipGenStatus).enabled).toBe(false);
    expect(server.ctx.clipGen.settings()).toEqual({ enabled: false, dailyCapMilli: 6_000 });
    const tooHigh = await server.request('/api/voice/clips/settings', { method: 'PUT', json: { enabled: true, dailyCapMilli: 10_000 } });
    expect(tooHigh.status).toBe(400);
    expect((await server.request('/api/voice/clips/settings', { method: 'PUT', json: { enabled: true, dailyCapMilli: 3_000, budget: 99 } })).status).toBe(400);
    const ok = await server.request('/api/voice/clips/settings', { method: 'PUT', json: { enabled: true, dailyCapMilli: 3_000 } });
    const status = (await ok.json()) as ClipGenStatus;
    expect(status).toMatchObject({ enabled: true, health: { state: 'ready' }, caps: { dailyMilli: 3_000, dailyMaxMilli: 6_000, totalMilli: 20_000 } });
    expect(server.ctx.clipGen.settings()).toEqual({ enabled: true, dailyCapMilli: 3_000 });
  });
});

describe('GET /api/voice/clips/overlay/*', () => {
  function mp3(dir: string, id: string, bytes = 600): void {
    mkdirSync(join(dir, VOICE_KEY, id.slice(1, 3)), { recursive: true });
    writeFileSync(join(dir, VOICE_KEY, id.slice(1, 3), `${id}.mp3`), Buffer.alloc(bytes, 0xff));
  }

  it('serves the index, the manifest and a take — with recording off too', async () => {
    const overlayDir = tempDir('gambit-clips-overlay-', cleanups);
    writeLibrary(overlayDir, [{ id: 'c0123456789abc', key: 'line:v3.whole.castle#16', text: 'Время для рокировки!' }]);
    mp3(overlayDir, 'c0123456789abc');
    const server = await createTestServer({ clipGen: { enabled: false, budgetMilli: 0, dailyMaxMilli: 3_000, dataDirPin: null, bin: null, overlayDir, overlayProblem: null } });
    servers.push(server);
    const index = await server.request('/api/voice/clips/overlay/index.json');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('application/json');
    expect(index.headers.get('cache-control')).toBe('no-store');
    const rel = ((await index.json()) as { voices: Record<string, string> }).voices[VOICE_KEY] as string;
    const manifest = await server.request(`/api/voice/clips/overlay/${rel}`);
    expect(manifest.status).toBe(200);
    // content-addressed: kept by the browser (the index never is)
    expect(manifest.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(((await manifest.json()) as { units: Record<string, unknown> }).units).toHaveProperty('c0123456789abc');
    const take = await server.request('/api/voice/clips/overlay/giselle-mm1/01/c0123456789abc.mp3');
    expect(take.status).toBe(200);
    expect(take.headers.get('content-type')).toBe('audio/mpeg');
    expect(take.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect((await take.arrayBuffer()).byteLength).toBe(600);
    expect(((await (await server.request('/api/health')).json()) as HealthInfo).clipGen).toEqual({ state: 'off', overlay: true });
  });

  it('nothing outside the three shapes, nothing outside the folder, nothing too big: a JSON 404', async () => {
    const root = tempDir('gambit-clips-root-', cleanups);
    const overlayDir = join(root, 'overlay');
    mkdirSync(overlayDir);
    writeFileSync(join(root, 'secret.json'), '{"key":"sk-secret"}');
    writeLibrary(overlayDir, []);
    mp3(overlayDir, 'c0123456789abc');
    mp3(overlayDir, 'cffffffffffff0', 3 * 1024 * 1024);
    writeFileSync(join(overlayDir, 'ledger.giselle-mm1.jsonl'), '{"ev":"created"}\n');
    writeFileSync(join(overlayDir, 'state.json'), '{}');
    // a symlinked take pointing out of the folder
    mkdirSync(join(overlayDir, VOICE_KEY, 'ab'), { recursive: true });
    symlinkSync(join(root, 'secret.json'), join(overlayDir, VOICE_KEY, 'ab', 'cab00000000000.mp3'));
    // a folder named like a take
    mkdirSync(join(overlayDir, VOICE_KEY, 'cd', 'ccd00000000000.mp3'), { recursive: true });
    const server = await createTestServer({ clipGen: { enabled: false, budgetMilli: 0, dailyMaxMilli: 3_000, dataDirPin: null, bin: null, overlayDir, overlayProblem: null } });
    servers.push(server);
    for (const path of [
      '../secret.json',
      '%2e%2e/secret.json',
      '..%2fsecret.json',
      'giselle-mm1/../../secret.json',
      'ledger.giselle-mm1.jsonl',
      'state.json',
      'giselle-mm1/02/c0123456789abc.mp3', // the folder must be the id's own
      'giselle-mm1/01/C0123456789ABC.mp3',
      'giselle-mm1/01/c0123456789abc.mp3.part',
      'giselle-mm1/ff/cffffffffffff0.mp3', // over 2 MB
      'giselle-mm1/ab/cab00000000000.mp3', // a symlink out of the folder
      'giselle-mm1/cd/ccd00000000000.mp3', // a directory
      'giselle-mm1/manifest.json',
      'giselle-mm1/manifest.zzzzzz.json',
      '.masters/job1.mp3',
      '',
      'index.json/',
    ]) {
      const res = await server.request(`/api/voice/clips/overlay/${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('sk-secret');
    }
    const res = await server.request('/api/voice/clips/overlay/giselle-mm1/01/c0123456789abc.mp3');
    expect(res.status).toBe(200);
  });

  it('a read-only overlay (the container mounts /overlay:ro, recording off) is served and never written to', async () => {
    const overlayDir = tempDir('gambit-clips-ro-', cleanups);
    writeLibrary(overlayDir, [{ id: 'c0123456789abc', key: 'line:v3.whole.castle#16', text: 'Время для рокировки!' }]);
    mp3(overlayDir, 'c0123456789abc');
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [join(dir, e.name), ...walk(join(dir, e.name))] : [join(dir, e.name)]));
    const snapshot = () => walk(overlayDir).map((path) => `${path}:${statSync(path).mtimeMs}:${statSync(path).size}`).sort();
    const setMode = (dirMode: number, fileMode: number) => {
      for (const path of [overlayDir, ...walk(overlayDir)]) chmodSync(path, statSync(path).isDirectory() ? dirMode : fileMode);
    };
    setMode(0o555, 0o444);
    // runs before the temp folder is removed (cleanups run last-in, first-out)
    cleanups.push(() => setMode(0o755, 0o644));
    const before = snapshot();
    // configured from the environment exactly as the image does (Dockerfile ENV)
    const server = await createEnvTestServer({ NODE_ENV: 'production', GAMBIT_CLIP_GEN: '0', HIGGSFIELD_BIN: 'off', VOICE_OVERLAY_DIR: overlayDir, GAMBIT_RUNTIME_AI: '0' });
    servers.push(server);
    expect(server.ctx.config.clipGen).toMatchObject({ enabled: false, bin: null, overlayDir, overlayProblem: null });
    expect((await server.request('/api/voice/clips/overlay/index.json')).status).toBe(200);
    expect((await server.request('/api/voice/clips/overlay/giselle-mm1/01/c0123456789abc.mp3')).status).toBe(200);
    expect((await server.request('/api/voice/clips/request', { method: 'POST', json: BODY })).status).toBe(503);
    expect((await server.request('/api/voice/clips/settings', { method: 'PUT', json: { enabled: true, dailyCapMilli: 1_000 } })).status).toBe(200);
    expect((await server.request('/api/voice/clips/status')).status).toBe(200);
    expect(((await (await server.request('/api/health')).json()) as HealthInfo).clipGen).toEqual({ state: 'off', overlay: true });
    server.ctx.clipGen.start();
    await server.ctx.clipGen.runQueue();
    expect(snapshot()).toEqual(before);
  });

  it('no overlay (off, or refused inside the checkout): 404', async () => {
    const off = await createTestServer();
    servers.push(off);
    expect((await off.request('/api/voice/clips/overlay/index.json')).status).toBe(404);
    const inside = await createTestServer({ clipGen: { enabled: false, budgetMilli: 0, dailyMaxMilli: 3_000, dataDirPin: null, bin: null, overlayDir: join(off.ctx.config.repoRoot, 'apps', 'web', 'public', 'voice'), overlayProblem: null } });
    servers.push(inside);
    // the static library is a real folder with an index.json: the overlay must refuse it all the same
    expect((await inside.request('/api/voice/clips/overlay/index.json')).status).toBe(404);
  });
});

describe('GET /api/health → clipGen', () => {
  it('codes only: the reason, a time, whether the overlay is there — never a path', async () => {
    const { server, overlayDir } = await recorder({ parentOn: false });
    const text = await (await server.request('/api/health')).text();
    expect(JSON.parse(text).clipGen).toEqual({ state: 'paused', reason: 'parent-off', until: null, overlay: true });
    expect(text).not.toContain(overlayDir);
    const pinned = await recorder({ clipGen: { dataDirPin: null } });
    expect(((await (await pinned.server.request('/api/health')).json()) as HealthInfo).clipGen).toMatchObject({ state: 'paused', reason: 'data-dir' });
  });
});
