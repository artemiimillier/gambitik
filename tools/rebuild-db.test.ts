/**
 * tools/rebuild-db.ts on a throw-away data folder written by the real server: the rebuilt database must answer like the
 * one it replaces — exactly for games with a machine twin, by the journal for older ones — and the tool must never
 * write anywhere but the new file.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GameThought } from '@gambit/shared';
import { openDb } from '../apps/server/src/storage/db.ts';
import { isRebuiltFromJournal } from '../apps/server/src/storage/gameData.ts';
import { Repo } from '../apps/server/src/storage/repo.ts';
import { createTestServer, sampleGameRecord } from '../apps/server/src/testing/fixtures.ts';
import type { TestServer } from '../apps/server/src/testing/fixtures.ts';
import { repoPath } from './lib/cli.ts';
import { RebuildRefused, parseFrontMatter, parseJournalReview, rebuildDb } from './lib/rebuild-db.ts';

const SCRIPT = repoPath('tools', 'rebuild-db.ts');
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-rebuild-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function server(): Promise<TestServer> {
  const s = await createTestServer({ autoReview: true });
  cleanups.push(() => s.cleanup());
  return s;
}

function gameAt(n: number, overrides: Parameters<typeof sampleGameRecord>[0] = {}) {
  const startedAt = new Date(Date.parse('2026-09-21T08:00:00.000Z') + n * 3_600_000).toISOString();
  return sampleGameRecord({ id: `g${n}`, startedAt, endedAt: new Date(Date.parse(startedAt) + 420_000).toISOString(), ...overrides });
}

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd: repoPath(), timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

/** A data folder as a real server leaves it: 3 games, one played by an adult, thoughts, puzzles, a review each. */
async function populated(): Promise<TestServer> {
  const s = await server();
  await s.request('/api/student', { method: 'PUT', json: { nickname: 'Миша', stage: 2 } });
  for (const record of [gameAt(1, { personaId: 'dima' }), gameAt(2, { result: '0-1' }), gameAt(3)]) {
    expect((await s.request('/api/games', { method: 'POST', json: record })).status).toBe(201);
  }
  await s.request('/api/puzzles/attempt', { method: 'POST', json: { puzzleId: 'p1', solved: true, msSpent: 4000, hintsUsed: 0, themes: ['fork'], puzzleRating: 700 } });
  await s.request('/api/games/g1/excluded', { method: 'PUT', json: { excluded: 'adult' } });
  const thoughts: GameThought[] = [{ id: 't1', source: 'voice', text: 'Я увидел мат', question: 'Как ты нашёл мат?', at: '2026-09-21T11:20:00.000Z' }];
  expect((await s.request('/api/games/g3/thoughts', { method: 'POST', json: { thoughts } })).status).toBe(200);
  await s.ctx.idle();
  return s;
}

describe('rebuildDb', () => {
  it('rebuilds games, flags, reviews, thoughts and the profile exactly from the machine twins', async () => {
    const s = await populated();
    const out = path.join(tempDir(), 'rebuilt.sqlite');
    const liveDb = path.join(s.dataDir, 'app.sqlite');
    const liveBefore = statSync(liveDb).mtimeMs;

    const summary = await rebuildDb({ dataDir: s.dataDir, out, content: s.ctx.content });
    expect(summary).toMatchObject({ games: 3, exact: 3, fromJournal: [], skipped: [], reviews: 3, thoughts: 1, excluded: 1, profileRestored: true, ratingPoints: 1 });
    expect(statSync(liveDb).mtimeMs).toBe(liveBefore);
    expect(existsSync(`${out}.partial-${process.pid}`)).toBe(false);

    const db = openDb(out, { readOnly: true });
    cleanups.push(() => db.close());
    const rebuilt = new Repo(db);
    const live = s.ctx.repo;
    expect(rebuilt.listGames(50)).toEqual(live.listGames(50));
    for (const id of ['g1', 'g2', 'g3']) {
      expect(rebuilt.getGame(id)).toEqual(live.getGame(id));
      expect(rebuilt.getReview(id)).toEqual(live.getReview(id));
      expect(rebuilt.getGameFileBase(id)).toBe(live.getGameFileBase(id));
    }
    expect(rebuilt.listThoughts('g3')).toEqual(live.listThoughts('g3').map((t) => ({ ...t, createdAt: expect.any(String) as unknown as string })));
    expect(rebuilt.progressPoints(100)).toEqual(live.progressPoints(100));
    const profile = rebuilt.loadProfile();
    const liveProfile = s.ctx.student.getProfile();
    expect(profile).toMatchObject({ nickname: 'Миша', stage: 2, totals: liveProfile.totals, recentAccuracy: liveProfile.recentAccuracy, bestWin: liveProfile.bestWin, puzzleRating: liveProfile.puzzleRating });
    expect(rebuilt.loadRatingHistory()).toHaveLength(1);
  });

  it('falls back to the journal + PGN for a game without a twin, and flags it so its journal is never overwritten', async () => {
    const s = await populated();
    const base = path.join(s.dataDir, s.ctx.repo.getGameFileBase('g2') ?? '');
    rmSync(`${base}.json`);
    writeFileSync(path.join(s.dataDir, 'games', 'stray.md'), '# просто заметка\n');
    const out = path.join(tempDir(), 'nested', 'rebuilt.sqlite');

    const summary = await rebuildDb({ dataDir: s.dataDir, out, content: s.ctx.content });
    expect(summary.games).toBe(3);
    expect(summary.exact).toBe(2);
    expect(summary.fromJournal).toEqual([s.ctx.repo.getGameFileBase('g2')]);
    expect(summary.skipped).toEqual([{ file: 'games/stray.md', reason: 'no game-journal/1 front matter' }]);

    const db = openDb(out, { readOnly: true });
    cleanups.push(() => db.close());
    const rebuilt = new Repo(db);
    const record = rebuilt.getGame('g2');
    const original = s.ctx.repo.getGame('g2');
    expect(record).toBeDefined();
    expect(isRebuiltFromJournal(record ?? sampleGameRecord())).toBe(true);
    expect(record).toMatchObject({ id: 'g2', startedAt: original?.startedAt, endedAt: original?.endedAt, personaId: 'petya', timeControlId: 'rapid10', childColor: 'w', result: '0-1', termination: 'checkmate', judgements: [] });
    expect(record?.summary).toMatchObject({ accuracy: 81.4, acpl: 38, takebacksOffered: 1, takebacksAccepted: 1, hintsUsed: 1, openingName: "King's Pawn Game" });
    expect(record?.summary.counts).toMatchObject({ blunder: 1, inaccuracy: 1, mistake: 0 });
    expect(record?.pgn).toContain('4. Qxf7#');
    expect(rebuilt.listGames(50).find((g) => g.id === 'g2')).toMatchObject({ accuracy: 81.4, blunders: 1, excluded: null, reviewStatus: 'template' });
    const review = rebuilt.getReview('g2');
    const liveReview = s.ctx.repo.getReview('g2');
    expect(review).toMatchObject({ status: 'template', provider: 'template', keyTakeaways: liveReview?.keyTakeaways });
    expect(review?.markdown.length).toBeGreaterThan(40);
  });

  it('refuses to write over anything: an existing file, the working app.sqlite, a folder that is not DATA_DIR', async () => {
    const s = await populated();
    const dir = tempDir();
    const existing = path.join(dir, 'taken.sqlite');
    writeFileSync(existing, 'не трогать');
    await expect(rebuildDb({ dataDir: s.dataDir, out: existing, content: s.ctx.content })).rejects.toThrow(RebuildRefused);
    expect(readFileSync(existing, 'utf8')).toBe('не трогать');
    await expect(rebuildDb({ dataDir: s.dataDir, out: path.join(s.dataDir, 'app.sqlite'), content: s.ctx.content })).rejects.toThrow(/рабочая база/);
    await expect(rebuildDb({ dataDir: dir, out: path.join(dir, 'x.sqlite'), content: s.ctx.content })).rejects.toThrow(/нет папки games/);
    expect(existsSync(path.join(dir, 'x.sqlite'))).toBe(false);
  });
});

describe('the rebuild CLI', () => {
  it('needs both flags, refuses an existing target and reports what it rebuilt', async () => {
    const s = await populated();
    const dir = tempDir();
    expect((await run(['--data-dir', s.dataDir])).code).toBe(2);
    const taken = path.join(dir, 'taken.sqlite');
    writeFileSync(taken, 'x');
    const refused = await run(['--data-dir', s.dataDir, '--out', taken]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('отказ');
    const ok = await run(['--data-dir', s.dataDir, '--out', path.join(dir, 'new.sqlite')]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('партий: 3 (точно, из .json: 3');
    expect(existsSync(path.join(dir, 'new.sqlite'))).toBe(true);
  });
});

describe('reading a journal', () => {
  it('parses the front matter our journals write — and nothing else', () => {
    expect(parseFrontMatter('---\nschema: game-journal/1\ngame_id: "a-1"\nexam_mode: false\naccuracy: 81.4\ntakebacks: { offered: 2, accepted: 1 }\nopening: "Sicilian: \\"Najdorf\\""\n---\n# x')).toEqual({
      schema: 'game-journal/1',
      game_id: 'a-1',
      exam_mode: false,
      accuracy: 81.4,
      takebacks: { offered: 2, accepted: 1 },
      opening: 'Sicilian: "Najdorf"',
    });
    expect(parseFrontMatter('---\nschema: student-profile/1\n---')).toBeNull();
    expect(parseFrontMatter('# no front matter')).toBeNull();
    expect(parseFrontMatter('---\nschema: game-journal/1\n')).toBeNull();
  });

  it('takes the review text, «Главное» and the provider back out of the review block', () => {
    const md = [
      '## Разбор тренера',
      '',
      '<!-- review:start -->',
      '### Итог',
      'Хорошая партия.',
      '',
      '### Главное',
      '- Проверяй защиту',
      '- Таблица \\| ломается',
      '',
      '**Что потренировать:** Вилка',
      '',
      '_Источник разбора: ИИ-тренер (Codex). Оценки ходов — только от шахматного движка._',
      '<!-- review:end -->',
    ].join('\n');
    expect(parseJournalReview(md, 'ready')).toEqual({ status: 'ready', provider: 'codex', markdown: '### Итог\nХорошая партия.', keyTakeaways: ['Проверяй защиту', 'Таблица | ломается'], suggestedTheme: null });
    expect(parseJournalReview(md, 'failed')).toMatchObject({ status: 'failed', markdown: '' });
    expect(parseJournalReview('без блока', 'ready')).toMatchObject({ markdown: '' });
  });
});
