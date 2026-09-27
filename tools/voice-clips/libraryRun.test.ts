/**
 * `voice:library-run` under a FAKE Higgsfield and a fake finish (nothing here can spend, talk to the network or play
 * audio): --dry-run and a missing --spend make zero calls, the budget and its cap hold, every portion goes
 * through the spend protocol into the overlay ledger (intent before create), the dedup skips a unit the server
 * recorded in between, a failed take gets exactly one take 2 alone and a unit never a third, errors of Higgsfield stop
 * the run, a stop request ends it cleanly, a resumed run waits for its pending job and finishes a downloaded one, the
 * run waits while the server has a job in flight, and with `inFlight` the waits overlap while the creates stay one at a
 * time.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VOICE, VOICE_KEY } from './config.ts';
import { jobMilli } from './cost.ts';
import { SpendRefused } from './generate.ts';
import type { CliResult, RunCli } from './higgsfield.ts';
import { keyOfJob } from './jobs.ts';
import type { GenJob } from './jobs.ts';
import { appendLedgerLine } from './ledger.ts';
import { EMPTY_USAGE, LIBRARY_CAMPAIGN } from './library.ts';
import type { LibraryUnit } from './library.ts';
import { Finisher, runLibrary, unfinishedJobs, unitIdsOfJob } from './libraryRun.ts';
import type { FinishBatch, FinishOutcome, LibraryRunDeps, LibraryRunOptions } from './libraryRun.ts';
import type { UnitRecord, UnitStore } from './manifest.ts';
import { ONDEMAND_CAMPAIGN, ONDEMAND_TAKE_BASE, OVERLAY_LEDGER, readOnDemandLedger, readOnDemandLines } from './ondemand.ts';
import { overlayPaths } from './overlay.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-library-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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
  /** the create number N (1-based) fails like this, no job made */
  createFailsAt?: { n: number; stderr: string };
  /** the create number N answers exit 0 without a job id; the job exists, is debited at once, and the list shows it one look later */
  createNoIdAt?: number;
  /** the `generate cost` calls number N… (1-based) fail with an HTTP 503 */
  costFailsAt?: number[];
  /** each wait takes this many event-loop turns (lets waits overlap) */
  waitTurns?: number;
  /** called after each create (a hook to change the world in between) */
  afterCreate?: (n: number) => void;
}

/** A fake Higgsfield: debits at completion; tracks the waits in flight and never-overlapping creates. */
function fakeHf(opts: FakeOptions = {}) {
  const calls: string[][] = [];
  const jobs = new Map<string, FakeJob>();
  let seq = 0;
  let creates = 0;
  let costs = 0;
  let balanceMilli = Math.round((opts.balance ?? 3000) * 1000);
  let waiting = 0;
  let maxWaiting = 0;
  /** jobs the next list does not show yet (a list that lags behind a create) */
  const hidden = new Set<string>();
  let creating = 0;
  let maxCreating = 0;
  const ok = (data: unknown): CliResult => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
  const jobJson = (j: FakeJob) => ({
    created_at: j.createdAt,
    id: j.id,
    job_type: 'text2speech_v2',
    params: { model: VOICE.variant, prompt: j.prompt, voice_id: VOICE.voiceId, voice_type: 'preset' },
    result_url: j.status === 'completed' ? `https://cdn.example/${j.id}.mp3` : null,
    status: j.status,
  });
  const promptOf = (args: readonly string[]) => args[args.indexOf('--prompt') + 1]!;
  const turns = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
  };
  const make = (prompt: string): FakeJob => {
    const id = `0000${String(++seq).padStart(4, '0')}-aaaa-bbbb-cccc-dddddddddddd`;
    const j = { id, prompt, status: 'queued', createdAt: new Date(Date.parse('2026-09-26T10:00:00Z') + seq * 1000).toISOString() };
    jobs.set(id, j);
    return j;
  };
  const runCli: RunCli = async (args) => {
    calls.push([...args]);
    const [group, action, arg] = args;
    if (group === 'account') return ok({ credits: balanceMilli / 1000, email: 'owner@example.com' });
    if (group === 'model') return ok(MODEL);
    if (group !== 'generate') return { code: 1, stdout: '', stderr: 'unknown' };
    if (action === 'cost') {
      costs++;
      if (opts.costFailsAt?.includes(costs)) return { code: 1, stdout: '', stderr: 'Error: Higgsfield API error (HTTP 503). request failed' };
      return ok({ credits: jobMilli(promptOf(args)) / 1000 });
    }
    if (action === 'list') {
      const shown = [...jobs.values()].filter((j) => !hidden.has(j.id));
      for (const id of [...hidden]) hidden.delete(id);
      return ok(shown.reverse().map(jobJson));
    }
    if (action === 'create') {
      creating++;
      maxCreating = Math.max(maxCreating, creating);
      await turns(1);
      creating--;
      creates++;
      if (opts.createFailsAt?.n === creates) return { code: 1, stdout: '', stderr: opts.createFailsAt.stderr };
      if (opts.createNoIdAt === creates) {
        const lost = make(promptOf(args));
        lost.status = 'completed';
        balanceMilli -= jobMilli(lost.prompt);
        hidden.add(lost.id);
        return ok(['queued']);
      }
      const j = make(promptOf(args));
      opts.afterCreate?.(creates);
      return ok([jobJson(j)]);
    }
    if (action === 'wait' || action === 'get') {
      const j = jobs.get(arg!);
      if (j === undefined) return { code: 1, stdout: '', stderr: 'job not found' };
      if (action === 'wait') {
        waiting++;
        maxWaiting = Math.max(maxWaiting, waiting);
        await turns(opts.waitTurns ?? 0);
        waiting--;
        if (j.status !== 'completed') {
          j.status = 'completed';
          balanceMilli -= jobMilli(j.prompt);
        }
      }
      return ok([jobJson(j)]);
    }
    return { code: 1, stdout: '', stderr: 'unknown' };
  };
  return {
    runCli,
    calls,
    jobs,
    make,
    creates: () => calls.filter((c) => c[1] === 'create').map((c) => promptOf(c)),
    get maxWaiting() {
      return maxWaiting;
    },
    get maxCreating() {
      return maxCreating;
    },
  };
}

/** A fake finish: every unit of a batch becomes a published take — or a checked failure for the texts in `fail`. */
function fakeFinish(overlayDir: string, fail: Set<string> = new Set()) {
  const batches: FinishBatch[] = [];
  const finish = async (batch: FinishBatch): Promise<FinishOutcome> => {
    batches.push(batch);
    const ov = overlayPaths(overlayDir);
    const store: UnitStore = existsSync(ov.storeFile) ? (JSON.parse(readFileSync(ov.storeFile, 'utf8')) as UnitStore) : { v: 1, voiceKey: VOICE_KEY, units: {} };
    const jobs = readOnDemandLedger(ov.ledgerFile).ledger.jobs;
    let published = 0;
    let needsEar = 0;
    for (const jobId of batch.jobIds) {
      const job = jobs.get(jobId)!.job;
      const ids = unitIdsOfJob(job);
      job.pieces.forEach((p, i) => {
        if ('discard' in p) return;
        const bad = fail.has(p.text);
        const rec: UnitRecord = {
          id: ids[i]!,
          key: p.key,
          text: p.text,
          take: job.take,
          ms: 900,
          on: 30,
          off: 860,
          file: `${ids[i]!.slice(1, 3)}/${ids[i]}.mp3`,
          qa: bad ? 'needsEar' : 'asr',
          jobId,
          jobKey: keyOfJob(job),
          cut: i,
          bytes: 1000,
          flags: bad ? ['asr:0.5'] : [],
          asr: { heard: bad ? 'что-то другое' : p.text, score: bad ? 0.5 : 1, ok: !bad, missing: [], model: 'fake', at: '2026-09-26T10:00:00Z' },
          processedAt: '2026-09-26T10:00:00Z',
        };
        store.units[rec.id] = rec;
        if (bad) needsEar++;
        else published++;
      });
    }
    mkdirSync(path.dirname(ov.storeFile), { recursive: true });
    writeFileSync(ov.storeFile, JSON.stringify(store));
    // the published takes: the overlay manifest the dedup reads
    const units: Record<string, unknown> = {};
    const keys: Record<string, string[]> = {};
    for (const u of Object.values(store.units)) {
      if (u.qa !== 'asr') continue;
      units[u.id] = { key: u.key, text: u.text, take: u.take, ms: u.ms, on: u.on, off: u.off, file: u.file, qa: u.qa };
      keys[u.key] = [...(keys[u.key] ?? []), u.id];
    }
    const rel = `${VOICE_KEY}/manifest.${String(batches.length).padStart(12, '0')}.json`;
    mkdirSync(path.join(overlayDir, VOICE_KEY), { recursive: true });
    writeFileSync(path.join(overlayDir, rel), JSON.stringify({ v: 1, voiceKey: VOICE_KEY, libraryVersion: batches.length, units, pools: {}, keys, fallbacks: {} }));
    writeFileSync(path.join(overlayDir, 'index.json'), JSON.stringify({ default: VOICE_KEY, voices: { [VOICE_KEY]: rel } }));
    return { processedJobs: batch.jobIds.length, requeued: 0, verified: published + needsEar, published, needsEar };
  };
  return { finish, batches };
}

const u = (n: number, text: string, extra: Partial<LibraryUnit> = {}): LibraryUnit => ({
  key: `line:v3.praise.test#${n}`,
  text,
  source: 'lesson',
  role: 'whole',
  kind: 'line',
  family: 'praise',
  weight: 10 - n / 100,
  ...extra,
});

/** Eight short sentences (each alone < 50 characters: four per job of ≤ 50 would still cost the same). */
const UNITS: LibraryUnit[] = ['Отлично!', 'Здорово!', 'Так держать!', 'Супер!', 'Красиво!', 'Вот это ход!', 'Браво!', 'Сильно!'].map((t, i) => u(i + 1, t));

function setup(o: { units?: LibraryUnit[]; fake?: FakeOptions; fail?: Set<string>; stopAfter?: number } = {}) {
  const dir = tempDir();
  const overlayDir = path.join(dir, 'ov');
  mkdirSync(overlayDir, { recursive: true });
  const hf = fakeHf(o.fake);
  const fin = fakeFinish(overlayDir, o.fail);
  const logs: string[] = [];
  const sleeps: number[] = [];
  let tick = 0;
  let asked = 0;
  const deps: LibraryRunDeps = {
    runCli: hf.runCli,
    download: async (_url, dest) => {
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, 'ID3 fake master');
      return { bytes: 15, sha256: 'f'.repeat(64) };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    now: () => new Date(Date.parse('2026-09-26T10:00:00.000Z') + 1000 * tick++),
    log: (line) => logs.push(line),
    finish: fin.finish,
    shouldStop: () => o.stopAfter !== undefined && ++asked > o.stopAfter,
  };
  const opts = (extra: Partial<LibraryRunOptions> = {}): LibraryRunOptions => ({
    budget: 50,
    spend: true,
    dryRun: false,
    portion: 2,
    inFlight: 1,
    overlayDir,
    staticLibrary: null,
    tools: null,
    usage: EMPTY_USAGE,
    units: o.units ?? UNITS,
    outDir: path.join(dir, 'out'),
    lockWaitMs: 0,
    ...extra,
  });
  return { dir, overlayDir, hf, fin, logs, sleeps, deps, opts, ledgerFile: path.join(overlayDir, OVERLAY_LEDGER) };
}

describe('nothing is called without the spend flags', () => {
  it('--dry-run: zero CLI calls, the plan file only', async () => {
    const s = setup();
    const summary = await runLibrary(s.opts({ dryRun: true, spend: false, budget: undefined }), s.deps);
    expect(summary.stop).toBe('dry-run');
    expect(s.hf.calls).toEqual([]);
    expect(existsSync(s.ledgerFile)).toBe(false);
    expect(summary.plan).toMatchObject({ planned: 8, jobs: 2 });
    expect(JSON.parse(readFileSync(path.join(s.dir, 'out', 'library.jobs.json'), 'utf8')).campaign).toBe(LIBRARY_CAMPAIGN);
  });

  it('no --spend / no budget / above the 1700 cap: refused with zero calls', async () => {
    const s = setup();
    await expect(runLibrary(s.opts({ spend: false }), s.deps)).rejects.toBeInstanceOf(SpendRefused);
    await expect(runLibrary(s.opts({ budget: undefined }), s.deps)).rejects.toBeInstanceOf(SpendRefused);
    await expect(runLibrary(s.opts({ budget: 1701 }), s.deps)).rejects.toThrow(/1700/);
    expect(s.hf.calls).toEqual([]);
  });
});

describe('recording', () => {
  it('records the whole plan into the overlay ledger (intent before each create), finishes every job, and a second run has nothing to do', async () => {
    const s = setup({ units: UNITS, fake: {} });
    const summary = await runLibrary(s.opts({ portion: 1 }), s.deps);
    expect(summary.stop).toBe('done');
    expect(summary).toMatchObject({ created: 2, charged: 2, failed: 0, left: { units: 0, jobs: 0 } });
    // every job: intent → created, in the campaign «library», take 101
    const lines = readOnDemandLines(s.ledgerFile).lines;
    const intents = lines.filter((l) => l.ev === 'intent');
    expect(intents).toHaveLength(2);
    for (const line of lines.filter((l) => l.ev === 'created')) {
      expect(line).toMatchObject({ campaign: LIBRARY_CAMPAIGN });
      if (line.ev === 'created') expect(line.job.take).toBe(ONDEMAND_TAKE_BASE);
      const at = lines.indexOf(line);
      expect(lines.slice(0, at).some((l) => l.ev === 'intent' && l.key === (line as { key: string }).key)).toBe(true);
    }
    expect(s.fin.batches.flatMap((b) => b.jobIds).sort()).toEqual([...s.hf.jobs.keys()].sort());
    expect(summary.finish.published).toBe(8);
    expect(summary.spentMilli).toBe(2 * 300);
    // again: everything is published — no call that could spend
    const before = s.hf.calls.length;
    const again = await runLibrary(s.opts(), s.deps);
    expect(again.plan.planned).toBe(0);
    expect(s.hf.calls.slice(before).filter((c) => c[1] === 'create')).toEqual([]);
  });

  it('stops at the budget: the ledgered spend never passes it', async () => {
    const s = setup();
    const summary = await runLibrary(s.opts({ budget: 0.3, portion: 1 }), s.deps);
    expect(summary.stop).toBe('budget');
    expect(summary.spentMilli).toBeLessThanOrEqual(300);
    expect(s.hf.creates()).toHaveLength(1);
  });

  it('a unit the server recorded since the plan was made is never paid again: its job is skipped and the rest re-packed', async () => {
    const s = setup({ units: UNITS.slice(0, 4).map((x) => ({ ...x, text: x.text })), fake: {} });
    // 4 units → one job of 4; the server records «Так держать!» before it (a job of its own in the overlay ledger)
    const srvJob: GenJob = { prompt: 'Так держать!', take: ONDEMAND_TAKE_BASE, recipe: 'single', pieces: [{ key: 'line:v3.praise.test#3', text: 'Так держать!', role: 'whole' }] };
    const plan = await runLibrary(s.opts({ dryRun: true }), s.deps);
    expect(plan.plan.jobs).toBe(1);
    appendLedgerLine(s.ledgerFile, { ev: 'created', at: '2026-09-26T09:00:00Z', run: 'srv', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(srvJob), jobId: 'srv-1', milli: 150, job: srvJob });
    appendLedgerLine(s.ledgerFile, { ev: 'charged', at: '2026-09-26T09:00:05Z', key: keyOfJob(srvJob), jobId: 'srv-1', campaign: ONDEMAND_CAMPAIGN, milli: 150, status: 'completed', resultUrl: 'https://cdn.example/srv-1.mp3' });
    const summary = await runLibrary(s.opts(), s.deps);
    expect(summary.stop).toBe('done');
    expect(s.hf.creates()).toEqual(['Отлично!<#0.6#>Здорово!<#0.6#>Супер!']);
  });

  it('a take that failed the check gets exactly one take 2, alone — never a third', async () => {
    const s = setup({ units: UNITS.slice(0, 3), fail: new Set(['Здорово!']) });
    const summary = await runLibrary(s.opts(), s.deps);
    expect(summary.stop).toBe('done');
    const creates = s.hf.creates();
    expect(creates).toEqual(['Отлично!<#0.6#>Здорово!<#0.6#>Так держать!', 'Здорово!']);
    const retake = [...readOnDemandLedger(s.ledgerFile).ledger.jobs.values()].find((j) => j.job.prompt === 'Здорово!')!;
    expect(retake.job.take).toBe(ONDEMAND_TAKE_BASE + 1);
    // it failed again: attempts are used up, nothing more is bought
    const before = s.hf.creates().length;
    await runLibrary(s.opts(), s.deps);
    expect(s.hf.creates().length).toBe(before);
  });

  it('an error of Higgsfield stops the run (no credits): nothing more is created', async () => {
    const s = setup({ fake: { createFailsAt: { n: 2, stderr: 'Error: insufficient credits (HTTP 402)' } } });
    const summary = await runLibrary(s.opts({ portion: 1 }), s.deps);
    expect(summary.stop).toBe('create-error');
    expect(summary.message).toMatch(/no-credits/);
    expect(s.hf.calls.filter((c) => c[1] === 'create')).toHaveLength(2);
  });

  it('a passing 503 of Higgsfield at a create: a 2-minute pause, the open intent is looked up, the same portion goes on — nothing twice', async () => {
    const s = setup({ fake: { createFailsAt: { n: 2, stderr: 'Error: Higgsfield API error (HTTP 503). request failed with status 503 Service Unavailable' } } });
    const summary = await runLibrary(s.opts({ portion: 2 }), s.deps);
    expect(summary.stop).toBe('done');
    expect(s.sleeps).toContain(120_000);
    // the failed create made no job; after the pause the same job is asked for once more — two jobs in all
    const creates = s.hf.creates();
    expect(creates).toHaveLength(3);
    expect(creates[1]).toBe(creates[2]);
    expect(creates[0]).not.toBe(creates[1]);
    expect(s.hf.jobs.size).toBe(2);
    expect(readOnDemandLedger(s.ledgerFile).unresolved).toEqual([]);
    expect(summary.finish.published).toBe(8);
  });

  it('a create without an id (the list lags): the audit counts that open intent, the run pauses, adopts the job and goes on', async () => {
    const s = setup({ fake: { createNoIdAt: 2 } });
    const summary = await runLibrary(s.opts({ portion: 2 }), s.deps);
    expect(summary.stop).toBe('done');
    const audits = readOnDemandLines(s.ledgerFile).lines.filter((l) => l.ev === 'audit');
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((a) => a.ev === 'audit' && a.ok)).toBe(true);
    // the job the CLI did not name is adopted from the list — never bought a second time
    expect(s.hf.jobs.size).toBe(2);
    expect(readOnDemandLedger(s.ledgerFile).unresolved).toEqual([]);
    expect(summary.finish.published).toBe(8);
  });

  it('an unanswered price check (at the start of a portion or before a create): a pause, then the same portion — nothing lost, nothing twice', async () => {
    const s = setup({ units: UNITS, fake: { costFailsAt: [1, 3] } });
    const summary = await runLibrary(s.opts({ portion: 1 }), s.deps);
    expect(summary.stop).toBe('done');
    expect(s.sleeps.filter((ms) => ms === 120_000)).toHaveLength(2);
    expect(s.hf.jobs.size).toBe(2);
    expect(new Set(s.hf.creates()).size).toBe(2);
    expect(summary.finish.published).toBe(8);
    const audits = readOnDemandLines(s.ledgerFile).lines.filter((l) => l.ev === 'audit');
    expect(audits.every((a) => a.ev === 'audit' && a.ok)).toBe(true);
  });

  it('a stop request ends the run cleanly before the next job; the finisher still checks what was recorded', async () => {
    // asked before the portion and before its job (both «go on»), then before the next portion: «stop»
    const s = setup({ stopAfter: 2 });
    const summary = await runLibrary(s.opts({ portion: 1 }), s.deps);
    expect(summary.stop).toBe('interrupted');
    expect(s.hf.creates()).toHaveLength(1);
    expect(summary.finish.published).toBe(4);
  });

  it('with inFlight 3 the waits overlap, the creates never do, and every job still ends charged before the balance is read', async () => {
    const units = Array.from({ length: 12 }, (_, i) => u(i + 1, `Фраза номер ${'раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать'.split(' ')[i]} для проверки длины.`));
    const s = setup({ units, fake: { waitTurns: 30 } });
    const summary = await runLibrary(s.opts({ portion: 12, inFlight: 3 }), s.deps);
    expect(summary.stop).toBe('done');
    expect(s.hf.maxWaiting).toBe(3);
    expect(s.hf.maxCreating).toBe(1);
    const view = readOnDemandLedger(s.ledgerFile).ledger;
    expect([...view.jobs.values()].every((j) => j.state === 'charged' && j.master !== undefined)).toBe(true);
    // the audit of the portion holds: every job was charged before the balance after the run was read
    const audits = readOnDemandLines(s.ledgerFile).lines.filter((l) => l.ev === 'audit');
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((a) => a.ev === 'audit' && a.ok)).toBe(true);
  });

  it('resumes: a pending job of a crashed run is waited for (never re-created), a downloaded one is finished first', async () => {
    const s = setup({ units: UNITS.slice(0, 4) });
    // the crashed run: its job exists at Higgsfield and in the ledger, never charged
    const job: GenJob = { prompt: 'Отлично!<#0.6#>Здорово!<#0.6#>Так держать!<#0.6#>Супер!', take: ONDEMAND_TAKE_BASE, recipe: 'pack', split: { mode: 'tags', minSilenceMs: 700 }, pieces: UNITS.slice(0, 4).map((x) => ({ key: x.key, text: x.text, role: 'whole' as const, kind: 'line' as const })), tier: 'library' };
    const j = s.hf.make(job.prompt);
    appendLedgerLine(s.ledgerFile, { ev: 'intent', at: '2026-09-26T09:59:00Z', run: 'crashed', campaign: LIBRARY_CAMPAIGN, key: keyOfJob(job), milli: jobMilli(job.prompt), job });
    appendLedgerLine(s.ledgerFile, { ev: 'created', at: '2026-09-26T09:59:01Z', run: 'crashed', campaign: LIBRARY_CAMPAIGN, key: keyOfJob(job), jobId: j.id, milli: jobMilli(job.prompt), job });
    const summary = await runLibrary(s.opts(), s.deps);
    expect(summary.stop).toBe('done');
    expect(summary.resumed).toBe(1);
    expect(s.hf.creates()).toEqual([]);
    expect(summary.finish.published).toBe(4);
    expect(unfinishedJobs(readOnDemandLedger(s.ledgerFile), overlayPaths(s.overlayDir).storeFile)).toEqual([]);
  });

  it('waits while the server has a job in flight (S7), then goes on', async () => {
    const s = setup({ units: UNITS.slice(0, 1) });
    const srvJob: GenJob = { prompt: 'Привет!', take: ONDEMAND_TAKE_BASE, recipe: 'single', pieces: [{ key: 'line:greet.hello.day#5', text: 'Привет!', role: 'whole' }] };
    appendLedgerLine(s.ledgerFile, { ev: 'created', at: '2026-09-26T09:00:00Z', run: 'srv', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(srvJob), jobId: 'srv-1', milli: 150, job: srvJob });
    // the server finishes its job while the run waits
    s.deps.sleep = async (ms) => {
      s.sleeps.push(ms);
      appendLedgerLine(s.ledgerFile, { ev: 'charged', at: '2026-09-26T09:00:05Z', key: keyOfJob(srvJob), jobId: 'srv-1', campaign: ONDEMAND_CAMPAIGN, milli: 150, status: 'completed', resultUrl: 'https://cdn.example/srv-1.mp3' });
    };
    const summary = await runLibrary(s.opts(), s.deps);
    expect(summary.stop).toBe('done');
    expect(s.sleeps).toContain(60_000);
    expect(s.hf.creates()).toEqual(['Отлично!']);
  });
});

describe('the finisher', () => {
  it('a batch that keeps failing stops the run after 3 tries (nothing is lost: the next run finishes it)', async () => {
    const logs: string[] = [];
    let tries = 0;
    const f = new Finisher(
      async () => {
        tries++;
        throw new Error('whisper-cli: dyld error');
      },
      () => new Map(),
      { sleep: async () => {}, log: (l) => logs.push(l) },
    );
    f.add(['a', 'b']);
    await f.drain();
    expect(tries).toBe(3);
    expect(f.failed).toMatch(/whisper-cli/);
    expect(logs.join('\n')).toMatch(/запись останавливается/);
  });
});
