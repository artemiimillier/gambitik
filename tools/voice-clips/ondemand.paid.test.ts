/**
 * «Дозапись голоса» — the paid steps of ./ondemand.ts and the overlay mode of `runGenerate`, all under a FAKE
 * Higgsfield (nothing here can spend, talk to the network or play audio): the intent line is on disk before the
 * create, the create output is read widely and confirmed, list adoption keeps its time window and never takes a job
 * another ledger owns, duplicates stop, open intents are resolved later, the machine-wide lock serialises every
 * generator (a stale lock is taken over by one taker only), `voice:generate` refuses while the server has a job in
 * flight (S7) or brings it home first (`--resume-server-jobs`), and a prefetch job whose unit is covered is skipped.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VOICE } from './config.ts';
import { jobMilli } from './cost.ts';
import { generateCoverage, unitCoverage } from './dedup.ts';
import { runGenerate } from './generate.ts';
import type { GenerateDeps } from './generate.ts';
import type { CliResult, RunCli } from './higgsfield.ts';
import { keyOfJob, parseJobsFile } from './jobs.ts';
import type { GenJob } from './jobs.ts';
import { LOCK_UNREADABLE_GRACE_MS, LedgerLocked, appendLedgerLine, lockLedger, tryLock } from './ledger.ts';
import {
  ADOPT_CHECK_MS,
  ONDEMAND_CAMPAIGN,
  ONDEMAND_TAKE_BASE,
  OVERLAY_LEDGER,
  PREFETCH_CAMPAIGN,
  adoptIntents,
  createJob,
  downloadJob,
  lockGlobal,
  onDemandViewOf,
  readOnDemandLedger,
  readOnDemandLines,
  spentByDay,
} from './ondemand.ts';
import type { OnDemandDeps } from './ondemand.ts';

/** The pid of a process that has already exited (a fixed number like 999999 may be a live pid on another OS). */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid ?? 999_999;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-ondemand-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const T0 = Date.parse('2026-09-24T20:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

interface FakeJob {
  id: string;
  prompt: string;
  status: string;
  createdAt: string;
  voiceId?: string;
}

interface FakeOptions {
  /** what `generate create` prints for the job it made (default: the job object with its prompt) */
  createOut?: (j: FakeJob) => string;
  /** the next create fails like this (exit 1); `withJob` = the job exists anyway */
  createFails?: { stderr: string; stdout?: string; withJob: boolean };
  /** the next N creates are rate-limited (`makes`: and still make the job) */
  rateLimits?: number;
  rateLimitMakes?: boolean;
  /** the list cannot be read */
  listFails?: boolean;
  /** `generate get` answers with another prompt (a wrong id) */
  getWrong?: boolean;
  existing?: FakeJob[];
}

/** A fake Higgsfield on a fake clock (every `now()` is 1 s later; created_at = the create's moment). */
function fakeHf(ledgerFile: string, opts: FakeOptions = {}) {
  const calls: string[][] = [];
  const jobs = new Map<string, FakeJob>((opts.existing ?? []).map((j) => [j.id, j]));
  /** the ledger text at the moment of each create (the intent must already be on disk) */
  const ledgerAtCreate: string[] = [];
  let clock = T0;
  let seq = 0;
  let rateLimits = opts.rateLimits ?? 0;
  let fails = opts.createFails;
  const ok = (data: unknown): CliResult => ({ code: 0, stdout: typeof data === 'string' ? data : JSON.stringify(data), stderr: '' });
  const jobJson = (j: FakeJob) => ({
    created_at: j.createdAt,
    id: j.id,
    job_type: 'text2speech_v2',
    params: { model: VOICE.variant, prompt: j.prompt, voice_id: j.voiceId ?? VOICE.voiceId, voice_type: 'preset' },
    result_url: j.status === 'completed' ? `https://cdn.example/${j.id}.mp3` : null,
    status: j.status,
  });
  const make = (prompt: string): FakeJob => {
    const j = { id: `job-${String(++seq).padStart(3, '0')}`, prompt, status: 'queued', createdAt: iso(clock) };
    jobs.set(j.id, j);
    return j;
  };
  const promptOf = (args: readonly string[]) => args[args.indexOf('--prompt') + 1]!;
  const runCli: RunCli = async (args) => {
    calls.push([...args]);
    const [group, action, arg] = args;
    if (group !== 'generate') return { code: 1, stdout: '', stderr: 'unknown' };
    if (action === 'create') {
      ledgerAtCreate.push(existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8') : '');
      if (rateLimits > 0) {
        rateLimits--;
        if (opts.rateLimitMakes) make(promptOf(args));
        return { code: 1, stdout: '', stderr: 'Error: request failed (429): rate_limit_reached' };
      }
      if (fails) {
        const f = fails;
        fails = undefined;
        if (f.withJob) make(promptOf(args));
        return { code: 1, stdout: f.stdout ?? '', stderr: f.stderr };
      }
      const j = make(promptOf(args));
      return ok(opts.createOut ? opts.createOut(j) : jobJson(j));
    }
    if (action === 'list') return opts.listFails ? { code: 1, stdout: '', stderr: 'HTTP 503' } : ok({ items: [...jobs.values()].reverse().map(jobJson) });
    if (action === 'get' || action === 'wait') {
      const j = jobs.get(arg!);
      if (!j) return { code: 1, stdout: '', stderr: 'job not found' };
      if (action === 'wait') j.status = 'completed';
      return ok(opts.getWrong && action === 'get' ? { ...jobJson(j), params: { ...jobJson(j).params, prompt: 'чужой текст' } } : jobJson(j));
    }
    return { code: 1, stdout: '', stderr: 'unknown' };
  };
  const logs: string[] = [];
  const sleeps: number[] = [];
  const deps: OnDemandDeps = {
    runCli,
    now: () => new Date((clock += 1000)),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0.5,
    log: (line) => logs.push(line),
  };
  const creates = () => calls.filter((c) => c[1] === 'create');
  const advance = (ms: number) => {
    clock += ms;
  };
  return { calls, jobs, deps, logs, sleeps, creates, ledgerAtCreate, make, advance };
}

const PROMPT = 'Давай сходим конём<#0.6#>— и это мат!';
const JOB: GenJob = {
  prompt: PROMPT,
  take: ONDEMAND_TAKE_BASE,
  recipe: 'pack',
  split: { mode: 'tags', minSilenceMs: 700 },
  pieces: [
    { key: 'line:v3.lead.subject@n#4', text: 'Давай сходим конём', pool: 'v3.lead.subject@n', kind: 'line', role: 'lead' },
    { key: 'line:v3.idea.mate#1', text: '— и это мат!', pool: 'v3.idea.mate', kind: 'line', role: 'tail' },
  ],
};
const MILLI = jobMilli(PROMPT);

function setup(opts: FakeOptions = {}) {
  const dir = tempDir();
  const ledgerFile = path.join(dir, OVERLAY_LEDGER);
  const hf = fakeHf(ledgerFile, opts);
  const input = { ledgerFile, campaign: ONDEMAND_CAMPAIGN, run: 'r1', job: JOB, milli: MILLI };
  const lines = () => readOnDemandLines(ledgerFile).lines;
  return { dir, ledgerFile, hf, input, lines };
}

describe('createJob', () => {
  it('writes the intent (fsync) BEFORE the create, then `created` with via and the masked shape', async () => {
    const s = setup();
    const out = await createJob(s.input, s.hf.deps);
    expect(out).toEqual({ ok: true, jobId: 'job-001', via: 'parse', shape: expect.stringContaining('params:{') });
    expect(s.hf.ledgerAtCreate[0]).toMatch(/"ev":"intent".*"key":"/);
    const evs = s.lines().map((l) => l.ev);
    expect(evs).toEqual(['intent', 'created']);
    const created = s.lines()[1] as { via?: string; createShape?: string; adopted?: boolean };
    expect(created.via).toBe('parse');
    expect(created.adopted).toBeUndefined();
    expect(created.createShape).not.toContain(PROMPT);
    expect(created.createShape).not.toContain('job-001');
    // resolved: nothing unresolved, the job pending at full price
    const view = readOnDemandLedger(s.ledgerFile);
    expect(view.unresolved).toEqual([]);
    expect(spentByDay(view, 'UTC').totalMilli).toBe(MILLI);
  });

  it('a job-set envelope without our prompt is confirmed by a free `generate get` (never the set id)', async () => {
    const s = setup({ createOut: (j) => JSON.stringify({ job_set_id: 'set-1', job_ids: [j.id] }) });
    const out = await createJob(s.input, s.hf.deps);
    expect(out).toMatchObject({ ok: true, jobId: 'job-001', via: 'get', shape: '{job_set_id:str,job_ids:[str]}' });
    expect(s.hf.calls.map((c) => c[1])).toEqual(['create', 'get']);
    expect(s.lines()[1]).toMatchObject({ ev: 'created', jobId: 'job-001', via: 'get', createShape: '{job_set_id:str,job_ids:[str]}' });
  });

  it('an id `generate get` does not confirm is not taken: the list finds the real job', async () => {
    const s = setup({ createOut: (j) => JSON.stringify({ job_set_id: 'set-1', job_ids: [j.id] }), getWrong: true });
    const out = await createJob(s.input, s.hf.deps);
    expect(out).toMatchObject({ ok: true, jobId: 'job-001', via: 'list' });
    expect(s.lines()[1]).toMatchObject({ ev: 'created', adopted: true, via: 'list' });
  });

  it('an unreadable create output falls back to the list; only a job created after the intent − 5 s is adopted', async () => {
    const old: FakeJob = { id: 'old-1', prompt: PROMPT, status: 'completed', createdAt: iso(T0 - 3_600_000) };
    const s = setup({ createOut: () => 'Job submitted', existing: [old] });
    const out = await createJob(s.input, s.hf.deps);
    expect(out).toMatchObject({ ok: true, jobId: 'job-001', via: 'list', shape: 'non-json(13)' });
    expect(s.hf.creates()).toHaveLength(1);
  });

  it('never adopts a job another ledger owns, nor one of another voice', async () => {
    const theirs: FakeJob = { id: 'tools-1', prompt: PROMPT, status: 'completed', createdAt: iso(T0 + 1500) };
    const voice: FakeJob = { id: 'voice-1', prompt: PROMPT, status: 'completed', createdAt: iso(T0 + 1500), voiceId: 'another-voice' };
    const s = setup({ createFails: { stderr: 'Error: context deadline exceeded', withJob: false }, existing: [theirs, voice] });
    const out = await createJob({ ...s.input, knownJobIds: new Set(['tools-1']) }, s.hf.deps);
    expect(out).toMatchObject({ ok: false, reason: 'unresolved' });
    // the intent stays open: it counts at full price until adoptIntents resolves it
    const view = readOnDemandLedger(s.ledgerFile);
    expect(view.unresolved.map((i) => i.key)).toEqual([keyOfJob(JOB)]);
    expect(spentByDay(view, 'UTC', ONDEMAND_CAMPAIGN).totalMilli).toBe(MILLI);
    expect(s.lines().map((l) => l.ev)).toEqual(['intent', 'error']);
  });

  it('an ambiguous failure whose job exists is adopted, never re-created', async () => {
    const s = setup({ createFails: { stderr: 'Error: context deadline exceeded', withJob: true } });
    const out = await createJob(s.input, s.hf.deps);
    expect(out).toMatchObject({ ok: true, jobId: 'job-001', via: 'list' });
    expect(s.hf.creates()).toHaveLength(1);
  });

  it('two un-ledgered jobs with our prompt: both are spend, the caller stops (duplicate)', async () => {
    const twin: FakeJob = { id: 'twin-1', prompt: PROMPT, status: 'queued', createdAt: iso(T0 + 1500) };
    const s = setup({ createFails: { stderr: 'Error: EOF', withJob: true }, existing: [twin] });
    const out = await createJob(s.input, s.hf.deps);
    expect(out).toMatchObject({ ok: false, reason: 'duplicate' });
    const view = readOnDemandLedger(s.ledgerFile);
    expect([...view.ledger.jobs.keys()].sort()).toEqual(['job-001', 'twin-1']);
    expect(view.unresolved).toEqual([]);
    expect(spentByDay(view, 'UTC').totalMilli).toBe(2 * MILLI);
  });

  it('no credits / an expired sign-in: stop at once, no retry (the intent stays open)', async () => {
    const s = setup({ createFails: { stderr: 'Error: insufficient credits for this generation', withJob: false } });
    expect(await createJob(s.input, s.hf.deps)).toMatchObject({ ok: false, reason: 'no-credits' });
    const t = setup({ createFails: { stderr: 'Session expired. Run `higgsfield auth login`', withJob: false } });
    expect(await createJob(t.input, t.hf.deps)).toMatchObject({ ok: false, reason: 'login' });
    expect(s.hf.creates()).toHaveLength(1);
    expect(t.hf.creates()).toHaveLength(1);
  });

  it('rate limits back off 2 → 4 s, look at the list before every retry, and never duplicate', async () => {
    const s = setup({ rateLimits: 1, rateLimitMakes: true });
    let limited = 0;
    const out = await createJob({ ...s.input, onRateLimit: () => limited++ }, s.hf.deps);
    expect(out).toMatchObject({ ok: true, via: 'list' });
    expect(limited).toBe(1);
    expect(s.hf.sleeps).toEqual([2000]);
    expect(s.hf.calls.map((c) => c[1])).toEqual(['create', 'list']);
    expect(s.hf.jobs.size).toBe(1);
  });

  it('without an intent (the tools ledger) nothing new is written before the create', async () => {
    const s = setup();
    await createJob({ ...s.input, intent: false }, s.hf.deps);
    expect(s.hf.ledgerAtCreate[0]).toBe('');
    expect(s.lines().map((l) => l.ev)).toEqual(['created']);
  });
});

describe('adoptIntents', () => {
  function withIntent(s: ReturnType<typeof setup>, at: number, job: GenJob = JOB): void {
    appendLedgerLine(s.ledgerFile, { ev: 'intent', at: iso(at), run: 'r0', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(job), milli: jobMilli(job.prompt), job });
  }

  it('adopts the job a crash left unledgered (created after the intent − 5 s)', async () => {
    const s = setup({ existing: [{ id: 'crash-1', prompt: PROMPT, status: 'completed', createdAt: iso(T0 - 3000) }] });
    withIntent(s, T0);
    const out = await adoptIntents({ ledgerFile: s.ledgerFile, run: 'r1' }, s.hf.deps);
    expect(out).toEqual({ adopted: [{ key: keyOfJob(JOB), jobId: 'crash-1' }], absent: [], open: [], duplicate: [] });
    expect(readOnDemandLedger(s.ledgerFile).ledger.jobs.get('crash-1')).toMatchObject({ adopted: true, state: 'pending' });
    expect(s.hf.calls.filter((c) => c[1] === 'list')).toHaveLength(1);
  });

  it('three empty checks 1 s apart ⇒ absent (and no spend); an older identical job is not ours', async () => {
    const s = setup({ existing: [{ id: 'older', prompt: PROMPT, status: 'completed', createdAt: iso(T0 - 60_000) }] });
    withIntent(s, T0);
    const out = await adoptIntents({ ledgerFile: s.ledgerFile, run: 'r1' }, s.hf.deps);
    expect(out.absent).toEqual([keyOfJob(JOB)]);
    expect(s.hf.sleeps).toEqual([ADOPT_CHECK_MS, ADOPT_CHECK_MS]);
    const view = readOnDemandLedger(s.ledgerFile);
    expect(view.unresolved).toEqual([]);
    expect(spentByDay(view, 'UTC').totalMilli).toBe(0);
    expect(s.lines().at(-1)).toMatchObject({ ev: 'absent', checks: 3 });
  });

  it('an unreadable list resolves nothing: the intent stays open at full price', async () => {
    const s = setup({ listFails: true });
    withIntent(s, T0);
    const out = await adoptIntents({ ledgerFile: s.ledgerFile, run: 'r1' }, s.hf.deps);
    expect(out.open).toEqual([keyOfJob(JOB)]);
    expect(spentByDay(readOnDemandLedger(s.ledgerFile), 'UTC').totalMilli).toBe(MILLI);
  });

  it('nothing to resolve ⇒ no CLI call at all', async () => {
    const s = setup();
    expect(await adoptIntents({ ledgerFile: s.ledgerFile, run: 'r1' }, s.hf.deps)).toEqual({ adopted: [], absent: [], open: [], duplicate: [] });
    expect(s.hf.calls).toEqual([]);
  });
});

describe('downloadJob', () => {
  const ledgered = (resultUrl?: string) => ({
    jobId: 'job-9',
    key: keyOfJob(JOB),
    campaign: ONDEMAND_CAMPAIGN,
    job: JOB,
    milli: MILLI,
    state: 'charged' as const,
    adopted: false,
    createdAt: iso(T0),
    ...(resultUrl ? { resultUrl } : {}),
  });

  it('downloads to <masters>/<jobId>.mp3 and writes `downloaded`; an expired link is renewed once via `generate get`', async () => {
    const s = setup({ existing: [{ id: 'job-9', prompt: PROMPT, status: 'completed', createdAt: iso(T0) }] });
    const got: string[] = [];
    let first = true;
    const download = async (url: string, dest: string) => {
      got.push(url);
      if (first) {
        first = false;
        throw new Error('403 expired');
      }
      writeFileSync(dest, 'ID3 master');
      return { bytes: 10, sha256: 'a'.repeat(64) };
    };
    const ok = await downloadJob({ ledgerFile: s.ledgerFile, mastersDir: path.join(s.dir, '.masters'), run: 'r1', job: ledgered('https://cdn.example/old.mp3') }, { ...s.hf.deps, download });
    expect(ok).toBe(true);
    expect(got).toEqual(['https://cdn.example/old.mp3', 'https://cdn.example/job-9.mp3']);
    expect(existsSync(path.join(s.dir, '.masters', 'job-9.mp3'))).toBe(true);
    expect(s.lines().map((l) => l.ev)).toEqual(['error', 'downloaded']);
  });

  it('a job id that could be a path or a flag is refused', async () => {
    const s = setup();
    const bad = { ...ledgered('https://x/y.mp3'), jobId: '../../etc' };
    await expect(downloadJob({ ledgerFile: s.ledgerFile, mastersDir: s.dir, run: 'r1', job: bad }, { ...s.hf.deps, download: async () => ({ bytes: 1, sha256: 'x' }) })).rejects.toThrow(/bad Higgsfield job id/);
  });
});

describe('the machine-wide lock', () => {
  it('serialises generators: a held lock is refused at once, waited for with waitMs, released for the next one', async () => {
    const dir = path.join(tempDir(), 'overlay');
    const release = await lockGlobal(dir);
    expect(existsSync(path.join(dir, 'higgsfield.lock'))).toBe(true);
    await expect(lockGlobal(dir)).rejects.toBeInstanceOf(LedgerLocked);
    const sleeps: number[] = [];
    const waits: number[] = [];
    await expect(lockGlobal(dir, { waitMs: 2000, sleep: async (ms) => void sleeps.push(ms), onWait: (pid) => waits.push(pid) })).rejects.toThrow(/держит другой генератор \(pid \d+\)/);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(2000);
    expect(waits).toEqual([process.pid]);
    release();
    const again = await lockGlobal(dir);
    again();
  });

  it('a lock left by a dead process is taken over', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'higgsfield.lock'), '999999');
    const release = await lockGlobal(dir);
    expect(readFileSync(path.join(dir, 'higgsfield.lock'), 'utf8')).toBe(String(process.pid));
    release();
    expect(existsSync(path.join(dir, 'higgsfield.lock'))).toBe(false);
  });

  it('two takers of one stale lock: only one gets it, and a release never removes a lock that is not its own', () => {
    const dir = tempDir();
    const lock = path.join(dir, 'higgsfield.lock');
    writeFileSync(lock, String(deadPid())); // a dead holder
    // B sees the dead pid; before B acts, A takes the stale lock over and holds it
    let a: ReturnType<typeof tryLock> | null = null;
    const b = tryLock(lock, { onStale: () => void (a = tryLock(lock)) });
    expect(a !== null && 'release' in a).toBe(true);
    expect('release' in b).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
    // A's lock is removed behind its back (a stale takeover elsewhere) and C takes the name: A's release keeps C's lock
    const aIno = statSync(lock).ino;
    rmSync(lock);
    const c = tryLock(lock);
    expect('release' in c).toBe(true);
    const cIno = statSync(lock).ino;
    (a as unknown as { release: () => void }).release();
    // A and C share this test's pid, so only the inode tells their locks apart; ext4 may hand C the very inode A just
    // freed — then nothing could, and the check needs the file system to give C a new one (APFS always does)
    if (cIno !== aIno) expect(existsSync(lock)).toBe(true);
    if ('release' in c) c.release();
    expect(existsSync(lock)).toBe(false);
    // no takeover lock or temp file is left behind
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a lock file without a pid yet (its writer between create and write) is held, not taken over', () => {
    const dir = tempDir();
    const lock = path.join(dir, 'higgsfield.lock');
    writeFileSync(lock, '');
    expect(tryLock(lock)).toEqual({ holder: 0 });
    expect(readFileSync(lock, 'utf8')).toBe('');
    // an empty file left for longer than the grace period is a crash: taken over
    const old = (Date.now() - LOCK_UNREADABLE_GRACE_MS - 1_000) / 1000;
    utimesSync(lock, old, old);
    const got = tryLock(lock);
    expect('release' in got).toBe(true);
    if ('release' in got) got.release();
  });

  it('lockLedger with a global dir takes both (global first) and frees both; without options only the ledger', async () => {
    const dir = tempDir();
    const ledger = path.join(dir, 'tools-ledger.jsonl');
    const overlay = path.join(dir, 'ov');
    const release = await lockLedger(ledger, { globalDir: overlay });
    expect(existsSync(`${ledger}.lock`)).toBe(true);
    expect(existsSync(path.join(overlay, 'higgsfield.lock'))).toBe(true);
    // the server's order (lockGlobal first, then the plain ledger lock) is refused while the tool holds the global one
    await expect(lockGlobal(overlay)).rejects.toBeInstanceOf(LedgerLocked);
    release();
    expect(existsSync(`${ledger}.lock`)).toBe(false);
    expect(existsSync(path.join(overlay, 'higgsfield.lock'))).toBe(false);
    // a held ledger lock: the global lock taken on the way is given back
    const held = lockLedger(ledger);
    await expect(lockLedger(ledger, { globalDir: overlay })).rejects.toBeInstanceOf(LedgerLocked);
    expect(existsSync(path.join(overlay, 'higgsfield.lock'))).toBe(false);
    held();
  });
});

// ── runGenerate with an overlay folder ───────────────────────────────────────────────────────────────────────────

const MODEL = {
  params: [
    { name: 'prompt', required: true },
    { name: 'variant', required: true, enum: ['minimax'] },
    { name: 'voice_id', required: true },
    { name: 'voice_type', required: true, enum: ['preset'] },
  ],
};

/** The fake of `fakeHf` plus account / model / cost, for a whole `runGenerate`. */
function generateHarness(ledgerFile: string, opts: FakeOptions = {}) {
  const hf = fakeHf(ledgerFile, opts);
  let balance = 50_000;
  const inner = hf.deps.runCli;
  const runCli: RunCli = async (args) => {
    if (args[0] === 'account') {
      hf.calls.push([...args]);
      return { code: 0, stdout: JSON.stringify({ credits: balance / 1000 }), stderr: '' };
    }
    if (args[0] === 'model') {
      hf.calls.push([...args]);
      return { code: 0, stdout: JSON.stringify(MODEL), stderr: '' };
    }
    if (args[1] === 'cost') {
      hf.calls.push([...args]);
      return { code: 0, stdout: JSON.stringify({ credits: jobMilli(args[args.indexOf('--prompt') + 1]!) / 1000 }), stderr: '' };
    }
    const result = await inner(args);
    if (args[1] === 'wait' && result.code === 0) balance -= jobMilli(JSON.parse(result.stdout).params.prompt);
    return result;
  };
  const deps: GenerateDeps = {
    ...hf.deps,
    runCli,
    download: async (_url, dest) => {
      writeFileSync(dest, 'ID3 master');
      return { bytes: 10, sha256: 'b'.repeat(64) };
    },
  };
  return { ...hf, deps };
}

const PREFETCH = parseJobsFile({
  v: 1,
  voiceKey: 'giselle-mm1',
  campaign: PREFETCH_CAMPAIGN,
  jobs: [
    { prompt: 'Отлично!<#0.6#>Так держать.', take: ONDEMAND_TAKE_BASE, recipe: 'pack', split: { mode: 'tags', minSilenceMs: 700 }, pieces: [{ key: 'line:v3.praise.a#1', text: 'Отлично!', role: 'whole' }, { key: 'line:v3.praise.b#1', text: 'Так держать.', role: 'whole' }] },
    { prompt: 'Ладью, коня или слона?', take: ONDEMAND_TAKE_BASE, recipe: 'single', pieces: [{ key: 'frag:f:ладью, коня или слона|?', text: 'Ладью, коня или слона?', kind: 'frag', role: 'frag' }] },
  ],
});

describe('runGenerate with the overlay folder', () => {
  it('S7: refuses with ZERO CLI calls while the server has a job in flight in the overlay ledger', async () => {
    const dir = tempDir();
    const overlayDir = path.join(dir, 'ov');
    const serverLedger = path.join(overlayDir, OVERLAY_LEDGER);
    const toolsLedger = path.join(dir, 'ledger.giselle-mm1.jsonl');
    const h = generateHarness(toolsLedger);
    const base = { spend: true, budget: 5, jobs: PREFETCH, ledgerFile: toolsLedger, mastersDir: path.join(dir, '.masters'), overlayDir };
    // an unresolved intent of the server
    await lockGlobal(overlayDir).then((r) => r());
    appendLedgerLine(serverLedger, { ev: 'intent', at: iso(T0), run: 's', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(JOB), milli: MILLI, job: JOB });
    await expect(runGenerate(base, h.deps)).rejects.toThrow(/сервер ещё ждёт задание без номера/);
    // … then a pending one
    appendLedgerLine(serverLedger, { ev: 'created', at: iso(T0), run: 's', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(JOB), jobId: 'srv-1', milli: MILLI, job: JOB, via: 'parse' });
    await expect(runGenerate(base, h.deps)).rejects.toThrow(/srv-1/);
    expect(h.calls).toEqual([]);
    // the lock was given back both times
    expect(existsSync(path.join(overlayDir, 'higgsfield.lock'))).toBe(false);
  });

  it('waits for the machine-wide lock (the server recording a phrase) and gives up with zero CLI calls', async () => {
    const dir = tempDir();
    const overlayDir = path.join(dir, 'ov');
    const h = generateHarness(path.join(dir, 'l.jsonl'));
    const held = await lockGlobal(overlayDir);
    await expect(runGenerate({ spend: true, budget: 5, jobs: PREFETCH, ledgerFile: path.join(dir, 'l.jsonl'), mastersDir: path.join(dir, 'm'), overlayDir, lockWaitMs: 3000 }, h.deps)).rejects.toBeInstanceOf(LedgerLocked);
    expect(h.calls).toEqual([]);
    expect(h.logs.join('\n')).toMatch(/сервер записывает фразу; жду до 3 с/);
    held();
  });

  it('the prefetch INTO the overlay ledger: intent before every create, wait --interval 1s, masters in the overlay', async () => {
    const dir = tempDir();
    const overlayDir = path.join(dir, 'ov');
    const ledgerFile = path.join(overlayDir, OVERLAY_LEDGER);
    const h = generateHarness(ledgerFile);
    const summary = await runGenerate({ spend: true, budget: 1, jobs: PREFETCH, ledgerFile, mastersDir: path.join(overlayDir, '.masters'), overlayDir }, h.deps);
    expect(summary).toMatchObject({ created: 2, charged: 2, downloaded: 2, stop: 'done' });
    expect(h.ledgerAtCreate.map((text) => text.trim().split('\n').at(-1))).toEqual([expect.stringContaining('"ev":"intent"'), expect.stringContaining('"ev":"intent"')]);
    const waits = h.calls.filter((c) => c[1] === 'wait');
    expect(waits.every((c) => c.includes('--interval') && c[c.indexOf('--interval') + 1] === '1s')).toBe(true);
    expect(existsSync(path.join(overlayDir, '.masters', 'job-001.mp3'))).toBe(true);
    const view = readOnDemandLedger(ledgerFile);
    expect(view.unresolved).toEqual([]);
    expect(spentByDay(view, undefined, PREFETCH_CAMPAIGN).totalMilli).toBe(summary.spentMilli);
  });

  it('an intent a crash left open is resolved first (adopted, never re-created) and counted in the budget', async () => {
    const dir = tempDir();
    const overlayDir = path.join(dir, 'ov');
    const ledgerFile = path.join(overlayDir, OVERLAY_LEDGER);
    const h = generateHarness(ledgerFile);
    const first = PREFETCH.jobs[0]!;
    await lockGlobal(overlayDir).then((r) => r());
    appendLedgerLine(ledgerFile, { ev: 'intent', at: iso(T0), run: 'crashed', campaign: PREFETCH_CAMPAIGN, key: keyOfJob(first), milli: jobMilli(first.prompt), job: first });
    h.make(first.prompt); // the create did happen before the crash
    const summary = await runGenerate({ spend: true, budget: 1, jobs: PREFETCH, ledgerFile, mastersDir: path.join(overlayDir, '.masters'), overlayDir }, h.deps);
    expect(summary).toMatchObject({ adopted: 1, resumed: 1, created: 1, charged: 2 });
    expect(h.creates().map((c) => c[c.indexOf('--prompt') + 1])).toEqual([PREFETCH.jobs[1]!.prompt]);
  });

  it('writing the tools ledger, a job the overlay ledger owns is never adopted', async () => {
    const dir = tempDir();
    const overlayDir = path.join(dir, 'ov');
    const toolsLedger = path.join(dir, 'tools.jsonl');
    const h = generateHarness(toolsLedger);
    const first = PREFETCH.jobs[0]!;
    // the server made (and finished) a job with the same prompt
    const srv = h.make(first.prompt);
    srv.status = 'completed';
    await lockGlobal(overlayDir).then((r) => r());
    const ov = path.join(overlayDir, OVERLAY_LEDGER);
    appendLedgerLine(ov, { ev: 'created', at: iso(T0), run: 's', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(first), jobId: srv.id, milli: jobMilli(first.prompt), job: first });
    appendLedgerLine(ov, { ev: 'charged', at: iso(T0), key: keyOfJob(first), jobId: srv.id, campaign: ONDEMAND_CAMPAIGN, milli: jobMilli(first.prompt), status: 'completed', resultUrl: 'https://cdn.example/x.mp3' });
    const summary = await runGenerate({ spend: true, budget: 1, jobs: { ...PREFETCH, campaign: 'pilot' }, ledgerFile: toolsLedger, mastersDir: path.join(dir, 'm'), overlayDir }, h.deps);
    expect(summary.adopted).toBe(0);
    expect(summary.created).toBe(2);
    // the tools ledger keeps its line types: no intent lines there
    expect(readFileSync(toolsLedger, 'utf8')).not.toContain('"ev":"intent"');
  });

  it('S7 with --resume-server-jobs: the server’s pending job is waited for and downloaded first (free), then the run goes on', async () => {
    const dir = tempDir();
    const overlayDir = path.join(dir, 'ov');
    const serverLedger = path.join(overlayDir, OVERLAY_LEDGER);
    const toolsLedger = path.join(dir, 'tools.jsonl');
    const h = generateHarness(toolsLedger);
    await lockGlobal(overlayDir).then((r) => r());
    // the server's job is still running at the provider; the server itself may not resume it (recording switched off)
    const srv = h.make(JOB.prompt);
    appendLedgerLine(serverLedger, { ev: 'created', at: iso(T0), run: 's', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(JOB), jobId: srv.id, milli: MILLI, job: JOB, via: 'parse' });
    const base = { spend: true, budget: 5, jobs: { ...PREFETCH, campaign: 'pilot' }, ledgerFile: toolsLedger, mastersDir: path.join(dir, 'm'), overlayDir };
    // without the flag: refused with zero calls, and the refusal names the way out
    await expect(runGenerate(base, h.deps)).rejects.toThrow(/включите её и запустите сервер или подождите\. Иначе добавьте --resume-server-jobs/);
    expect(h.calls).toEqual([]);
    const summary = await runGenerate({ ...base, resumeServerJobs: true }, h.deps);
    expect(summary).toMatchObject({ created: 2, stop: 'done' });
    // the server's job: charged and downloaded into the overlay (its finish publishes it later), never re-created
    expect(readOnDemandLedger(serverLedger).ledger.jobs.get(srv.id)).toMatchObject({ state: 'charged', master: `${srv.id}.mp3` });
    expect(existsSync(path.join(overlayDir, '.masters', `${srv.id}.mp3`))).toBe(true);
    expect(h.creates().map((c) => c[c.indexOf('--prompt') + 1])).toEqual(PREFETCH.jobs.map((j) => j.prompt));
    // waited for BEFORE this run read the balance: its debit is outside the audit window, the audit holds
    const order = h.calls.map((c) => `${c[0]} ${c[1]} ${c[2] ?? ''}`.trim());
    expect(order.indexOf(`generate wait ${srv.id}`)).toBeLessThan(order.indexOf('account status --json'));
    expect(summary.audit?.ok).toBe(true);
    expect(existsSync(`${serverLedger}.lock`)).toBe(false);
  });

  it('into the overlay: a job with a unit the server recorded (or published) since the plan was made is skipped', async () => {
    const dir = tempDir();
    const overlayDir = path.join(dir, 'ov');
    const ledgerFile = path.join(overlayDir, OVERLAY_LEDGER);
    const h = generateHarness(ledgerFile);
    await lockGlobal(overlayDir).then((r) => r());
    // the server recorded «Отлично!» alone — its own prompt, so another job key than the plan's pack
    const srvJob: GenJob = { prompt: 'Отлично!', take: ONDEMAND_TAKE_BASE, recipe: 'single', pieces: [{ key: 'line:v3.praise.a#1', text: 'Отлично!', role: 'whole' }] };
    appendLedgerLine(ledgerFile, { ev: 'created', at: iso(T0), run: 's', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(srvJob), jobId: 'srv-1', milli: 150, job: srvJob, via: 'parse' });
    appendLedgerLine(ledgerFile, { ev: 'charged', at: iso(T0), key: keyOfJob(srvJob), jobId: 'srv-1', campaign: ONDEMAND_CAMPAIGN, milli: 150, status: 'completed', resultUrl: 'https://cdn.example/srv-1.mp3' });
    appendLedgerLine(ledgerFile, { ev: 'downloaded', at: iso(T0), key: keyOfJob(srvJob), jobId: 'srv-1', master: 'srv-1.mp3', bytes: 1, sha256: 'x' });
    // …and the static library already has the options sentence under its exact key
    const lib = path.join(dir, 'static');
    const frag = PREFETCH.jobs[1]!.pieces[0] as { key: string; text: string };
    const rel = 'giselle-mm1/manifest.000000000001.json';
    mkdirSync(path.join(lib, 'giselle-mm1'), { recursive: true });
    writeFileSync(path.join(lib, rel), JSON.stringify({ v: 1, voiceKey: 'giselle-mm1', libraryVersion: 1, units: { c0000000000abc: { key: frag.key, text: frag.text, take: 1, ms: 900, on: 30, off: 860, file: '00/c0000000000abc.mp3', qa: 'asr' } }, pools: {}, keys: { [frag.key]: ['c0000000000abc'] }, fallbacks: {} }));
    writeFileSync(path.join(lib, 'index.json'), JSON.stringify({ default: 'giselle-mm1', voices: { 'giselle-mm1': rel } }));
    const summary = await runGenerate({ spend: true, budget: 1, jobs: PREFETCH, ledgerFile, mastersDir: path.join(overlayDir, '.masters'), overlayDir, unitCovered: unitCoverage({ overlayDir, staticLibrary: lib }) }, h.deps);
    expect(summary).toMatchObject({ created: 0, skipped: 2, stop: 'done' });
    expect(h.creates()).toEqual([]);
    expect(h.logs.join('\n')).toMatch(/пропускаю задание «Отлично!<#0\.6#>Так держать\.»: «Отлично!» уже в задании srv-1 \(«ondemand»\)/);
    expect(h.logs.join('\n')).toMatch(/«Ладью, коня или слона\?» уже записана/);
    // no intent was written for them: nothing is counted as spent
    expect(readOnDemandLedger(ledgerFile).unresolved).toEqual([]);
    expect(summary.spentMilli).toBe(0);
  });

  it('by unit means by its words: the same words under another line\'s key cover it too (a job, the static library)', () => {
    const dir = tempDir();
    const overlayDir = path.join(dir, 'ov');
    // the server is recording «Привет!» as the game's hello; the static library has «Поторопись!» as the teacher's
    const srvJob: GenJob = { prompt: 'Привет!', take: ONDEMAND_TAKE_BASE, recipe: 'single', pieces: [{ key: 'line:hello.game#1', text: 'Привет!', role: 'whole' }] };
    const view = onDemandViewOf([{ ev: 'created', at: iso(T0), run: 's', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(srvJob), jobId: 'srv-1', milli: 150, job: srvJob }]);
    const lib = path.join(dir, 'static');
    const rel = 'giselle-mm1/manifest.000000000003.json';
    mkdirSync(path.join(lib, 'giselle-mm1'), { recursive: true });
    writeFileSync(path.join(lib, rel), JSON.stringify({ v: 1, voiceKey: 'giselle-mm1', libraryVersion: 1, units: { c0000000000aaa: { key: 'line:teach.hurry#1', text: 'Поторопись!', take: 1, ms: 700, on: 30, off: 660, file: '00/c0000000000aaa.mp3', qa: 'asr' } }, pools: {}, keys: { 'line:teach.hurry#1': ['c0000000000aaa'] }, fallbacks: {} }));
    writeFileSync(path.join(lib, 'index.json'), JSON.stringify({ default: 'giselle-mm1', voices: { 'giselle-mm1': rel } }));
    const covered = unitCoverage({ overlayDir, staticLibrary: lib });
    expect(covered({ key: 'line:greet.hello.day#5', text: 'Привет!' }, view)).toBe('уже в задании srv-1 («ondemand»)');
    expect(covered({ key: 'line:shell.hurry#1', text: 'Поторопись!' }, view)).toBe('уже записана');
    expect(covered({ key: 'line:greet.hello.day#1', text: 'Добрый день!' }, view)).toBeNull();
  });

  it("a static run (the tools ledger): a job with a catalogue sentence the server recorded on demand is skipped", async () => {
    const dir = tempDir();
    const overlayDir = path.join(dir, 'ov');
    const overlayLedger = path.join(overlayDir, OVERLAY_LEDGER);
    const toolsLedger = path.join(dir, 'ledger.giselle-mm1.jsonl');
    const h = generateHarness(toolsLedger);
    await lockGlobal(overlayDir).then((r) => r());
    // the server recorded «Привет-привет, добрый день!» on demand (its own prompt) and published it into the overlay;
    // it is paying for «Отлично сыграно!» right now (charged, not finished yet)
    const hello = { key: 'line:greet.hello.day#2', text: 'Привет-привет, добрый день!', role: 'whole' as const, pool: 'greet.hello.day' };
    const praise = { key: 'line:praise.generic#3', text: 'Отлично сыграно!', role: 'whole' as const, pool: 'praise.generic' };
    const srvJob: GenJob = { prompt: 'Отлично сыграно!', take: ONDEMAND_TAKE_BASE, recipe: 'single', pieces: [praise] };
    appendLedgerLine(overlayLedger, { ev: 'created', at: iso(T0), run: 's', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(srvJob), jobId: 'srv-1', milli: 150, job: srvJob, via: 'parse' });
    appendLedgerLine(overlayLedger, { ev: 'charged', at: iso(T0), key: keyOfJob(srvJob), jobId: 'srv-1', campaign: ONDEMAND_CAMPAIGN, milli: 150, status: 'completed', resultUrl: 'https://cdn.example/srv-1.mp3' });
    appendLedgerLine(overlayLedger, { ev: 'downloaded', at: iso(T0), key: keyOfJob(srvJob), jobId: 'srv-1', master: 'srv-1.mp3', bytes: 1, sha256: 'x' });
    const rel = 'giselle-mm1/manifest.000000000002.json';
    mkdirSync(path.join(overlayDir, 'giselle-mm1'), { recursive: true });
    writeFileSync(path.join(overlayDir, rel), JSON.stringify({ v: 1, voiceKey: 'giselle-mm1', libraryVersion: 2, units: { c0000000000def: { key: hello.key, text: hello.text, take: 101, ms: 1500, on: 30, off: 1460, file: '00/c0000000000def.mp3', qa: 'asr' } }, pools: { 'greet.hello.day': ['c0000000000def'] }, keys: { [hello.key]: ['c0000000000def'] }, fallbacks: {} }));
    writeFileSync(path.join(overlayDir, 'index.json'), JSON.stringify({ default: 'giselle-mm1', voices: { 'giselle-mm1': rel } }));
    // the full campaign's plan (made before): one job with both, one with neither
    const full = parseJobsFile({
      v: 1,
      voiceKey: 'giselle-mm1',
      campaign: 'full',
      jobs: [
        { prompt: 'Привет-привет, добрый день!<#0.6#>Отлично сыграно!', take: 1, recipe: 'pack', split: { mode: 'tags', minSilenceMs: 700 }, pieces: [hello, praise] },
        { prompt: 'Добрый вечер!', take: 1, recipe: 'single', pieces: [{ key: 'line:greet.hello.evening#1', text: 'Добрый вечер!', role: 'whole', pool: 'greet.hello.evening' }] },
      ],
    });
    // what the voice:generate command passes for a static run while the machine has an overlay (none without one)
    const coverage = generateCoverage({ overlayDir, intoOverlay: false, staticLibrary: path.join(dir, 'static'), toolsLedger });
    expect(coverage.unitCovered).toBeTypeOf('function');
    expect(coverage.otherLedgers).toBeUndefined();
    expect(generateCoverage({ overlayDir: null, intoOverlay: false, staticLibrary: path.join(dir, 'static'), toolsLedger })).toEqual({});
    const summary = await runGenerate({ spend: true, budget: 1, jobs: full, ledgerFile: toolsLedger, mastersDir: path.join(dir, 'm'), overlayDir, ...coverage }, h.deps);
    expect(summary).toMatchObject({ created: 1, skipped: 1, stop: 'done' });
    expect(h.creates().map((c) => c[c.indexOf('--prompt') + 1])).toEqual(['Добрый вечер!']);
    expect(h.logs.join('\n')).toMatch(/«Привет-привет, добрый день!» уже записана; «Отлично сыграно!» уже в задании srv-1 \(«ondemand»\)/);
    expect(h.logs.join('\n')).toMatch(/pnpm voice:plan/);
  });
});
