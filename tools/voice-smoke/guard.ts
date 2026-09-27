/**
 * Safety rails of the voice smoke scripts (run.mjs, conversation.mjs, teacher.mjs, review.mjs): a test
 * never touches the child's server or data, never talks aloud, never spends money by accident.
 *
 *  - `--base-url` is MANDATORY: no default server. It must be plain http on a loopback host with an explicit port, and
 *    never the real stack's ports (8787 = the child's server, 5173 = the Vite dev server that proxies to it).
 *  - The server must be a Гамбитик server that reports a throw-away DATA_DIR (`GET /api/health` → `dataDirIsTemp`):
 *    only then may a script put the profile «Тигр» and play / save games there.
 *  - Output goes to test-results/voice-samples (git-ignored), scratch files to the OS temp dir; no path given on the
 *    command line (`--out`, `--shots`, `--work`, `--data-dir`, `--reanalyse`) may lie inside the real `data/`.
 *
 * Plain functions that throw `SmokeGuardError` (tested in guard.test.ts) + `…OrExit` wrappers for the scripts.
 */
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SERVER_PORT, WEB_DEV_PORT } from '@gambit/shared';

/** The real stack: the child's server and the Vite dev port that proxies to it. A smoke script never talks to them. */
export const OWNER_PORTS: readonly number[] = [SERVER_PORT, WEB_DEV_PORT];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Default output folder (git-ignored: `test-results/`), relative to the repository root. */
export const DEFAULT_OUT_DIR = join('test-results', 'voice-samples');

export class SmokeGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmokeGuardError';
  }
}

const HOW_TO =
  'start a throw-away server first, e.g. `GAMBIT_API_PORT=8788 DATA_DIR="${TMPDIR:-/tmp}/gambit-smoke/data" … node apps/server/src/index.ts` ' +
  '(see tools/voice-smoke/README.md), then pass --base-url http://127.0.0.1:8788';

/** The value after `--name` in argv (undefined when absent or when the flag is the last word). */
export function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * The server a script may talk to: `--base-url` from argv, checked. Throws on a missing flag, a bare `--base` flag,
 * anything that is not `http://<loopback>:<port>` and the real stack's ports.
 */
export function parseBaseUrl(argv: readonly string[]): string {
  if (argv.includes('--base')) throw new SmokeGuardError('--base was renamed: pass --base-url (there is no default server any more)');
  const raw = argValue(argv, 'base-url');
  if (raw === undefined || raw.startsWith('--')) throw new SmokeGuardError(`--base-url is required — ${HOW_TO}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SmokeGuardError(`--base-url «${raw}» is not a URL — ${HOW_TO}`);
  }
  if (url.protocol !== 'http:') throw new SmokeGuardError(`--base-url must be http:// (a local test server), got «${raw}»`);
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new SmokeGuardError(`--base-url must point at this computer (127.0.0.1 / localhost), got «${url.hostname}»`);
  if (url.port === '') throw new SmokeGuardError(`--base-url needs an explicit port (e.g. http://127.0.0.1:8788), got «${raw}»`);
  const port = Number(url.port);
  if (OWNER_PORTS.includes(port)) {
    throw new SmokeGuardError(`port ${port} is the owner's own Гамбитик (${OWNER_PORTS.join(' / ')}) — smoke scripts never touch it; ${HOW_TO}`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new SmokeGuardError(`--base-url is the server's origin only (no path / query), got «${raw}»`);
  }
  return url.origin;
}

/** What the scripts read from GET /api/health (a subset of HealthInfo, loosely typed: it comes over the wire). */
export interface SmokeHealth {
  ok: true;
  llm: { openaiKey: boolean; [key: string]: unknown };
  voice: { live?: boolean; liveModel?: string; model: string; voice: string; realtime: boolean; preferred?: string };
  dataDirIsTemp?: boolean;
  build?: { gitSha: string | null; startedAt: string; distBuiltAt: string | null };
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The health answer must come from a Гамбитик server whose DATA_DIR is a temp folder. An older server (no
 * `dataDirIsTemp`) or one on the real `data/` is refused: the scripts write a profile and games.
 */
export function assertSafeHealth(health: unknown, baseUrl: string): SmokeHealth {
  if (!isRecord(health) || health.ok !== true || !isRecord(health.llm) || !isRecord(health.voice) || !isRecord(health.puzzles)) {
    throw new SmokeGuardError(`${baseUrl} is not a Гамбитик server (unexpected /api/health) — refusing to run`);
  }
  if (health.dataDirIsTemp !== true) {
    const why = health.dataDirIsTemp === false ? 'its DATA_DIR is not a temp folder (the child’s real data?)' : 'it does not report dataDirIsTemp (an older server?)';
    throw new SmokeGuardError(`${baseUrl}: ${why} — refusing to write a profile or games there. Start the server with DATA_DIR under ${tmpdir()} or /tmp.`);
  }
  return health as unknown as SmokeHealth;
}

/** GET /api/health of `baseUrl`, then `assertSafeHealth`. */
export async function fetchSafeHealth(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<SmokeHealth> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/health`);
  } catch {
    throw new SmokeGuardError(`no server on ${baseUrl} — ${HOW_TO}`);
  }
  if (!response.ok) throw new SmokeGuardError(`${baseUrl}/api/health → ${response.status} — is this a Гамбитик server?`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SmokeGuardError(`${baseUrl}/api/health did not answer JSON — not a Гамбитик server`);
  }
  return assertSafeHealth(body, baseUrl);
}

/** An output folder (`--out` or the default) resolved against the repository root; never inside the real `data/`. */
export function outDir(root: string, value: string | undefined, fallback: string = DEFAULT_OUT_DIR): string {
  return safeLocalPath(root, value ?? fallback, '--out');
}

/** A path given on the command line, resolved against `root`; refused when it lies inside `<root>/data` (the child's data). */
export function safeLocalPath(root: string, value: string, flag: string): string {
  const path = resolve(root, value);
  const fromData = relative(join(root, 'data'), path);
  const outside = fromData === '..' || fromData.startsWith(`..${sep}`) || isAbsolute(fromData);
  if (!outside) throw new SmokeGuardError(`${flag} ${value} is inside data/ — the child's real data is never touched`);
  return path;
}

/** Scratch files (synthesised child lines, raw recordings): the OS temp dir, never the repository. */
export function scratchDir(name: string): string {
  return join(tmpdir(), 'gambit-voice-smoke', name);
}

/** The scratch folder: `--work` (resolved against `root`) or `scratchDir(name)`; never inside the real `data/`. */
export function workDir(root: string, value: string | undefined, name: string): string {
  return safeLocalPath(root, value ?? scratchDir(name), '--work');
}

function exitWith(error: unknown): never {
  console.error(error instanceof SmokeGuardError ? `voice-smoke: ${error.message}` : error);
  process.exit(2);
}

/** Runs a guard; prints the reason and exits with code 2 when it refuses (e.g. `--out data/…`). */
export function orExit<T>(guard: () => T): T {
  try {
    return guard();
  } catch (error) {
    return exitWith(error);
  }
}

/** `parseBaseUrl`, printing the reason and exiting with code 2 when the flag is missing or unsafe. */
export function baseUrlOrExit(argv: readonly string[] = process.argv): string {
  return orExit(() => parseBaseUrl(argv));
}

/** `fetchSafeHealth`, printing the reason and exiting with code 2 when the server is not a safe target. */
export async function safeHealthOrExit(baseUrl: string): Promise<SmokeHealth> {
  try {
    return await fetchSafeHealth(baseUrl);
  } catch (error) {
    return exitWith(error);
  }
}
