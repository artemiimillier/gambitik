/**
 * «Дозапись голоса»: the child processes of the recorder — the Higgsfield CLI (`RunCli`) and the tools' free `process`
 * / `verify` steps («finish») plus the ffmpeg / whisper probe. Like `codexChildEnv`: an allow-listed environment (no
 * key, no token ever reaches a child), no shell, arguments never interpolated, each child in its own process group
 * that is killed whole on a timeout or at shutdown (`ChildRunner.dispose`).
 *
 * Nothing here decides whether a call may happen: the service's gates run first (docs/voice-clips/ONDEMAND.md). Tests never reach a
 * real binary — they inject a fake `RunCli` / finish, or run a fake shell script through `higgsfieldRunCli`.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { DEFAULT_WHISPER_MODEL, VOICE_KEY, WHISPER_BIN, WHISPER_MODEL, isToolFailureFlag, readCurrentManifest } from './bridge.ts';
import type { CliResult, RunCli } from './bridge.ts';
import type { OverlayPaths } from './overlay.ts';

// ───────────────────────── the environment of a child ─────────────────────────

/** Exact names copied into a child's environment; everything else (the keys of `.env` included) is dropped. */
const CHILD_ENV_ALLOW = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LANGUAGE']);
/** belt and braces: even an allow-listed or LC_* name never carries something that looks like a secret */
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
/** plain output, no self-update check (it would print and slow every call), no telemetry */
export const CHILD_FLAGS = { NO_COLOR: '1', HIGGSFIELD_NO_UPDATE_CHECK: '1', HIGGSFIELD_DISABLE_TELEMETRY: '1' } as const;
/** ffmpeg and whisper-cli come from Homebrew; the launcher's PATH may not have it */
const TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

/** The environment of a Higgsfield CLI child: the allow-list plus `CHILD_FLAGS`. The CLI signs in from HOME. */
export function clipGenChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!CHILD_ENV_ALLOW.has(name) && !/^LC_[A-Z_]+$/.test(name)) continue;
    if (SECRET_NAME_RE.test(name)) continue;
    env[name] = value;
  }
  return { ...env, ...CHILD_FLAGS };
}

/** The environment of the finish children (the tools' `process` / `verify`): the same, with Homebrew on PATH. */
export function finishChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = clipGenChildEnv(base);
  const dirs = (env.PATH ?? '').split(delimiter).filter((d) => d !== '');
  env.PATH = [...dirs, ...TOOL_DIRS.filter((d) => !dirs.includes(d))].join(delimiter);
  return env;
}

// ───────────────────────── one process group per child ─────────────────────────

export interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const STDOUT_CAP = 4 * 1024 * 1024;
const STDERR_CAP = 64 * 1024;

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  try {
    // detached: true made the child a process-group leader — signal the whole group (the CLI may spawn helpers)
    if (pid !== undefined) process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Spawns children and remembers them, so a shutdown kills every one (the ledger lets the next start resume). */
export class ChildRunner {
  private readonly children = new Set<ChildProcess>();
  private disposed = false;

  run(command: string, args: readonly string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number; cwd?: string }): Promise<ChildResult> {
    if (this.disposed) return Promise.resolve({ code: 1, stdout: '', stderr: 'shutting down', timedOut: false });
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let done = false;
      const child = spawn(command, [...args], { env: o.env, cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false });
      this.children.add(child);
      const finish = (code: number, timedOut: boolean, extra = ''): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.children.delete(child);
        resolve({ code, stdout, stderr: `${stderr}${extra}`, timedOut });
      };
      const timer = setTimeout(() => {
        killTree(child, 'SIGTERM');
        setTimeout(() => killTree(child, 'SIGKILL'), 1_500).unref();
        finish(1, true, `\ntimed out after ${o.timeoutMs} ms`);
      }, o.timeoutMs);
      timer.unref();
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < STDOUT_CAP) stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => finish(1, false, `\n${error.message}`));
      child.on('close', (code) => finish(typeof code === 'number' ? code : 1, false));
    });
  }

  /** Kills every running child (SIGTERM, then SIGKILL) and refuses new ones. */
  dispose(): void {
    this.disposed = true;
    for (const child of this.children) {
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 1_500).unref();
    }
    this.children.clear();
  }
}

// ───────────────────────── the Higgsfield CLI ─────────────────────────

/** `generate wait --timeout` of the server: a job is done in ≈ 5 s; a longer one stays pending and is resumed. */
export const SERVER_WAIT_TIMEOUT = '3m';

/** The process timeout of one CLI call: create 60 s, wait 3.5 min (its own --timeout is 3 min), anything else 30 s. */
export function cliTimeoutMs(args: readonly string[]): number {
  if (args[0] === 'generate' && args[1] === 'wait') return 210_000;
  if (args[0] === 'generate' && args[1] === 'create') return 60_000;
  return 30_000;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** How a binary is started: a `.js` wrapper (an npm bin) runs on this very node — no `node` is needed on PATH. */
export function commandOf(bin: string): { command: string; prefix: string[] } {
  let real = bin;
  try {
    real = realpathSync(bin);
  } catch {
    // a missing file fails at spawn with a clear error
  }
  return /\.[cm]?js$/i.test(real) ? { command: process.execPath, prefix: [real] } : { command: bin, prefix: [] };
}

/** The real `RunCli`: `higgsfield <args>` through `runner`, allow-listed env, per-call timeouts. */
export function higgsfieldRunCli(bin: string, runner: ChildRunner, env: NodeJS.ProcessEnv = clipGenChildEnv()): RunCli {
  const { command, prefix } = commandOf(bin);
  return async (args): Promise<CliResult> => {
    const result = await runner.run(command, [...prefix, ...args], { env, timeoutMs: cliTimeoutMs(args) });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  };
}

// ───────────────────────── finish: the tools' process + verify, as children ─────────────────────────

export interface FinishInput {
  jobId: string;
  /** the job's kept pieces: their clip ids (`clipId(voice, prompt, cut, take)`), unit keys and texts */
  units: readonly { id: string; key: string; text: string }[];
}

export interface FinishResult {
  /** clip ids of `units` that the overlay manifest now publishes (checked by ASR under the overlay QA rule) */
  published: string[];
}

/** Processes, checks and publishes one downloaded job into the overlay. Throws when a step could not run. */
export type FinishFn = (input: FinishInput) => Promise<FinishResult>;

/**
 * The real finish: `node tools/voice-clips/cli.ts process --overlay <ov> --job <id>` (60 s) then `verify --unit <ids>` (90 s) as
 * children against the overlay's paths — the DSP and whisper never block the server's event loop, and the tools keep
 * one implementation of cutting, loudness, QA and publishing. The result is read back from the overlay manifest:
 * only a published take ever reaches the child.
 */
export function createToolsFinish(o: { repoRoot: string; overlay: OverlayPaths; workDir: string; runner: ChildRunner; env?: NodeJS.ProcessEnv; log: (line: string) => void }): FinishFn {
  const env = o.env ?? finishChildEnv();
  const cli = join(o.repoRoot, 'tools', 'voice-clips', 'cli.ts');
  // `--overlay` makes the tools publish with the overlay's QA rule (hard / soft gates, `ctx`, `blocked`); the paths are
  // also given explicitly, so the server and the tools can never disagree about where a file is
  const common = ['--overlay', o.overlay.dir, '--ledger', o.overlay.ledger, '--masters', o.overlay.masters, '--units', o.overlay.units, '--review-file', o.overlay.review, '--library', o.overlay.dir, '--work', o.workDir];
  return async (input) => {
    if (process.env.VITEST) throw new Error('the real finish never runs under vitest (inject a fake)');
    const started = Date.now();
    const processed = await o.runner.run(process.execPath, [cli, 'process', '--job', input.jobId, ...common, '--report', o.overlay.processReport], { env, timeoutMs: 60_000, cwd: o.repoRoot });
    if (processed.code !== 0) throw new Error(`voice:process ${processed.timedOut ? 'timed out' : `exit ${processed.code}`}`);
    const ids = input.units.flatMap((u) => ['--unit', u.id]);
    const verified = await o.runner.run(process.execPath, [cli, 'verify', ...ids, ...common, '--report', o.overlay.verifyReport], { env, timeoutMs: 90_000, cwd: o.repoRoot });
    if (verified.code !== 0) throw new Error(`voice:verify ${verified.timedOut ? 'timed out' : `exit ${verified.code}`}`);
    return finishResultOf(o.overlay, input, started);
  };
}

function readReport(file: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * What a finish published — or an error when a tool could not do its part. Both children exit 0 when the recogniser is
 * broken (a `brew upgrade` left whisper-cli without its library: verify turns ASR off, or every transcription throws),
 * and then nothing is published. Taken as a verdict, that would buy a take 2 of every unit and give each one up, while
 * the breaker never noticed. So the reports of THIS finish are read: ASR off, a unit of the job whose check could not
 * run (`asr-error`, `missing-file`) or the job's master missing is a failed finish — retried later, a breaker failure,
 * never a paid take 2. Only a unit that was really transcribed and turned down counts as failed.
 */
export function finishResultOf(overlay: OverlayPaths, input: FinishInput, since = 0): FinishResult {
  const processed = readReport(overlay.processReport);
  const missing = Array.isArray(processed?.missingMasters) ? processed.missingMasters : [];
  if (missing.includes(input.jobId)) throw new Error(`voice:process: the master of ${input.jobId} is missing`);
  const verified = readReport(overlay.verifyReport);
  if (verified === null) throw new Error('voice:verify wrote no report');
  const at = typeof verified.at === 'string' ? Date.parse(verified.at) : Number.NaN;
  // the report of an earlier verify: nothing is known about this job's takes
  if (!Number.isFinite(at) || at < since - 1_000) throw new Error('voice:verify left an old report');
  if (verified.asr !== 'on') throw new Error(`voice:verify ran without the recogniser${typeof verified.asrNote === 'string' ? ` (${verified.asrNote})` : ''}`);
  const ids = new Set(input.units.map((u) => u.id));
  const needsEar = Array.isArray(verified.needsEar) ? (verified.needsEar as { id?: unknown; flags?: unknown }[]) : [];
  for (const v of needsEar) {
    if (typeof v.id !== 'string' || !ids.has(v.id) || !Array.isArray(v.flags)) continue;
    const broken = v.flags.find((f): f is string => typeof f === 'string' && isToolFailureFlag(f));
    if (broken !== undefined) throw new Error(`voice:verify could not check ${v.id} (${broken})`);
  }
  return publishedOf(overlay.dir, input.units);
}

/** What a finish published: the clip ids of `units` the overlay manifest now holds — only those ever reach the child. */
export function publishedOf(overlayDir: string, units: FinishInput['units']): FinishResult {
  const manifest = readCurrentManifest(overlayDir, VOICE_KEY);
  return { published: units.map((u) => u.id).filter((id) => manifest !== null && Object.hasOwn(manifest.units, id)) };
}

// ───────────────────────── are ffmpeg and whisper there? ─────────────────────────

function findTool(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Does whisper-cli really start? Present on PATH is not enough: after a `brew upgrade` it may fail to load its library
 * (dyld) and then every check would fail. The tools' own probe (asr.ts `whisperProblem`): `--help` exits 0 or prints its
 * usage. null = it starts.
 */
export async function whisperRunProblem(runner: ChildRunner, whisper: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const probe = await runner.run(whisper, ['--help'], { env, timeoutMs: 15_000 });
  if (probe.code === 0 || /usage/i.test(`${probe.stdout}${probe.stderr}`)) return null;
  const why = `${probe.stderr}`.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? `exit ${probe.code}`;
  return `whisper-cli does not start (${why.slice(0, 200)})`;
}

/**
 * Why the finish cannot check a take (null = it can): ffmpeg with libmp3lame, loudnorm and atempo, whisper-cli that
 * really starts and its complete model. Without them nothing unchecked may ever be published, so nothing is recorded
 * ('no-tools'). Local and free (no Higgsfield call); never run under vitest.
 */
export async function toolsProblem(runner: ChildRunner, env: NodeJS.ProcessEnv = finishChildEnv()): Promise<string | null> {
  if (process.env.VITEST) return 'tools are not probed under vitest';
  const ffmpeg = findTool('ffmpeg', env);
  if (ffmpeg === null) return 'ffmpeg not found';
  const encoders = await runner.run(ffmpeg, ['-hide_banner', '-encoders'], { env, timeoutMs: 15_000 });
  const filters = await runner.run(ffmpeg, ['-hide_banner', '-filters'], { env, timeoutMs: 15_000 });
  if (!encoders.stdout.includes('libmp3lame') || !filters.stdout.includes('loudnorm') || !filters.stdout.includes('atempo')) return 'ffmpeg lacks libmp3lame / loudnorm / atempo';
  const whisper = findTool(WHISPER_BIN, env);
  if (whisper === null) return 'whisper-cli not found';
  if (!existsSync(DEFAULT_WHISPER_MODEL) || statSync(DEFAULT_WHISPER_MODEL).size !== WHISPER_MODEL.bytes) return 'whisper model missing or incomplete';
  return whisperRunProblem(runner, whisper, env);
}
