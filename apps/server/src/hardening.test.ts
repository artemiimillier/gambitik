/**
 * Robustness rather than features: secret masking, marker injection, a corrupt database, the config side,
 * file modes, a locked puzzle database, loud content fallbacks, the size of a new game.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Puzzle } from '@gambit/shared';
import { allowedHosts, allowedOrigins, isSafeModelId, listenLine, loadConfig, parseBindHost, parsePublicHosts } from './config.ts';
import { contentWarningLines, loadContent } from './content.ts';
import { describeUpstreamError, maskSecrets, upstreamErrorInfo } from './sanitize.ts';
import { PUZZLE_DB_RETRY_AFTER_MS, MemoryPuzzleSource, ResilientPuzzleSource, builtinPuzzles } from './services/puzzles.ts';
import type { CandidateQuery, PuzzleSource } from './services/puzzles.ts';
import { StudentService } from './services/student.ts';
import { fallbackCurriculum } from './content.ts';
import { MIGRATIONS, isCorruptDbError, kvGet, kvSet, migrate, openAppDb, openDb } from './storage/db.ts';
import { PARENT_NOTES_END, PARENT_NOTES_START, atomicWriteFile, extractParentNotes, neutraliseMarkers, parentNotesBlock } from './storage/files.ts';
import { mdInline } from './storage/notation.ts';
import { Repo } from './storage/repo.ts';
import { MAX_GAME_EVENTS, MAX_GAME_PGN_CHARS, MAX_GAME_PLIES, gameRecordSchema, newGameRecordSchema, pgnPlyCount } from './schemas.ts';
import { GAME_BODY_LIMIT } from './routes/validation.ts';
import { createTestServer, sampleGameRecord } from './testing/fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'gambit-hardening-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(root, entry.name)) : [join(root, entry.name)]));
}

const mode = (path: string): number => statSync(path).mode & 0o777;

describe('secrets never reach a log line', () => {
  it('masks full, partly starred and ephemeral keys plus bearer tokens', () => {
    const line = 'Incorrect API key provided: sk-test-********************abcd / sk-or-v1-0123456789abcdef / ek_68af0123456789 / Authorization: Bearer abcdefghijklmnop';
    const masked = maskSecrets(line);
    expect(masked).toBe('Incorrect API key provided: sk-*** / sk-*** / ek_*** / Authorization: Bearer ***');
    expect(maskSecrets('my-odd-secret-value is here', ['my-odd-secret-value'])).toBe('*** is here');
    expect(maskSecrets('nothing to hide: task-list, risk-free')).toBe('nothing to hide: task-list, risk-free');
  });

  it('describes an upstream error by identifiers only', () => {
    const info = upstreamErrorInfo(402, { error: { code: 402, message: 'secret text sk-abc', metadata: { error_type: 'payment_required', limit_source: 'openrouter_credits', reason: '<b>free text</b>' } } });
    expect(describeUpstreamError('OpenRouter', info)).toBe('OpenRouter answered 402 (code=402, error_type=payment_required, limit_source=openrouter_credits)');
    expect(describeUpstreamError('OpenAI', upstreamErrorInfo(500, 'not json'))).toBe('OpenAI answered 500');
  });

  it('the context logger masks whatever a caller passes in', async () => {
    const logs: string[] = [];
    const server = await createTestServer({ openaiApiKey: 'sk-live-key-1234567890', openrouterApiKey: 'custom-router-key-42' }, { log: (m) => logs.push(m) });
    try {
      server.ctx.log('upstream said sk-live-key-1234567890 and custom-router-key-42');
      expect(logs.at(-1)).toBe('upstream said *** and ***');
    } finally {
      await server.cleanup();
    }
  });
});

describe('parent-notes marker injection', () => {
  it('takes the LAST block, so a marker in the body cannot swallow the file', () => {
    const notes = '\nМои заметки\n';
    const file = ['# Журнал', `- 00:41 — Миша: «${PARENT_NOTES_START}»`, 'ещё строки журнала', '## Разбор', `${PARENT_NOTES_START}${notes}${PARENT_NOTES_END}`, ''].join('\n');
    expect(extractParentNotes(file)).toBe(notes);
    expect(extractParentNotes(`${PARENT_NOTES_END} перевёрнуто ${PARENT_NOTES_START}`)).toBeNull();
    expect(extractParentNotes('нет блока')).toBeNull();
    // the parent's text itself can never contain a marker when written back
    expect(parentNotesBlock(`a${PARENT_NOTES_START}b${PARENT_NOTES_END}c`)).toBe(`${PARENT_NOTES_START}abc${PARENT_NOTES_END}`);
  });

  it('neutralises HTML comments in generated text', () => {
    expect(mdInline(`до ${PARENT_NOTES_START} после | x`)).toBe('до &lt;!-- parent-notes:start --&gt; после \\| x');
    expect(neutraliseMarkers('## Разбор\n<!-- review:end -->')).toBe('## Разбор\n&lt;!-- review:end --&gt;');
  });

  it('rejects SAN / FEN strings that could carry markup', () => {
    const base = sampleGameRecord();
    const first = base.judgements[0];
    const moment = base.summary.keyMoments[0];
    if (first === undefined || moment === undefined) throw new Error('fixture changed');
    expect(gameRecordSchema.safeParse(base).success).toBe(true);
    expect(gameRecordSchema.safeParse({ ...base, judgements: [{ ...first, san: '<!--x-->' }] }).success).toBe(false);
    expect(gameRecordSchema.safeParse({ ...base, judgements: [{ ...first, bestSan: 'a`|b' }] }).success).toBe(false);
    expect(gameRecordSchema.safeParse({ ...base, summary: { ...base.summary, keyMoments: [{ ...moment, fenBefore: `${moment.fenBefore}\`<!--` }] } }).success).toBe(false);
    expect(gameRecordSchema.safeParse({ ...base, summary: { ...base.summary, keyMoments: [{ ...moment, bestSan: '' }] } }).success).toBe(true);
  });

  it('end to end: injected markers in speech, explanations and the LLM review leave the journal and profile.md intact', async () => {
    const hostileReview = {
      markdown: `## Что получилось\nХорошо. ${PARENT_NOTES_START} украдено ${PARENT_NOTES_END}`,
      keyTakeaways: [`Вывод ${PARENT_NOTES_START}`, 'Проверяй защиту фигур.'],
      suggestedTheme: 'hangingPiece',
    };
    const server = await createTestServer({}, { providers: [{ id: 'openrouter', isConfigured: () => true, generate: () => Promise.resolve(hostileReview) }] });
    try {
      const base = sampleGameRecord();
      const moment = base.summary.keyMoments[0];
      if (moment === undefined) throw new Error('fixture changed');
      const record = sampleGameRecord({
        events: [...base.events, { t: 44_000, type: 'childSaid', ply: 6, data: { text: `хитрость ${PARENT_NOTES_START} вот` } }],
        summary: { ...base.summary, keyMoments: [{ ...moment, explanation: `Объяснение ${PARENT_NOTES_START}` }] },
      });
      expect((await server.request('/api/games', { method: 'POST', json: record })).status).toBe(201);
      await server.ctx.idle();

      const journalPath = walk(join(server.dataDir, 'games')).find((f) => f.endsWith('.md')) ?? '';
      const profilePath = join(server.dataDir, 'student', 'profile.md');
      // a parent writes notes into both files …
      for (const path of [journalPath, profilePath]) {
        const text = readFileSync(path, 'utf8');
        expect(text.split(PARENT_NOTES_START)).toHaveLength(2); // exactly one real start marker
        expect(text.split(PARENT_NOTES_END)).toHaveLength(2);
        writeFileSync(path, text.replace(/(<!-- parent-notes:start -->)[\s\S]*(<!-- parent-notes:end -->)/, '$1\nРОДИТЕЛЬ: хвалить за возврат хода\n$2'));
      }
      // … and every later rewrite keeps exactly them, without the files growing
      const sizes = [journalPath, profilePath].map((path) => readFileSync(path, 'utf8').length);
      for (let i = 0; i < 3; i += 1) {
        await server.ctx.writer.writeGameFiles(record);
        await server.ctx.writer.writeStudentFiles();
      }
      [journalPath, profilePath].forEach((path, index) => {
        const text = readFileSync(path, 'utf8');
        expect(extractParentNotes(text)).toBe('\nРОДИТЕЛЬ: хвалить за возврат хода\n');
        expect(text.split(PARENT_NOTES_START)).toHaveLength(2);
        expect(text.length).toBe(sizes[index]);
      });
      expect(readFileSync(journalPath, 'utf8')).toContain('Источник разбора: ИИ-тренер (OpenRouter)');
    } finally {
      await server.cleanup();
    }
  });
});

describe('a damaged app.sqlite does not keep the child from playing', () => {
  it('quarantines the file, logs a clear message and starts fresh', () => {
    const path = join(dir, 'corrupt', 'app.sqlite');
    mkdirSync(join(dir, 'corrupt'), { recursive: true });
    writeFileSync(path, randomBytes(8192));
    writeFileSync(`${path}-wal`, 'stale wal'); // must not confuse the fresh database either
    const logs: string[] = [];
    const db = openAppDb(path, { log: (m) => logs.push(m), now: () => new Date('2026-09-21T15:00:00.000Z') });
    try {
      expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(MIGRATIONS.length);
      kvSet(db, 'k', 'v');
      expect(kvGet(db, 'k')).toBe('v');
    } finally {
      db.close();
    }
    const quarantined = join(dir, 'corrupt', 'app.sqlite.corrupt-2026-09-21T15-00-00-000Z');
    expect(readFileSync(quarantined).length).toBe(8192);
    expect(logs.join('\n')).toContain('повреждён');
    expect(logs.join('\n')).toContain(quarantined);
  });

  it('boots the whole server on top of a damaged database', async () => {
    const dataDir = mkdtempSync(join(dir, 'boot-'));
    writeFileSync(join(dataDir, 'app.sqlite'), randomBytes(4096));
    const logs: string[] = [];
    const server = await createTestServer({ dataDir }, { log: (m) => logs.push(m) });
    try {
      expect((await server.request('/api/health')).status).toBe(200);
      expect((await server.request('/api/student')).status).toBe(200);
      expect(readdirSync(dataDir).some((name) => name.startsWith('app.sqlite.corrupt-'))).toBe(true);
    } finally {
      await server.ctx.idle();
      await server.ctx.close();
    }
  });

  it('does NOT treat other failures as corruption', () => {
    expect(isCorruptDbError(Object.assign(new Error('file is not a database'), { errcode: 26 }))).toBe(true);
    expect(isCorruptDbError(Object.assign(new Error('database disk image is malformed'), { errcode: 11 }))).toBe(true);
    expect(isCorruptDbError(Object.assign(new Error('database is locked'), { errcode: 5 }))).toBe(false);
    expect(isCorruptDbError(new Error('Database schema version 9 is newer than this server (2).'))).toBe(false);

    const path = join(dir, 'newer.sqlite');
    const db = openDb(path);
    migrate(db);
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => openAppDb(path)).toThrow(/newer than this server/);
    expect(readdirSync(dir).filter((name) => name.startsWith('newer.sqlite.corrupt'))).toEqual([]);
  });

  it('migrates a version-1 database: old reviews survive and OpenRouter reviews can be stored', () => {
    const path = join(dir, 'v1.sqlite');
    const v1 = openDb(path);
    migrate(v1, MIGRATIONS.slice(0, 1));
    const record = sampleGameRecord();
    new Repo(v1).insertGame(record, 'games/2026/09/x', '2026-09-21T15:00:00.000Z');
    new Repo(v1).saveReview({ gameId: record.id, status: 'ready', provider: 'codex', markdown: 'старый разбор', keyTakeaways: ['a'], suggestedTheme: 'fork' }, '2026-09-21T15:01:00.000Z');
    expect(() => new Repo(v1).saveReview({ gameId: record.id, status: 'ready', provider: 'openrouter', markdown: 'x', keyTakeaways: [], suggestedTheme: null }, 'now')).toThrow();
    v1.close();

    const db = openAppDb(path);
    try {
      const repo = new Repo(db);
      expect(repo.getReview(record.id)).toMatchObject({ provider: 'codex', markdown: 'старый разбор', keyTakeaways: ['a'], suggestedTheme: 'fork' });
      repo.saveReview({ gameId: record.id, status: 'ready', provider: 'openrouter', markdown: 'новый разбор', keyTakeaways: [], suggestedTheme: null }, '2026-09-21T15:02:00.000Z');
      expect(repo.getReview(record.id)).toMatchObject({ provider: 'openrouter', markdown: 'новый разбор' });
      expect(db.all(`SELECT name FROM sqlite_master WHERE name = 'review_v2'`)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('backs up a stored profile that is not even JSON before replacing it', () => {
    const db = openDb(':memory:');
    migrate(db);
    const repo = new Repo(db);
    kvSet(db, 'student-profile', '{"nickname":"Миша", обрыв записи');
    const profile = new StudentService(repo, { curriculum: fallbackCurriculum() }).getProfile();
    expect(profile.nickname).toBe('Шахматист');
    const backups = db.all<{ key: string; value: string }>(`SELECT key, value FROM kv WHERE key LIKE 'student-profile.backup.%'`);
    expect(backups).toHaveLength(1);
    expect(backups[0]?.value).toContain('обрыв записи');
  });
});

describe('the Vite dev port is a development-only origin', () => {
  it('is dropped from both allow-lists under NODE_ENV=production', () => {
    const dev = loadConfig({}, { codexBin: null });
    const prod = loadConfig({ NODE_ENV: 'production' }, { codexBin: null });
    expect(dev.production).toBe(false);
    expect(prod.production).toBe(true);
    expect([...allowedHosts(dev)]).toEqual(['127.0.0.1:8787', 'localhost:8787', '127.0.0.1:5173', 'localhost:5173']);
    expect([...allowedHosts(prod)]).toEqual(['127.0.0.1:8787', 'localhost:8787']);
    expect([...allowedOrigins(prod)]).toEqual(['http://127.0.0.1:8787', 'http://localhost:8787']);
  });
});

describe('behind a proxy: GAMBIT_BIND_HOST, GAMBIT_PUBLIC_HOSTS, GAMBIT_PUBLIC_HTTP (deploy/docker-ssh)', () => {
  it('unset: loopback only, no public name — the lists and the start-up line are exactly the local ones', () => {
    for (const env of [{}, { GAMBIT_BIND_HOST: '', GAMBIT_PUBLIC_HOSTS: ' , ', GAMBIT_PUBLIC_HTTP: '1' }]) {
      const config = loadConfig({ NODE_ENV: 'production', ...env }, { codexBin: null });
      expect(config).toMatchObject({ hostname: '127.0.0.1', publicHosts: [], networkWarnings: [], buildSha: null });
      expect([...allowedHosts(config)]).toEqual(['127.0.0.1:8787', 'localhost:8787']);
      expect([...allowedOrigins(config)]).toEqual(['http://127.0.0.1:8787', 'http://localhost:8787']);
      expect(listenLine(config, 8787)).toBe('http://127.0.0.1:8787');
    }
    // a config built by hand (no public fields at all) keeps the local lists
    expect([...allowedHosts({ port: 8787, webDevPort: 5173, production: true })]).toEqual(['127.0.0.1:8787', 'localhost:8787']);
  });

  it('GAMBIT_BIND_HOST: 0.0.0.0 or an IP literal; a name or junk keeps 127.0.0.1 and says so', () => {
    for (const ip of ['0.0.0.0', '10.0.0.5', '::', '::1']) expect(parseBindHost(ip), ip).toEqual({ hostname: ip, warning: null });
    expect(parseBindHost(' 0.0.0.0 ')).toEqual({ hostname: '0.0.0.0', warning: null });
    for (const bad of ['localhost', 'example.com', '0.0.0.0; rm -rf /', '256.1.1.1', '*', '0.0.0.0:8787', 'line\nforged']) {
      const parsed = parseBindHost(bad);
      expect(parsed.hostname, bad).toBe('127.0.0.1');
      expect(parsed.warning, bad).toMatch(/^GAMBIT_BIND_HOST ".*" ignored/);
      expect(parsed.warning, bad).not.toContain('\n');
    }
    expect(loadConfig({ GAMBIT_BIND_HOST: 'localhost' }, { codexBin: null })).toMatchObject({ hostname: '127.0.0.1', networkWarnings: [expect.stringContaining('GAMBIT_BIND_HOST')] });
    const any = loadConfig({ GAMBIT_BIND_HOST: '0.0.0.0' }, { codexBin: null });
    expect(any.hostname).toBe('0.0.0.0');
    // binding wide opens no name: the Host allow-list is still the loopback one
    expect([...allowedHosts(any)]).toEqual(['127.0.0.1:8787', 'localhost:8787', '127.0.0.1:5173', 'localhost:5173']);
    expect(listenLine({ hostname: '::', publicHosts: [], publicHttp: false }, 8787)).toBe('http://[::]:8787');
  });

  it('GAMBIT_PUBLIC_HOSTS: trusted as the Host and as the https Origin (http only with GAMBIT_PUBLIC_HTTP=1)', () => {
    const env = { NODE_ENV: 'production', GAMBIT_BIND_HOST: '0.0.0.0', GAMBIT_PUBLIC_HOSTS: 'gambitik.example.test, kids.example.test:8443' };
    const config = loadConfig(env, { codexBin: null });
    expect(config).toMatchObject({ hostname: '0.0.0.0', publicHosts: ['gambitik.example.test', 'kids.example.test:8443'], publicHttp: false, networkWarnings: [] });
    expect([...allowedHosts(config)]).toEqual(['127.0.0.1:8787', 'localhost:8787', 'gambitik.example.test', 'kids.example.test:8443']);
    expect([...allowedOrigins(config)]).toEqual([
      'http://127.0.0.1:8787',
      'http://localhost:8787',
      'https://gambitik.example.test',
      'https://kids.example.test:8443',
    ]);
    expect(listenLine(config, 8787)).toBe('http://0.0.0.0:8787 · public: https://gambitik.example.test, https://kids.example.test:8443');
    const http = loadConfig({ ...env, GAMBIT_PUBLIC_HTTP: '1' }, { codexBin: null });
    expect(allowedOrigins(http).has('http://gambitik.example.test')).toBe(true);
    expect(allowedOrigins(http).has('https://gambitik.example.test')).toBe(true);
    // the dev origin stays a development-only one
    expect(allowedHosts(loadConfig({ GAMBIT_PUBLIC_HOSTS: 'kids.example.test' }, { codexBin: null }))).toEqual(
      new Set(['127.0.0.1:8787', 'localhost:8787', '127.0.0.1:5173', 'localhost:5173', 'kids.example.test']),
    );
  });

  it('GAMBIT_PUBLIC_HOSTS is strict: a bad entry is skipped with a warning, the good ones still count, at most 5', () => {
    const bad = [
      'Gambitik.Example.test',
      'https://kids.example.test',
      'kids.example.test/path',
      '*.example.test',
      '1.2.3.4',
      'localhost',
      'kids.example.test:0',
      'kids.example.test:99999',
      'kids..example.test',
      '-kids.example.test',
      'kids.example.test.',
      'kids example.test',
      `${'a'.repeat(64)}.example.test`,
    ];
    for (const entry of bad) {
      const parsed = parsePublicHosts(entry);
      expect(parsed.hosts, entry).toEqual([]);
      expect(parsed.warnings, entry).toHaveLength(1);
    }
    const mixed = parsePublicHosts('evil/x, kids.example.test ,kids.example.test, EVIL.test');
    expect(mixed.hosts).toEqual(['kids.example.test']);
    expect(mixed.warnings).toHaveLength(2);
    const many = parsePublicHosts('a.test,b.test,c.test,d.test,e.test,f.test');
    expect(many.hosts).toEqual(['a.test', 'b.test', 'c.test', 'd.test', 'e.test']);
    expect(many.warnings).toEqual([expect.stringContaining('at most 5')]);
    const config = loadConfig({ NODE_ENV: 'production', GAMBIT_PUBLIC_HOSTS: 'evil/x' }, { codexBin: null });
    expect(config.publicHosts).toEqual([]);
    expect([...allowedHosts(config)]).toEqual(['127.0.0.1:8787', 'localhost:8787']);
    expect(config.networkWarnings).toEqual([expect.stringContaining('GAMBIT_PUBLIC_HOSTS')]);
  });

  it('GAMBIT_BUILD_SHA: a commit of 7–40 hex digits, reported in its short form; anything else is none', () => {
    expect(loadConfig({ GAMBIT_BUILD_SHA: 'B4D0ABE1234567890' }, { codexBin: null }).buildSha).toBe('b4d0abe');
    for (const bad of ['', 'b4d0ab', 'main', 'b4d0abe; x']) expect(loadConfig({ GAMBIT_BUILD_SHA: bad }, { codexBin: null }).buildSha, bad).toBeNull();
  });
});

describe('configuration from the environment', () => {
  it('has the documented defaults: runtime AI off — the template and the recorded voice, codex not even looked for', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      runtimeAi: false,
      openaiApiKey: null,
      openrouterApiKey: null,
      openrouterReviewModel: 'openai/gpt-5.6-terra',
      openrouterFallbackModels: ['openai/gpt-5.6-luna'],
      voiceModel: 'gpt-realtime-2.1',
      voiceLiveModel: 'gpt-live-1',
      voiceLiveVoice: 'marin',
      voicePreferred: 'clips',
      reviewIncludeChildSpeech: false,
      llmProvider: 'template',
      codexModel: 'gpt-5.6-luna',
      codexBin: null,
    });
    // with runtime AI on, the parse defaults apply
    expect(loadConfig({ GAMBIT_RUNTIME_AI: '1' }, { codexBin: null })).toMatchObject({ runtimeAi: true, voicePreferred: 'live', llmProvider: 'auto' });
  });

  it('GAMBIT_RUNTIME_AI: a flag (1/true/yes/on), off by default, and it wins over LLM_PROVIDER, VOICE_PREFERRED, CODEX_BIN and overrides', () => {
    for (const on of ['1', 'true', 'YES', ' on ']) expect(loadConfig({ GAMBIT_RUNTIME_AI: on }, { codexBin: null }).runtimeAi, on).toBe(true);
    for (const off of [undefined, '', '0', 'false', 'off', 'no', 'maybe']) expect(loadConfig({ GAMBIT_RUNTIME_AI: off }, { codexBin: null }).runtimeAi, String(off)).toBe(false);
    // an .env copied from an older example: the paid settings, a key, an explicit codex
    const env = { LLM_PROVIDER: 'auto', VOICE_PREFERRED: 'live', OPENAI_API_KEY: 'x', OPENROUTER_API_KEY: 'y', CODEX_BIN: '/bin/sh' };
    expect(loadConfig(env)).toMatchObject({ runtimeAi: false, llmProvider: 'template', voicePreferred: 'clips', codexBin: null, openaiApiKey: 'x', openrouterApiKey: 'y' });
    expect(loadConfig({ ...env, GAMBIT_RUNTIME_AI: '1' })).toMatchObject({ runtimeAi: true, llmProvider: 'auto', voicePreferred: 'live', codexBin: '/bin/sh' });
    // applied AFTER the overrides: an override alone cannot switch a model back on…
    expect(loadConfig({}, { llmProvider: 'codex', voicePreferred: 'realtime', codexBin: '/bin/sh' })).toMatchObject({ llmProvider: 'template', voicePreferred: 'clips', codexBin: null });
    // …the flag itself can (tests of the paid paths), and it can also switch it off over the environment
    expect(loadConfig({}, { runtimeAi: true, llmProvider: 'codex', codexBin: '/bin/sh' })).toMatchObject({ runtimeAi: true, llmProvider: 'codex', codexBin: '/bin/sh' });
    expect(loadConfig({ ...env, GAMBIT_RUNTIME_AI: '1' }, { runtimeAi: false })).toMatchObject({ runtimeAi: false, llmProvider: 'template', codexBin: null });
  });

  it('reads the OpenRouter, voice, strategist, port and web-build settings, and refuses flag-like model ids', () => {
    const config = loadConfig(
      {
        GAMBIT_RUNTIME_AI: '1',
        OPENROUTER_API_KEY: ' sk-or-v1-x ',
        OPENROUTER_REVIEW_MODEL: 'openai/gpt-5.6-sol',
        OPENROUTER_FALLBACK_MODELS: 'openai/gpt-5.6-terra, --evil, openai/gpt-5.6-luna',
        VOICE_LIVE_MODEL: 'gpt-live-2',
        VOICE_LIVE_VOICE: 'cedar',
        VOICE_PREFERRED: 'Realtime',
        REVIEW_INCLUDE_CHILD_SPEECH: '1',
        LLM_PROVIDER: 'openrouter',
        CODEX_MODEL: '--dangerously-bypass-approvals-and-sandbox',
      },
      { codexBin: null },
    );
    expect(config).toMatchObject({
      openrouterApiKey: 'sk-or-v1-x',
      openrouterReviewModel: 'openai/gpt-5.6-sol',
      openrouterFallbackModels: ['openai/gpt-5.6-terra', 'openai/gpt-5.6-luna'],
      voiceLiveModel: 'gpt-live-2',
      voiceLiveVoice: 'cedar',
      voicePreferred: 'realtime',
      reviewIncludeChildSpeech: true,
      llmProvider: 'openrouter',
      codexModel: 'gpt-5.6-luna',
    });
    expect(loadConfig({ OPENROUTER_FALLBACK_MODELS: 'none' }, { codexBin: null }).openrouterFallbackModels).toEqual([]);
    // the smart strategist of «Учитель»: Sol by default, overridable, never a flag
    expect(loadConfig({}, { codexBin: null })).toMatchObject({ codexStrategyModel: 'gpt-5.6-sol', openrouterStrategyModel: 'openai/gpt-5.6-sol', openaiStrategyModel: 'gpt-5.6-sol' });
    expect(
      loadConfig({ CODEX_STRATEGY_MODEL: 'gpt-5.6-terra', OPENROUTER_STRATEGY_MODEL: '--evil', OPENAI_STRATEGY_MODEL: 'gpt-5.6-luna' }, { codexBin: null }),
    ).toMatchObject({ codexStrategyModel: 'gpt-5.6-terra', openrouterStrategyModel: 'openai/gpt-5.6-sol', openaiStrategyModel: 'gpt-5.6-luna' });
    // a second stack on other ports (e2e / smoke test while the owner's server holds 8787); junk keeps the defaults
    expect(loadConfig({}, { codexBin: null })).toMatchObject({ port: 8787, webDevPort: 5173 });
    const moved = loadConfig({ GAMBIT_API_PORT: '8788', GAMBIT_WEB_PORT: '5174' }, { codexBin: null });
    expect(moved).toMatchObject({ port: 8788, webDevPort: 5174 });
    expect(allowedHosts(moved).has('127.0.0.1:8788')).toBe(true);
    expect(allowedHosts(moved).has('127.0.0.1:8787')).toBe(false);
    expect(loadConfig({ GAMBIT_API_PORT: '80', GAMBIT_WEB_PORT: 'x' }, { codexBin: null })).toMatchObject({ port: 8787, webDevPort: 5173 });
    // GAMBIT_WEB_DIST: a smoke test serves its own build and never touches apps/web/dist, which the owner's server serves
    const repoRoot = '/r';
    expect(loadConfig({}, { codexBin: null, repoRoot }).webDistDir).toBe('/r/apps/web/dist');
    expect(loadConfig({ GAMBIT_WEB_DIST: '  ' }, { codexBin: null, repoRoot }).webDistDir).toBe('/r/apps/web/dist');
    expect(loadConfig({ GAMBIT_WEB_DIST: '/private/tmp/x/dist' }, { codexBin: null, repoRoot }).webDistDir).toBe('/private/tmp/x/dist');
    expect(loadConfig({ GAMBIT_WEB_DIST: 'build/web' }, { codexBin: null, repoRoot }).webDistDir).toBe('/r/build/web');
    expect(isSafeModelId('openai/gpt-5.6-terra')).toBe(true);
    expect(isSafeModelId('-m')).toBe(false);
    expect(isSafeModelId('a b')).toBe(false);
  });
});

describe('child data is private to the account', () => {
  it('writes files 0600 into directories 0700', async () => {
    const path = join(dir, 'private', 'deep', 'note.md');
    await atomicWriteFile(path, 'x');
    expect(mode(path)).toBe(0o600);
    expect(mode(join(dir, 'private', 'deep'))).toBe(0o700);
    expect(mode(join(dir, 'private'))).toBe(0o700);
  });

  it('the data directory, the database and every journal are owner-only — also after an upgrade from 0755', async () => {
    const dataDir = mkdtempSync(join(dir, 'modes-'));
    mkdirSync(join(dataDir, 'inner'), { mode: 0o755 });
    const looseDataDir = join(dataDir, 'inner');
    const server = await createTestServer({ dataDir: looseDataDir });
    try {
      await server.request('/api/games', { method: 'POST', json: sampleGameRecord() });
      await server.ctx.idle();
      expect(mode(looseDataDir)).toBe(0o700);
      expect(mode(join(looseDataDir, 'app.sqlite'))).toBe(0o600);
      const files = [...walk(join(looseDataDir, 'games')), ...walk(join(looseDataDir, 'student'))];
      expect(files.length).toBeGreaterThanOrEqual(4);
      for (const file of files) expect(mode(file), file).toBe(0o600);
      for (const extra of ['app.sqlite-wal', 'app.sqlite-shm']) {
        if (existsSync(join(looseDataDir, extra))) expect(mode(join(looseDataDir, extra)), extra).toBe(0o600);
      }
    } finally {
      await server.ctx.idle();
      await server.ctx.close();
    }
  });
});

describe('a locked / damaged puzzles.sqlite', () => {
  const fallbackPuzzles = builtinPuzzles();

  function flakySource(state: { broken: boolean; calls: number }): PuzzleSource {
    const healthy = new MemoryPuzzleSource('starter', [{ ...(fallbackPuzzles[0] as Puzzle), id: 'from-sqlite' }]);
    return {
      kind: 'sqlite',
      count: () => 5_000_000,
      candidates: (query: CandidateQuery) => {
        state.calls += 1;
        if (state.broken) throw Object.assign(new Error('database is locked'), { errcode: 5 });
        return healthy.candidates(query);
      },
      getById: (id: string) => {
        state.calls += 1;
        if (state.broken) throw new Error('database disk image is malformed');
        return healthy.getById(id);
      },
      close: () => undefined,
    };
  }

  it('answers from the in-memory set, logs once and leaves the database alone for a while', () => {
    const state = { broken: true, calls: 0 };
    const logs: string[] = [];
    let now = 1_000_000;
    const source = new ResilientPuzzleSource(flakySource(state), () => new MemoryPuzzleSource('builtin', fallbackPuzzles), { log: (m) => logs.push(m), now: () => now });
    const query: CandidateQuery = { lo: 0, hi: 100_000, exclude: new Set(), limit: 3 };

    expect(source.kind).toBe('sqlite');
    expect(source.candidates(query)).toHaveLength(3);
    expect(source.candidates(query)).toHaveLength(3);
    expect(source.getById(fallbackPuzzles[0]?.id ?? '')).toBeDefined();
    expect(state.calls).toBe(1); // one stall, not one per call
    expect(logs).toHaveLength(1);
    expect(source.degraded).toBe(true);

    // the lock is gone: after the pause the imported database is used again
    state.broken = false;
    now += PUZZLE_DB_RETRY_AFTER_MS + 1;
    expect(source.candidates(query).map((p) => p.id)).toEqual(['from-sqlite']);
    expect(source.degraded).toBe(false);
  });

  it('GET /api/puzzles/next answers 200 (not 500) while another process holds an exclusive lock', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dataDir = mkdtempSync(join(dir, 'locked-'));
    mkdirSync(join(dataDir, 'build'));
    const dbPath = join(dataDir, 'build', 'puzzles.sqlite');
    const writer = new DatabaseSync(dbPath);
    writer.exec(`
      CREATE TABLE puzzle (id TEXT PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL, rating INTEGER NOT NULL, popularity INTEGER, nb_plays INTEGER, themes TEXT NOT NULL);
      INSERT INTO puzzle VALUES ('00008', 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24', 'f2g3 e6e7 b2b1 b3c1 b1c1 h6c1', 1797, 95, 10183, 'crushing hangingPiece long middlegame');
    `);
    const logs: string[] = [];
    const server = await createTestServer({ dataDir, puzzlesDbPath: dbPath }, { log: (m) => logs.push(m) });
    try {
      expect(server.ctx.puzzles.kind).toBe('sqlite');
      writer.exec('BEGIN EXCLUSIVE');
      const startedAt = Date.now();
      const res = await server.request('/api/puzzles/next?count=3');
      expect(res.status).toBe(200);
      expect(((await res.json()) as Puzzle[]).length).toBe(3);
      expect(Date.now() - startedAt).toBeLessThan(1_500); // one short busy wait, not 3 s per statement
      expect(logs.filter((line) => line.includes('[puzzles]'))).toHaveLength(1);
      writer.exec('ROLLBACK');
    } finally {
      writer.close();
      await server.ctx.idle();
      await server.ctx.close();
    }
  });
});

describe('content fallbacks are loud', () => {
  it('a healthy install uses no fallback at all', async () => {
    const content = await loadContent();
    expect(content.fallbacks).toEqual([]);
    expect(contentWarningLines(content)).toEqual([]);
  });

  it('lists what fell back and prints a banner at start-up', async () => {
    const broken = await loadContent({ loadContentModule: () => Promise.resolve({ PERSONAS: 'garbage' }), loadCoreModule: () => Promise.reject(new Error('boom')) });
    expect(broken.fallbacks).toEqual(expect.arrayContaining(['@gambit/content:PERSONAS', '@gambit/content:CONCEPT_CARDS', '@gambit/core:buildTemplateReview']));
    expect(broken.fallbacks).toEqual(expect.arrayContaining(['@gambit/content:STRATEGIES', '@gambit/content:getStrategiesFor', '@gambit/core:sanToSpokenRu']));
    expect(broken.strategyLibrary.source).toBe('builtin');
    expect(broken.strategyLibrary.eligible({ childColor: 'w', stage: 1 }).length).toBeGreaterThan(0);
    expect(broken.sanToSpokenRu('Nf3')).toBe('конь на эф три');
    expect(contentWarningLines(broken).join('\n')).toContain('FALLBACKS');

    const logs: string[] = [];
    const server = await createTestServer({}, { log: (m) => logs.push(m), content: { loadContentModule: () => Promise.resolve({}), loadCoreModule: () => Promise.resolve({}) } });
    try {
      expect(logs.join('\n')).toContain('[content] built-in FALLBACKS are in use instead of: @gambit/content:PERSONAS');
    } finally {
      await server.cleanup();
    }
  });
});

describe('a new game is held to the size of a real one', () => {
  it('counts the plies of a PGN cheaply: headers, comments, variations, numbers and the result are skipped', () => {
    expect(pgnPlyCount('[Event "Гамбитик"]\n[Opening "Van Geet [x]"]\n\n1. e4 {[%clk 0:04:44]} 1... e5 2. Nf3 (2. f4 exf4 3. Nf3) 2... Nc6 ; a note\n3. O-O-O exd5 4. e8=Q+ 1-0')).toBe(7);
    // no spaces between the moves: still every move counts
    expect(pgnPlyCount('1.e4e5 2.Nf3Nc6')).toBe(4);
    expect(pgnPlyCount('')).toBe(0);
  });

  it('refuses a 28 000-ply PGN (and any beyond 600 plies or 32 000 characters), too many events, a bloated event; takes a real game', () => {
    const base = sampleGameRecord();
    expect(newGameRecordSchema.safeParse(base).success).toBe(true);
    const moves = (plies: number) => Array.from({ length: plies / 4 }, () => 'Nf3 Nf6 Ng1 Ng8').join(' ');
    // a legal 600-ply game (knights out and back) passes; one more move does not
    expect(newGameRecordSchema.safeParse({ ...base, pgn: moves(MAX_GAME_PLIES) }).success).toBe(true);
    expect(newGameRecordSchema.safeParse({ ...base, pgn: `${moves(MAX_GAME_PLIES)} Nf3` }).success).toBe(false);
    expect(newGameRecordSchema.safeParse({ ...base, pgn: moves(28_000).slice(0, 190_000) }).success).toBe(false);
    expect(newGameRecordSchema.safeParse({ ...base, pgn: `{${'x'.repeat(MAX_GAME_PGN_CHARS)}}` }).success).toBe(false);
    const event = base.events[0];
    if (event === undefined) throw new Error('fixture changed');
    expect(newGameRecordSchema.safeParse({ ...base, events: Array.from({ length: MAX_GAME_EVENTS + 1 }, () => event) }).success).toBe(false);
    expect(newGameRecordSchema.safeParse({ ...base, events: [{ ...event, data: { text: 'x'.repeat(9000) } }] }).success).toBe(false);
    expect(newGameRecordSchema.safeParse({ ...base, events: [{ ...event, ply: MAX_GAME_PLIES + 1 }] }).success).toBe(false);
    // a game saved before stays readable with the plain schema
    expect(gameRecordSchema.safeParse({ ...base, pgn: `${moves(MAX_GAME_PLIES)} Nf3` }).success).toBe(true);
  });

  it('over HTTP: an oversized game is refused before anything parses its PGN; the body limit is 1 MB', async () => {
    expect(GAME_BODY_LIMIT).toBe(1024 * 1024);
    const server = await createTestServer({ autoReview: false });
    try {
      const big = sampleGameRecord({ pgn: Array.from({ length: 7_000 }, () => 'Nf3 Nf6 Ng1 Ng8').join(' ').slice(0, 199_000) });
      const res = await server.request('/api/games', { method: 'POST', json: big });
      expect(res.status).toBe(400);
      expect((await server.request('/api/games')).status).toBe(200);
      expect(await (await server.request('/api/games')).json()).toEqual([]);
      const huge = await server.request('/api/games', { method: 'POST', json: { ...sampleGameRecord(), padding: 'x'.repeat(GAME_BODY_LIMIT) } });
      expect(huge.status).toBe(413);
      expect((await server.request('/api/games', { method: 'POST', json: sampleGameRecord() })).status).toBe(201);
    } finally {
      await server.cleanup();
    }
  });
});
