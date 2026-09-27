/**
 * The catalogue commands through the real entry point (`node tools/voice-clips/cli.ts …`) with a fake `higgsfield`
 * first on PATH: they are free — the fake is never called — and write nothing with `--no-write`.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoPath } from '../lib/cli.ts';
import { jobsFileOf, jsonWithLines } from './cliCatalog.ts';

const CLI = repoPath('tools', 'voice-clips', 'cli.ts');
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-voice-catalog-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls.txt');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'higgsfield'), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 1\n`);
  chmodSync(path.join(bin, 'higgsfield'), 0o755);
  const run = (...args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }, timeout: 120_000 }, (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
        resolve({ code, out: `${stdout}${stderr}` });
      });
    });
  const callLog = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  return { dir, run, callLog };
}

describe('catalogue commands are free and silent', () => {
  it('plan --tier pilot --no-write: within the hard cap, the demo fully voiced, nothing written, no CLI call', async () => {
    const s = sandbox();
    const before = statSync(jobsFileOf('pilot')).mtimeMs;
    const res = await s.run('plan', '--tier', 'pilot', '--no-write');
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/цена по SPEC 1[0-3](\.\d+)? кр\./);
    expect(res.out).toMatch(/в пределах/);
    expect(res.out).toMatch(/(\d+) из \1 фраз на уровнях L1–L2/);
    expect(res.out).toMatch(/ничего не потрачено/);
    expect(statSync(jobsFileOf('pilot')).mtimeMs).toBe(before);
    expect(s.callLog()).toEqual([]);
  }, 120_000);

  it('coverage --tier pilot reports the demo; bad flags are usage errors', async () => {
    const s = sandbox();
    const cov = await s.run('coverage', '--tier', 'pilot');
    expect(cov.code).toBe(0);
    expect(cov.out).toMatch(/демо-партия g\d+ — (\d+) из \1 фраз на L1–L2/);
    expect((await s.run('plan', '--tier', 'gold')).code).toBe(2);
    expect((await s.run('harvest', '--games', '3')).code).toBe(2);
    expect((await s.run('harvest', '--clip', '--analyse', '--out', 'data/harvest.jsonl.gz')).out).toMatch(/inside data\//);
    expect(s.callLog()).toEqual([]);
  }, 120_000);
});

describe('files one entry per line', () => {
  it('stay valid JSON', () => {
    const text = jsonWithLines({ v: 1, campaign: 'pilot', jobs: [{ a: 1 }, { b: [2, 3] }] }, 'jobs');
    expect(JSON.parse(text)).toEqual({ v: 1, campaign: 'pilot', jobs: [{ a: 1 }, { b: [2, 3] }] });
    expect(text.split('\n').filter((l) => l.startsWith(' {'))).toHaveLength(2);
    expect(JSON.parse(jsonWithLines({ units: [] }, 'units'))).toEqual({ units: [] });
  });
});
