/**
 * The real entry point (`node tools/voice-clips/cli.ts …`) with a fake `higgsfield` first on PATH that only records
 * its arguments: proves the wiring refuses with ZERO calls without --spend / --budget, and that the free commands
 * never call the CLI at all. Nothing can reach the real Higgsfield account from here.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoPath } from '../lib/cli.ts';

const CLI = repoPath('tools', 'voice-clips', 'cli.ts');
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-voice-cli-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls.txt');
  mkdirSync(bin, { recursive: true });
  // a fake CLI: records every call, answers nothing useful (exit 1)
  writeFileSync(path.join(bin, 'higgsfield'), `#!/bin/sh\necho "$@" >> "${calls}"\necho "fake: no network here" >&2\nexit 1\n`);
  chmodSync(path.join(bin, 'higgsfield'), 0o755);
  const jobs = path.join(dir, 'jobs.json');
  writeFileSync(jobs, JSON.stringify({ v: 1, voiceKey: 'giselle-mm1', campaign: 'pilot', jobs: [{ prompt: 'Ого!<#0.6#>Смотри, тут подарок!', take: 1, recipe: 'whole', pieces: [{ key: 'line:bark.wow#1', text: 'Ого!' }, { key: 'line:treasure.look#1', text: 'Смотри, тут подарок!' }] }] }));
  const flags = ['--jobs', jobs, '--ledger', path.join(dir, 'ledger.jsonl'), '--masters', path.join(dir, '.masters')];
  const run = (...args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }, timeout: 60_000 }, (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1;
        resolve({ code, out: `${stdout}${stderr}` });
      });
    });
  const callLog = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  return { dir, flags, run, callLog };
}

describe('cli generate refuses before touching the CLI', () => {
  it('without --spend: exit ≠ 0, the fake higgsfield was never called', async () => {
    const s = sandbox();
    const res = await s.run('generate', ...s.flags, '--budget', '15');
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/ничего не потрачено/);
    expect(s.callLog()).toEqual([]);
  }, 60_000);

  it('without --budget: exit ≠ 0, no call', async () => {
    const s = sandbox();
    const res = await s.run('generate', ...s.flags, '--spend');
    expect(res.code).not.toBe(0);
    expect(s.callLog()).toEqual([]);
  }, 60_000);

  it('with both flags the first call is the balance check, and a failing CLI stops everything', async () => {
    const s = sandbox();
    const res = await s.run('generate', ...s.flags, '--spend', '--budget', '0.3');
    expect(res.code).not.toBe(0);
    expect(s.callLog()).toEqual(['account status --json']);
  }, 60_000);

  it('cost and ledger are free: no call at all', async () => {
    const s = sandbox();
    const cost = await s.run('cost', ...s.flags);
    expect(cost.code).toBe(0);
    expect(cost.out).toMatch(/1 заданий, 2 записей, 31 символов, 0.15 кр/);
    const ledger = await s.run('ledger', '--ledger', path.join(s.dir, 'ledger.jsonl'));
    expect(ledger.code).toBe(0);
    expect(s.callLog()).toEqual([]);
  }, 60_000);

  it('--overlay: refused while the server has a job in flight there (S7), with zero calls; never inside the checkout', async () => {
    const s = sandbox();
    const ov = path.join(s.dir, 'overlay');
    mkdirSync(ov, { recursive: true });
    const job = { prompt: 'Ого!', take: 101, recipe: 'single', pieces: [{ key: 'line:v3.x#1', text: 'Ого!' }] };
    writeFileSync(path.join(ov, 'ledger.giselle-mm1.jsonl'), `${JSON.stringify({ ev: 'created', at: '2026-09-24T20:00:00.000Z', run: 's', campaign: 'ondemand', key: 'k', jobId: 'srv-1', milli: 150, job })}\n`);
    const res = await s.run('generate', ...s.flags, '--spend', '--budget', '1', '--overlay', ov, '--ledger', path.join(s.dir, 'ledger.jsonl'));
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/сервер ещё ждёт задание srv-1/);
    expect(s.callLog()).toEqual([]);
    const inside = await s.run('ledger', '--overlay', repoPath('voice-overlay'));
    expect(inside.code).not.toBe(0);
    expect(inside.out).toMatch(/inside this checkout/);
    const relative = await s.run('ledger', '--overlay', 'voice-overlay');
    expect(relative.out).toMatch(/absolute path/);
    // the free ledger view of the overlay shows the server's spend
    const view = await s.run('ledger', '--overlay', ov);
    expect(view.code).toBe(0);
    expect(view.out).toMatch(/«ondemand»: заданий 1, ждут 1/);
    expect(s.callLog()).toEqual([]);
  }, 60_000);

  it('paths inside the child’s data/ folder are refused', async () => {
    const s = sandbox();
    const res = await s.run('ledger', '--ledger', 'data/ledger.jsonl');
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/inside data\//);
  }, 60_000);
});
