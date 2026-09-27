/**
 * Provider A: the official `codex` CLI authenticated with the owner's ChatGPT subscription.
 *
 * Hardened invocation (research 04, incl. its verification corrections):
 *   codex exec --skip-git-repo-check --sandbox read-only --ephemeral --ignore-user-config
 *     --ignore-rules --json --color never -m <model> -c model_reasoning_effort="low"
 *     -c web_search="disabled" [--disable <feature>]… --output-schema <file> -C <empty tmp dir> -
 *  - the prompt goes through stdin, which is ALWAYS closed (otherwise codex waits for input);
 *  - the child environment is built from a small ALLOW-LIST (PATH, HOME, CODEX_HOME, locale,
 *    TMPDIR, …): no OPENAI_API_KEY / CODEX_API_KEY (the CLI must use the ChatGPT login and never
 *    silently switch to API billing), no OPENROUTER_API_KEY, no *_KEY / *_TOKEN / *_SECRET of any
 *    kind — an LLM agent that reads partly untrusted text never holds a secret;
 *  - `--disable` only gets feature names that the installed CLI actually knows
 *    (`codex features list`): an unknown name is a hard `Unknown feature flag` failure, and brew
 *    upgrades rename features regularly. The hardening FAILS CLOSED: when the feature list cannot
 *    be obtained, or none of the agent tools can be disabled, codex is not run at all (kind
 *    'unsafe' → the gateway moves on to the next provider); on `Unknown feature flag` the list is
 *    re-queried and the call retried with the fresh intersection — never without the flags;
 *  - timeout → the whole process group gets SIGTERM, then SIGKILL;
 *  - this module never reads ~/.codex/auth.json — authentication is the CLI's own business.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { LlmProviderError } from '../types.ts';
import type { JsonSchema, LlmErrorKind, LlmProvider, LlmRequest } from '../types.ts';

/** Agent tools a text-only coach never needs. Intersected with `codex features list` at runtime. */
export const CODEX_DISABLED_FEATURES: readonly string[] = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'remote_plugin',
  'multi_agent',
  'image_generation',
  'memories',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'goals',
  'sleep_tool',
  'skill_search',
  'tool_suggest',
  'view_image',
  'hooks',
  'personality',
  'in_app_browser',
];

export class CodexExecError extends Error {
  readonly kind: LlmErrorKind;
  readonly stderr: string;
  readonly retryAt: Date | null;

  constructor(kind: LlmErrorKind, message: string, stderr = '', retryAt: Date | null = null) {
    super(message);
    this.name = 'CodexExecError';
    this.kind = kind;
    this.stderr = stderr;
    this.retryAt = retryAt;
  }
}

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface CodexExecOptions {
  codexBin: string;
  prompt: string;
  model: string;
  schema?: JsonSchema;
  /** 'none' skips the reasoning pass (the strategist: gpt-5.6-sol answered in 7.0 s instead of 9.4 s; 'minimal' is refused by Sol) */
  effort?: 'none' | 'low' | 'medium' | 'high';
  timeoutMs: number;
  /** feature names passed as `--disable`; must already be intersected with the CLI's list */
  disableFeatures?: readonly string[];
  /** base environment; only the allow-listed names of it reach the child (see codexChildEnv); default process.env */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** receives the spawned child so the owner can kill it on shutdown */
  onSpawn?: (child: ChildProcess) => void;
}

export interface CodexExecResult {
  /** parsed JSON when a schema was given, else the raw final message */
  data: unknown;
  raw: string;
  threadId: string | null;
  usage: CodexUsage | null;
  ms: number;
}

/** Exact names copied into the codex child environment; everything else is dropped. */
const CHILD_ENV_ALLOW = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'LANG', 'LANGUAGE', 'CODEX_HOME']);
/** belt and braces: even an allow-listed or LC_* name never carries something that looks like a secret */
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/**
 * Minimal allow-listed environment of the codex child. The child authenticates with
 * the ChatGPT login stored under HOME / CODEX_HOME — it needs no API key and gets none.
 */
export function codexChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!CHILD_ENV_ALLOW.has(name) && !/^LC_[A-Z_]+$/.test(name)) continue;
    if (SECRET_NAME_RE.test(name)) continue;
    env[name] = value;
  }
  return env;
}

/** A model id is a plain identifier; anything else (e.g. a leading '-') could be parsed as a CLI flag after `-m`. */
const CODEX_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function buildCodexArgs(options: { model: string; effort: string; workDir: string; schemaPath: string | null; disableFeatures: readonly string[] }): string[] {
  if (!CODEX_MODEL_RE.test(options.model)) throw new CodexExecError('unsafe', 'CODEX_MODEL is not a plain model id');
  if (!/^(none|low|medium|high)$/.test(options.effort)) throw new CodexExecError('unsafe', 'invalid reasoning effort');
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--json',
    '--color',
    'never',
    '-m',
    options.model,
    '-c',
    `model_reasoning_effort="${options.effort}"`,
    '-c',
    'web_search="disabled"',
  ];
  for (const feature of options.disableFeatures) args.push('--disable', feature);
  if (options.schemaPath !== null) args.push('--output-schema', options.schemaPath);
  args.push('-C', options.workDir, '-');
  return args;
}

/**
 * "…try again at Sep 23rd, 2026 12:05 PM." → Date (local time). `new Date()` chokes on the ordinal
 * suffix, so it is removed first. Null when absent, unparsable, in the past or implausibly far.
 */
export function parseRetryAt(message: string, now: Date = new Date()): Date | null {
  const match = /try again at (.+?)\.?\s*$/i.exec(message.trim());
  const raw = match?.[1];
  if (raw === undefined) return null;
  const cleaned = raw.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
  const parsed = new Date(cleaned);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) return null;
  if (time <= now.getTime() || time - now.getTime() > 8 * 24 * 3600_000) return null;
  return parsed;
}

export function classifyCodexFailure(message: string, stderr: string, now: Date = new Date()): { kind: LlmErrorKind; retryAt: Date | null } {
  const all = `${message}\n${stderr}`;
  if (/usage limit/i.test(all)) return { kind: 'usage_limit', retryAt: parseRetryAt(message, now) ?? parseRetryAt(stderr, now) };
  if (/unknown feature flag/i.test(all)) return { kind: 'unknown_feature', retryAt: null };
  if (/not logged in|logged out|login required|please log in|unauthorized|\b401\b|authentication/i.test(all)) return { kind: 'auth', retryAt: null };
  return { kind: 'failed', retryAt: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  try {
    // detached: true made the child a process-group leader — signal the whole group
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

/** One stateless `codex exec` call. Rejects with {@link CodexExecError}. */
export async function codexExec(options: CodexExecOptions): Promise<CodexExecResult> {
  const startedAt = Date.now();
  const now = options.now ?? (() => new Date());
  const root = await mkdtemp(join(tmpdir(), 'gambit-codex-'));
  try {
    const workDir = join(root, 'work'); // stays empty: the agent has nothing to read
    await mkdir(workDir);
    let schemaPath: string | null = null;
    if (options.schema !== undefined) {
      schemaPath = join(root, 'schema.json');
      await writeFile(schemaPath, JSON.stringify(options.schema), 'utf8');
    }
    const args = buildCodexArgs({
      model: options.model,
      effort: options.effort ?? 'low',
      workDir,
      schemaPath,
      disableFeatures: options.disableFeatures ?? [],
    });

    return await new Promise<CodexExecResult>((resolve, reject) => {
      const child = spawn(options.codexBin, args, {
        cwd: workDir,
        env: codexChildEnv(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        shell: false,
      });
      options.onSpawn?.(child);

      let stderr = '';
      let lastMessage: string | null = null;
      let usage: CodexUsage | null = null;
      let threadId: string | null = null;
      let failure: string | null = null;
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        killTree(child, 'SIGTERM');
        killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 1500);
        killTimer.unref();
        settle(() => reject(new CodexExecError('timeout', `codex exec timed out after ${options.timeoutMs} ms`, stderr)));
      }, options.timeoutMs);

      child.on('error', (error) => settle(() => reject(new CodexExecError('spawn', `cannot start codex: ${error.message}`, stderr))));
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
      });
      child.stdin?.on('error', () => undefined); // EPIPE when the child dies early
      if (child.stdout !== null) {
        createInterface({ input: child.stdout }).on('line', (line) => {
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (!isRecord(event)) return;
          const item = isRecord(event.item) ? event.item : null;
          if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id;
          // item.completed with item.type === 'error' is only a warning; a failed turn is turn.failed / exit code
          if (event.type === 'item.completed' && item !== null && item.type === 'agent_message' && typeof item.text === 'string') lastMessage = item.text;
          if (event.type === 'turn.completed' && isRecord(event.usage)) usage = event.usage as CodexUsage;
          if (event.type === 'turn.failed') failure = isRecord(event.error) && typeof event.error.message === 'string' ? event.error.message : 'turn failed';
          if (event.type === 'error' && failure === null && typeof event.message === 'string') failure = event.message;
        });
      }
      child.on('close', (code) => {
        if (killTimer !== null) clearTimeout(killTimer);
        settle(() => {
          const ms = Date.now() - startedAt;
          if (failure !== null || code !== 0) {
            const message = failure ?? `codex exited with code ${String(code)}`;
            const { kind, retryAt } = classifyCodexFailure(message, stderr, now());
            reject(new CodexExecError(kind, message, stderr, retryAt));
            return;
          }
          if (lastMessage === null) {
            reject(new CodexExecError('bad_output', 'no agent_message in the codex event stream', stderr));
            return;
          }
          if (options.schema === undefined) {
            resolve({ data: lastMessage, raw: lastMessage, threadId, usage, ms });
            return;
          }
          try {
            resolve({ data: JSON.parse(lastMessage) as unknown, raw: lastMessage, threadId, usage, ms });
          } catch {
            reject(new CodexExecError('bad_output', 'the final codex message is not valid JSON', stderr));
          }
        });
      });

      child.stdin?.end(options.prompt); // ALWAYS close stdin
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ───────────────────────── small local commands (no model call) ─────────────────────────

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a fixed binary with an argument array (never a shell); used for `features list` / `login status`. */
export function runCommand(bin: string, args: readonly string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (result: CommandResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(bin, [...args], { env: codexChildEnv(options.env), stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false });
    const timer = setTimeout(() => {
      killTree(child, 'SIGKILL');
      finish({ code: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 256_000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64_000) stderr += chunk.toString('utf8');
    });
    child.on('error', () => finish({ code: null, stdout, stderr, timedOut: false }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut: false }));
  });
}

export interface CodexFeature {
  name: string;
  stage: string;
  enabled: boolean;
}

/** Parses `codex features list`: `<name>  <stage (may contain spaces)>  <true|false>` per line. */
export function parseFeatureList(stdout: string): CodexFeature[] {
  const features: CodexFeature[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    const name = tokens[0];
    const last = tokens[tokens.length - 1];
    if (tokens.length < 3 || name === undefined || !/^[a-z0-9_]+$/.test(name) || (last !== 'true' && last !== 'false')) continue;
    features.push({ name, stage: tokens.slice(1, -1).join(' '), enabled: last === 'true' });
  }
  return features;
}

/** Wanted ∩ known-and-not-removed. `missing` lists the wanted names the CLI no longer knows. */
export function intersectFeatures(wanted: readonly string[], known: readonly CodexFeature[]): { disable: string[]; missing: string[] } {
  const usable = new Set(known.filter((f) => f.stage !== 'removed').map((f) => f.name));
  return { disable: wanted.filter((name) => usable.has(name)), missing: wanted.filter((name) => !usable.has(name)) };
}

export interface CodexStatus {
  cli: boolean;
  loggedIn: boolean;
}

export interface CodexProviderOptions {
  codexBin: string | null;
  model: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export interface CodexProvider extends LlmProvider {
  status(): Promise<CodexStatus>;
  dispose(): void;
}

const STATUS_TTL_MS = 60_000;

export function createCodexProvider(options: CodexProviderOptions): CodexProvider {
  const log = options.log ?? (() => undefined);
  const children = new Set<ChildProcess>();
  let featuresPromise: Promise<string[]> | null = null;
  let statusCache: { at: number; value: Promise<CodexStatus> } | null = null;

  /**
   * FAIL CLOSED: without the feature list — or when not even one agent tool can be switched off —
   * codex would run as an unrestricted agent (shell, apps, …) on partly untrusted text. Then it is
   * not run at all; the gateway pauses the provider and the next one answers.
   */
  const resolveDisabledFeatures = (bin: string): Promise<string[]> => {
    const attempt = (async () => {
      const result = await runCommand(bin, ['features', 'list'], { timeoutMs: 5_000, env: options.env });
      const known = result.code === 0 ? parseFeatureList(result.stdout) : [];
      if (known.length === 0) throw new CodexExecError('unsafe', '`codex features list` is unavailable — refusing to run codex without its --disable hardening');
      const { disable, missing } = intersectFeatures(CODEX_DISABLED_FEATURES, known);
      if (missing.length > 0) log(`[codex] features unknown to this CLI version, not disabled: ${missing.join(', ')}`);
      if (disable.length === 0) throw new CodexExecError('unsafe', 'this codex CLI knows none of the agent tools we disable — refusing to run it unrestricted');
      return disable;
    })();
    featuresPromise = attempt;
    // a failure is not cached: the next call (after the breaker cooldown) asks the CLI again
    attempt.catch(() => {
      if (featuresPromise === attempt) featuresPromise = null;
    });
    return attempt;
  };
  const disabledFeatures = (bin: string): Promise<string[]> => featuresPromise ?? resolveDisabledFeatures(bin);

  const exec = async (bin: string, request: LlmRequest, disableFeatures: readonly string[]): Promise<unknown> => {
    const result = await codexExec({
      codexBin: bin,
      prompt: request.prompt,
      // a per-task model (the strategist's CODEX_STRATEGY_MODEL) — validated as a plain id in buildCodexArgs
      model: request.model ?? options.model,
      schema: request.jsonSchema,
      // the per-task effort ('none' for the strategist); 'minimal' does not exist for every model → the hardened 'low'
      effort: request.reasoningEffort === 'none' || request.reasoningEffort === 'medium' ? request.reasoningEffort : 'low',
      timeoutMs: request.timeoutMs,
      disableFeatures,
      env: options.env,
      onSpawn: (child) => {
        children.add(child);
        child.once('close', () => children.delete(child));
      },
    });
    return result.data;
  };

  return {
    id: 'codex',
    isConfigured: () => options.codexBin !== null,

    async generate(request: LlmRequest): Promise<unknown> {
      const bin = options.codexBin;
      if (bin === null) throw new LlmProviderError('codex', 'spawn', 'codex CLI is not installed');
      try {
        try {
          return await exec(bin, request, await disabledFeatures(bin));
        } catch (error) {
          if (error instanceof CodexExecError && error.kind === 'unknown_feature') {
            // the CLI was upgraded under us: ask it again and retry ONCE with the fresh intersection
            // (never with no flags at all — that would be an unrestricted agent)
            log('[codex] unknown feature flag — re-reading `codex features list` and retrying');
            featuresPromise = null;
            return await exec(bin, request, await resolveDisabledFeatures(bin));
          }
          throw error;
        }
      } catch (error) {
        if (error instanceof CodexExecError) throw new LlmProviderError('codex', error.kind, error.message, error.retryAt);
        throw new LlmProviderError('codex', 'failed', error instanceof Error ? error.message : String(error));
      }
    },

    status(): Promise<CodexStatus> {
      const bin = options.codexBin;
      if (bin === null) return Promise.resolve({ cli: false, loggedIn: false });
      if (statusCache !== null && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
      const value = runCommand(bin, ['login', 'status'], { timeoutMs: 4_000, env: options.env }).then((result) => {
        const text = `${result.stdout}\n${result.stderr}`;
        return { cli: true, loggedIn: result.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text) };
      });
      statusCache = { at: Date.now(), value };
      return value;
    },

    dispose(): void {
      for (const child of children) killTree(child, 'SIGKILL');
      children.clear();
    },
  };
}
