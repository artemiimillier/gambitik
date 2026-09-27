/**
 * End-to-end tests of the import CLI against small synthetic inputs (no network):
 * real rows from kb/puzzles-starter.json are re-packed as a Lichess-style CSV, compressed the way
 * database.lichess.org does it (pzstd: several frames, each preceded by a skippable frame).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { repoPath } from './lib/cli.ts';
import type { StarterPuzzle } from './lib/starter-select.ts';

const SCRIPT = repoPath('tools', 'import-puzzles.ts');
const HEADER = 'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd: repoPath(), timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

function pzstd(text: string, frames: number): Buffer {
  const lines = text.split('\n');
  const perFrame = Math.ceil(lines.length / frames);
  const out: Buffer[] = [];
  for (let i = 0; i < lines.length; i += perFrame) {
    const last = i + perFrame >= lines.length;
    const part = lines.slice(i, i + perFrame).join('\n') + (last ? '' : '\n');
    const frame = zstdCompressSync(Buffer.from(part));
    const skippable = Buffer.alloc(12);
    skippable.writeUInt32LE(0x184d2a50, 0);
    skippable.writeUInt32LE(4, 4);
    skippable.writeUInt32LE(frame.length, 8);
    out.push(skippable, frame);
  }
  return Buffer.concat(out);
}

describe('tools/import-puzzles.ts (CLI)', () => {
  let dir = '';
  let good: StarterPuzzle[] = [];
  let csv = '';

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-import-test-'));
    good = (JSON.parse(readFileSync(repoPath('kb', 'puzzles-starter.json'), 'utf8')) as StarterPuzzle[]).slice(0, 120);
    const rows = good.map((p) => `${p.id},${p.fen},${p.moves},${p.rating},75,95,1000,${p.themes},https://lichess.org/x#1,,`);
    const first = good[0];
    if (!first) throw new Error('starter file is empty');
    rows.push(
      `zzz01,${first.fen},${first.moves},2400,75,95,1000,${first.themes},u,,`, // too hard
      `zzz02,${first.fen},${first.moves},900,120,95,1000,${first.themes},u,,`, // unreliable rating
      `zzz03,${first.fen},${first.moves},900,75,40,1000,${first.themes},u,,`, // unpopular
      `zzz04,${first.fen},${first.moves},900,75,95,12,${first.themes},u,,`, // rarely played
      `zzz05,${first.fen},${first.moves},900,75,95,1000,crushing endgame short,u,,`, // no kid theme
      `zzz06,${first.fen},a1a1 b2b2,900,75,95,1000,fork short,u,,`, // illegal line
      'garbage line without enough fields',
    );
    csv = `${HEADER}\n${rows.join('\n')}\n`;
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('imports a multi-frame .csv.zst into exactly the ARCHITECTURE §4 schema', async () => {
    const src = path.join(dir, 'ok.csv.zst');
    const out = path.join(dir, 'ok.sqlite');
    writeFileSync(src, pzstd(csv, 3));

    const res = await run(['--from-file', src, '--out', out]);
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`puzzles kept : ${good.length}`);
    expect(res.stdout).toContain('rating histogram');

    const db = new DatabaseSync(out, { readOnly: true });
    try {
      const tables = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { sql: string }[];
      expect(tables.map((t) => t.sql)).toEqual([
        'CREATE TABLE puzzle (id TEXT PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL, rating INTEGER NOT NULL, popularity INTEGER, nb_plays INTEGER, themes TEXT NOT NULL)',
        'CREATE TABLE puzzle_theme (theme TEXT NOT NULL, rating INTEGER NOT NULL, puzzle_id TEXT NOT NULL, PRIMARY KEY (theme, rating, puzzle_id)) WITHOUT ROWID',
      ]);
      expect((db.prepare('SELECT count(*) AS n FROM puzzle').get() as { n: number }).n).toBe(good.length);
      expect((db.prepare("SELECT count(*) AS n FROM puzzle WHERE id LIKE 'zzz%'").get() as { n: number }).n).toBe(0);

      const sample = good[5];
      if (!sample) throw new Error('fixture too small');
      expect(db.prepare('SELECT id, fen, moves, rating, popularity, nb_plays, themes FROM puzzle WHERE id = ?').get(sample.id)).toEqual({
        id: sample.id, fen: sample.fen, moves: sample.moves, rating: sample.rating, popularity: 95, nb_plays: 1000, themes: sample.themes,
      });
      // every tag of a kept puzzle (kid and meta) is indexed with the puzzle's rating
      const indexed = db.prepare('SELECT theme, rating FROM puzzle_theme WHERE puzzle_id = ? ORDER BY theme').all(sample.id) as { theme: string; rating: number }[];
      expect(indexed.map((r) => r.theme)).toEqual([...new Set(sample.themes.split(' '))].sort());
      expect(indexed.every((r) => r.rating === sample.rating)).toBe(true);
      // the documented server query is served by the primary key
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT puzzle_id FROM puzzle_theme WHERE theme = 'fork' AND rating BETWEEN 500 AND 700").all() as { detail: string }[];
      expect(plan[0]?.detail).toMatch(/PRIMARY KEY/);
    } finally {
      db.close();
    }

    const stats = JSON.parse(readFileSync(path.join(dir, 'ok.stats.json'), 'utf8')) as { scanned: number; kept: number; malformed: number; invalid: number };
    expect(stats).toMatchObject({ scanned: good.length + 7, kept: good.length, malformed: 1, invalid: 1 });
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('fails cleanly on a truncated download: exit 1, clear message, no partial DB, old DB untouched', async () => {
    const full = pzstd(csv, 3);
    const src = path.join(dir, 'cut.csv.zst');
    const out = path.join(dir, 'cut.sqlite');
    writeFileSync(src, full.subarray(0, full.length - 40));
    writeFileSync(out, 'previous good database');

    const res = await run(['--from-file', src, '--out', out]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/FAILED: .*truncated/);
    expect(res.stderr).toContain('no database was written');
    expect(readFileSync(out, 'utf8')).toBe('previous good database');
    expect(existsSync(`${out}.tmp`)).toBe(false);
  });

  it('reads plain CSV and honours --limit-rows / --per-bucket', async () => {
    const src = path.join(dir, 'plain.csv');
    const out = path.join(dir, 'plain.sqlite');
    writeFileSync(src, csv);
    const res = await run(['--from-file', src, '--out', out, '--limit-rows', '10', '--per-bucket', '1']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('rows scanned : 10');
    const db = new DatabaseSync(out, { readOnly: true });
    try {
      const n = (db.prepare('SELECT count(*) AS n FROM puzzle').get() as { n: number }).n;
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(10);
    } finally {
      db.close();
    }
  });

  describe('network source', () => {
    let server: Server | undefined;
    let requests = 0;
    let failFirst = 0;
    let base = '';

    beforeAll(async () => {
      const body = pzstd(csv, 3);
      server = createServer((req, res) => {
        requests++;
        if (req.url === '/missing.csv.zst') {
          res.writeHead(404).end('nope');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
        if (requests <= failFirst) {
          // connection reset in the middle of the download
          res.write(body.subarray(0, Math.floor(body.length / 2)), () => res.destroy());
          return;
        }
        res.end(body);
      });
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    });

    it('streams from HTTP and retries once after a dropped connection', async () => {
      requests = 0;
      failFirst = 1;
      const out = path.join(dir, 'net-retry.sqlite');
      const res = await run(['--url', `${base}/puzzles.csv.zst`, '--out', out, '--retry-delay', '50']);
      expect(res.stderr).toMatch(/attempt 1\/2 failed/);
      expect(res.code).toBe(0);
      expect(requests).toBe(2);
      const db = new DatabaseSync(out, { readOnly: true });
      try {
        expect((db.prepare('SELECT count(*) AS n FROM puzzle').get() as { n: number }).n).toBe(good.length);
      } finally {
        db.close();
      }
    });

    it('gives up after two failed attempts: exit 1, clear message, nothing left on disk', async () => {
      requests = 0;
      failFirst = 99;
      const out = path.join(dir, 'net-fail.sqlite');
      const res = await run(['--url', `${base}/puzzles.csv.zst`, '--out', out, '--retry-delay', '50']);
      expect(res.code).toBe(1);
      expect(requests).toBe(2);
      expect(res.stderr).toMatch(/FAILED: stream failed after/);
      expect(res.stderr).toContain('no database was written');
      expect(readdirSync(dir).filter((f) => f.startsWith('net-fail'))).toEqual([]);
    });

    it('reports HTTP errors and unreachable hosts', async () => {
      failFirst = 0;
      const notFound = await run(['--url', `${base}/missing.csv.zst`, '--out', path.join(dir, 'net-404.sqlite'), '--retry-delay', '50']);
      expect(notFound.code).toBe(1);
      expect(notFound.stderr).toMatch(/HTTP 404/);

      const unreachable = await run(['--url', 'http://127.0.0.1:9/puzzles.csv.zst', '--out', path.join(dir, 'net-down.sqlite'), '--retry-delay', '50']);
      expect(unreachable.code).toBe(1);
      expect(unreachable.stderr).toMatch(/cannot reach http:\/\/127\.0\.0\.1:9/);
      expect(readdirSync(dir).filter((f) => f.startsWith('net-404') || f.startsWith('net-down'))).toEqual([]);
    });
  });

  it('rejects files that are not a puzzle CSV, unknown flags and missing files', async () => {
    const src = path.join(dir, 'other.csv');
    writeFileSync(src, 'a,b,c\n1,2,3\n');
    const notCsv = await run(['--from-file', src, '--out', path.join(dir, 'other.sqlite')]);
    expect(notCsv.code).toBe(1);
    expect(notCsv.stderr).toMatch(/no puzzle passed the filter/);
    expect(existsSync(path.join(dir, 'other.sqlite'))).toBe(false);

    const badFlag = await run(['--definitely-not-a-flag']);
    expect(badFlag.code).toBe(1);
    expect(badFlag.stderr).toMatch(/usage error/);

    const missing = await run(['--from-file', path.join(dir, 'nope.zst'), '--out', path.join(dir, 'nope.sqlite')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/no such file/);
  });
});
