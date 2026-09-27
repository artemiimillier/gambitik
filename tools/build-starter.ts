/**
 * node tools/build-starter.ts
 *
 * Samples ≈ 400 easy puzzles (rating 400–1400) from data/build/puzzles.sqlite into
 * kb/puzzles-starter.json so the app has puzzles before / without `pnpm puzzles:import`.
 * Rows keep the raw Lichess semantics of the database: `{ id, fen, moves, rating, themes }`,
 * FEN BEFORE the opponent's first move, `moves` and `themes` space-separated.
 * Every puzzle is replayed with chess.js (legal line; mate themes end in mate). Deterministic.
 *
 * Flags: --db <path> (default data/build/puzzles.sqlite), --out <path> (default kb/puzzles-starter.json)
 */
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { displayPath, errorMessage, fmt, fmtBytes, parseCli, repoPath, UsageError } from './lib/cli.ts';
import { pickStarter, serializeStarter, STARTER_OPTIONS, STARTER_QUOTAS, themeCounts } from './lib/starter-select.ts';
import type { StarterCandidate } from './lib/starter-select.ts';

const TAG = '[starter:build]';

interface DbRow {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  popularity: number | null;
  nb_plays: number | null;
  themes: string;
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2), {
    db: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (args.help) {
    console.log('Usage: node tools/build-starter.ts [--db <puzzles.sqlite>] [--out <puzzles-starter.json>]');
    return;
  }
  const dbFile = path.resolve(args.db ?? repoPath('data', 'build', 'puzzles.sqlite'));
  const outFile = path.resolve(args.out ?? repoPath('kb', 'puzzles-starter.json'));
  if (!existsSync(dbFile)) throw new UsageError(`${displayPath(dbFile)} not found — run "pnpm puzzles:import" first`);

  const db = new DatabaseSync(dbFile, { readOnly: true });
  let rows: DbRow[];
  try {
    rows = db
      .prepare('SELECT id, fen, moves, rating, popularity, nb_plays, themes FROM puzzle WHERE rating BETWEEN ? AND ? ORDER BY id')
      .all(STARTER_OPTIONS.minRating, STARTER_OPTIONS.maxRating) as unknown as DbRow[];
  } finally {
    db.close();
  }
  const candidates: StarterCandidate[] = rows.map((r) => ({
    id: r.id,
    fen: r.fen,
    moves: r.moves,
    rating: r.rating,
    themes: r.themes,
    popularity: r.popularity ?? 0,
    nbPlays: r.nb_plays ?? 0,
  }));

  const puzzles = pickStarter(candidates);
  const wanted = STARTER_QUOTAS.reduce((sum, q) => sum + q.count, 0);
  if (puzzles.length < wanted * 0.9) {
    throw new Error(`only ${puzzles.length} of ${wanted} starter puzzles could be picked — is the database a --limit-rows test build?`);
  }

  const json = serializeStarter(puzzles);
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(`${outFile}.tmp`, json, 'utf8');
  await rename(`${outFile}.tmp`, outFile);

  const counts = themeCounts(puzzles);
  console.log(`${TAG} ${fmt(candidates.length)} candidates → ${puzzles.length} puzzles, ${fmtBytes(Buffer.byteLength(json))} → ${displayPath(outFile)}`);
  console.log(`${TAG} per quota theme: ${STARTER_QUOTAS.map((q) => `${q.theme} ${counts[q.theme] ?? 0}`).join(' · ')}`);
  const bands = new Map<number, number>();
  for (const p of puzzles) bands.set(Math.floor(p.rating / 100) * 100, (bands.get(Math.floor(p.rating / 100) * 100) ?? 0) + 1);
  console.log(`${TAG} per rating band: ${[...bands].sort((a, b) => a[0] - b[0]).map(([b, n]) => `${b}: ${n}`).join(' · ')}`);
}

main().catch((err: unknown) => {
  console.error(`${TAG} ${err instanceof UsageError ? 'usage error' : 'FAILED'}: ${errorMessage(err)}`);
  process.exitCode = 1;
});
