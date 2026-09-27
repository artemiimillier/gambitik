/**
 * The codex wrapper is tested against FAKE executables only (shell scripts in a temp dir).
 * The real `codex` binary is never started here.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmProviderError } from '../types.ts';
import type { LlmRequest } from '../types.ts';
import { sampleGameRecord } from '../../testing/fixtures.ts';
import { REVIEW_JSON_SCHEMA } from '../reviewSchema.ts';
import {
  CODEX_DISABLED_FEATURES,
  CodexExecError,
  buildCodexArgs,
  classifyCodexFailure,
  codexChildEnv,
  codexExec,
  createCodexProvider,
  intersectFeatures,
  parseFeatureList,
  parseRetryAt,
} from './codex.ts';

let dir: string;

interface FakeCodexOptions {
  /** JSONL lines printed on stdout by `codex exec` */
  stdout?: string[];
  stderr?: string;
  exitCode?: number;
  /** raw sh executed before the output is printed (e.g. a hang, or an argument check) */
  preamble?: string;
  features?: string;
  loginStatus?: string;
}

/**
 * Writes an executable fake `codex`. Output comes from side files (no shell quoting games);
 * every `exec` call records its argv / env / cwd / stdin / schema next to the script.
 */
function fakeCodex(name: string, options: FakeCodexOptions = {}): string {
  const path = join(dir, name);
  const features =
    options.features ??
    ['shell_tool                stable             true', 'unified_exec              stable             true', 'apps                      stable             true', 'hooks                     under development  false', 'personality               removed            false'].join('\n');
  writeFileSync(`${path}.features`, `${features}\n`);
  writeFileSync(`${path}.login`, `${options.loginStatus ?? 'Logged in using ChatGPT'}\n`);
  writeFileSync(`${path}.stdout`, (options.stdout ?? []).map((line) => `${line}\n`).join(''));
  writeFileSync(`${path}.stderr`, options.stderr ?? '');
  writeFileSync(
    path,
    `#!/bin/sh
SELF="${path}"
if [ "$1" = "features" ]; then cat "$SELF.features"; exit 0; fi
if [ "$1" = "login" ]; then cat "$SELF.login"; exit 0; fi
printf '%s\\n' "$@" > "$SELF.args"
env > "$SELF.env"
pwd > "$SELF.cwd"
ls -A . > "$SELF.ls"
cat > "$SELF.stdin"
prev=""
for a in "$@"; do if [ "$prev" = "--output-schema" ]; then cp "$a" "$SELF.schema"; fi; prev="$a"; done
${options.preamble ?? ''}
cat "$SELF.stdout"
cat "$SELF.stderr" >&2
exit ${options.exitCode ?? 0}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const REVIEW = { markdown: '## Что получилось\nОчень внимательная партия, молодец!', keyTakeaways: ['Проверяй защиту фигур'], suggestedTheme: 'hangingPiece' };

const SUCCESS: FakeCodexOptions = {
  stdout: [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'turn.started' }),
    // a warning item is NOT a failure
    JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'under-development features enabled' } }),
    'this line is not json',
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(REVIEW) } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2540, cached_input_tokens: 0, output_tokens: 120, reasoning_output_tokens: 10 } }),
  ],
};

const USAGE_LIMIT_MESSAGE = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 23rd, 2026 12:05 PM.";

const USAGE_LIMIT: FakeCodexOptions = {
  stdout: [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-2' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'error', message: USAGE_LIMIT_MESSAGE }),
    JSON.stringify({ type: 'turn.failed', error: { message: USAGE_LIMIT_MESSAGE } }),
  ],
  exitCode: 1,
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gambit-fake-codex-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function request(timeoutMs = 10_000): LlmRequest {
  const record = sampleGameRecord();
  return {
    task: { kind: 'rephrase', event: { id: 'e', kind: 'praise', priority: 0, text: 'Молодец', bubbleText: 'Молодец', pose: 'cheer', pauseClock: false } },
    prompt: `Разбери партию ${record.id}. «Кавычки» и $(echo injection) не должны ничего сломать.`,
    jsonSchema: REVIEW_JSON_SCHEMA,
    schemaName: 'game_review',
    timeoutMs,
  };
}

// Every case spawns fake shell executables (several in a row); under a full parallel `pnpm test` (the content package runs
// real Stockfish processes at the same time) one spawn can take seconds, so the 5 s default made these cases flaky.
const SPAWN_TIMEOUT = { timeout: 30_000 };

describe('codexExec against a fake executable', SPAWN_TIMEOUT, () => {
  it('parses the JSONL stream of a successful run and hardens the invocation', async () => {
    const bin = fakeCodex('codex-ok', SUCCESS);
    const result = await codexExec({
      codexBin: bin,
      prompt: 'привет, codex',
      model: 'gpt-5.6-luna',
      schema: REVIEW_JSON_SCHEMA,
      timeoutMs: 10_000,
      disableFeatures: ['shell_tool', 'apps'],
      env: {
        ...process.env,
        OPENAI_API_KEY: 'sk-must-not-leak',
        CODEX_API_KEY: 'ck-must-not-leak',
        OPENROUTER_API_KEY: 'sk-or-must-not-leak',
        SOME_OTHER_SECRET: 'other-must-not-leak',
        GITHUB_TOKEN: 'ghp-must-not-leak',
        OPENAI_BASE_URL: 'http://attacker.example/v1',
        NOT_ON_THE_LIST: 'dropped',
        CODEX_HOME: '/tmp/codex-home',
        LC_ALL: 'ru_RU.UTF-8',
      },
    });
    expect(result.data).toEqual(REVIEW);
    expect(result.threadId).toBe('thread-1');
    expect(result.usage?.input_tokens).toBe(2540);

    const args = readFileSync(`${bin}.args`, 'utf8').trim().split('\n');
    expect(args.slice(0, 16)).toEqual([
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
      'gpt-5.6-luna',
      '-c',
      'model_reasoning_effort="low"',
      '-c',
      'web_search="disabled"',
    ]);
    expect(args.slice(16, 20)).toEqual(['--disable', 'shell_tool', '--disable', 'apps']);
    expect(args[args.length - 1]).toBe('-');
    expect(args).toContain('--output-schema');
    // cwd of the child is the -C directory (macOS reports it with a /private prefix)
    const workDir = args[args.indexOf('-C') + 1] ?? 'missing';
    expect(readFileSync(`${bin}.cwd`, 'utf8').trim().endsWith(workDir.replace(/^\/private/, ''))).toBe(true);

    // prompt went through stdin (which was closed), never through argv
    expect(readFileSync(`${bin}.stdin`, 'utf8')).toBe('привет, codex');
    expect(args.join(' ')).not.toContain('привет');
    // the child gets an allow-listed environment — no key, token or secret of any kind
    const env = readFileSync(`${bin}.env`, 'utf8');
    expect(env).not.toContain('OPENAI_API_KEY');
    expect(env).not.toContain('CODEX_API_KEY');
    expect(env).not.toContain('OPENROUTER_API_KEY');
    expect(env).not.toContain('must-not-leak');
    expect(env).not.toContain('attacker.example');
    expect(env).not.toContain('NOT_ON_THE_LIST');
    expect(env).toMatch(/^PATH=/m);
    expect(env).toContain('CODEX_HOME=/tmp/codex-home');
    expect(env).toContain('LC_ALL=ru_RU.UTF-8');
    // the agent's working directory is empty and the schema was readable during the run
    expect(readFileSync(`${bin}.ls`, 'utf8').trim()).toBe('');
    expect(JSON.parse(readFileSync(`${bin}.schema`, 'utf8'))).toEqual(REVIEW_JSON_SCHEMA);
    // temp files are gone afterwards
    expect(existsSync(args[args.indexOf('-C') + 1] ?? '')).toBe(false);
    expect(existsSync(args[args.indexOf('--output-schema') + 1] ?? '')).toBe(false);
  });

  it('classifies the usage-limit failure and parses the retry time', async () => {
    const bin = fakeCodex('codex-limit', USAGE_LIMIT);
    const now = new Date(2026, 8, 21, 13, 0, 0);
    const error = await codexExec({ codexBin: bin, prompt: 'x', model: 'm', schema: REVIEW_JSON_SCHEMA, timeoutMs: 10_000, now: () => now }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodexExecError);
    const failure = error as CodexExecError;
    expect(failure.kind).toBe('usage_limit');
    expect(failure.message).toContain('usage limit');
    expect(failure.retryAt?.getTime()).toBe(new Date(2026, 8, 23, 12, 5, 0).getTime());
  });

  it('kills a hanging process after the timeout (and its children)', async () => {
    const bin = fakeCodex('codex-hang', { preamble: 'sleep 30 &\nwait' });
    const startedAt = Date.now();
    const error = await codexExec({ codexBin: bin, prompt: 'x', model: 'm', timeoutMs: 300 }).catch((e: unknown) => e);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(error).toBeInstanceOf(CodexExecError);
    expect((error as CodexExecError).kind).toBe('timeout');
  });

  it('reports bad output, auth problems, unknown features and a missing binary', async () => {
    const noMessage = await codexExec({ codexBin: fakeCodex('codex-empty', { stdout: [JSON.stringify({ type: 'turn.completed' })] }), prompt: 'x', model: 'm', timeoutMs: 5_000 }).catch((e: unknown) => e);
    expect((noMessage as CodexExecError).kind).toBe('bad_output');

    const notJson = await codexExec({
      codexBin: fakeCodex('codex-text', { stdout: [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'просто текст' } })] }),
      prompt: 'x',
      model: 'm',
      schema: REVIEW_JSON_SCHEMA,
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);
    expect((notJson as CodexExecError).kind).toBe('bad_output');

    const auth = await codexExec({ codexBin: fakeCodex('codex-auth', { stderr: 'Error: Not logged in. Run codex login.\n', exitCode: 1 }), prompt: 'x', model: 'm', timeoutMs: 5_000 }).catch((e: unknown) => e);
    expect((auth as CodexExecError).kind).toBe('auth');

    const feature = await codexExec({ codexBin: fakeCodex('codex-feature', { stderr: 'Error: Unknown feature flag: hooks\n', exitCode: 1 }), prompt: 'x', model: 'm', timeoutMs: 5_000 }).catch((e: unknown) => e);
    expect((feature as CodexExecError).kind).toBe('unknown_feature');

    const missing = await codexExec({ codexBin: join(dir, 'no-such-codex'), prompt: 'x', model: 'm', timeoutMs: 5_000 }).catch((e: unknown) => e);
    expect((missing as CodexExecError).kind).toBe('spawn');
  });
});

describe('codex provider', SPAWN_TIMEOUT, () => {
  it('disables only the features the installed CLI knows (and none that were removed)', async () => {
    const bin = fakeCodex('codex-provider', SUCCESS);
    const logs: string[] = [];
    const provider = createCodexProvider({ codexBin: bin, model: 'gpt-5.6-luna', log: (m) => logs.push(m) });
    expect(provider.isConfigured()).toBe(true);
    const data = await provider.generate(request());
    expect(data).toMatchObject({ suggestedTheme: 'hangingPiece' });
    const args = readFileSync(`${bin}.args`, 'utf8').trim().split('\n');
    const disabled = args.filter((_, i) => args[i - 1] === '--disable');
    expect(disabled).toEqual(['shell_tool', 'unified_exec', 'apps', 'hooks']);
    expect(logs.join('\n')).toContain('personality');
    expect(await provider.status()).toEqual({ cli: true, loggedIn: true });
  });

  it('runs a per-task model (the strategist’s gpt-5.6-sol) and still refuses a flag-like one', async () => {
    const bin = fakeCodex('codex-strategy-model', SUCCESS);
    const provider = createCodexProvider({ codexBin: bin, model: 'gpt-5.6-luna' });
    await provider.generate({ ...request(), model: 'gpt-5.6-sol' });
    const args = readFileSync(`${bin}.args`, 'utf8').trim().split('\n');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-sol');
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args).toContain('--output-schema');
    await expect(provider.generate({ ...request(), model: '--yolo' })).rejects.toMatchObject({ kind: 'unsafe' });
    // the strategist skips the reasoning pass; 'minimal' (refused by Sol) falls back to the hardened 'low'
    await provider.generate({ ...request(), model: 'gpt-5.6-sol', reasoningEffort: 'none' });
    expect(readFileSync(`${bin}.args`, 'utf8').trim().split('\n')).toContain('model_reasoning_effort="none"');
    await provider.generate({ ...request(), model: 'gpt-5.6-sol', reasoningEffort: 'minimal' });
    expect(readFileSync(`${bin}.args`, 'utf8').trim().split('\n')).toContain('model_reasoning_effort="low"');
    expect(() => buildCodexArgs({ model: 'gpt-5.6-sol', effort: 'none"; x="', workDir: '/tmp/w', schemaPath: null, disableFeatures: [] })).toThrow(CodexExecError);
  });

  it('re-reads the feature list and retries WITH the fresh flags when the CLI rejects a feature name', async () => {
    // the CLI was "upgraded" between the cached list and the call: `apps` no longer exists
    const bin = fakeCodex('codex-renamed', {
      ...SUCCESS,
      preamble: 'case " $* " in *" --disable apps "*) printf \'shell_tool  stable  true\\nunified_exec  stable  true\\n\' > "$SELF.features"; echo "Error: Unknown feature flag: apps" >&2; exit 1;; esac',
    });
    const provider = createCodexProvider({ codexBin: bin, model: 'm' });
    await expect(provider.generate(request())).resolves.toMatchObject({ suggestedTheme: 'hangingPiece' });
    const args = readFileSync(`${bin}.args`, 'utf8').trim().split('\n');
    expect(args.filter((_, i) => args[i - 1] === '--disable')).toEqual(['shell_tool', 'unified_exec']);
  });

  it('fails closed: without a usable feature list codex is never started', async () => {
    for (const features of ['', 'some_future_tool  stable  true']) {
      const name = `codex-nofeatures-${features.length}`;
      const bin = fakeCodex(name, { ...SUCCESS, features });
      const provider = createCodexProvider({ codexBin: bin, model: 'm' });
      const error = await provider.generate(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LlmProviderError);
      expect((error as LlmProviderError).kind).toBe('unsafe');
      expect(existsSync(`${bin}.args`)).toBe(false); // `codex exec` never ran
    }
    // the failure is not cached for ever: once the CLI answers again the provider works
    const bin = fakeCodex('codex-features-back', { ...SUCCESS, features: '' });
    const provider = createCodexProvider({ codexBin: bin, model: 'm' });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: 'unsafe' });
    writeFileSync(`${bin}.features`, 'shell_tool  stable  true\n');
    await expect(provider.generate(request())).resolves.toMatchObject({ suggestedTheme: 'hangingPiece' });
  });

  it('never passes a flag-like CODEX_MODEL to the CLI', async () => {
    const bin = fakeCodex('codex-flag-model', SUCCESS);
    const provider = createCodexProvider({ codexBin: bin, model: '--dangerously-bypass-approvals-and-sandbox' });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: 'unsafe' });
    expect(existsSync(`${bin}.args`)).toBe(false);
    expect(() => buildCodexArgs({ model: '-c', effort: 'low', workDir: '/tmp/w', schemaPath: null, disableFeatures: [] })).toThrow(CodexExecError);
  });

  it('maps failures to LlmProviderError and reports a logged-out CLI', async () => {
    const bin = fakeCodex('codex-provider-limit', { ...USAGE_LIMIT, loginStatus: 'Not logged in' });
    const provider = createCodexProvider({ codexBin: bin, model: 'm' });
    const error = await provider.generate(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmProviderError);
    expect((error as LlmProviderError).kind).toBe('usage_limit');
    expect((error as LlmProviderError).provider).toBe('codex');
    expect(await provider.status()).toEqual({ cli: true, loggedIn: false });
  });

  it('is not configured without a binary', async () => {
    const provider = createCodexProvider({ codexBin: null, model: 'm' });
    expect(provider.isConfigured()).toBe(false);
    expect(await provider.status()).toEqual({ cli: false, loggedIn: false });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: 'spawn' });
  });
});

describe('pure helpers', () => {
  it('builds the child environment from an allow-list', () => {
    const env = codexChildEnv({
      PATH: '/bin',
      HOME: '/Users/x',
      TMPDIR: '/tmp/',
      LANG: 'ru_RU.UTF-8',
      LC_CTYPE: 'UTF-8',
      CODEX_HOME: '/Users/x/.codex',
      OPENAI_API_KEY: 'a',
      CODEX_API_KEY: 'b',
      OPENROUTER_API_KEY: 'c',
      AWS_SECRET_ACCESS_KEY: 'd',
      NPM_TOKEN: 'e',
      LC_SECRET_TOKEN: 'f',
      OPENAI_BASE_URL: 'http://attacker.example',
      NODE_OPTIONS: '--require /tmp/x.js',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/Users/x', TMPDIR: '/tmp/', LANG: 'ru_RU.UTF-8', LC_CTYPE: 'UTF-8', CODEX_HOME: '/Users/x/.codex' });
  });

  it('builds the documented argument list', () => {
    const args = buildCodexArgs({ model: 'gpt-5.6-luna', effort: 'low', workDir: '/tmp/w', schemaPath: '/tmp/s.json', disableFeatures: [] });
    expect(args.join(' ')).toBe(
      'exec --skip-git-repo-check --sandbox read-only --ephemeral --ignore-user-config --ignore-rules --json --color never -m gpt-5.6-luna -c model_reasoning_effort="low" -c web_search="disabled" --output-schema /tmp/s.json -C /tmp/w -',
    );
  });

  it('parses "try again at" with an ordinal suffix as local time', () => {
    const now = new Date(2026, 8, 21, 13, 0, 0);
    expect(parseRetryAt(USAGE_LIMIT_MESSAGE, now)?.getTime()).toBe(new Date(2026, 8, 23, 12, 5, 0).getTime());
    expect(parseRetryAt('try again at Oct 1st, 2026 9:00 AM', now)).toBeNull(); // implausibly far
    expect(parseRetryAt('try again at Sep 20th, 2026 9:00 AM.', now)).toBeNull(); // in the past
    expect(parseRetryAt('try again at some point', now)).toBeNull();
    expect(parseRetryAt('no hint at all', now)).toBeNull();
  });

  it('classifies failures', () => {
    expect(classifyCodexFailure(USAGE_LIMIT_MESSAGE, '').kind).toBe('usage_limit');
    expect(classifyCodexFailure('codex exited with code 1', 'Error: Unknown feature flag: foo').kind).toBe('unknown_feature');
    expect(classifyCodexFailure('401 Unauthorized', '').kind).toBe('auth');
    expect(classifyCodexFailure('stream disconnected', '').kind).toBe('failed');
  });

  it('parses `codex features list` (stages may contain spaces) and intersects', () => {
    const known = parseFeatureList(
      ['apply_patch_freeform                     removed            false', 'apps                                     stable             true', 'artifact                                 under development  false', '', 'garbage line'].join('\n'),
    );
    expect(known).toEqual([
      { name: 'apply_patch_freeform', stage: 'removed', enabled: false },
      { name: 'apps', stage: 'stable', enabled: true },
      { name: 'artifact', stage: 'under development', enabled: false },
    ]);
    expect(intersectFeatures(['apps', 'apply_patch_freeform', 'gone'], known)).toEqual({ disable: ['apps'], missing: ['apply_patch_freeform', 'gone'] });
    expect(CODEX_DISABLED_FEATURES).toContain('shell_tool');
  });
});
