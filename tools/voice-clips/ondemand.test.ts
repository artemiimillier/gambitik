/**
 * «Дозапись голоса» — the pure primitives of the on-demand paid protocol (no CLI is run: these read strings and ledger
 * lines only). The create output is parsed widely but never guessed (never `job_set_id`, never one of several ids);
 * unresolved intents count at full price; paid attempts per unit survive a restart because they are read from the ledger.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliResult } from './higgsfield.ts';
import type { GenJob } from './jobs.ts';
import {
  MAX_PAID_ATTEMPTS,
  ONDEMAND_CAMPAIGN,
  ONDEMAND_TAKE_BASE,
  PREFETCH_CAMPAIGN,
  WAIT_INTERVAL,
  isAuthProblem,
  isNoCredits,
  localDay,
  onDemandViewOf,
  parseCreated,
  readOnDemandLedger,
  spentByDay,
  unitAttempts,
  waitArgs,
} from './ondemand.ts';
import type { OnDemandLine } from './ondemand.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const PROMPT = 'Давай сходим конём<#0.6#>— и это мат!';
const res = (code: number, stdout = '', stderr = ''): CliResult => ({ code, stdout, stderr });

describe('parseCreated', () => {
  it('reads the job id from every plausible shape', () => {
    expect(parseCreated(JSON.stringify({ id: 'j1', status: 'queued', params: { prompt: PROMPT } }))).toMatchObject({ jobId: 'j1', prompt: PROMPT });
    expect(parseCreated(JSON.stringify({ job_id: 'j2' })).jobId).toBe('j2');
    expect(parseCreated(JSON.stringify({ job: { id: 'j3', prompt: PROMPT } }))).toMatchObject({ jobId: 'j3', prompt: PROMPT });
    expect(parseCreated(JSON.stringify({ data: { id: 'j4' } })).jobId).toBe('j4');
    expect(parseCreated(JSON.stringify({ jobs: [{ id: 'j5' }] })).jobId).toBe('j5');
    expect(parseCreated(JSON.stringify({ data: [{ job_id: 'j6' }] })).jobId).toBe('j6');
    expect(parseCreated(JSON.stringify([{ id: 'j7' }])).jobId).toBe('j7');
    expect(parseCreated(JSON.stringify({ job_set_id: 's1', job_ids: ['j8'] }))).toMatchObject({ jobId: 'j8', prompt: null });
  });

  it('never takes a job set / request id, and never guesses among several jobs', () => {
    expect(parseCreated(JSON.stringify({ job_set_id: 's1' })).jobId).toBeNull();
    expect(parseCreated(JSON.stringify({ job_set_id: 's1', id: 's1', request_id: 'r1' })).jobId).toBeNull();
    expect(parseCreated(JSON.stringify({ request_id: 'r1' })).jobId).toBeNull();
    expect(parseCreated(JSON.stringify({ job_set_id: 's1', job_ids: ['j1', 'j2'] })).jobId).toBeNull();
    expect(parseCreated(JSON.stringify({ jobs: [{ id: 'j1' }, { id: 'j2' }] })).jobId).toBeNull();
    expect(parseCreated(JSON.stringify([{ id: 'j1' }, { id: 'j2' }])).jobId).toBeNull();
    expect(parseCreated('').jobId).toBeNull();
    expect(parseCreated('Job submitted: j1').jobId).toBeNull();
  });

  it('records the output`s key skeleton with every value masked', () => {
    const out = parseCreated(JSON.stringify({ job_set_id: 'secret-set', job_ids: ['secret-job'], credits: 0.15, ok: true, owner: { email: 'x@y.z' } }));
    expect(out.shape).toBe('{job_set_id:str,job_ids:[str],credits:num,ok:bool,owner:{email:str}}');
    expect(out.shape).not.toMatch(/secret|x@y/);
    expect(parseCreated('').shape).toBe('empty');
    expect(parseCreated('Job submitted: j1').shape).toBe('non-json(17)');
    expect(parseCreated(JSON.stringify({ jobs: [{ id: 'a' }, { id: 'b' }] })).shape).toBe('{jobs:[{id:str},…]}');
  });
});

describe('isNoCredits / isAuthProblem', () => {
  it('recognise the account problems only on a failed call', () => {
    expect(isNoCredits(res(1, '', 'Error: insufficient credits for this generation'))).toBe(true);
    expect(isNoCredits(res(1, JSON.stringify({ error: 'Not enough credits' })))).toBe(true);
    expect(isNoCredits(res(1, '', 'HTTP 402 Payment Required'))).toBe(true);
    expect(isNoCredits(res(0, '', 'insufficient credits'))).toBe(false);
    expect(isAuthProblem(res(1, '', 'Session expired. Run `higgsfield auth login`'))).toBe(true);
    expect(isAuthProblem(res(1, '', 'HTTP 401'))).toBe(true);
    expect(isAuthProblem(res(1, JSON.stringify({ error: { message: 'Unauthorized' } })))).toBe(true);
    expect(isAuthProblem(res(0, '', 'not logged in'))).toBe(false);
  });

  it('never read the whole JSON: a «402» / «401» inside a value is not an error', () => {
    const job = JSON.stringify({ id: 'j1', created_at: '2026-09-24T10:40:02.401Z', prompt: 'Payment required? Unauthorized!' });
    expect(isNoCredits(res(1, job, 'exit status 1'))).toBe(false);
    expect(isAuthProblem(res(1, job, 'exit status 1'))).toBe(false);
    expect(isNoCredits(res(1, '', 'rate_limit_reached'))).toBe(false);
  });
});

describe('waitArgs', () => {
  it('polls every second by default', () => {
    expect(WAIT_INTERVAL).toBe('1s');
    expect(waitArgs('j-1')).toEqual(['generate', 'wait', 'j-1', '--json', '--quiet', '--timeout', '10m', '--interval', '1s']);
    expect(waitArgs('j-1', { timeout: '3m' })).toEqual(['generate', 'wait', 'j-1', '--json', '--quiet', '--timeout', '3m', '--interval', '1s']);
  });

  it('refuses an id or a duration that could be read as a flag', () => {
    expect(() => waitArgs('--help')).toThrow();
    expect(() => waitArgs('')).toThrow();
    expect(() => waitArgs('j 1')).toThrow();
    expect(() => waitArgs('j1', { interval: '--x' })).toThrow();
    expect(() => waitArgs('j1', { timeout: '1 m' })).toThrow();
  });
});

// ── the overlay ledger view ──────────────────────────────────────────────────────────────────────────────────────

const unit = (key: string) => ({ key, text: 'x', pool: key.slice(5, key.indexOf('#')), kind: 'line' as const });
const job = (prompt: string, keys: string[]): GenJob => ({ prompt, take: ONDEMAND_TAKE_BASE, recipe: 'whole', pieces: keys.map(unit), split: { mode: 'tags', minSilenceMs: 700 } });
const A = 'line:v3.lead.advice@n#1';
const B = 'line:v3.idea.mate#1';

function lines(): OnDemandLine[] {
  const j1 = job('p1', [A, B]);
  const j2 = job('p2', [A]);
  const j3 = job('p3', [B]);
  const j4 = job('p4', [A]);
  return [
    { ev: 'intent', at: '2026-09-24T20:00:00.000Z', run: 'r1', campaign: ONDEMAND_CAMPAIGN, key: 'k1', milli: 300, job: j1 },
    { ev: 'created', at: '2026-09-24T20:00:01.000Z', run: 'r1', campaign: ONDEMAND_CAMPAIGN, key: 'k1', jobId: 'h1', milli: 300, job: j1, via: 'parse', createShape: '{id:str}' },
    { ev: 'charged', at: '2026-09-24T20:00:06.000Z', key: 'k1', jobId: 'h1', campaign: ONDEMAND_CAMPAIGN, milli: 300, status: 'completed', resultUrl: 'https://cdn/x.mp3' },
    // a job that failed (not charged): no attempt, no spend
    { ev: 'intent', at: '2026-09-24T21:00:00.000Z', run: 'r1', campaign: ONDEMAND_CAMPAIGN, key: 'k2', milli: 150, job: j2 },
    { ev: 'created', at: '2026-09-24T21:00:01.000Z', run: 'r1', campaign: ONDEMAND_CAMPAIGN, key: 'k2', jobId: 'h2', milli: 150, job: j2 },
    { ev: 'failed', at: '2026-09-24T21:00:05.000Z', key: 'k2', jobId: 'h2', campaign: ONDEMAND_CAMPAIGN, status: 'failed' },
    // an intent the create never resolved (a crash): counts in full, on its own day
    { ev: 'intent', at: '2026-09-25T09:00:00.000Z', run: 'r2', campaign: ONDEMAND_CAMPAIGN, key: 'k3', milli: 150, job: j3 },
    // an intent resolved as absent: nothing
    { ev: 'intent', at: '2026-09-25T09:10:00.000Z', run: 'r2', campaign: ONDEMAND_CAMPAIGN, key: 'k4', milli: 150, job: j4 },
    { ev: 'absent', at: '2026-09-25T09:10:05.000Z', run: 'r2', key: 'k4', checks: 3 },
    // the parent's prefetch, still pending: counts in full under its own campaign
    { ev: 'created', at: '2026-09-25T10:00:00.000Z', run: 'r3', campaign: PREFETCH_CAMPAIGN, key: 'k5', jobId: 'h5', milli: 450, job: job('p5', ['line:v3.aim.develop#1']) },
  ];
}

describe('the overlay ledger view', () => {
  it('keeps the tools` view and the unresolved intents', () => {
    const view = onDemandViewOf(lines());
    expect([...view.ledger.jobs.keys()]).toEqual(['h1', 'h2', 'h5']);
    expect(view.unresolved.map((i) => i.key)).toEqual(['k3']);
  });

  it('counts paid attempts per unit: charged, pending and unresolved — never a failed job', () => {
    const view = onDemandViewOf(lines());
    expect(MAX_PAID_ATTEMPTS).toBe(2);
    expect(unitAttempts(view, A)).toBe(1);
    expect(unitAttempts(view, B)).toBe(2);
    expect(unitAttempts(view, 'line:v3.aim.develop#1')).toBe(1);
    expect(unitAttempts(view, 'line:v3.nope#1')).toBe(0);
  });

  it('with its words: a key whose number now names other words has no attempts at them; twins share their attempts', () => {
    const view = onDemandViewOf(lines());
    // the jobs above recorded the words «x» under A and B
    expect(unitAttempts(view, { key: B, text: 'x' })).toBe(2);
    expect(unitAttempts(view, { key: B, text: '— и это мат!' })).toBe(0);
    // «{Он} ушёл»: the same words under another piece's key count for this one too
    expect(unitAttempts(view, { key: 'line:v3.lead.advice@b#1', text: 'x', twins: new Set([A]) })).toBe(1);
    expect(unitAttempts(view, { key: 'line:v3.lead.advice@b#1', text: 'x' })).toBe(0);
  });

  it('spends by local day with pending jobs and unresolved intents at full price', () => {
    const view = onDemandViewOf(lines());
    expect(spentByDay(view, 'UTC', ONDEMAND_CAMPAIGN)).toEqual({ days: { '2026-09-24': 300, '2026-09-25': 150 }, totalMilli: 450 });
    expect(spentByDay(view, 'UTC', PREFETCH_CAMPAIGN)).toEqual({ days: { '2026-09-25': 450 }, totalMilli: 450 });
    expect(spentByDay(view, 'UTC').totalMilli).toBe(900);
    // Moscow (UTC+3): the 20:00Z charge is still the 24th (23:00), a moment at 21:30Z is already the 25th
    expect(spentByDay(view, 'Europe/Moscow', ONDEMAND_CAMPAIGN).days).toEqual({ '2026-09-24': 300, '2026-09-25': 150 });
    expect(localDay('2026-09-24T21:30:00.000Z', 'Europe/Moscow')).toBe('2026-09-25');
    expect(localDay('2026-09-24T21:30:00.000Z', 'UTC')).toBe('2026-09-24');
  });

  it('reads a ledger file (a torn last line is broken, a missing file is empty)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-ondemand-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'ledger.giselle-mm1.jsonl');
    expect(readOnDemandLedger(file).unresolved).toEqual([]);
    writeFileSync(file, `${lines()
      .map((l) => JSON.stringify(l))
      .join('\n')}\n{"ev":"char`);
    const view = readOnDemandLedger(file);
    expect(view.ledger.broken).toBe(1);
    expect(view.unresolved.map((i) => i.key)).toEqual(['k3']);
    expect(view.ledger.jobs.get('h1')?.state).toBe('charged');
  });
});
