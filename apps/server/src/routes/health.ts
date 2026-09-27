import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { API_BASE } from '@gambit/shared';
import type { HealthInfo, ServerBuildInfo } from '@gambit/shared';
import type { ServerContext } from '../context.ts';

// ───────────────────────── which code runs (the launcher compares it with the code on disk) ─────────────────────────

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** a ref under refs/ — never `..`, never an absolute path */
const REF_RE = /^refs\/[A-Za-z0-9._/-]+$/;

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * The short commit (7 hex digits, as `git rev-parse --short=7 HEAD`) of the checkout at `repoRoot`, read straight from
 * `.git` — no `git` process (on a Mac without the command line tools that would pop up an installer). Handles a
 * detached HEAD, loose and packed refs and a worktree (`.git` file). Null outside a git checkout or on anything odd.
 * Шахматы.command reads it the same way.
 */
export function readGitSha(repoRoot: string): string | null {
  try {
    let gitDir = join(repoRoot, '.git');
    if (!existsSync(gitDir)) return null;
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readText(gitDir) ?? '')?.[1];
      if (pointer === undefined) return null;
      gitDir = resolve(repoRoot, pointer.trim());
    }
    const head = readText(join(gitDir, 'HEAD')) ?? '';
    if (SHA_RE.test(head)) return head.slice(0, 7);
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
    if (ref === undefined || !REF_RE.test(ref) || ref.includes('..')) return null;
    // a worktree keeps its refs in the common dir
    const common = readText(join(gitDir, 'commondir'));
    const dirs = common === null ? [gitDir] : [gitDir, resolve(gitDir, common)];
    for (const dir of dirs) {
      const loose = readText(join(dir, ref));
      if (loose !== null && SHA_RE.test(loose)) return loose.slice(0, 7);
    }
    for (const dir of dirs) {
      for (const line of (readText(join(dir, 'packed-refs')) ?? '').split('\n')) {
        const [sha, name] = line.trim().split(' ');
        if (name === ref && sha !== undefined && SHA_RE.test(sha)) return sha.slice(0, 7);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function mtimeIso(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

// ───────────────────────── is DATA_DIR a throw-away folder? ─────────────────────────

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The OS temp dir and the usual temp roots (macOS: /tmp → /private/tmp, $TMPDIR under /var/folders). */
export function defaultTempRoots(): string[] {
  const roots = [tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'];
  return [...new Set(roots.flatMap((root) => [resolve(root), realOrResolved(root)]))].filter((root) => root.length > 1);
}

/**
 * True when `dir` lies inside a temp folder — the DATA_DIR of a test or a smoke run. The smoke scripts
 * (tools/voice-smoke) write a profile and games only to such a server: the child's real `data/` is never one.
 */
export function isTempDir(dir: string, tempRoots: readonly string[] = defaultTempRoots()): boolean {
  const real = realOrResolved(dir);
  return tempRoots.some((root) => real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
}

// ───────────────────────── activity: is somebody playing / talking right now? ─────────────────────────

const HEALTH_PATH = `${API_BASE}/health`;
const lastActivityAt = new WeakMap<ServerContext, number>();

/**
 * Remembers the time of the newest /api request that is not a health check (mounted on `/api/*` in app.ts): a game
 * asks for its strategy and re-plans, a conversation opens voice sessions and sends its black box every few seconds,
 * a finished game is saved. Health checks (the launcher, the settings screen) never count.
 */
export function activityRecorder(ctx: ServerContext, now: () => number = () => Date.now()): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    if (path !== HEALTH_PATH && !path.startsWith(`${HEALTH_PATH}/`)) lastActivityAt.set(ctx, now());
    await next();
  };
}

// ───────────────────────── the route ─────────────────────────

export interface HealthRouteOptions {
  now?: () => number;
  /** tests: another checkout */
  gitSha?: string | null;
}

/**
 * `GET /health` — which optional upgrades (LLM review, live / realtime voice) are available right now, which code runs
 * (`build`), whether DATA_DIR is a throw-away folder (`dataDirIsTemp`), how long the app has been idle (`activity`) and
 * whether missing lesson phrases are recorded (`clipGen`: 'off' | 'ready' | 'paused' + a reason code).
 * Booleans, model ids, a commit and times only — never a key, never a path.
 *
 * Runtime AI off (GAMBIT_RUNTIME_AI unset — docs/TEACHING.md §4.4): `ai.runtime` false, no live / realtime voice,
 * `preferred: 'clips'`, and codex is not asked (`codex login status` is never spawned); the keys are still reported as
 * present / absent, so the settings can tell the parent a key is there but unused.
 */
export function healthRoutes(ctx: ServerContext, options: HealthRouteOptions = {}) {
  const now = options.now ?? (() => Date.now());
  // read once: the commit the server STARTED from (the launcher compares it with the checkout on disk); a container
  // has no .git — its image says which commit it was built from (GAMBIT_BUILD_SHA)
  const gitSha = options.gitSha !== undefined ? options.gitSha : (readGitSha(ctx.config.repoRoot) ?? ctx.config.buildSha);
  const startedAt = new Date(now()).toISOString();
  const dataDirIsTemp = isTempDir(ctx.config.dataDir);
  return new Hono().get('/', async (c) => {
    const runtime = ctx.config.runtimeAi === true;
    // runtime AI off: codex is never spawned (not even `codex login status`)
    const codex = runtime ? await ctx.codex.status() : { cli: false, loggedIn: false };
    const openaiKey = ctx.config.openaiApiKey !== null;
    // the voice routes answer 503 without runtime AI (routes/voice.ts), so no voice is promised then
    const voiceAvailable = runtime && openaiKey;
    const last = lastActivityAt.get(ctx);
    const build: ServerBuildInfo = { gitSha, startedAt, distBuiltAt: mtimeIso(join(ctx.config.webDistDir, 'index.html')) };
    // codex skipped right now (its limit, a failed login, failures, too slow for a game's first line): the settings must
    // not promise «через подписку Codex» then
    const codexPaused = runtime ? ctx.strategist.codexPause() : null;
    const health: HealthInfo = {
      ok: true,
      llm: { codexCli: codex.cli, codexLoggedIn: codex.loggedIn, openaiKey, openrouterKey: ctx.config.openrouterApiKey !== null, ...(codexPaused !== null ? { codexPaused } : {}) },
      voice: {
        realtime: voiceAvailable,
        model: ctx.config.voiceModel,
        voice: ctx.config.voiceName,
        // full-duplex gpt-live-1 (POST /api/voice/live); same key as realtime
        live: voiceAvailable,
        liveModel: ctx.config.voiceLiveModel,
        preferred: runtime ? ctx.config.voicePreferred : 'clips',
      },
      puzzles: { count: ctx.puzzles.count() },
      dataDirIsTemp,
      build,
      activity: { idleSeconds: last === undefined ? null : Math.max(0, Math.floor((now() - last) / 1000)) },
      ai: { runtime },
      // «Дозапись голоса»: codes only, from memory and a few file stats — never a CLI call, a path or a key
      clipGen: ctx.clipGen.health(),
    };
    return c.json(health);
  });
}
