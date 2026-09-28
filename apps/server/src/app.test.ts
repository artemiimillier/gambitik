import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CurriculumStage, GameListItem, GameRecord, GameReview, HealthInfo, ProgressSnapshot, Puzzle, StudentProfile, ThemeSkill } from '@gambit/shared';
import { PARENT_NOTES_END, PARENT_NOTES_START } from './storage/files.ts';
import { MAX_GAME_EVENTS } from './schemas.ts';
import { createEnvTestServer, createTestServer, sampleGameRecord, sampleTeacherGameRecord } from './testing/fixtures.ts';
import type { TestServer } from './testing/fixtures.ts';

const servers: TestServer[] = [];

async function start(...args: Parameters<typeof createTestServer>): Promise<TestServer> {
  const server = await createTestServer(...args);
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.cleanup();
});

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
}

describe('GET /api/health', () => {
  it('reports the zero-API baseline truthfully', async () => {
    const server = await start();
    const res = await server.request('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const health = (await res.json()) as HealthInfo;
    expect(health).toEqual({
      ok: true,
      llm: { codexCli: false, codexLoggedIn: false, openaiKey: false, openrouterKey: false },
      // runtime AI off by default (GAMBIT_RUNTIME_AI, docs/TEACHING.md §4.4): the recorded voice
      voice: { realtime: false, model: 'gpt-realtime-2.1', voice: 'marin', live: false, liveModel: 'gpt-live-1', preferred: 'clips' },
      puzzles: { count: 25 },
      // (routes/health.test.ts covers these three)
      dataDirIsTemp: true,
      build: expect.objectContaining({ startedAt: expect.any(String), distBuiltAt: null }),
      activity: { idleSeconds: null },
      ai: { runtime: false },
      // «Дозапись голоса» off by default, no overlay under vitest (voiceGen/clips.test.ts covers the rest)
      clipGen: { state: 'off', overlay: false },
    });
  });

  it('reports the keys as booleans, the live voice and the preferred layer', async () => {
    const server = await start({ runtimeAi: true, openaiApiKey: 'sk-test-secret-value', openrouterApiKey: 'sk-or-v1-test-secret-value', voicePreferred: 'realtime', voiceLiveModel: 'gpt-live-2' });
    const text = await (await server.request('/api/health')).text();
    expect(text).not.toContain('secret-value');
    const health = JSON.parse(text) as HealthInfo;
    expect(health.llm).toMatchObject({ openaiKey: true, openrouterKey: true });
    expect(health.voice).toMatchObject({ realtime: true, live: true, liveModel: 'gpt-live-2', preferred: 'realtime' });
    expect(health.ai).toEqual({ runtime: true });
  });

  it('runtime AI off: the keys are still reported (the parent sees one is there), but no voice is promised', async () => {
    const server = await start({ openaiApiKey: 'sk-test-secret-value', openrouterApiKey: 'sk-or-v1-test-secret-value', voicePreferred: 'live' });
    const health = (await (await server.request('/api/health')).json()) as HealthInfo;
    expect(health.llm).toMatchObject({ openaiKey: true, openrouterKey: true, codexCli: false, codexLoggedIn: false });
    expect(health.voice).toMatchObject({ realtime: false, live: false, preferred: 'clips' });
    expect(health.ai).toEqual({ runtime: false });
  });

  it('never exposes the API key', async () => {
    const server = await start({ openaiApiKey: 'sk-test-secret-value' });
    const res = await server.request('/api/health');
    const text = await res.text();
    expect(text).not.toContain('sk-test-secret-value');
    expect((JSON.parse(text) as HealthInfo).llm.openaiKey).toBe(true);
  });
});

describe('security', () => {
  it('sends a strict Content-Security-Policy that still allows the engine and the OpenAI voice', async () => {
    const server = await start();
    const csp = (await server.request('/api/health')).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("connect-src 'self' https://api.openai.com wss://api.openai.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // no inline / eval-able scripts, no wildcard sources
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(csp).not.toContain('*');
  });

  it('rejects unknown Host headers (DNS rebinding)', async () => {
    const server = await start();
    const res = await server.request('/api/health', { headers: { host: 'evil.example:8787' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden-host' });
  });

  it('accepts the production and the dev hosts', async () => {
    const server = await start();
    for (const host of ['127.0.0.1:8787', 'localhost:8787', 'localhost:5173', '127.0.0.1:5173']) {
      const res = await server.request('/api/health', { headers: { host } });
      expect(res.status, host).toBe(200);
    }
  });

  it('rejects state-changing requests from a foreign Origin', async () => {
    const server = await start();
    const res = await server.request('/api/student', { method: 'PUT', json: { nickname: 'Хакер' }, headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden-origin' });
    const profile = (await (await server.request('/api/student')).json()) as StudentProfile;
    expect(profile.nickname).not.toBe('Хакер');
  });

  it('rejects cross-site requests that carry no Origin but say so in Sec-Fetch-Site', async () => {
    const server = await start();
    const res = await server.app.request('/api/voice/session', { method: 'POST', headers: { host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site' } });
    expect(res.status).toBe(403);
  });

  it('production does not trust the Vite dev port (any other project may be served on :5173)', async () => {
    const server = await start({ production: true });
    for (const host of ['localhost:5173', '127.0.0.1:5173']) {
      expect((await server.request('/api/health', { headers: { host } })).status, host).toBe(403);
    }
    const viaVite = await server.request('/api/student', { method: 'PUT', json: { address: 'f' }, headers: { origin: 'http://localhost:5173' } });
    expect(viaVite.status).toBe(403);
    expect(await viaVite.json()).toEqual({ error: 'forbidden-origin' });
    expect((await server.request('/api/health')).status).toBe(200);
    expect((await server.request('/api/student', { method: 'PUT', json: { address: 'f' } })).status).toBe(200);
  });

  it('refuses "simple" (non-JSON) state-changing requests, body-less ones included', async () => {
    const server = await start({ openaiApiKey: 'sk-test-secret-value' });
    const before = (await (await server.request('/api/student')).json()) as StudentProfile;
    const plain = await server.request('/api/student', { method: 'PUT', body: '{"address":"f"}', headers: { 'content-type': 'text/plain' } });
    expect(plain.status).toBe(415);
    expect(await plain.json()).toEqual({ error: 'unsupported-media-type' });
    const form = await server.request('/api/student', { method: 'PUT', body: 'address=f', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(form.status).toBe(415);
    // the handler that would mint a paid voice session is never reached (the test fetch rejects every network call)
    const bodiless = await server.request('/api/voice/session', { method: 'POST' });
    expect(bodiless.status).toBe(415);
    expect(((await (await server.request('/api/student')).json()) as StudentProfile).updatedAt).toBe(before.updatedAt);
    // a charset parameter is fine
    const ok = await server.request('/api/student', { method: 'PUT', body: '{"address":"f"}', headers: { 'content-type': 'application/json; charset=utf-8' } });
    expect(ok.status).toBe(200);
  });

  it('accepts the Vite dev origin and non-browser clients without an Origin', async () => {
    const server = await start();
    const viaVite = await server.request('/api/student', { method: 'PUT', json: { address: 'f' }, headers: { origin: 'http://localhost:5173' } });
    expect(viaVite.status).toBe(200);
    const curl = await server.app.request('/api/student', { method: 'PUT', headers: { host: '127.0.0.1:8787', 'content-type': 'application/json' }, body: '{"address":"m"}' });
    expect(curl.status).toBe(200);
  });

  it('answers unknown API routes with a JSON 404', async () => {
    const server = await start();
    const res = await server.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not-found' });
  });
});

describe('behind a TLS proxy (GAMBIT_PUBLIC_HOSTS, deploy/docker-ssh)', () => {
  const PUBLIC = 'gambitik.example.test';
  const env = { NODE_ENV: 'production', GAMBIT_BIND_HOST: '0.0.0.0', GAMBIT_PUBLIC_HOSTS: PUBLIC };

  async function startPublic(extra: NodeJS.ProcessEnv = {}): Promise<TestServer> {
    const server = await createEnvTestServer({ ...env, ...extra });
    servers.push(server);
    return server;
  }

  it('answers the public name, and a browser on https://<name> may change state (Origin or fetch metadata)', async () => {
    const server = await startPublic();
    const get = await server.request('/api/health', { headers: { host: PUBLIC } });
    expect(get.status).toBe(200);
    expect(((await get.json()) as HealthInfo).ok).toBe(true);
    const put = await server.request('/api/student', { method: 'PUT', json: { address: 'f' }, headers: { host: PUBLIC, origin: `https://${PUBLIC}`, 'sec-fetch-site': 'same-origin' } });
    expect(put.status).toBe(200);
    const noOrigin = await server.app.request('/api/student', {
      method: 'PUT',
      headers: { host: PUBLIC, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: '{"address":"m"}',
    });
    expect(noOrigin.status).toBe(200);
    // the beacon of a closing page proves its origin with the https one
    const beacon = await server.app.request('/api/voice/usage', {
      method: 'POST',
      headers: { host: PUBLIC, origin: `https://${PUBLIC}`, 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ provider: 'openai-live', seconds: 5 }),
    });
    expect(beacon.status).toBe(200);
    // the container's own health check (docker exec … 127.0.0.1:8787) keeps working
    expect((await server.request('/api/health')).status).toBe(200);
  });

  it('still refuses a foreign Host, a foreign or look-alike Origin, plain http and a cross-site request', async () => {
    const server = await startPublic();
    for (const host of ['evil.example', `${PUBLIC}.evil.example`, `${PUBLIC}:8443`, 'localhost:5173', 'GAMBITIK.example.test.']) {
      expect((await server.request('/api/health', { headers: { host } })).status, host).toBe(403);
    }
    for (const origin of ['https://evil.example', `https://${PUBLIC}.evil.example`, `http://${PUBLIC}`, 'null']) {
      const res = await server.request('/api/student', { method: 'PUT', json: { nickname: 'Хакер' }, headers: { host: PUBLIC, origin } });
      expect(res.status, origin).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden-origin' });
    }
    const crossSite = await server.app.request('/api/student', {
      method: 'PUT',
      headers: { host: PUBLIC, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: '{"nickname":"Хакер"}',
    });
    expect(crossSite.status).toBe(403);
    const profile = (await (await server.request('/api/student', { headers: { host: PUBLIC } })).json()) as StudentProfile;
    expect(profile.nickname).not.toBe('Хакер');
  });

  it('GAMBIT_PUBLIC_HTTP=1 also trusts http://<name>; an invalid GAMBIT_PUBLIC_HOSTS opens nothing', async () => {
    const http = await startPublic({ GAMBIT_PUBLIC_HTTP: '1' });
    expect((await http.request('/api/student', { method: 'PUT', json: { address: 'f' }, headers: { host: PUBLIC, origin: `http://${PUBLIC}` } })).status).toBe(200);
    const invalid = await startPublic({ GAMBIT_PUBLIC_HOSTS: 'https://gambitik.example.test, Gambitik.example.test' });
    expect(invalid.ctx.config.publicHosts).toEqual([]);
    expect(invalid.ctx.config.networkWarnings).toHaveLength(2);
    expect((await invalid.request('/api/health', { headers: { host: PUBLIC } })).status).toBe(403);
    expect((await invalid.request('/api/health')).status).toBe(200);
  });
});

describe('student', () => {
  it('creates a default profile and updates nickname / address / stage', async () => {
    const server = await start();
    const initial = (await (await server.request('/api/student')).json()) as StudentProfile;
    expect(initial.stage).toBe(1);
    expect(initial.puzzleRating.rating).toBe(600);
    expect(initial.totals.games).toBe(0);

    const res = await server.request('/api/student', { method: 'PUT', json: { nickname: '  Миша  ', address: 'm', stage: 3 } });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as StudentProfile;
    expect(updated.nickname).toBe('Миша');
    expect(updated.stage).toBe(3);

    const again = (await (await server.request('/api/student')).json()) as StudentProfile;
    expect(again.nickname).toBe('Миша');

    const profileMd = readFileSync(join(server.dataDir, 'student', 'profile.md'), 'utf8');
    expect(profileMd).toContain('# Профиль ученика: Миша');
    expect(profileMd).toContain('Ступень 3');
  });

  it('validates the body', async () => {
    const server = await start();
    for (const body of [{ address: 'x' }, { stage: 0 }, { nickname: '' }, { nickname: '<script>' }]) {
      const res = await server.request('/api/student', { method: 'PUT', json: body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid-body');
    }
    const notJson = await server.request('/api/student', { method: 'PUT', body: 'nickname=x', headers: { 'content-type': 'application/json' } });
    expect(notJson.status).toBe(400);
  });

  it('clamps a manual stage to the curriculum', async () => {
    const server = await start();
    const res = await server.request('/api/student', { method: 'PUT', json: { stage: 40 } });
    const profile = (await res.json()) as StudentProfile;
    expect(profile.stage).toBe(server.ctx.content.curriculum.length);
  });
});

describe('games', () => {
  it('saves a game → files → list → get → template review → regenerated journal', async () => {
    const server = await start();
    await server.request('/api/student', { method: 'PUT', json: { nickname: 'Миша' } });
    const record = sampleGameRecord();

    const saved = await server.request('/api/games', { method: 'POST', json: record });
    expect(saved.status).toBe(201);
    expect(await saved.json()).toEqual({ id: record.id });

    // files exist and are well-formed
    const files = walk(join(server.dataDir, 'games'));
    const pgnPath = files.find((f) => f.endsWith('.pgn'));
    const mdPath = files.find((f) => f.endsWith('.md'));
    expect(pgnPath).toMatch(/games\/2026\/09\/2026-09-2\d_\d{4}_vs-petya\.pgn$/);
    expect(mdPath).toBe(pgnPath?.replace(/\.pgn$/, '.md'));
    const pgn = readFileSync(pgnPath ?? '', 'utf8');
    expect(pgn).toContain('[White "Миша"]');
    expect(pgn).toContain('[Black "Петя (бот)"]');
    expect(pgn).toContain('[Result "1-0"]');
    expect(pgn).toContain('4. Qxf7#');
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);

    // list
    const list = (await (await server.request('/api/games?limit=10')).json()) as GameListItem[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: record.id, personaId: 'petya', timeControlId: 'rapid10', childColor: 'w', result: '1-0', accuracy: 81.4, blunders: 1 });

    // get
    const got = (await (await server.request(`/api/games/${record.id}`)).json()) as GameRecord;
    expect(got).toEqual(record);

    // review: no LLM is available → the template review
    await server.ctx.idle();
    const review = (await (await server.request(`/api/games/${record.id}/review`)).json()) as GameReview;
    expect(review.status).toBe('template');
    expect(review.provider).toBe('template');
    expect(review.gameId).toBe(record.id);
    expect(review.markdown.length).toBeGreaterThan(40);
    const listAfter = (await (await server.request('/api/games')).json()) as GameListItem[];
    expect(listAfter[0]?.reviewStatus).toBe('template');

    // the journal was regenerated with the review inside
    const journal = readFileSync(mdPath ?? '', 'utf8');
    expect(journal).toContain('schema: game-journal/1');
    expect(journal).toContain('# Партия с ботом Петя');
    expect(journal).toContain('| Результат | **победа** (1-0), мат |');
    expect(journal).toContain('| Точность | **81%** |');
    expect(journal).toContain('| Контроль времени | 10 минут |');
    expect(journal).toContain('**Фh5?!**');
    expect(journal).toContain('**Ф:f7#!**'.replace(':', 'x'));
    expect(journal).toContain('~~Фxe5+??~~');
    expect(journal).toContain('Тренер предложил вернуть ход');
    expect(journal).toContain('«Верну ход и подумаю»');
    expect(journal).toContain('Подсказка уровня 1 (вопрос-подсказка)');
    expect(journal).toContain('Миша: «Слон может пойти на це четыре!»');
    expect(journal).toContain('Позиция перед ходом (FEN): `r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 2 3`');
    expect(journal).toContain('Источник разбора: шаблон тренера');
    expect(journal).not.toContain('Разбор готовится');
    expect(journal).toContain(PARENT_NOTES_START);

    // student files
    const profileMd = readFileSync(join(server.dataDir, 'student', 'profile.md'), 'utf8');
    expect(profileMd).toContain('## Последние 10 партий');
    expect(profileMd).toContain('| Петя | 10 минут | белые | победа (1-0) | 81% | 1 |');
    expect(profileMd).toContain('## Заметки тренера');
    const progress = JSON.parse(readFileSync(join(server.dataDir, 'student', 'progress.json'), 'utf8')) as { schema: string; games: { total: number } };
    expect(progress.schema).toBe('progress/1');
    expect(progress.games.total).toBe(1);

    const profile = (await (await server.request('/api/student')).json()) as StudentProfile;
    expect(profile.totals).toMatchObject({ games: 1, wins: 1, losses: 0, draws: 0 });
    expect(profile.bestWin).toBe('petya');
    expect(profile.recentAccuracy).toEqual([81.4]);
  });

  it('teacher mode: a game with coachStyle and the advice round-trips and its journal shows the teacher lines (docs/TEACHER-MODE.md §7.5)', async () => {
    const server = await start();
    const record = { ...sampleTeacherGameRecord(), id: 'teacher-1' };
    expect((await server.request('/api/games', { method: 'POST', json: record })).status).toBe(201);
    const got = (await (await server.request(`/api/games/${record.id}`)).json()) as GameRecord;
    expect(got.coachStyle).toBe('teacher');
    expect(got.events.find((e) => e.type === 'move' && e.ply === 1)?.data).toMatchObject({ advice: ['e4', 'd4'], followed: 'primary' });
    await server.ctx.idle();
    const md = readFileSync(walk(join(server.dataDir, 'games')).find((f) => f.endsWith('.md')) ?? '', 'utf8');
    expect(md).toContain('coach_style: teacher');
    expect(md).toContain('| Советы учителя | по совету: 3 из 4 ходов');
    // the concept card of the new topic is named by the real content bundle
    expect(md).toMatch(/Тренер \(совет учителя, план дебюта, новая тема «[^»]+»\): советует e4 \(зел\.\), d4 \(син\.\)/);
    // a style outside the contract is refused
    const bad = await server.request('/api/games', { method: 'POST', json: { ...record, id: 'teacher-2', coachStyle: 'robot' } });
    expect(bad.status).toBe(400);
  });

  it('is idempotent by game id', async () => {
    const server = await start();
    const record = sampleGameRecord();
    expect((await server.request('/api/games', { method: 'POST', json: record })).status).toBe(201);
    const again = await server.request('/api/games', { method: 'POST', json: record });
    expect(again.status).toBe(200);
    const profile = (await (await server.request('/api/student')).json()) as StudentProfile;
    expect(profile.totals.games).toBe(1);
    expect(walk(join(server.dataDir, 'games')).filter((f) => f.endsWith('.pgn'))).toHaveLength(1);
  });

  it('gives two games started in the same minute different files', async () => {
    const server = await start();
    await server.request('/api/games', { method: 'POST', json: sampleGameRecord({ id: 'a1' }) });
    await server.request('/api/games', { method: 'POST', json: sampleGameRecord({ id: 'a2' }) });
    const pgns = walk(join(server.dataDir, 'games')).filter((f) => f.endsWith('.pgn'));
    expect(pgns).toHaveLength(2);
    expect(pgns.some((f) => f.endsWith('_vs-petya_2.pgn'))).toBe(true);
  });

  it('keeps a game the engine never judged out of the progress chart and marks it in the list', async () => {
    const server = await start({ autoReview: false });
    await server.request('/api/games', { method: 'POST', json: sampleGameRecord({ id: 'judged' }) });
    const unjudged = sampleGameRecord({ id: 'unjudged', startedAt: '2026-09-20T10:00:00.000Z', endedAt: '2026-09-20T10:05:00.000Z', judgements: [] });
    unjudged.summary = { ...unjudged.summary, accuracy: 0, keyMoments: [] };
    expect((await server.request('/api/games', { method: 'POST', json: unjudged })).status).toBe(201);

    const list = (await (await server.request('/api/games')).json()) as (GameListItem & { judgedMoves?: number })[];
    expect(list.find((g) => g.id === 'unjudged')?.judgedMoves).toBe(0);
    expect(list.find((g) => g.id === 'judged')?.judgedMoves).toBeGreaterThan(0);

    const progress = (await (await server.request('/api/progress')).json()) as ProgressSnapshot;
    expect(progress.games.map((g) => g.gameId)).toEqual(['judged']);
    // the false «0 %» never reaches the profile either
    expect(progress.profile.recentAccuracy).toHaveLength(1);
  });

  it('keeps the parent notes of a journal when the review arrives', async () => {
    const server = await start({ autoReview: false });
    const record = sampleGameRecord();
    await server.request('/api/games', { method: 'POST', json: record });
    const mdPath = walk(join(server.dataDir, 'games')).find((f) => f.endsWith('.md')) ?? '';
    const before = readFileSync(mdPath, 'utf8');
    expect(before).toContain('Разбор готовится');
    const note = '\n## Заметки родителя\n\nПосле школы был уставший, но доиграл.\n';
    const notesFrom = before.indexOf(PARENT_NOTES_START) + PARENT_NOTES_START.length;
    writeFileSync(mdPath, `${before.slice(0, notesFrom)}${note}${before.slice(before.indexOf(PARENT_NOTES_END))}`);

    server.ctx.reviews.enqueue(record.id);
    await server.ctx.idle();
    const after = readFileSync(mdPath, 'utf8');
    expect(after).toContain('После школы был уставший, но доиграл.');
    expect(after).not.toContain('Разбор готовится');
  });

  it('rejects malformed and oversized bodies', async () => {
    const server = await start();
    const broken = { ...sampleGameRecord(), personaId: 'kasparov' };
    const res = await server.request('/api/games', { method: 'POST', json: broken });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe('invalid-body');
    expect(body.issues[0]?.path).toBe('personaId');

    const badId = await server.request('/api/games', { method: 'POST', json: sampleGameRecord({ id: '../../etc/passwd' }) });
    expect(badId.status).toBe(400);

    const huge = await server.request('/api/games', { method: 'POST', json: { ...sampleGameRecord(), pgn: 'x'.repeat(2 * 1024 * 1024 + 10) } });
    expect(huge.status).toBe(413);

    const list = (await (await server.request('/api/games')).json()) as GameListItem[];
    expect(list).toEqual([]);
  });

  it('accepts a large but legitimate record (well under 1 MB)', async () => {
    const server = await start({ autoReview: false });
    const base = sampleGameRecord();
    // as many events as a new game may carry (3000; real games have at most 140)
    const events = Array.from({ length: MAX_GAME_EVENTS }, (_, i) => ({ t: i * 100, type: 'coachSaid' as const, data: { text: `Реплика номер ${i} — думаем, считаем, проверяем.` } }));
    const res = await server.request('/api/games', { method: 'POST', json: { ...base, id: 'big', events } });
    expect(res.status).toBe(201);
  });

  it('answers 404 for unknown games and reviews', async () => {
    const server = await start();
    expect((await server.request('/api/games/nope')).status).toBe(404);
    expect((await server.request('/api/games/nope/review')).status).toBe(404);
    expect((await server.request('/api/games/..%2F..%2Fx')).status).toBe(404);
  });
});

describe('progress', () => {
  it('returns a snapshot with stage, games and the theme table', async () => {
    const server = await start({ autoReview: false });
    await server.request('/api/games', { method: 'POST', json: sampleGameRecord() });
    const puzzles = (await (await server.request('/api/puzzles/next?count=1')).json()) as Puzzle[];
    const puzzle = puzzles[0];
    expect(puzzle).toBeDefined();
    await server.request('/api/puzzles/attempt', {
      method: 'POST',
      json: { puzzleId: puzzle?.id, solved: true, msSpent: 8000, hintsUsed: 0, themes: puzzle?.themes, puzzleRating: puzzle?.rating },
    });

    const snapshot = (await (await server.request('/api/progress')).json()) as ProgressSnapshot;
    expect(snapshot.profile.totals.games).toBe(1);
    expect(snapshot.games).toHaveLength(1);
    expect(snapshot.games[0]).toMatchObject({ gameId: 'game-0001', accuracy: 81.4, blunders: 1, personaId: 'petya', result: '1-0' });
    expect(snapshot.stage.stage).toBe(1);
    expect(snapshot.nextStage?.stage).toBe(2);
    expect(snapshot.puzzleRatingHistory).toHaveLength(1);
    const mate = snapshot.themeTable.find((row) => row.theme === 'mateIn1');
    expect(mate).toMatchObject({ attempts: 1, solved: 1 });
    expect(mate?.title).not.toBe('');
    // service tags never get their own scale
    expect(snapshot.themeTable.some((row) => row.theme === 'oneMove')).toBe(false);
  });
});

describe('puzzles', () => {
  it('serves playable puzzles adapted to the rating and updates the rating on attempts', async () => {
    const server = await start();
    const res = await server.request('/api/puzzles/next?theme=mateIn1&count=3');
    expect(res.status).toBe(200);
    const puzzles = (await res.json()) as Puzzle[];
    expect(puzzles).toHaveLength(3);
    for (const p of puzzles) {
      expect(p.themes).toContain('mateIn1');
      expect(p.solutionUci.length).toBeGreaterThan(0);
      expect(p.lastMoveUci).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
      // a new child (600 ± 300) is aimed at the easy end of the scale: 400 ± 150
      expect(p.rating).toBeLessThanOrEqual(550);
    }

    const first = puzzles[0];
    const win = await server.request('/api/puzzles/attempt', {
      method: 'POST',
      json: { puzzleId: first?.id, solved: true, msSpent: 5000, hintsUsed: 0, themes: first?.themes, puzzleRating: first?.rating },
    });
    expect(win.status).toBe(200);
    const afterWin = ((await win.json()) as { puzzleRating: ThemeSkill }).puzzleRating;
    expect(afterWin.rating).toBeGreaterThan(600);
    expect(afterWin.rd).toBeLessThan(300);
    expect(afterWin).toMatchObject({ attempts: 1, solved: 1 });

    const second = puzzles[1];
    const loss = await server.request('/api/puzzles/attempt', {
      method: 'POST',
      json: { puzzleId: second?.id, solved: false, msSpent: 9000, hintsUsed: 2, themes: second?.themes, puzzleRating: second?.rating },
    });
    const afterLoss = ((await loss.json()) as { puzzleRating: ThemeSkill }).puzzleRating;
    expect(afterLoss.rating).toBeLessThan(afterWin.rating);
    expect(afterLoss).toMatchObject({ attempts: 2, solved: 1 });

    // a repeated attempt on a seen puzzle is counted but not rated
    const repeat = await server.request('/api/puzzles/attempt', {
      method: 'POST',
      json: { puzzleId: first?.id, solved: true, msSpent: 1000, hintsUsed: 0, themes: first?.themes, puzzleRating: first?.rating },
    });
    const afterRepeat = ((await repeat.json()) as { puzzleRating: ThemeSkill }).puzzleRating;
    expect(afterRepeat.rating).toBe(afterLoss.rating);
    expect(afterRepeat.attempts).toBe(3);

    const profile = (await (await server.request('/api/student')).json()) as StudentProfile;
    expect(profile.totals).toMatchObject({ puzzlesAttempted: 3, puzzlesSolved: 2 });
    expect(profile.themeSkills.mateIn1?.attempts).toBe(3);

    // recently attempted puzzles are not served again while fresh ones exist
    const next = (await (await server.request('/api/puzzles/next?count=10')).json()) as Puzzle[];
    expect(next).toHaveLength(10);
    expect(next.map((p) => p.id)).not.toContain(first?.id);
    expect(next.map((p) => p.id)).not.toContain(second?.id);

    await server.ctx.idle();
    expect(readFileSync(join(server.dataDir, 'student', 'profile.md'), 'utf8')).toContain('`mateIn1`');
  });

  it('prefers data/build/puzzles.sqlite, converting raw Lichess rows', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const server0 = await start();
    const dbDir = join(server0.dataDir, 'build');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, 'puzzles.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE puzzle (id TEXT PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL, rating INTEGER NOT NULL, popularity INTEGER, nb_plays INTEGER, themes TEXT NOT NULL);
      CREATE TABLE puzzle_theme (theme TEXT NOT NULL, rating INTEGER NOT NULL, puzzle_id TEXT NOT NULL, PRIMARY KEY (theme, rating, puzzle_id)) WITHOUT ROWID;
      INSERT INTO puzzle VALUES ('00008', 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24', 'f2g3 e6e7 b2b1 b3c1 b1c1 h6c1', 1797, 95, 10183, 'crushing hangingPiece long middlegame');
      INSERT INTO puzzle_theme VALUES ('hangingPiece', 1797, '00008');
    `);
    db.close();

    const server = await start({ dataDir: server0.dataDir, puzzlesDbPath: dbPath });
    const health = (await (await server.request('/api/health')).json()) as HealthInfo;
    expect(health.puzzles.count).toBe(1);
    const puzzles = (await (await server.request('/api/puzzles/next?theme=hangingPiece&count=2')).json()) as Puzzle[];
    expect(puzzles).toEqual([
      {
        id: '00008',
        // the opponent's first move (f2g3) is already applied: White (the child) to move
        fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2b1/PqP3PP/7K w - - 0 25',
        lastMoveUci: 'f2g3',
        solutionUci: ['e6e7', 'b2b1', 'b3c1', 'b1c1', 'h6c1'],
        rating: 1797,
        themes: ['crushing', 'hangingPiece', 'long', 'middlegame'],
      },
    ]);
  });

  it('validates queries and bodies', async () => {
    const server = await start();
    expect((await server.request('/api/puzzles/next?count=0')).status).toBe(400);
    expect((await server.request('/api/puzzles/next?theme=drop%20table')).status).toBe(400);
    expect((await server.request('/api/puzzles/attempt', { method: 'POST', json: { puzzleId: 'x' } })).status).toBe(400);
  });
});

describe('curriculum and knowledge base', () => {
  it('returns the stages and the current one', async () => {
    const server = await start();
    await server.request('/api/student', { method: 'PUT', json: { stage: 2 } });
    const body = (await (await server.request('/api/curriculum')).json()) as { stages: CurriculumStage[]; current: number };
    expect(body.current).toBe(2);
    expect(body.stages.length).toBeGreaterThanOrEqual(5);
    expect(body.stages.map((s) => s.stage)).toEqual(body.stages.map((_, i) => i + 1));
  });

  it('returns a concept card by id and 404 otherwise', async () => {
    const server = await start();
    const id = server.ctx.content.conceptCards[0]?.id ?? '';
    const res = await server.request(`/api/kb/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(id);
    expect((await server.request('/api/kb/no-such-card')).status).toBe(404);
  });
});

describe('voice and coach', () => {
  it('answers 503 no-api-key without a key and never calls out', async () => {
    const server = await start();
    const res = await server.request('/api/voice/session', { method: 'POST', json: {} });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'no-api-key' });
  });

  it('an automated test run never gets a voice session, even when a key is configured', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      calls.push(String(input));
      return Promise.reject(new Error('must not be called'));
    };
    const server = await start({ runtimeAi: true, openaiApiKey: 'sk-test-secret-value' }, { fetchImpl });
    const res = await server.request('/api/voice/session', { method: 'POST', json: {}, headers: { 'x-gambit-automation': '1' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'no-api-key' });
    expect(calls).toEqual([]);
  });

  it('falls back to the original text when no LLM is available', async () => {
    const server = await start();
    const event = { id: 'e1', kind: 'praise', priority: 0, text: 'Отличный ход, ты проверил все угрозы!', bubbleText: 'Отличный ход!', pose: 'cheer', pauseClock: false };
    const res = await server.request('/api/coach/rephrase', { method: 'POST', json: { event } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: event.text, provider: 'template' });
    expect((await server.request('/api/coach/rephrase', { method: 'POST', json: { event: { text: 'x' } } })).status).toBe(400);
  });
});

describe('runtime AI is off unless GAMBIT_RUNTIME_AI says so (docs/TEACHING.md §4.4)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
  });

  /** A fake codex that only leaves a trace: every spawn (`login status`, `features list`, `exec`) appends its arguments. */
  function fakeCodex(): { bin: string; spawns: () => string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'gambit-fake-codex-'));
    dirs.push(dir);
    const bin = join(dir, 'codex');
    const trace = join(dir, 'spawns.txt');
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${trace}"\nif [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; fi\nexit 0\n`);
    chmodSync(bin, 0o755);
    return { bin, spawns: () => (existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter((line) => line !== '') : []) };
  }

  /** An .env copied from an older .env.example: the paid defaults, both keys, codex installed. */
  const ownersEnv = (codexBin: string): NodeJS.ProcessEnv => ({
    LLM_PROVIDER: 'auto',
    VOICE_PREFERRED: 'live',
    OPENAI_API_KEY: 'x',
    OPENROUTER_API_KEY: 'sk-or-v1-test-secret-value',
    CODEX_BIN: codexBin,
  });

  function recordingFetch(): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      fetchImpl: (input) => {
        calls.push(String(input));
        return Promise.reject(new Error('must not be called'));
      },
    };
  }

  it('no flag: a template-only gateway, POST /voice/live 503, health.ai.runtime false — and codex is never spawned', async () => {
    const codex = fakeCodex();
    const { fetchImpl, calls } = recordingFetch();
    const server = await createEnvTestServer(ownersEnv(codex.bin), { fetchImpl });
    servers.push(server);
    // the flag wins over LLM_PROVIDER / VOICE_PREFERRED / CODEX_BIN; the keys stay known
    expect(server.ctx.config).toMatchObject({ runtimeAi: false, llmProvider: 'template', voicePreferred: 'clips', codexBin: null, openaiApiKey: 'x' });
    expect(server.ctx.gateway.providerIds()).toEqual(['template']);
    expect(server.ctx.gateway.hasLlm(['codex', 'openrouter', 'openai-api'], 'interactive')).toBe(false);

    const live = await server.request('/api/voice/live', { method: 'POST', json: { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } });
    expect(live.status).toBe(503);
    expect(await live.json()).toEqual({ error: 'no-api-key' });
    expect((await server.request('/api/voice/session', { method: 'POST', json: {} })).status).toBe(503);

    const health = (await (await server.request('/api/health')).json()) as HealthInfo;
    expect(health.ai).toEqual({ runtime: false });
    expect(health.voice).toMatchObject({ realtime: false, live: false, preferred: 'clips' });
    expect(health.llm).toEqual({ codexCli: false, codexLoggedIn: false, openaiKey: true, openrouterKey: true });

    // the strategy, a re-phrase and the review of a saved game: all from the template
    const strategy = (await (await server.request('/api/coach/strategy', { method: 'POST', json: { childColor: 'w', stage: 1, personaId: 'petya', timeControlId: 'rapid10' } })).json()) as { provider: string };
    expect(strategy.provider).toBe('template');
    const event = { id: 'e1', kind: 'praise', priority: 0, text: 'Ты проверил все угрозы.', bubbleText: 'Ты проверил все угрозы.', pose: 'cheer', pauseClock: false };
    expect(await (await server.request('/api/coach/rephrase', { method: 'POST', json: { event } })).json()).toEqual({ text: event.text, provider: 'template' });
    await server.request('/api/games', { method: 'POST', json: sampleGameRecord() });
    await server.ctx.idle();
    expect(((await (await server.request('/api/games/game-0001/review')).json()) as GameReview).provider).toBe('template');

    expect(calls).toEqual([]);
    expect(codex.spawns()).toEqual([]);
  });

  it('an override cannot switch a model back on without the flag either', async () => {
    const codex = fakeCodex();
    const server = await start({ codexBin: codex.bin, llmProvider: 'codex', voicePreferred: 'live', openaiApiKey: 'x' });
    expect(server.ctx.config).toMatchObject({ runtimeAi: false, llmProvider: 'template', voicePreferred: 'clips', codexBin: null });
    expect(server.ctx.gateway.providerIds()).toEqual(['template']);
    await server.request('/api/health');
    expect(codex.spawns()).toEqual([]);
  });

  it('GAMBIT_RUNTIME_AI=1: the same environment may use them again', async () => {
    const codex = fakeCodex();
    const { fetchImpl, calls } = recordingFetch();
    const server = await createEnvTestServer({ ...ownersEnv(codex.bin), GAMBIT_RUNTIME_AI: '1' }, { fetchImpl });
    servers.push(server);
    expect(server.ctx.config).toMatchObject({ runtimeAi: true, llmProvider: 'auto', voicePreferred: 'live', codexBin: codex.bin });
    expect(server.ctx.gateway.providerIds()).toEqual(['codex', 'openrouter', 'openai-api', 'template']);
    const health = (await (await server.request('/api/health')).json()) as HealthInfo;
    expect(health.ai).toEqual({ runtime: true });
    expect(health.voice).toMatchObject({ realtime: true, live: true, preferred: 'live' });
    expect(health.llm).toMatchObject({ codexCli: true, codexLoggedIn: true });
    expect(codex.spawns()).toEqual(['login status']);
    // the paid route is really tried (the fake fetch refuses it: 502, never a real call)
    expect((await server.request('/api/voice/session', { method: 'POST', json: {} })).status).toBe(502);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('static SPA (production)', () => {
  it('serves apps/web/dist with an index.html fallback, but never for /api', async () => {
    const server0 = await start();
    const dist = join(server0.dataDir, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Гамбитик</title>');
    writeFileSync(join(dist, 'app.js'), 'console.log("ok");');
    const server = await start({ webDistDir: dist });

    const asset = await server.request('/app.js');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('console.log');
    const deepLink = await server.request('/review/123');
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toContain('Гамбитик');
    expect((await server.request('/api/nope')).status).toBe(404);
    expect((await server.request('/', { headers: { host: 'evil.example' } })).status).toBe(403);
  });

  it('serves the same files under a public name behind a proxy: relative, no redirect to a loopback URL', async () => {
    const server0 = await start();
    const dist = join(server0.dataDir, 'dist');
    mkdirSync(join(dist, 'engine'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Гамбитик</title><script type="module" src="/assets/app.js"></script>');
    writeFileSync(join(dist, 'engine', 'stockfish.js'), '// engine');
    const server = await start({ production: true, publicHosts: ['gambitik.example.test'], webDistDir: dist });
    const host = { host: 'gambitik.example.test' };
    for (const path of ['/', '/engine/stockfish.js', '/review/123', '/engine']) {
      const res = await server.request(path, { headers: host });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('location'), path).toBeNull();
      expect(await res.text(), path).not.toMatch(/127\.0\.0\.1|localhost/);
    }
  });

  it('serves nothing but the API when dist is missing', async () => {
    const server = await start();
    expect((await server.request('/')).status).toBe(404);
  });
});
