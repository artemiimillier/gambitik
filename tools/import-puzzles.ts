/**
 * pnpm puzzles:import  (= node tools/import-puzzles.ts)   — Node ≥ 26, zero npm dependencies besides chess.js
 *
 * Streams https://database.lichess.org/lichess_db_puzzle.csv.zst (≈304 MB, CC0) through
 *   HTTP body → multi-frame zstd decompress (node:zlib per frame) → line splitter → kid filter → soft-capped buckets
 * straight into data/build/puzzles.sqlite (node:sqlite). Nothing is stored on disk except the
 * resulting database (unless --keep). Schema: docs/ARCHITECTURE.md §4.
 *
 * Flags:
 *   --from-file <path>   read a local .csv.zst (or plain .csv) instead of downloading
 *   --limit-rows <n>     stop after n data rows (quick test; the download is aborted)
 *   --keep               also save the download to data/raw/lichess/lichess_db_puzzle.csv.zst
 *   --out <path>         output database (default data/build/puzzles.sqlite)
 *   --per-bucket <n>     soft cap per (theme × 100-point rating band), default 80
 *   --max-rating <n>     default 2000
 *   --no-validate        skip replaying every kept solution with chess.js
 *   --url <url>          alternative source URL
 *   --retry-delay <ms>   pause before the second network attempt (default 3000)
 *
 * Failure behaviour: the database is built as <out>.tmp and renamed only after a complete,
 * verified run — a network error or truncated stream never leaves a partial database behind and
 * never destroys a previous good one. Network sources are tried twice. Exit code 1 on failure.
 */
import { createReadStream, createWriteStream, existsSync, rmSync, statSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough, pipeline, Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { displayPath, errorMessage, fmt, fmtBytes, parseCli, parsePositiveInt, repoPath, UsageError } from './lib/cli.ts';
import {
  columnsFromHeader,
  DEFAULT_COLUMNS,
  emptyStats,
  formatStats,
  isHeaderLine,
  parsePuzzleLine,
  PuzzleSelector,
  recordKept,
  validatePuzzleRow,
} from './lib/puzzle-filter.ts';
import type { ColumnIndex, ImportStats } from './lib/puzzle-filter.ts';
import { createMultiFrameZstdDecompress, looksLikeZstd } from './lib/zstd-frames.ts';

const TAG = '[puzzles:import]';
const DEFAULT_URL = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';
const NETWORK_ATTEMPTS = 2;
const BATCH_SIZE = 5000;
const PROGRESS_EVERY_MS = 5000;

/** Exactly the schema of docs/ARCHITECTURE.md §4 (+ one helper index for theme-less picks). */
const SCHEMA_SQL = `
CREATE TABLE puzzle (id TEXT PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL, rating INTEGER NOT NULL, popularity INTEGER, nb_plays INTEGER, themes TEXT NOT NULL);
CREATE TABLE puzzle_theme (theme TEXT NOT NULL, rating INTEGER NOT NULL, puzzle_id TEXT NOT NULL, PRIMARY KEY (theme, rating, puzzle_id)) WITHOUT ROWID;
`;
const INDEX_SQL = 'CREATE INDEX puzzle_rating_idx ON puzzle (rating);';

interface Options {
  fromFile?: string;
  url: string;
  limitRows?: number;
  keep: boolean;
  out: string;
  perBucket: number;
  maxRating: number;
  validate: boolean;
  retryDelayMs: number;
}

interface Source {
  stream: Readable;
  compressed: boolean;
  /** expected number of source bytes, when known */
  totalBytes?: number;
  label: string;
  abort(): void;
}

class ImportError extends Error {}

// ───────────────────────── sources ─────────────────────────

async function openFileSource(file: string): Promise<Source> {
  const abs = path.resolve(file);
  if (!existsSync(abs)) throw new UsageError(`--from-file: no such file: ${abs}`);
  const handle = await open(abs, 'r');
  const head = Buffer.alloc(4);
  try {
    await handle.read(head, 0, 4, 0);
  } finally {
    await handle.close();
  }
  const stream = createReadStream(abs);
  return {
    stream,
    compressed: looksLikeZstd(head),
    totalBytes: statSync(abs).size,
    label: abs,
    abort: () => stream.destroy(),
  };
}

async function openUrlSource(url: string): Promise<Source> {
  const controller = new AbortController();
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'gambit-kids-chess-trainer/0.1 (local build tool)' } });
  } catch (err) {
    throw new ImportError(`cannot reach ${url}: ${errorMessage(err)}`);
  }
  if (!res.ok || !res.body) {
    controller.abort();
    throw new ImportError(`${url} answered HTTP ${res.status} ${res.statusText}`);
  }
  const length = Number(res.headers.get('content-length'));
  return {
    stream: Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
    compressed: !url.endsWith('.csv'),
    totalBytes: Number.isFinite(length) && length > 0 ? length : undefined,
    label: url,
    abort: () => controller.abort(),
  };
}

// ───────────────────────── one import pass ─────────────────────────

async function runImport(options: Options, tmpDb: string): Promise<ImportStats> {
  const source = options.fromFile ? await openFileSource(options.fromFile) : await openUrlSource(options.url);
  console.log(`${TAG} source: ${source.label}${source.totalBytes ? ` (${fmtBytes(source.totalBytes)})` : ''}`);

  // Optional tee of the raw download (--keep).
  let keepStream: WriteStream | undefined;
  let keepPart: string | undefined;
  const keepFinal = repoPath('data', 'raw', 'lichess', 'lichess_db_puzzle.csv.zst');
  if (options.keep && !options.fromFile) {
    await mkdir(path.dirname(keepFinal), { recursive: true });
    keepPart = `${keepFinal}.part`;
    keepStream = createWriteStream(keepPart);
  }

  let sourceBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      sourceBytes += chunk.length;
      if (keepStream && !keepStream.write(chunk)) keepStream.once('drain', () => done(null, chunk));
      else done(null, chunk);
    },
  });
  // A failing --keep file (disk full, permissions) must fail the run, not crash with an unhandled 'error'.
  keepStream?.on('error', (err) => counter.destroy(new ImportError(`cannot write ${keepPart}: ${err.message}`)));

  // NOT zlib.createZstdDecompress(): the Lichess export is multi-frame (pzstd) — see lib/zstd-frames.ts.
  const text: Readable = source.compressed ? createMultiFrameZstdDecompress() : new PassThrough();
  let stoppedEarly = false;
  // pipeline() forwards an error of ANY stage to `text` (destroying it), so the for-await below
  // rejects on network failures and on truncated zstd frames alike.
  pipeline(source.stream, counter, text as PassThrough, () => undefined);
  text.setEncoding('utf8');

  rmSync(tmpDb, { force: true });
  const db = new DatabaseSync(tmpDb);
  const stats = emptyStats();
  const started = Date.now();
  let lastProgress = started;

  try {
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    db.exec(SCHEMA_SQL);
    const insertPuzzle = db.prepare('INSERT OR IGNORE INTO puzzle (id, fen, moves, rating, popularity, nb_plays, themes) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertTheme = db.prepare('INSERT OR IGNORE INTO puzzle_theme (theme, rating, puzzle_id) VALUES (?, ?, ?)');
    const selector = new PuzzleSelector({ perBucket: options.perBucket, maxRating: options.maxRating });

    let columns: ColumnIndex = DEFAULT_COLUMNS;
    let firstLine = true;
    let inBatch = 0;
    db.exec('BEGIN');

    const handleLine = (line: string): void => {
      if (firstLine) {
        firstLine = false;
        if (isHeaderLine(line)) {
          columns = columnsFromHeader(line);
          return;
        }
      }
      if (line === '') return;
      stats.scanned++;
      const row = parsePuzzleLine(line, columns);
      if (!row) {
        stats.malformed++;
        return;
      }
      const verdict = selector.consider(row);
      if (!verdict.accept) {
        stats.rejected[verdict.reason]++;
        return;
      }
      if (options.validate && validatePuzzleRow(row).length > 0) {
        stats.invalid++;
        return;
      }
      const inserted = insertPuzzle.run(row.id, row.fen, row.moves, row.rating, row.popularity, row.nbPlays, row.themes);
      if (inserted.changes === 0) return; // duplicate id — cannot happen in the official export
      for (const theme of new Set(row.themes.split(' '))) {
        if (theme !== '') insertTheme.run(theme, row.rating, row.id);
      }
      selector.commit(row, verdict.kidThemes);
      recordKept(stats, row);
      if (++inBatch >= BATCH_SIZE) {
        db.exec('COMMIT; BEGIN');
        inBatch = 0;
      }
    };

    let rest = '';
    try {
      outer: for await (const chunk of text as AsyncIterable<string>) {
        const data = rest + chunk;
        let from = 0;
        for (let nl = data.indexOf('\n', from); nl >= 0; nl = data.indexOf('\n', from)) {
          const end = nl > from && data.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
          handleLine(data.slice(from, end));
          from = nl + 1;
          if (options.limitRows !== undefined && stats.scanned >= options.limitRows) {
            stoppedEarly = true;
            break outer;
          }
        }
        rest = data.slice(from);

        const now = Date.now();
        if (now - lastProgress >= PROGRESS_EVERY_MS) {
          lastProgress = now;
          const pct = source.totalBytes ? ` (${((sourceBytes / source.totalBytes) * 100).toFixed(1)} %)` : '';
          console.log(`${TAG}   … read ${fmtBytes(sourceBytes)}${pct}, scanned ${fmt(stats.scanned)} rows, kept ${fmt(stats.kept)}`);
        }
      }
      if (!stoppedEarly && rest !== '') handleLine(rest.replace(/\r$/, ''));
    } catch (err) {
      // Typical: network reset mid-download, or Z_BUF_ERROR for a truncated .zst.
      throw new ImportError(
        `stream failed after ${fmtBytes(sourceBytes)} / ${fmt(stats.scanned)} rows: ${errorMessage(err)}` +
          (source.compressed ? ' — the download was interrupted or the .zst file is truncated' : ''),
      );
    } finally {
      source.abort();
    }

    if (!stoppedEarly && source.totalBytes !== undefined && sourceBytes < source.totalBytes) {
      throw new ImportError(`source ended early: got ${fmt(sourceBytes)} of ${fmt(source.totalBytes)} bytes`);
    }
    if (stats.kept === 0) {
      throw new ImportError(`no puzzle passed the filter (${fmt(stats.scanned)} rows scanned, ${fmt(stats.malformed)} malformed) — is this a Lichess puzzle CSV?`);
    }

    db.exec('COMMIT');
    db.exec(INDEX_SQL);
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== 'ok') throw new ImportError(`SQLite quick_check failed: ${JSON.stringify(check)}`);
    const counted = db.prepare('SELECT count(*) AS n FROM puzzle').get() as { n: number };
    if (counted.n !== stats.kept) throw new ImportError(`row count mismatch: database has ${counted.n}, expected ${stats.kept}`);
    db.exec('PRAGMA journal_mode = DELETE;');
  } catch (err) {
    closeQuietly(db);
    keepStream?.destroy();
    if (keepPart) rmSync(keepPart, { force: true });
    throw err;
  }
  db.close();

  if (keepStream && keepPart) {
    await new Promise<void>((resolve, reject) => {
      keepStream.once('error', reject);
      keepStream.end(resolve);
    });
    if (stoppedEarly) rmSync(keepPart, { force: true });
    else {
      await rename(keepPart, keepFinal);
      console.log(`${TAG} raw download kept at ${displayPath(keepFinal)} (${fmtBytes(sourceBytes)})`);
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${TAG} pass finished in ${seconds} s${stoppedEarly ? ` (stopped after --limit-rows ${options.limitRows})` : ''}`);
  return stats;
}

function closeQuietly(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

// ───────────────────────── main ─────────────────────────

function readOptions(argv: string[]): Options | 'help' {
  const args = parseCli(argv, {
    'from-file': { type: 'string' },
    'limit-rows': { type: 'string' },
    keep: { type: 'boolean' },
    out: { type: 'string' },
    'per-bucket': { type: 'string' },
    'max-rating': { type: 'string' },
    'no-validate': { type: 'boolean' },
    url: { type: 'string' },
    'retry-delay': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (args.help) return 'help';
  return {
    fromFile: args['from-file'],
    url: args.url ?? DEFAULT_URL,
    limitRows: parsePositiveInt(args['limit-rows'], '--limit-rows'),
    keep: args.keep ?? false,
    out: path.resolve(args.out ?? repoPath('data', 'build', 'puzzles.sqlite')),
    perBucket: parsePositiveInt(args['per-bucket'], '--per-bucket') ?? 80,
    maxRating: parsePositiveInt(args['max-rating'], '--max-rating') ?? 2000,
    validate: !(args['no-validate'] ?? false),
    retryDelayMs: parsePositiveInt(args['retry-delay'], '--retry-delay') ?? 3000,
  };
}

const HELP = `Usage: node tools/import-puzzles.ts [--from-file <path>] [--limit-rows <n>] [--keep] [--out <path>]
                                     [--per-bucket <n>] [--max-rating <n>] [--no-validate] [--url <url>] [--retry-delay <ms>]`;

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  if (options === 'help') {
    console.log(HELP);
    return;
  }
  const tmpDb = `${options.out}.tmp`;
  await mkdir(path.dirname(options.out), { recursive: true });

  const cleanup = (): void => {
    for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${tmpDb}${suffix}`, { force: true });
  };
  process.once('SIGINT', () => {
    cleanup();
    console.error(`\n${TAG} interrupted — partial database removed`);
    process.exit(130);
  });

  const attempts = options.fromFile ? 1 : NETWORK_ATTEMPTS;
  let stats: ImportStats | undefined;
  for (let attempt = 1; attempt <= attempts && !stats; attempt++) {
    try {
      stats = await runImport(options, tmpDb);
    } catch (err) {
      cleanup();
      if (err instanceof UsageError || attempt === attempts) throw err;
      console.warn(`${TAG} attempt ${attempt}/${attempts} failed: ${errorMessage(err)}`);
      console.warn(`${TAG} retrying in ${(options.retryDelayMs / 1000).toFixed(1)} s…`);
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
    }
  }
  if (!stats) throw new ImportError('import did not produce a result');

  for (const suffix of ['-journal', '-wal', '-shm']) rmSync(`${options.out}${suffix}`, { force: true });
  await rename(tmpDb, options.out);

  const statsFile = options.out.replace(/\.sqlite$/, '') + '.stats.json';
  await writeFile(
    statsFile,
    `${JSON.stringify({ source: options.fromFile ?? options.url, limitRows: options.limitRows ?? null, perBucket: options.perBucket, maxRating: options.maxRating, ...stats }, null, 2)}\n`,
    'utf8',
  );

  console.log(`\n${formatStats(stats)}\n`);
  console.log(`${TAG} wrote ${displayPath(options.out)} (${fmtBytes(statSync(options.out).size)}), stats → ${displayPath(statsFile)}`);
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) console.error(`${TAG} usage error: ${err.message}\n${HELP}`);
  else {
    console.error(`${TAG} FAILED: ${errorMessage(err)}`);
    console.error(`${TAG} no database was written (partial file removed). Check the network and run "pnpm puzzles:import" again,`);
    console.error(`${TAG} or download the file manually and use --from-file <path>. Until then the app uses kb/puzzles-starter.json.`);
  }
  process.exitCode = 1;
});
