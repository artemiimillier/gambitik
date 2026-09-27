/**
 * Test helpers for «Дозапись голоса» — never imported by production code. Nothing here can spend: a fake Higgsfield
 * account answers the CLI calls (`runCli`) and implements the tools' paid protocol against a REAL overlay ledger, with
 * the same line types the tools write (intent → created → charged / failed → downloaded, absent), so the service's
 * budget, dedup and resume logic run on real ledger arithmetic. A fake finish publishes into a real overlay manifest.
 */
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClipGenSettings } from '@gambit/shared';
import { loadConfig } from '../config.ts';
import type { ClipGenConfig, ServerConfig } from '../config.ts';
import { openAppDb } from '../storage/db.ts';
import type { Db } from '../storage/db.ts';
import { LedgerLocked, VOICE_KEY, appendLedger, jobMilli, keyOfJob, readOnDemandLedger } from './bridge.ts';
import type { CliResult, GenJob, LedgerLine, OnDemandLine, RunCli } from './bridge.ts';
import { ClipGenSettingsStore } from './budget.ts';
import type { FinishInput, FinishResult } from './runner.ts';
import { createClipGenService } from './service.ts';
import type { ClipGenOverrides, ClipGenProtocol, ClipGenService } from './service.ts';

export function tempDir(prefix: string, cleanups: (() => void)[]): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function append(file: string, line: OnDemandLine): void {
  appendLedger(file, line as LedgerLine);
}

export type CreatePlan = 'ok' | 'crash-made' | 'crash-none' | 'rate' | 'no-credits' | 'login' | 'error';
export type WaitPlan = 'completed' | 'failed' | 'pending';

interface FakeJob {
  id: string;
  prompt: string;
  status: 'queued' | 'completed' | 'failed';
}

/** One fake Higgsfield account (shared by every service instance of a test, like the real one). */
export class FakeHiggsfield {
  readonly jobs = new Map<string, FakeJob>();
  /** every CLI call, in order */
  readonly calls: string[][] = [];
  /** every create that reached the provider (paid) */
  readonly creates: GenJob[] = [];
  createPlan: (job: GenJob) => CreatePlan = () => 'ok';
  waitPlan: (jobId: string) => WaitPlan = () => 'completed';
  downloadPlan: (jobId: string) => boolean = () => true;
  private next = 0;

  private newJob(prompt: string, status: FakeJob['status'] = 'queued'): FakeJob {
    const job = { id: `job${String(++this.next).padStart(4, '0')}`, prompt, status };
    this.jobs.set(job.id, job);
    return job;
  }

  readonly runCli: RunCli = async (args) => {
    this.calls.push([...args]);
    const ok = (data: unknown): CliResult => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
    if (args[0] === 'model' && args[1] === 'get') {
      return ok({
        params: [
          { name: 'prompt', required: true },
          { name: 'variant', enum: ['minimax'] },
          { name: 'voice_id' },
          { name: 'voice_type', enum: ['preset'] },
        ],
      });
    }
    if (args[0] === 'generate' && args[1] === 'cost') {
      const prompt = args[args.indexOf('--prompt') + 1] ?? '';
      return ok({ credits: jobMilli(prompt) / 1000 });
    }
    if (args[0] === 'generate' && args[1] === 'wait') {
      const job = this.jobs.get(args[2] ?? '');
      if (!job) return { code: 1, stdout: '', stderr: 'HTTP 404 job not found' };
      const plan = this.waitPlan(job.id);
      if (plan !== 'pending') job.status = plan;
      return ok({ id: job.id, status: job.status, result_url: job.status === 'completed' ? `https://cdn.example.test/${job.id}.mp3` : null, params: { prompt: job.prompt } });
    }
    return { code: 2, stdout: '', stderr: `fake higgsfield: unexpected call ${args.slice(0, 2).join(' ')}` };
  };

  /** The tools' protocol, faked on the real ledger file. */
  protocol(): ClipGenProtocol {
    return {
      createJob: async (input, deps) => {
        const at = deps.now().toISOString();
        const key = keyOfJob(input.job);
        append(input.ledgerFile, { ev: 'intent', at, run: input.run, campaign: input.campaign, key, milli: input.milli, job: input.job });
        const plan = this.createPlan(input.job);
        if (plan === 'ok') {
          this.creates.push(input.job);
          const job = this.newJob(input.job.prompt);
          append(input.ledgerFile, { ev: 'created', at, run: input.run, campaign: input.campaign, key, jobId: job.id, milli: input.milli, job: input.job, via: 'parse', createShape: '{id:str}' });
          return { ok: true, jobId: job.id, via: 'parse', shape: '{id:str}' };
        }
        if (plan === 'crash-made') {
          // the provider made (and debited) the job, but we never learned its id
          this.creates.push(input.job);
          this.newJob(input.job.prompt);
          return { ok: false, reason: 'unresolved', message: 'create output had no job id' };
        }
        if (plan === 'crash-none') return { ok: false, reason: 'unresolved', message: 'create output had no job id' };
        // a refused create made no job: the intent is resolved as absent
        append(input.ledgerFile, { ev: 'absent', at, run: input.run, key, checks: 3 });
        return { ok: false, reason: plan, message: plan };
      },
      adoptIntents: async (input, deps) => {
        const view = readOnDemandLedger(input.ledgerFile);
        const known = new Set(view.ledger.jobs.keys());
        const summary = { adopted: [] as { key: string; jobId: string }[], absent: [] as string[], open: [] as string[], duplicate: [] as string[] };
        for (const intent of view.unresolved) {
          const found = [...this.jobs.values()].find((j) => j.prompt === intent.job.prompt && !known.has(j.id));
          const at = deps.now().toISOString();
          if (found) {
            known.add(found.id);
            append(input.ledgerFile, { ev: 'created', at, run: input.run, campaign: intent.campaign, key: intent.key, jobId: found.id, milli: intent.milli, job: intent.job, adopted: true, via: 'list' });
            summary.adopted.push({ key: intent.key, jobId: found.id });
          } else {
            append(input.ledgerFile, { ev: 'absent', at, run: input.run, key: intent.key, checks: 3 });
            summary.absent.push(intent.key);
          }
        }
        return summary;
      },
      downloadJob: async (input, deps) => {
        const at = deps.now().toISOString();
        if (!this.downloadPlan(input.job.jobId)) {
          append(input.ledgerFile, { ev: 'error', at, run: input.run, key: input.job.key, jobId: input.job.jobId, stage: 'download', message: 'fake download failed' });
          return false;
        }
        mkdirSync(input.mastersDir, { recursive: true });
        writeFileSync(join(input.mastersDir, `${input.job.jobId}.mp3`), Buffer.alloc(512, 0xff));
        append(input.ledgerFile, { ev: 'downloaded', at, key: input.job.key, jobId: input.job.jobId, master: `${input.job.jobId}.mp3`, bytes: 512, sha256: 'f'.repeat(64) });
        return true;
      },
      lockGlobal: async (dir) => {
        const file = join(dir, 'higgsfield.lock');
        try {
          closeSync(openSync(file, 'wx'));
        } catch {
          throw new LedgerLocked(`fake: ${file} is held`);
        }
        return () => {
          if (existsSync(file)) unlinkSync(file);
        };
      },
    };
  }
}

export interface OverlayTake {
  id: string;
  key: string;
  text: string;
  ctx?: 'cont';
}

let manifestSeq = 0;

/** Writes an overlay (or static) library the way the tools publish it: a content-named manifest, then the index. */
export function writeLibrary(dir: string, takes: readonly OverlayTake[], o: { version?: number; blocked?: string[] } = {}): void {
  const units: Record<string, unknown> = {};
  const keys: Record<string, string[]> = {};
  for (const t of takes) {
    units[t.id] = { key: t.key, text: t.text, take: 1, ms: 1000, on: 30, off: 970, file: `${t.id.slice(1, 3)}/${t.id}.mp3`, qa: 'asr', ...(t.ctx ? { ctx: t.ctx } : {}) };
    (keys[t.key] ??= []).push(t.id);
  }
  const rel = `${VOICE_KEY}/manifest.${(++manifestSeq).toString(16).padStart(12, '0')}.json`;
  mkdirSync(join(dir, VOICE_KEY), { recursive: true });
  writeFileSync(join(dir, rel), JSON.stringify({ v: 1, voiceKey: VOICE_KEY, libraryVersion: o.version ?? manifestSeq, units, pools: {}, keys, fallbacks: {}, ...(o.blocked ? { blocked: o.blocked } : {}) }));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ default: VOICE_KEY, voices: { [VOICE_KEY]: rel } }));
}

/** A fake finish: publishes what `pass` accepts into the overlay manifest (cumulative), like the tools' verify. */
export function fakeFinish(overlayDir: string, pass: (unit: { id: string; key: string; text: string }) => boolean = () => true): { finish: (input: FinishInput) => Promise<FinishResult>; calls: FinishInput[]; published: OverlayTake[] } {
  const published: OverlayTake[] = [];
  const calls: FinishInput[] = [];
  return {
    calls,
    published,
    finish: async (input) => {
      calls.push(input);
      const ok = input.units.filter(pass);
      for (const u of ok) published.push({ id: u.id, key: u.key, text: u.text });
      if (ok.length > 0) writeLibrary(overlayDir, published);
      return { published: ok.map((u) => u.id) };
    },
  };
}

export interface Rig {
  dataDir: string;
  overlayDir: string;
  config: ServerConfig;
  db: Db;
  hf: FakeHiggsfield;
  clock: { now: number };
  logs: string[];
  /** the shared fake finish (every instance publishes into the same overlay); `pass` decides which units pass */
  finisher: ReturnType<typeof fakeFinish>;
  pass: (unit: { id: string; key: string; text: string }) => boolean;
  make(overrides?: ClipGenOverrides & { clipGen?: Partial<ClipGenConfig> }): ClipGenService;
  enable(settings?: Partial<ClipGenSettings>): void;
}

/**
 * A pinned, enabled recorder on temp folders with a fake account: DATA_DIR pinned, the temp roots emptied (allowed only
 * with a fake runner), the parent's switch on, 10 credits a day and 20 in total unless changed.
 */
export function rig(cleanups: (() => void)[], o: { clipGen?: Partial<ClipGenConfig>; parentStored?: boolean } = {}): Rig {
  const dataDir = tempDir('gambit-cg-data-', cleanups);
  const overlayDir = tempDir('gambit-cg-overlay-', cleanups);
  const clipGen: ClipGenConfig = { enabled: true, budgetMilli: 20_000, dailyMaxMilli: 10_000, dataDirPin: dataDir, bin: null, overlayDir, overlayProblem: null, ...o.clipGen };
  const config = loadConfig({}, { dataDir, log: false, clipGen });
  const db = openAppDb(':memory:');
  cleanups.push(() => db.close());
  // the rig starts from «the parent turned recording off» (`enable()` turns it on); the default without any stored choice
  // is ON and is tested on its own (`parentStored: false`)
  if (o.parentStored !== false) new ClipGenSettingsStore(db, clipGen.dailyMaxMilli).set({ enabled: false, dailyCapMilli: 10_000 });
  const hf = new FakeHiggsfield();
  const clock = { now: Date.parse('2026-09-24T10:00:00') };
  const logs: string[] = [];
  const services: ClipGenService[] = [];
  cleanups.push(() => {
    for (const s of services) void s.dispose();
  });
  const r: Rig = {
    dataDir,
    overlayDir,
    config,
    db,
    hf,
    clock,
    logs,
    finisher: fakeFinish(overlayDir, (u) => r.pass(u)),
    pass: () => true,
    make(overrides = {}) {
      const { clipGen: cg, ...rest } = overrides;
      const base: ClipGenOverrides = {
        runCli: hf.runCli,
        protocol: hf.protocol(),
        finish: (input) => r.finisher.finish(input),
        toolsProblem: async () => null,
        now: () => clock.now,
        sleep: async () => undefined,
        random: () => 0.5,
        tempRoots: [],
        staticLibraryDir: null,
        toolsLedgerFile: null,
        timers: false,
      };
      const service = createClipGenService({
        config: cg ? { ...config, clipGen: { ...config.clipGen, ...cg } } : config,
        db,
        nickname: () => 'Тигр',
        fetchImpl: () => Promise.reject(new Error('network access is not allowed in tests')),
        log: (line) => logs.push(line),
        overrides: { ...base, ...rest },
      });
      services.push(service);
      return service;
    },
    enable(settings = {}) {
      new ClipGenSettingsStore(db, config.clipGen.dailyMaxMilli).set({ enabled: true, dailyCapMilli: 10_000, ...settings });
    },
  };
  return r;
}
