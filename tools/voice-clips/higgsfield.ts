/**
 * The only door to the Higgsfield CLI. Every call goes through an injected `RunCli`, so tests use a fake and can never
 * spend; the real runner uses `execFile` (no shell, arguments never interpolated).
 *
 * Output handling rules (docs/voice-clips/SPEC.md §10):
 *  - a rate limit is recognised ONLY by a non-zero exit code AND `rate_limit_reached` in stderr — never by grepping the
 *    JSON (a «429» inside a `created_at` timestamp would pass for a rate limit and cause a paid duplicate);
 *  - `account status --json` also returns the account's e-mail: only `credits` is read, nothing else is kept or printed.
 */
import { execFile } from 'node:child_process';
import { RATE_LIMIT_MARKER, VOICE, WAIT_INTERVAL, WAIT_TIMEOUT } from './config.ts';
import { creditsToMilli } from './cost.ts';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCli = (args: readonly string[]) => Promise<CliResult>;

/**
 * The real runner: `higgsfield <args>` via execFile, 15-minute ceiling, never through a shell. The CLI is told not to
 * check for updates or send telemetry (no extra network call next to a paid one, no «new version» text in the output).
 */
export const realRunCli: RunCli = (args) =>
  new Promise((resolve) => {
    const env = { ...process.env, NO_COLOR: '1', HIGGSFIELD_NO_UPDATE_CHECK: '1', HIGGSFIELD_DISABLE_TELEMETRY: '1' };
    execFile('higgsfield', [...args], { maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000, env }, (err, stdout, stderr) => {
      if (err === null) {
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      // a numeric code is the exit status; ENOENT / a timeout kill have none
      const exit: unknown = (err as { code?: unknown }).code;
      resolve({ code: typeof exit === 'number' && exit !== 0 ? exit : 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || err.message });
    });
  });

export function isRateLimited(result: CliResult): boolean {
  return result.code !== 0 && result.stderr.includes(RATE_LIMIT_MARKER);
}

/** A server hiccup worth waiting out: an HTTP 5xx or a dropped connection. Reads stderr only — never grep JSON. */
export function isTransient(result: CliResult): boolean {
  return result.code !== 0 && /HTTP 5\d\d\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/.test(result.stderr);
}

export class CliError extends Error {
  readonly result: CliResult;
  constructor(message: string, result: CliResult) {
    super(message);
    this.name = 'CliError';
    this.result = result;
  }
}

/** A Higgsfield job as `generate create|get|wait|list --json` print it (only the fields the tools read). */
export interface HfJob {
  id: string;
  status: string;
  prompt: string | null;
  voiceId: string | null;
  variant: string | null;
  resultUrl: string | null;
  createdAt: string | null;
}

export const DONE_OK = 'completed';
/** Terminal states without audio (not charged). */
export const DONE_FAILED: ReadonlySet<string> = new Set(['failed', 'nsfw', 'canceled', 'cancelled', 'error', 'rejected']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function toJob(raw: unknown): HfJob | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id) ?? str(raw.job_id);
  if (id === null) return null;
  const params = isRecord(raw.params) ? raw.params : {};
  return {
    id,
    status: str(raw.status) ?? 'unknown',
    prompt: typeof params.prompt === 'string' ? params.prompt : null,
    voiceId: str(params.voice_id),
    variant: str(params.model) ?? str(params.variant),
    resultUrl: str(raw.result_url),
    createdAt: str(raw.created_at),
  };
}

/** Jobs from any of the shapes the CLI prints: an array, `{ jobs | items | data: [...] }` or one job object. */
export function parseJobs(stdout: string): HfJob[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  const list = Array.isArray(data)
    ? data
    : isRecord(data)
      ? ((['jobs', 'items', 'data', 'results'] as const).map((k) => data[k]).find(Array.isArray) ?? [data])
      : [];
  return (list as unknown[]).map(toJob).filter((job): job is HfJob => job !== null);
}

export function isOurVoice(job: HfJob): boolean {
  return job.voiceId === VOICE.voiceId && (job.variant === null || job.variant === VOICE.variant);
}

async function run(runCli: RunCli, args: readonly string[]): Promise<CliResult> {
  return runCli(args);
}

/** Available credits in milli-credits (the e-mail in the same answer is ignored). */
export async function accountMilli(runCli: RunCli): Promise<number> {
  const result = await run(runCli, ['account', 'status', '--json']);
  if (result.code !== 0) throw new CliError('`higgsfield account status` failed (signed in?)', result);
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new CliError('`higgsfield account status --json` did not print JSON', result);
  }
  const credits = isRecord(data) ? data.credits : undefined;
  if (typeof credits !== 'number' || !Number.isFinite(credits)) throw new CliError('`higgsfield account status --json` has no numeric credits', result);
  return creditsToMilli(credits);
}

/**
 * `model get text2speech_v2 --json` must still take exactly the params the pricing and the recipes were measured with:
 * prompt, variant (with minimax), voice_id, voice_type (with preset), and nothing else required. Returns the problem or null.
 */
export async function modelProblem(runCli: RunCli): Promise<string | null> {
  const result = await run(runCli, ['model', 'get', VOICE.model, '--json']);
  if (result.code !== 0) return '`higgsfield model get text2speech_v2` failed';
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    return '`higgsfield model get` did not print JSON';
  }
  if (!isRecord(data) || !Array.isArray(data.params)) return 'model description has no params';
  const params = new Map<string, Record<string, unknown>>();
  for (const p of data.params) if (isRecord(p) && typeof p.name === 'string') params.set(p.name, p);
  for (const name of ['prompt', 'variant', 'voice_id', 'voice_type']) if (!params.has(name)) return `model lost the «${name}» param`;
  const variants = params.get('variant')?.enum;
  if (Array.isArray(variants) && !variants.includes(VOICE.variant)) return `variant ${VOICE.variant} is no longer offered`;
  const types = params.get('voice_type')?.enum;
  if (Array.isArray(types) && !types.includes(VOICE.voiceType)) return `voice_type ${VOICE.voiceType} is no longer offered`;
  const extra = [...params.values()].filter((p) => p.required === true && !['prompt', 'variant', 'voice_id', 'voice_type'].includes(String(p.name)));
  if (extra.length > 0) return `model now requires ${extra.map((p) => String(p.name)).join(', ')}`;
  return null;
}

function voiceArgs(prompt: string): string[] {
  return ['--prompt', prompt, '--variant', VOICE.variant, '--voice_type', VOICE.voiceType, '--voice_id', VOICE.voiceId];
}

/** The server's own price for a prompt (free; creates nothing). */
export async function serverCostMilli(runCli: RunCli, prompt: string): Promise<number> {
  const result = await run(runCli, ['generate', 'cost', VOICE.model, ...voiceArgs(prompt), '--json']);
  if (result.code !== 0) throw new CliError('`higgsfield generate cost` failed', result);
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new CliError('`higgsfield generate cost --json` did not print JSON', result);
  }
  const credits = isRecord(data) ? data.credits : undefined;
  if (typeof credits !== 'number' || !Number.isFinite(credits)) throw new CliError('`generate cost` has no numeric credits', result);
  return creditsToMilli(credits);
}

/** `generate create … --json` WITHOUT --wait: returns the raw result; the caller decides what a failure means. */
export function createArgs(prompt: string): string[] {
  return ['generate', 'create', VOICE.model, ...voiceArgs(prompt), '--json'];
}

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

/** A job id we may pass to the CLI or use as a file name (never a flag, never a path). */
export function isJobId(id: string): boolean {
  return JOB_ID_RE.test(id);
}

const DURATION_RE = /^\d{1,4}(?:ms|s|m|h)$/;

/**
 * `generate wait <id> --json --quiet --timeout <t> --interval <i>` (interval default 1 s: the job is done in ≈ 5 s;
 * timeout default WAIT_TIMEOUT, the server passes '3m'). Throws on a job id or duration that could be read as a flag.
 */
export function waitArgs(jobId: string, o: { timeout?: string; interval?: string } = {}): string[] {
  const timeout = o.timeout ?? WAIT_TIMEOUT;
  const interval = o.interval ?? WAIT_INTERVAL;
  if (!JOB_ID_RE.test(jobId)) throw new Error(`bad Higgsfield job id: ${JSON.stringify(jobId.slice(0, 40))}`);
  if (!DURATION_RE.test(timeout) || !DURATION_RE.test(interval)) throw new Error(`bad wait duration: ${timeout} / ${interval}`);
  return ['generate', 'wait', jobId, '--json', '--quiet', '--timeout', timeout, '--interval', interval];
}

export function getArgs(jobId: string): string[] {
  return ['generate', 'get', jobId, '--json'];
}

export function listArgs(size: number): string[] {
  return ['generate', 'list', '--audio', '--json', '--size', String(size)];
}
