/**
 * «Дозапись голоса»: the recorder's children. A fake `higgsfield` shell script writes its environment to a file (the
 * pattern of app.test.ts's fake codex): no key, token or app setting ever reaches it, and it runs quiet (no update
 * check, no telemetry, no colour). Nothing here can reach the real CLI or the network.
 */
import { chmodSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildRunner, clipGenChildEnv, cliTimeoutMs, commandOf, createToolsFinish, finishChildEnv, finishResultOf, higgsfieldRunCli, toolsProblem, whisperRunProblem } from './runner.ts';
import { overlayPaths } from './overlay.ts';
import { tempDir } from './testkit.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function traceEnv(dir: string): { bin: string; env: () => Map<string, string> } {
  const trace = join(dir, 'env.txt');
  const bin = join(dir, 'higgsfield');
  writeFileSync(bin, `#!/bin/sh\nenv > "${trace}"\necho "$@" >> "${join(dir, 'args.txt')}"\necho '{"credits": 0.15}'\n`);
  chmodSync(bin, 0o755);
  return {
    bin,
    env: () =>
      new Map(
        readFileSync(trace, 'utf8')
          .split('\n')
          .filter((l) => l.includes('='))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as [string, string]),
      ),
  };
}

const OWNER_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/owner',
  USER: 'owner',
  LOGNAME: 'owner',
  TMPDIR: '/tmp/',
  LANG: 'ru_RU.UTF-8',
  LC_ALL: 'ru_RU.UTF-8',
  // what the owner's .env and shell may hold — none of it may reach the child
  OPENAI_API_KEY: 'sk-test-secret-value',
  OPENROUTER_API_KEY: 'sk-or-v1-test-secret-value',
  HIGGSFIELD_TOKEN: 'hf-secret',
  LC_ACCESS_TOKEN: 'lc-secret',
  GAMBIT_CLIP_GEN: '1',
  CLIP_GEN_BUDGET: '60',
  DATA_DIR: '/Users/owner/Chess/data',
  NODE_OPTIONS: '--require /tmp/evil.js',
};

describe('the environment of a child', () => {
  it('keeps the allow-list, drops everything else, adds the quiet flags', () => {
    const env = clipGenChildEnv(OWNER_ENV);
    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/owner',
      USER: 'owner',
      LOGNAME: 'owner',
      TMPDIR: '/tmp/',
      LANG: 'ru_RU.UTF-8',
      LC_ALL: 'ru_RU.UTF-8',
      NO_COLOR: '1',
      HIGGSFIELD_NO_UPDATE_CHECK: '1',
      HIGGSFIELD_DISABLE_TELEMETRY: '1',
    });
    expect(finishChildEnv(OWNER_ENV).PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin');
    expect(finishChildEnv({ PATH: '/opt/homebrew/bin' }).PATH).toBe('/opt/homebrew/bin:/usr/local/bin');
  });

  it('a fake higgsfield script sees no key, no token and no app setting — with the default environment too', async () => {
    const dir = tempDir('gambit-fake-hf-', cleanups);
    const fake = traceEnv(dir);
    for (const [name, value] of Object.entries(OWNER_ENV)) if (name !== 'PATH' && name !== 'HOME' && value !== undefined) vi.stubEnv(name, value);
    cleanups.push(() => vi.unstubAllEnvs());
    const runner = new ChildRunner();
    const result = await higgsfieldRunCli(fake.bin, runner)(['generate', 'cost', 'text2speech_v2', '--prompt', 'Время для рокировки!', '--json']);
    expect(result).toMatchObject({ code: 0 });
    expect(JSON.parse(result.stdout)).toEqual({ credits: 0.15 });
    const seen = fake.env();
    for (const name of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'HIGGSFIELD_TOKEN', 'LC_ACCESS_TOKEN', 'GAMBIT_CLIP_GEN', 'CLIP_GEN_BUDGET', 'DATA_DIR', 'NODE_OPTIONS', 'VITEST']) {
      expect(seen.has(name), name).toBe(false);
    }
    expect(seen.get('HIGGSFIELD_NO_UPDATE_CHECK')).toBe('1');
    expect(seen.get('HIGGSFIELD_DISABLE_TELEMETRY')).toBe('1');
    expect(seen.get('NO_COLOR')).toBe('1');
    expect(seen.get('LANG')).toBe('ru_RU.UTF-8');
    expect(seen.get('HOME')).toBe(process.env.HOME);
    // the arguments arrive as they are (no shell): the Russian prompt is one argument
    expect(readFileSync(join(dir, 'args.txt'), 'utf8')).toBe('generate cost text2speech_v2 --prompt Время для рокировки! --json\n');
    expect(JSON.stringify([...seen.values()])).not.toContain('secret');
  });
});

describe('ChildRunner', () => {
  it('runs a `.js` wrapper on this very node (no `node` needed on PATH)', async () => {
    const dir = tempDir('gambit-fake-hf-js-', cleanups);
    const script = join(dir, 'main.js');
    writeFileSync(script, 'console.log(JSON.stringify({ argv: process.argv.slice(2), key: process.env.OPENAI_API_KEY ?? null }));\n');
    const link = join(dir, 'higgsfield');
    symlinkSync(script, link);
    expect(commandOf(link)).toEqual({ command: process.execPath, prefix: [realpathSync(script)] });
    expect(commandOf('/usr/bin/true')).toEqual({ command: '/usr/bin/true', prefix: [] });
    const result = await higgsfieldRunCli(link, new ChildRunner(), clipGenChildEnv(OWNER_ENV))(['model', 'get', 'text2speech_v2', '--json']);
    expect(JSON.parse(result.stdout)).toEqual({ argv: ['model', 'get', 'text2speech_v2', '--json'], key: null });
  });

  it('kills a child that runs too long, and every child at shutdown', async () => {
    const runner = new ChildRunner();
    const slow = await runner.run('/bin/sh', ['-c', 'sleep 5'], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 100 });
    expect(slow).toMatchObject({ code: 1, timedOut: true });
    const running = runner.run('/bin/sh', ['-c', 'sleep 5'], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    runner.dispose();
    const killed = await running;
    expect(killed.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await runner.run('/bin/sh', ['-c', 'exit 0'], { env: {}, timeoutMs: 1_000 })).toMatchObject({ code: 1, stderr: 'shutting down' });
  });

  it('per-call timeouts: create 60 s, wait 3.5 min, anything else 30 s', () => {
    expect(cliTimeoutMs(['generate', 'create', 'text2speech_v2'])).toBe(60_000);
    expect(cliTimeoutMs(['generate', 'wait', 'j1', '--timeout', '3m'])).toBe(210_000);
    expect(cliTimeoutMs(['generate', 'cost'])).toBe(30_000);
    expect(cliTimeoutMs(['model', 'get'])).toBe(30_000);
  });

  it('a whisper-cli that is on PATH but cannot start (a broken library after an upgrade) is a tools problem', async () => {
    const dir = tempDir('gambit-fake-whisper-', cleanups);
    const broken = join(dir, 'whisper-broken');
    writeFileSync(broken, '#!/bin/sh\necho "dyld[123]: Library not loaded: @rpath/libwhisper.1.dylib" >&2\nexit 134\n');
    chmodSync(broken, 0o755);
    const fine = join(dir, 'whisper-fine');
    writeFileSync(fine, '#!/bin/sh\necho "usage: whisper-cli [options] file0 file1 ..." >&2\nexit 1\n');
    chmodSync(fine, 0o755);
    const runner = new ChildRunner();
    expect(await whisperRunProblem(runner, broken, { PATH: '/usr/bin:/bin' })).toMatch(/does not start \(dyld\[123\]: Library not loaded/);
    expect(await whisperRunProblem(runner, fine, { PATH: '/usr/bin:/bin' })).toBeNull();
  });

  it('a finish whose recogniser could not run is a failed finish (retried), never a verdict that buys a take 2', () => {
    const dir = tempDir('gambit-finish-reports-', cleanups);
    const ov = overlayPaths(dir);
    const input = { jobId: 'job1', units: [{ id: 'c0000000000001', key: 'line:v3.whole.castle#16', text: 'Время для рокировки!' }] };
    const since = Date.parse('2026-09-24T10:00:00Z');
    const at = '2026-09-24T10:00:05.000Z';
    const reports = (processed: unknown, verified: unknown) => {
      writeFileSync(ov.processReport, JSON.stringify(processed));
      writeFileSync(ov.verifyReport, JSON.stringify(verified));
    };
    const ok = { at, units: 1, passed: 1, needsEar: [], asr: 'on', publish: null };
    // ASR switched off (whisperProblem) — the verify child still exits 0
    reports({ missingMasters: [] }, { ...ok, asr: 'off', asrNote: 'ASR выключен: whisper-cli is not installed' });
    expect(() => finishResultOf(ov, input, since)).toThrow(/without the recogniser \(ASR выключен/);
    // every transcription threw
    reports({ missingMasters: [] }, { ...ok, passed: 0, needsEar: [{ id: 'c0000000000001', key: 'k', text: 't', flags: ['asr-error'] }] });
    expect(() => finishResultOf(ov, input, since)).toThrow(/could not check c0000000000001 \(asr-error\)/);
    // the take's file is gone, the master is missing, an old report
    reports({ missingMasters: [] }, { ...ok, needsEar: [{ id: 'c0000000000001', flags: ['missing-file'] }] });
    expect(() => finishResultOf(ov, input, since)).toThrow(/missing-file/);
    reports({ missingMasters: ['job1'] }, ok);
    expect(() => finishResultOf(ov, input, since)).toThrow(/master of job1 is missing/);
    reports({ missingMasters: [] }, { ...ok, at: '2026-09-24T09:00:00.000Z' });
    expect(() => finishResultOf(ov, input, since)).toThrow(/old report/);
    // really transcribed and turned down: a verdict — the unit is simply not published
    reports({ missingMasters: [] }, { ...ok, passed: 0, needsEar: [{ id: 'c0000000000001', flags: ['asr:0.61'] }] });
    expect(finishResultOf(ov, input, since)).toEqual({ published: [] });
    // another unit's broken check (not of this job) does not fail this finish
    reports({ missingMasters: ['job9'] }, { ...ok, needsEar: [{ id: 'c0000000000099', flags: ['asr-error'] }] });
    expect(finishResultOf(ov, input, since)).toEqual({ published: [] });
  });

  it('under vitest the real finish and the ffmpeg / whisper probe never run', async () => {
    const runner = new ChildRunner();
    const spawn = vi.spyOn(runner, 'run');
    expect(await toolsProblem(runner)).toMatch(/vitest/);
    const dir = tempDir('gambit-finish-', cleanups);
    const finish = createToolsFinish({ repoRoot: '/nonexistent', overlay: overlayPaths(dir), workDir: dir, runner, log: () => undefined });
    await expect(finish({ jobId: 'job1', units: [] })).rejects.toThrow(/vitest/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
