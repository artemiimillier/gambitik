/**
 * The paid path under a fake Higgsfield CLI: nothing here can spend, talk to the network or play audio.
 * Proves the SPEC §10 spend protocol: no --spend / --budget ⇒ zero calls; the budget and --max-jobs caps; a rate limit
 * never produces a duplicate job; a resume waits for ledgered jobs and never re-creates them.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VOICE } from './config.ts';
import { jobMilli } from './cost.ts';
import { SpendRefused, assertSpendAllowed, backoffMs, runGenerate } from './generate.ts';
import type { GenerateDeps, GenerateOptions } from './generate.ts';
import type { CliResult, RunCli } from './higgsfield.ts';
import { keyOfJob, parseJobsFile } from './jobs.ts';
import type { GenJob, JobsFile } from './jobs.ts';
import { LedgerLocked, appendLedger, readLedger, spentMilli } from './ledger.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-voice-gen-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** What the real `higgsfield model get text2speech_v2 --json` prints (a captured sample). */
const MODEL = {
  display_name: 'Text to Speech V2',
  job_type: 'text2speech_v2',
  params: [
    { name: 'prompt', type: 'string', default: null, required: true },
    { name: 'variant', type: 'string', default: null, required: true, enum: ['elevenlabs', 'minimax', 'seed_speech', 'vibe_voice', 'cozy_voice'] },
    { name: 'voice_id', type: 'string', default: null, required: true },
    { name: 'voice_type', type: 'string', default: null, required: true, enum: ['preset', 'element'] },
  ],
  type: 'audio',
};

interface FakeJob {
  id: string;
  prompt: string;
  status: string;
  createdAt: string;
}

interface FakeOptions {
  balance?: number;
  /** the next N creates answer with a rate limit */
  rateLimits?: number;
  /** …and still create the job (a server that misbehaves: the duplicate check must catch it) */
  rateLimitStillCreates?: boolean;
  /** the next create fails ambiguously (exit 1, no rate limit); `withJob` = the job exists anyway */
  ambiguous?: 'withJob' | 'noJob';
  finalStatus?: string;
  waitFails?: boolean;
  /** the next N waits answer HTTP 503 (a server hiccup) */
  waitUnavailable?: number;
  costCredits?: number;
  model?: unknown;
  /** jobs that already exist at Higgsfield before the run */
  existing?: FakeJob[];
  /** the timestamp every created job gets */
  createdAt?: string;
  /** a server that charges this many credits more (or less) than it says for each completed job (the audit must see it) */
  chargeSkew?: number;
  /** the server's price per prompt (default: the SPEC price) — a change after the first job must stop the run */
  costOf?: (prompt: string) => number;
}

function fakeHiggsfield(opts: FakeOptions = {}) {
  const calls: string[][] = [];
  const jobs = new Map<string, FakeJob>((opts.existing ?? []).map((j) => [j.id, j]));
  let seq = 0;
  let rateLimits = opts.rateLimits ?? 0;
  let ambiguous = opts.ambiguous;
  /** a real account: its balance falls when a job completes (debit at completion) */
  let balanceMilli = Math.round((opts.balance ?? 100) * 1000);
  const debited = new Set<string>();
  const ok = (data: unknown): CliResult => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
  const jobJson = (j: FakeJob) => ({
    created_at: j.createdAt,
    display_name: 'Text to Speech V2',
    id: j.id,
    job_type: 'text2speech_v2',
    params: { model: VOICE.variant, prompt: j.prompt, voice_id: VOICE.voiceId, voice_type: 'preset' },
    result_url: j.status === 'completed' ? `https://cdn.example/${j.id}.mp3` : null,
    status: j.status,
  });
  const newJob = (prompt: string): FakeJob => {
    const id = `0000${String(++seq).padStart(4, '0')}-aaaa-bbbb-cccc-dddddddddddd`;
    const job = { id, prompt, status: 'queued', createdAt: opts.createdAt ?? '2026-09-24T06:00:00.000000Z' };
    jobs.set(id, job);
    return job;
  };
  const promptOf = (args: readonly string[]) => args[args.indexOf('--prompt') + 1]!;
  const runCli: RunCli = async (args) => {
    calls.push([...args]);
    const [group, action, arg] = args;
    if (group === 'account') return ok({ credits: balanceMilli / 1000, email: 'owner@example.com', subscription_plan_type: 'plus' });
    if (group === 'model') return ok(opts.model ?? MODEL);
    if (group !== 'generate') return { code: 1, stdout: '', stderr: 'unknown command' };
    if (action === 'cost') return ok({ credits: opts.costCredits ?? opts.costOf?.(promptOf(args)) ?? jobMilli(promptOf(args)) / 1000 });
    if (action === 'list') return ok([...jobs.values()].reverse().map(jobJson));
    if (action === 'create') {
      if (rateLimits > 0) {
        rateLimits--;
        if (opts.rateLimitStillCreates) newJob(promptOf(args));
        return { code: 1, stdout: '', stderr: 'Error: request failed (429): rate_limit_reached, retry later' };
      }
      if (ambiguous !== undefined) {
        const kind = ambiguous;
        ambiguous = undefined;
        if (kind === 'withJob') newJob(promptOf(args));
        return { code: 1, stdout: '', stderr: 'Error: context deadline exceeded' };
      }
      return ok([jobJson(newJob(promptOf(args)))]);
    }
    if (action === 'wait' || action === 'get') {
      const job = jobs.get(arg!);
      if (job === undefined) return { code: 1, stdout: '', stderr: 'job not found' };
      if (action === 'wait' && opts.waitFails) return { code: 1, stdout: '', stderr: 'Error: timeout' };
      if (action === 'wait' && (opts.waitUnavailable ?? 0) > 0) {
        opts.waitUnavailable = (opts.waitUnavailable ?? 0) - 1;
        return { code: 1, stdout: '', stderr: 'Error: Higgsfield API error (HTTP 503). request failed' };
      }
      job.status = opts.finalStatus ?? 'completed';
      if (job.status === 'completed' && !debited.has(job.id)) {
        debited.add(job.id);
        balanceMilli -= jobMilli(job.prompt) + Math.round((opts.chargeSkew ?? 0) * 1000);
      }
      return ok([jobJson(job)]);
    }
    return { code: 1, stdout: '', stderr: 'unknown' };
  };
  const creates = () => calls.filter((c) => c[1] === 'create');
  return { runCli, calls, jobs, creates };
}

function jobsFile(prompts: string[], campaign = 'pilot'): JobsFile {
  return parseJobsFile({
    v: 1,
    voiceKey: 'giselle-mm1',
    campaign,
    jobs: prompts.map((prompt, i) => ({ prompt, take: 1, recipe: 'whole', pieces: [{ key: `line:test.line#${i + 1}`, text: prompt, pool: 'test.line' }] })),
  });
}

/** Five whole lines, each ≤ 50 characters (0.15 credits each). */
const FIVE = ['Ого!', 'Смотри, тут подарок!', 'Осторожно!', 'Найдёшь ход сам?', 'Я готов, начинаем!'];

function harness(dir: string, fake: ReturnType<typeof fakeHiggsfield>) {
  const sleeps: number[] = [];
  const downloads: string[] = [];
  const logs: string[] = [];
  let tick = 0;
  const deps: GenerateDeps = {
    runCli: fake.runCli,
    download: async (url, dest) => {
      downloads.push(url);
      writeFileSync(dest, 'ID3 fake master');
      return { bytes: 15, sha256: 'f'.repeat(64) };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    now: () => new Date(Date.parse('2026-09-24T10:00:00.000Z') + 1000 * tick++),
    log: (line) => logs.push(line),
  };
  const base = (file: JobsFile, extra: Partial<GenerateOptions> = {}): GenerateOptions => ({
    spend: true,
    budget: 15,
    jobs: file,
    ledgerFile: path.join(dir, 'ledger.giselle-mm1.jsonl'),
    mastersDir: path.join(dir, '.masters'),
    ...extra,
  });
  return { deps, base, sleeps, downloads, logs, ledgerFile: path.join(dir, 'ledger.giselle-mm1.jsonl') };
}

describe('refusals happen before any CLI call', () => {
  it('no --spend ⇒ zero calls, no ledger', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield();
    const h = harness(dir, fake);
    await expect(runGenerate(h.base(jobsFile(FIVE), { spend: false }), h.deps)).rejects.toBeInstanceOf(SpendRefused);
    expect(fake.calls).toHaveLength(0);
    expect(existsSync(h.ledgerFile)).toBe(false);
  });

  it('no --budget, zero, negative or NaN budget ⇒ zero calls', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield();
    const h = harness(dir, fake);
    for (const budget of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(runGenerate(h.base(jobsFile(FIVE), { budget }), h.deps)).rejects.toThrow(/--budget/);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('an empty or over-long prompt ⇒ zero calls (checked for every job up front)', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield();
    const h = harness(dir, fake);
    const bad = (prompt: string): JobsFile => ({ v: 1, voiceKey: 'giselle-mm1', campaign: 'pilot', jobs: [...jobsFile(FIVE).jobs, { prompt, take: 1, recipe: 'whole', pieces: [{ key: 'line:x#1', text: 'x' }] }] });
    await expect(runGenerate(h.base(bad('')), h.deps)).rejects.toThrow(/empty prompt/);
    await expect(runGenerate(h.base(bad('   ')), h.deps)).rejects.toThrow(/empty prompt/);
    await expect(runGenerate(h.base(bad('а'.repeat(481))), h.deps)).rejects.toThrow(/481 characters/);
    expect(fake.calls).toHaveLength(0);
    expect(() => assertSpendAllowed({ spend: true, budget: 1, jobs: jobsFile(FIVE), maxJobs: -1 })).toThrow(SpendRefused);
  });

  it('a second generator on the same ledger is refused (concurrency 1)', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield();
    const h = harness(dir, fake);
    writeFileSync(`${h.ledgerFile}.lock`, String(process.pid));
    await expect(runGenerate(h.base(jobsFile(FIVE)), h.deps)).rejects.toBeInstanceOf(LedgerLocked);
    expect(fake.calls).toHaveLength(0);
  });

  it('a lock left by a dead process is taken over', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield();
    const h = harness(dir, fake);
    writeFileSync(`${h.ledgerFile}.lock`, '999999');
    const summary = await runGenerate(h.base(jobsFile(FIVE.slice(0, 1))), h.deps);
    expect(summary.created).toBe(1);
    expect(existsSync(`${h.ledgerFile}.lock`)).toBe(false);
  });
});

describe('pre-flight checks refuse before any create', () => {
  it('balance lower than what the run may spend', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield({ balance: 0.3 });
    const h = harness(dir, fake);
    await expect(runGenerate(h.base(jobsFile(FIVE)), h.deps)).rejects.toThrow(/на счёте 0.3/);
    expect(fake.creates()).toHaveLength(0);
  });

  it('model params changed (a new required param)', async () => {
    const dir = tempDir();
    const model = { ...MODEL, params: [...MODEL.params, { name: 'speed', type: 'number', required: true }] };
    const fake = fakeHiggsfield({ model });
    const h = harness(dir, fake);
    await expect(runGenerate(h.base(jobsFile(FIVE)), h.deps)).rejects.toThrow(/speed/);
    expect(fake.creates()).toHaveLength(0);
  });

  it('the server prices a prompt differently from the SPEC formula', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield({ costCredits: 0.3 });
    const h = harness(dir, fake);
    await expect(runGenerate(h.base(jobsFile(FIVE)), h.deps)).rejects.toThrow(/цена изменилась/);
    expect(fake.creates()).toHaveLength(0);
  });

  it('checks account and model first, and never writes the account e-mail anywhere', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield();
    const h = harness(dir, fake);
    await runGenerate(h.base(jobsFile(FIVE.slice(0, 1))), h.deps);
    expect(fake.calls[0]).toEqual(['account', 'status', '--json']);
    expect(fake.calls[1]).toEqual(['model', 'get', 'text2speech_v2', '--json']);
    expect(readFileSync(h.ledgerFile, 'utf8')).not.toContain('@');
    expect(h.logs.join('\n')).not.toContain('@');
  });
});

describe('the price of every job and the balance audit', () => {
  it('asks the server for the price of EVERY prompt before its create; a changed price stops the run there', async () => {
    const dir = tempDir();
    // the provider raises its price after the first job: 0.3 instead of 0.15 for everything but «Ого!»
    const fake = fakeHiggsfield({ costOf: (prompt) => (prompt === FIVE[0] ? 0.15 : 0.3) });
    const h = harness(dir, fake);
    const summary = await runGenerate(h.base(jobsFile(FIVE)), h.deps);
    expect(summary.created).toBe(1);
    expect(summary.stop).toBe('price');
    expect(fake.creates()).toHaveLength(1);
    // one price question per prompt, each right before its create (the second one found the change)
    const costs = fake.calls.filter((c) => c[1] === 'cost').map((c) => c[c.indexOf('--prompt') + 1]);
    expect(costs).toEqual([FIVE[0], FIVE[1]]);
    const createAt = fake.calls.findIndex((c) => c[1] === 'create');
    const secondCostAt = fake.calls.findIndex((c, i) => i > createAt && c[1] === 'cost');
    expect(secondCostAt).toBeGreaterThan(createAt);
    expect(h.logs.join('\n')).toMatch(/цена изменилась/);
    // the balance still fell by exactly what was charged: the audit agrees
    expect(summary.audit).toMatchObject({ ok: true, deltaMilli: 150, minMilli: 150 });
  });

  it('a run whose balance fell by what the ledger charged passes the audit', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield({ balance: 10 });
    const h = harness(dir, fake);
    const summary = await runGenerate(h.base(jobsFile(FIVE.slice(0, 3))), h.deps);
    expect(summary.charged).toBe(3);
    expect(summary.balanceBeforeMilli - (summary.balanceAfterMilli ?? 0)).toBe(450);
    expect(summary.audit).toEqual({ ok: true, deltaMilli: 450, minMilli: 450, maxMilli: 450 });
  });

  it('a balance that fell by more than the ledger says is recorded, and every later run refuses until --accept-audit', async () => {
    const dir = tempDir();
    // the provider takes 0.15 more per job than the price it announced
    const fake = fakeHiggsfield({ balance: 10, chargeSkew: 0.15 });
    const h = harness(dir, fake);
    const first = await runGenerate(h.base(jobsFile(FIVE.slice(0, 2))), h.deps);
    expect(first.audit).toEqual({ ok: false, deltaMilli: 600, minMilli: 300, maxMilli: 300 });
    expect(h.logs.join('\n')).toMatch(/баланс упал на 0\.6 кр\./);
    const audits = readLedger(h.ledgerFile).lines.filter((l) => l.ev === 'audit');
    expect(audits).toEqual([expect.objectContaining({ ok: false, deltaMilli: 600 })]);

    // the next run: refused before ANY call (not even the balance)
    const calls = fake.calls.length;
    await expect(runGenerate(h.base(jobsFile(FIVE)), h.deps)).rejects.toThrow(/не сошёлся с журналом/);
    expect(fake.calls).toHaveLength(calls);

    // the parent looked and accepts: the run goes on (and its own audit starts afresh)
    const accepted = await runGenerate(h.base(jobsFile(FIVE.slice(0, 3)), { acceptAudit: true }), h.deps);
    expect(accepted.created).toBe(1);
    const after = readLedger(h.ledgerFile).lines.filter((l) => l.ev === 'audit');
    expect(after[1]).toMatchObject({ ok: true, accepted: true });
  });
});

describe('budget and job caps', () => {
  it('stops exactly at the budget: 0.45 credits buy three 0.15 jobs', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield();
    const h = harness(dir, fake);
    const summary = await runGenerate(h.base(jobsFile(FIVE), { budget: 0.45 }), h.deps);
    expect(summary.created).toBe(3);
    expect(summary.stop).toBe('budget');
    expect(summary.spentMilli).toBe(450);
    expect(fake.creates()).toHaveLength(3);
    expect(spentMilli(readLedger(h.ledgerFile), 'pilot')).toBe(450);

    // the same command again: the campaign already used its budget → no new job
    const again = await runGenerate(h.base(jobsFile(FIVE), { budget: 0.45 }), h.deps);
    expect(again.created).toBe(0);
    expect(again.stop).toBe('budget');
    expect(fake.creates()).toHaveLength(3);
  });

  it('every create uses the exact voice and no --wait', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield();
    const h = harness(dir, fake);
    await runGenerate(h.base(jobsFile(FIVE.slice(0, 1))), h.deps);
    expect(fake.creates()[0]).toEqual(['generate', 'create', 'text2speech_v2', '--prompt', 'Ого!', '--variant', 'minimax', '--voice_type', 'preset', '--voice_id', VOICE.voiceId, '--json']);
    expect(fake.creates()[0]).not.toContain('--wait');
  });

  it('--max-jobs is a second cap; --max-jobs 0 creates nothing', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield();
    const h = harness(dir, fake);
    const two = await runGenerate(h.base(jobsFile(FIVE), { maxJobs: 2 }), h.deps);
    expect(two.created).toBe(2);
    expect(two.stop).toBe('max-jobs');
    const none = await runGenerate(h.base(jobsFile(FIVE), { maxJobs: 0 }), h.deps);
    expect(none.created).toBe(0);
    expect(fake.creates()).toHaveLength(2);
  });

  it('writes created BEFORE waiting, then charged and downloaded; masters land in .masters/', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield();
    const h = harness(dir, fake);
    await runGenerate(h.base(jobsFile(FIVE.slice(0, 2))), h.deps);
    const events = readFileSync(h.ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { ev: string; jobId?: string });
    expect(events.map((e) => e.ev)).toEqual(['balance', 'created', 'charged', 'downloaded', 'created', 'charged', 'downloaded', 'balance', 'audit']);
    const view = readLedger(h.ledgerFile);
    for (const job of view.jobs.values()) {
      expect(job.state).toBe('charged');
      expect(existsSync(path.join(dir, '.masters', job.master!))).toBe(true);
    }
    expect(h.downloads).toHaveLength(2);
  });

  it('a failed job is not charged and does not use the budget', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield({ finalStatus: 'failed' });
    const h = harness(dir, fake);
    const summary = await runGenerate(h.base(jobsFile(FIVE.slice(0, 1))), h.deps);
    expect(summary.failed).toBe(1);
    expect(summary.spentMilli).toBe(0);
    expect(h.downloads).toHaveLength(0);
  });
});

describe('rate limits never produce a duplicate', () => {
  it('backs off 2 s → 4 s (with jitter) and checks generate list before every retry', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield({ rateLimits: 2 });
    const h = harness(dir, fake);
    const summary = await runGenerate(h.base(jobsFile(FIVE.slice(0, 1))), h.deps);
    expect(summary.created).toBe(1);
    expect(summary.rateLimited).toBe(2);
    expect(fake.creates()).toHaveLength(3);
    expect(fake.jobs.size).toBe(1);
    expect(h.sleeps).toEqual([2000, 4000]);
    // list before the 2nd and the 3rd create (plus the one at the start)
    const order = fake.calls.filter((c) => c[1] === 'create' || c[1] === 'list').map((c) => c[1]);
    expect(order).toEqual(['list', 'create', 'list', 'create', 'list', 'create']);
  });

  it('a create that answered 429 but made the job anyway is adopted, not repeated', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield({ rateLimits: 1, rateLimitStillCreates: true });
    const h = harness(dir, fake);
    const summary = await runGenerate(h.base(jobsFile(FIVE.slice(0, 1))), h.deps);
    expect(fake.creates()).toHaveLength(1);
    expect(fake.jobs.size).toBe(1);
    expect(summary.adopted).toBe(1);
    expect(summary.charged).toBe(1);
  });

  it('«429» inside the JSON of a successful create is not a rate limit', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield({ createdAt: '2026-09-24T05:55:26.042904Z' });
    const h = harness(dir, fake);
    const summary = await runGenerate(h.base(jobsFile(FIVE.slice(0, 1))), h.deps);
    expect(summary.created).toBe(1);
    expect(summary.rateLimited).toBe(0);
    expect(h.sleeps).toEqual([]);
    expect(fake.jobs.size).toBe(1);
  });

  it('gives up after 8 tries and stops the run (nothing charged)', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield({ rateLimits: 100 });
    const h = harness(dir, fake);
    const summary = await runGenerate(h.base(jobsFile(FIVE)), h.deps);
    expect(summary.stop).toBe('rate-limit');
    expect(fake.creates()).toHaveLength(8);
    expect(fake.jobs.size).toBe(0);
    expect(summary.spentMilli).toBe(0);
    expect(Math.max(...h.sleeps)).toBeLessThanOrEqual(60_000);
  });

  it('an ambiguous create failure adopts the job if it exists …', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield({ ambiguous: 'withJob' });
    const h = harness(dir, fake);
    const summary = await runGenerate(h.base(jobsFile(FIVE.slice(0, 1))), h.deps);
    expect(fake.creates()).toHaveLength(1);
    expect(summary.adopted).toBe(1);
    expect(fake.jobs.size).toBe(1);
  });

  it('… and otherwise stops without retrying blindly', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield({ ambiguous: 'noJob' });
    const h = harness(dir, fake);
    const summary = await runGenerate(h.base(jobsFile(FIVE)), h.deps);
    expect(summary.stop).toBe('create-error');
    expect(fake.creates()).toHaveLength(1);
    expect(fake.jobs.size).toBe(0);
  });

  it('backoff grows 2 → 60 s with ±25 % jitter', () => {
    expect(backoffMs(1, () => 0)).toBe(1500);
    expect(backoffMs(1, () => 1)).toBe(2500);
    expect(backoffMs(2, () => 0.5)).toBe(4000);
    expect(backoffMs(6, () => 0.5)).toBe(60_000);
    expect(backoffMs(8, () => 1)).toBe(60_000);
  });
});

describe('resume never re-creates', () => {
  function seedPending(ledgerFile: string, job: GenJob, jobId: string, campaign = 'pilot') {
    appendLedger(ledgerFile, { ev: 'created', at: '2026-09-24T09:00:00.000Z', run: 'r0', campaign, key: keyOfJob(job), jobId, milli: jobMilli(job.prompt), job });
  }

  it('a ledgered job without a result is waited for, not created again', async () => {
    const dir = tempDir();
    const file = jobsFile(FIVE.slice(0, 2));
    const pendingId = 'feed0000-aaaa-bbbb-cccc-dddddddddddd';
    const fake = fakeHiggsfield({ existing: [{ id: pendingId, prompt: file.jobs[0]!.prompt, status: 'in_progress', createdAt: '2026-09-24T09:00:00Z' }] });
    const h = harness(dir, fake);
    seedPending(h.ledgerFile, file.jobs[0]!, pendingId);

    const summary = await runGenerate(h.base(file), h.deps);
    expect(summary.resumed).toBe(1);
    expect(fake.calls.filter((c) => c[1] === 'wait' && c[2] === pendingId)).toHaveLength(1);
    const prompts = fake.creates().map((c) => c[c.indexOf('--prompt') + 1]);
    expect(prompts).toEqual([file.jobs[1]!.prompt]);
    expect(readLedger(h.ledgerFile).jobs.get(pendingId)?.state).toBe('charged');

    // a second run: everything is done → no create, no wait
    const before = fake.calls.length;
    const again = await runGenerate(h.base(file), h.deps);
    expect(again.created + again.resumed + again.adopted).toBe(0);
    expect(fake.calls.slice(before).filter((c) => c[1] === 'create' || c[1] === 'wait')).toHaveLength(0);
  });

  it('a pending job counts at full price, and a failed wait stops the run with the job still ledgered', async () => {
    const dir = tempDir();
    const file = jobsFile(FIVE);
    const pendingId = 'feed0001-aaaa-bbbb-cccc-dddddddddddd';
    const fake = fakeHiggsfield({ waitFails: true, existing: [{ id: pendingId, prompt: file.jobs[0]!.prompt, status: 'in_progress', createdAt: '2026-09-24T09:00:00Z' }] });
    const h = harness(dir, fake);
    seedPending(h.ledgerFile, file.jobs[0]!, pendingId);
    const summary = await runGenerate(h.base(file), h.deps);
    expect(summary.stop).toBe('wait-error');
    expect(fake.creates()).toHaveLength(0);
    expect(readLedger(h.ledgerFile).jobs.get(pendingId)?.state).toBe('pending');
    expect(spentMilli(readLedger(h.ledgerFile), 'pilot')).toBe(150);
  });

  it('a 503 while waiting is waited out (free): no stop, no second create, the job is charged once', async () => {
    const dir = tempDir();
    const file = jobsFile(FIVE.slice(0, 2));
    const fake = fakeHiggsfield({ waitUnavailable: 2 });
    const h = harness(dir, fake);
    const summary = await runGenerate(h.base(file), h.deps);
    expect(summary.stop).toBe('done');
    expect(summary.charged).toBe(2);
    expect(fake.creates()).toHaveLength(2);
    expect(spentMilli(readLedger(h.ledgerFile), 'pilot')).toBe(file.jobs.reduce((s, j) => s + jobMilli(j.prompt), 0));
  });

  it('an un-ledgered identical job at Higgsfield (crash between create and ledger) is adopted', async () => {
    const dir = tempDir();
    const file = jobsFile(FIVE.slice(0, 1));
    const orphanId = 'feed0002-aaaa-bbbb-cccc-dddddddddddd';
    const fake = fakeHiggsfield({ existing: [{ id: orphanId, prompt: file.jobs[0]!.prompt, status: 'completed', createdAt: '2026-09-24T09:00:00Z' }] });
    const h = harness(dir, fake);
    const summary = await runGenerate(h.base(file), h.deps);
    expect(summary.adopted).toBe(1);
    expect(fake.creates()).toHaveLength(0);
    expect(readLedger(h.ledgerFile).jobs.get(orphanId)?.adopted).toBe(true);
  });

  it('a charged job whose master is missing is downloaded again (fresh URL via generate get)', async () => {
    const dir = tempDir();
    const file = jobsFile(FIVE.slice(0, 1));
    const fake = fakeHiggsfield();
    const h = harness(dir, fake);
    await runGenerate(h.base(file, { maxJobs: 1 }), h.deps);
    // simulate a lost download: drop the downloaded line
    const lines = readFileSync(h.ledgerFile, 'utf8').trim().split('\n').filter((l) => !l.includes('"downloaded"'));
    writeFileSync(h.ledgerFile, `${lines.join('\n')}\n`);
    let failOnce = true;
    const deps: GenerateDeps = {
      ...h.deps,
      download: async (url, dest) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('403 expired');
        }
        return h.deps.download(url, dest);
      },
    };
    const summary = await runGenerate(h.base(file), deps);
    expect(summary.downloaded).toBe(1);
    expect(fake.calls.some((c) => c[1] === 'get')).toBe(true);
    expect(fake.creates()).toHaveLength(1);
  });

  it('a truncated last ledger line (crash mid-write) is skipped, not fatal', async () => {
    const dir = tempDir();
    const fake = fakeHiggsfield();
    const h = harness(dir, fake);
    writeFileSync(h.ledgerFile, '{"ev":"created","at":"2026-09-24T09:00:00Z","run":"r0","campai');
    const summary = await runGenerate(h.base(jobsFile(FIVE.slice(0, 1))), h.deps);
    expect(summary.created).toBe(1);
    expect(h.logs.some((l) => l.includes('повреждённых'))).toBe(true);
    // new lines start on a fresh line: the torn one stays the only broken line
    const view = readLedger(h.ledgerFile);
    expect(view.broken).toBe(1);
    expect(view.jobs.size).toBe(1);
  });
});
