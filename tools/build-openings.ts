/**
 * pnpm openings:build  (= node tools/build-openings.ts)
 *
 * Downloads a.tsv … e.tsv from lichess-org/chess-openings (CC0, GitHub master — NOT the stale
 * Hugging Face mirror), replays every PGN with chess.js to get the EPD of the named position and
 * writes packages/openings/src/generated/openings.json as a compact `{ epd: [eco, name] }` map.
 *
 * Flags:
 *   --from-dir <dir>   read a.tsv … e.tsv from a local directory instead of downloading
 *   --out <file>       output path (default packages/openings/src/generated/openings.json)
 *   --base-url <url>   alternative download base (default raw.githubusercontent.com/…/master/)
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { displayPath, errorMessage, fmt, fmtBytes, parseCli, repoPath, UsageError } from './lib/cli.ts';
import { buildOpeningTable, parseOpeningsTsv, serializeOpeningTable } from './lib/openings-build.ts';
import type { OpeningTsvRow } from './lib/openings-build.ts';

const TAG = '[openings:build]';
const DEFAULT_BASE_URL = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master/';
const VOLUMES = ['a', 'b', 'c', 'd', 'e'] as const;
const MIN_EXPECTED_ENTRIES = 3000;
const FETCH_ATTEMPTS = 2;
const FETCH_TIMEOUT_MS = 30_000;

async function fetchText(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      console.warn(`${TAG} attempt ${attempt}/${FETCH_ATTEMPTS} failed for ${url}: ${errorMessage(err)}`);
    }
  }
  throw new Error(`could not download ${url}: ${errorMessage(lastError)}`);
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2), {
    'from-dir': { type: 'string' },
    out: { type: 'string' },
    'base-url': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (args.help) {
    console.log('Usage: node tools/build-openings.ts [--from-dir <dir>] [--out <file>] [--base-url <url>]');
    return;
  }

  const outFile = path.resolve(args.out ?? repoPath('packages', 'openings', 'src', 'generated', 'openings.json'));
  const baseUrl = (args['base-url'] ?? DEFAULT_BASE_URL).replace(/\/?$/, '/');
  const started = performance.now();

  const rows: OpeningTsvRow[] = [];
  for (const volume of VOLUMES) {
    const fileName = `${volume}.tsv`;
    const text = args['from-dir']
      ? await readFile(path.resolve(args['from-dir'], fileName), 'utf8')
      : await fetchText(new URL(fileName, baseUrl).href);
    const parsed = parseOpeningsTsv(text);
    console.log(`${TAG} ${fileName}: ${fmt(parsed.length)} rows`);
    rows.push(...parsed);
  }

  const result = buildOpeningTable(rows);
  for (const e of result.errors.slice(0, 10)) {
    console.error(`${TAG} cannot replay "${e.row.name}" (${e.row.pgn}): ${e.message}`);
  }
  if (result.errors.length > 0) {
    throw new Error(`${result.errors.length} of ${result.rows} PGNs could not be replayed — refusing to write a partial book`);
  }
  const entries = Object.keys(result.table).length;
  if (entries < MIN_EXPECTED_ENTRIES) {
    throw new Error(`only ${entries} named positions (expected > ${MIN_EXPECTED_ENTRIES}) — source data looks truncated`);
  }

  const json = serializeOpeningTable(result.table);
  await mkdir(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp`;
  await writeFile(tmp, json, 'utf8');
  await rename(tmp, outFile);

  const ms = Math.round(performance.now() - started);
  console.log(
    `${TAG} ${fmt(result.rows)} rows → ${fmt(entries)} named positions ` +
      `(${result.duplicates} duplicate positions skipped), ${fmtBytes(Buffer.byteLength(json))} → ${displayPath(outFile)} in ${ms} ms`,
  );
}

main().catch((err: unknown) => {
  console.error(`${TAG} ${err instanceof UsageError ? 'usage error' : 'FAILED'}: ${errorMessage(err)}`);
  process.exitCode = 1;
});
