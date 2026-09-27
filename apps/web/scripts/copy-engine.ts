/**
 * Copies the Stockfish 19 "lite single-threaded" build from node_modules/stockfish
 * into apps/web/public/engine/ so it is served as a static classic Worker:
 *
 *   new Worker('/engine/stockfish-19-lite-single.js')   // the .wasm is found next to it
 *
 * The engine file must NOT go through the bundler. Runs automatically before
 * `vite` / `vite build` (see package.json) and via `pnpm engine:copy` from the repo root.
 * Executed by Node 26 directly (native type stripping) — erasable syntax only.
 */
import { copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface EngineFile {
  /** file name inside node_modules/stockfish (relative to the package root) */
  source: string;
  /** file name inside public/engine */
  target: string;
  /** sanity bounds in bytes — guards against picking the 94 MB build or a truncated file */
  minBytes: number;
  maxBytes: number;
}

const ENGINE_FILES: EngineFile[] = [
  // stockfish@19.0.0: 21 415 bytes
  { source: 'bin/stockfish-19-lite-single.js', target: 'stockfish-19-lite-single.js', minBytes: 10_000, maxBytes: 100_000 },
  // stockfish@19.0.0: 1 787 571 bytes
  { source: 'bin/stockfish-19-lite-single.wasm', target: 'stockfish-19-lite-single.wasm', minBytes: 1_000_000, maxBytes: 4_000_000 },
  // GPL-3.0: keep the licence next to the binary
  { source: 'Copying.txt', target: 'LICENSE-stockfish.txt', minBytes: 1_000, maxBytes: 200_000 },
];

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = join(webRoot, 'public', 'engine');

function findStockfishDir(): string {
  const candidates = [
    join(webRoot, 'node_modules', 'stockfish'),
    join(webRoot, '..', '..', 'node_modules', 'stockfish'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  throw new Error(
    'Package "stockfish" is not installed. Run `pnpm install` in the repo root first.\n' +
      `Looked in:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
  );
}

function formatBytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(2)} MB` : `${(bytes / 1_000).toFixed(1)} KB`;
}

function copyEngine(): void {
  const stockfishDir = findStockfishDir();
  mkdirSync(targetDir, { recursive: true });

  for (const file of ENGINE_FILES) {
    const from = join(stockfishDir, file.source);
    const to = join(targetDir, file.target);
    if (!existsSync(from)) {
      throw new Error(`Engine file is missing in the stockfish package: ${from}`);
    }
    const size = statSync(from).size;
    if (size < file.minBytes || size > file.maxBytes) {
      throw new Error(
        `Unexpected size of ${file.source}: ${size} bytes (expected ${file.minBytes}…${file.maxBytes}). ` +
          'The stockfish package layout has probably changed — check the pinned version (19.0.0).',
      );
    }
    const upToDate = existsSync(to) && statSync(to).size === size;
    if (!upToDate) copyFileSync(from, to);
    console.log(`[engine:copy] ${upToDate ? 'ok    ' : 'copied'} ${file.target} (${formatBytes(size)})`);
  }
}

try {
  copyEngine();
} catch (error) {
  console.error(`[engine:copy] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
