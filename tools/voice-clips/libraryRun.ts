/**
 * `voice:library-run` — records the plan of ./library.ts into the overlay, portion by portion, and publishes it.
 * PAID: only with `--spend` and `--budget N` (≤ LIBRARY_MAX_BUDGET); `--dry-run` calls nothing at all.
 *
 *  - Paid step = `runGenerate` of ./generate.ts per portion, with the whole spend protocol unchanged: the machine-wide
 *    lock (let go between portions, so the server may record), S7, intent lines, the server's price of every prompt,
 *    the dedup BY UNIT right before each create (./dedup.ts: published, blocked, rejected, held by a job, awaiting the
 *    parent's ear, out of paid attempts — the server's rule), the balance audit after each portion. The budget is the
 *    campaign's whole ledgered spend, across runs, retakes included. The creates are sequential; `--in-flight N` jobs
 *    may be waited for at once.
 *  - Free step = the finish of every charged job, in the background while the next portion records: `process` (cut,
 *    loudness, the overlay's QA rule) and `verify` (whisper) of the tools as child processes, which publish into the
 *    overlay — only what the recogniser confirmed is heard by the child.
 *  - Order: the plan (plain and boy's variants first, the most used first) → re-planned after each pass (a job skipped
 *    by the dedup comes back packed anew) → when the plan is empty and every take is checked, the retake pass: a unit
 *    whose take really failed the check gets its take 2 alone (≤ 2 paid attempts per unit, both ledgers).
 *  - Stops: the budget; a refusal or error of Higgsfield that a person must look at (no credits, the sign-in, a price
 *    or model change, a failed audit, duplicates); the finish failing 3 times in a row (no silent pile of unchecked
 *    takes); Ctrl-C or the stop file — cleanly, after the jobs in flight. A passing hiccup (a 5xx or a dropped
 *    connection at a create, a wait without answer, the rate limit) pauses the run for 2 minutes and it goes on with the
 *    same portion — its open intent is resolved from `generate list` first — at most 5 times in a row, then it stops.
 *    Resumes from the ledger: pending jobs are waited for, downloaded jobs never processed are finished first, the plan
 *    is rebuilt from what is covered.
 *  - Progress: one log line per portion and per finish batch, and `test-results/voice-library/progress.json`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { coverageSnapshots, coveredWhy, twinKeysOf } from './dedup.ts';
import type { ToolsFiles } from './dedup.ts';
import { fmtCredits } from './cost.ts';
import { SpendRefused, runGenerate } from './generate.ts';
import { CliError } from './higgsfield.ts';
import type { GenerateDeps, GenerateSummary } from './generate.ts';
import { clipId } from './ids.ts';
import { isDiscard } from './jobs.ts';
import type { GenJob } from './jobs.ts';
import { LedgerLocked, spentMilli } from './ledger.ts';
import { LIBRARY_CAMPAIGN, LIBRARY_MAX_BUDGET, libraryJobsFile, libraryUnits, planLibrary, weighUnits } from './library.ts';
import type { LibraryPlan, LibraryUnit, UsageStats } from './library.ts';
import { readStore } from './manifest.ts';
import { readOnDemandLedger, unitAttempts } from './ondemand.ts';
import type { OnDemandView } from './ondemand.ts';
import { overlayPaths } from './overlay.ts';
import { VOICE_KEY } from './config.ts';

// ───────────────────────── the finish (free) ─────────────────────────

export interface FinishBatch {
  jobIds: string[];
  /** the clip ids of the batch's kept pieces (what `process` names them) */
  unitIds: string[];
}

export interface FinishOutcome {
  processedJobs: number;
  requeued: number;
  verified: number;
  published: number;
  needsEar: number;
}

/** Processes + verifies (+ publishes) the charged jobs of a batch; throws when a step could not run. */
export type FinishFn = (batch: FinishBatch) => Promise<FinishOutcome>;

/** Jobs per finish batch: one `process` + one `verify` child for them. */
export const FINISH_BATCH_JOBS = 60;
/** A batch that fails is tried this often (a minute apart); then the run stops recording. */
export const FINISH_TRIES = 3;

/** The clip ids of a job's kept pieces (`clipId(voice, prompt, cut, take)`, as `process` names them). */
export function unitIdsOfJob(job: Pick<GenJob, 'prompt' | 'take' | 'pieces'>): string[] {
  const ids: string[] = [];
  job.pieces.forEach((p, cut) => {
    if (!isDiscard(p)) ids.push(clipId(VOICE_KEY, job.prompt, cut, job.take));
  });
  return ids;
}

/**
 * The library's charged, downloaded jobs that still need their finish: never processed (no unit in the store, not
 * requeued), or processed with a unit never checked (`qa: 'auto'` — a stop between `process` and `verify`).
 */
export function unfinishedJobs(view: OnDemandView, storeFile: string): string[] {
  let store: ReturnType<typeof readStore> | null = null;
  try {
    store = readStore(storeFile);
  } catch {
    store = null;
  }
  const byJob = new Map<string, { checked: boolean }[]>();
  for (const u of Object.values(store?.units ?? {})) {
    const list = byJob.get(u.jobId) ?? [];
    list.push({ checked: u.qa !== 'auto' || u.asr !== undefined });
    byJob.set(u.jobId, list);
  }
  const requeued = new Set(Object.keys(store?.requeued ?? {}));
  const out: string[] = [];
  for (const job of view.ledger.jobs.values()) {
    if (job.campaign !== LIBRARY_CAMPAIGN || job.state !== 'charged' || job.master === undefined) continue;
    if (requeued.has(job.jobId)) continue;
    const units = byJob.get(job.jobId);
    if (units === undefined || units.some((u) => !u.checked)) out.push(job.jobId);
  }
  return out;
}

/** The background finisher: batches of job ids, one at a time, in order; `drain()` waits for the queue to empty. */
export class Finisher {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private running: Promise<void> | null = null;
  readonly totals = { batches: 0, processedJobs: 0, requeued: 0, verified: 0, published: 0, needsEar: 0, errors: 0 };
  /** set after FINISH_TRIES failures of one batch: the run stops recording */
  failed: string | null = null;

  private readonly finish: FinishFn;
  /** the ledgered jobs of these ids (read once per batch) */
  private readonly jobsOf: (jobIds: readonly string[]) => ReadonlyMap<string, Pick<GenJob, 'prompt' | 'take' | 'pieces'>>;
  private readonly deps: Pick<GenerateDeps, 'sleep' | 'log'>;
  private readonly onBatch: () => void;

  constructor(
    finish: FinishFn,
    jobsOf: (jobIds: readonly string[]) => ReadonlyMap<string, Pick<GenJob, 'prompt' | 'take' | 'pieces'>>,
    deps: Pick<GenerateDeps, 'sleep' | 'log'>,
    onBatch: () => void = () => {},
  ) {
    this.finish = finish;
    this.jobsOf = jobsOf;
    this.deps = deps;
    this.onBatch = onBatch;
  }

  add(jobIds: readonly string[]): void {
    for (const id of jobIds) {
      if (this.queued.has(id)) continue;
      this.queued.add(id);
      this.queue.push(id);
    }
    if (this.running === null && this.queue.length > 0 && this.failed === null) this.running = this.loop().finally(() => (this.running = null));
  }

  get pending(): number {
    return this.queue.length;
  }

  async drain(): Promise<void> {
    while (this.running !== null) await this.running;
  }

  private async loop(): Promise<void> {
    while (this.queue.length > 0 && this.failed === null) {
      const jobIds = this.queue.splice(0, FINISH_BATCH_JOBS);
      const jobs = this.jobsOf(jobIds);
      const unitIds = jobIds.flatMap((id) => {
        const job = jobs.get(id);
        return job === undefined ? [] : unitIdsOfJob(job);
      });
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await this.finish({ jobIds, unitIds });
          this.totals.batches++;
          this.totals.processedJobs += r.processedJobs;
          this.totals.requeued += r.requeued;
          this.totals.verified += r.verified;
          this.totals.published += r.published;
          this.totals.needsEar += r.needsEar;
          this.deps.log(
            `проверка записей: заданий ${jobIds.length}, фраз ${r.verified} — опубликовано ${r.published}, послушать ${r.needsEar}${r.requeued > 0 ? `, не разрезалось ${r.requeued}` : ''} (всего опубликовано ${this.totals.published}; в очереди ${this.queue.length} заданий)`,
          );
          break;
        } catch (error) {
          this.totals.errors++;
          const message = error instanceof Error ? error.message : String(error);
          if (attempt >= FINISH_TRIES) {
            this.failed = message;
            this.deps.log(`ОШИБКА проверки записей (${attempt} раза подряд): ${message} — запись останавливается; записанное не пропало, следующий запуск доделает проверку`);
            break;
          }
          this.deps.log(`проверка записей не удалась (${message}) — повтор через минуту`);
          await this.deps.sleep(60_000);
        }
      }
      for (const id of jobIds) this.queued.delete(id);
      this.onBatch();
    }
  }
}

/** Environment names a finish child gets (no key, no token): the same allow-list as the server's finish. */
const CHILD_ENV_ALLOW = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LANGUAGE']);
const TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!CHILD_ENV_ALLOW.has(name) && !/^LC_[A-Z_]+$/.test(name)) continue;
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i.test(name)) continue;
    env[name] = value;
  }
  const dirs = (env.PATH ?? '').split(path.delimiter).filter((d) => d !== '');
  env.PATH = [...dirs, ...TOOL_DIRS.filter((d) => !dirs.includes(d))].join(path.delimiter);
  return env;
}

function runChild(args: readonly string[], o: { cwd: string; timeoutMs: number }): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...args], { cwd: o.cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let out = '';
    const keep = (chunk: Buffer): void => {
      out = (out + chunk.toString('utf8')).slice(-8000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGTERM'), o.timeoutMs);
    timer.unref();
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, out: `${out}\n${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: typeof code === 'number' ? code : 1, out });
    });
  });
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The real finish: `node tools/voice-clips/cli.ts process --overlay <ov> --job …` then `verify --overlay <ov> --unit …`
 * (their own reports in `reportDir`, never the server's), each under the overlay's publish lock (the CLI takes it).
 * A verify that ran without the recogniser, or could not check a take, is an error — never a verdict.
 */
export function childFinish(o: { repoRoot: string; overlayDir: string; reportDir: string; timeoutMs?: number }): FinishFn {
  const cli = path.join(o.repoRoot, 'tools', 'voice-clips', 'cli.ts');
  const processReport = path.join(o.reportDir, 'process-report.json');
  const verifyReport = path.join(o.reportDir, 'verify-report.json');
  const timeoutMs = o.timeoutMs ?? 20 * 60_000;
  mkdirSync(o.reportDir, { recursive: true });
  return async ({ jobIds, unitIds }) => {
    const p = await runChild([cli, 'process', '--overlay', o.overlayDir, '--report', processReport, ...jobIds.flatMap((id) => ['--job', id])], { cwd: o.repoRoot, timeoutMs });
    if (p.code !== 0) throw new Error(`voice:process exit ${p.code}: ${p.out.trim().split('\n').slice(-3).join(' | ')}`);
    const pr = readJson(processReport);
    const missing = Array.isArray(pr?.missingMasters) ? (pr.missingMasters as string[]).filter((id) => jobIds.includes(id)) : [];
    if (missing.length > 0) throw new Error(`voice:process: нет мастер-файла у ${missing.length} заданий (${missing.slice(0, 2).join(', ')})`);
    const requeued = Array.isArray(pr?.requeue) ? pr.requeue.length : 0;
    if (unitIds.length === 0) return { processedJobs: Number(pr?.processedJobs ?? 0), requeued, verified: 0, published: 0, needsEar: 0 };
    // only the units `process` really made (a requeued job has none)
    let store: ReturnType<typeof readStore> | null = null;
    try {
      store = readStore(overlayPaths(o.overlayDir).storeFile);
    } catch {
      store = null;
    }
    const made = unitIds.filter((id) => store?.units[id] !== undefined);
    if (made.length === 0) return { processedJobs: Number(pr?.processedJobs ?? 0), requeued, verified: 0, published: 0, needsEar: 0 };
    const v = await runChild([cli, 'verify', '--overlay', o.overlayDir, '--report', verifyReport, ...made.flatMap((id) => ['--unit', id])], { cwd: o.repoRoot, timeoutMs });
    if (v.code !== 0) throw new Error(`voice:verify exit ${v.code}: ${v.out.trim().split('\n').slice(-3).join(' | ')}`);
    const vr = readJson(verifyReport);
    if (vr === null) throw new Error('voice:verify не записал отчёт');
    if (vr.asr !== 'on') throw new Error(`voice:verify работал без распознавателя (${String(vr.asrNote ?? 'whisper недоступен')})`);
    const needsEar = Array.isArray(vr.needsEar) ? (vr.needsEar as { flags?: unknown }[]) : [];
    const broken = needsEar.filter((u) => Array.isArray(u.flags) && (u.flags as unknown[]).some((f) => typeof f === 'string' && /^(?:asr-error|missing-file)(?::|$)/.test(f)));
    if (broken.length > 0) throw new Error(`voice:verify не смог проверить ${broken.length} записей (asr-error / missing-file)`);
    return { processedJobs: Number(pr?.processedJobs ?? 0), requeued, verified: Number(vr.units ?? made.length), published: Number(vr.passed ?? 0), needsEar: needsEar.length };
  };
}

// ───────────────────────── the run ─────────────────────────

export interface LibraryRunOptions {
  /** credits: the campaign's whole ledgered spend (every run, retakes included) stays within it */
  budget: number | undefined;
  spend: boolean;
  /** plan and print only: zero CLI calls, nothing written but the plan file */
  dryRun: boolean;
  /** jobs per `runGenerate` (the machine-wide lock is let go between portions) */
  portion: number;
  /** at most this many new jobs in this run (a cautious start); absent = no cap */
  maxJobs?: number;
  /** jobs waited for at once (the creates stay sequential) */
  inFlight: number;
  overlayDir: string;
  staticLibrary: string | null;
  tools: ToolsFiles | null;
  usage: UsageStats;
  /** the library (tests pass a small one); default: `libraryUnits()` weighed by `usage` */
  units?: LibraryUnit[];
  /** where the plan and the progress go (test-results/voice-library) */
  outDir: string;
  acceptAudit?: boolean;
  lockWaitMs: number;
  /** how long the run waits while the server has a job in flight (S7) or holds the lock, before it gives up */
  busyWaitMs?: number;
  /** at most this many planning passes (each pass records the whole current plan) */
  maxPasses?: number;
}

export interface LibraryRunDeps extends GenerateDeps {
  finish: FinishFn;
  /** true = stop cleanly before the next job (Ctrl-C, the stop file) */
  shouldStop: () => boolean;
}

export type LibraryStop = 'done' | 'dry-run' | 'max-jobs' | 'interrupted' | 'finish-error' | 'busy' | 'audit' | GenerateSummary['stop'] | `refused:${string}`;

export interface LibraryRunSummary {
  stop: LibraryStop;
  /** the first plan of this run */
  plan: Pick<LibraryPlan, 'total' | 'covered' | 'planned' | 'retakes' | 'milli'> & { jobs: number };
  /** what is left to record when the run ended (0 = the library is complete, as far as the budget and attempts allow) */
  left: { units: number; jobs: number; milli: number };
  created: number;
  adopted: number;
  resumed: number;
  charged: number;
  failed: number;
  skipped: number;
  rateLimited: number;
  /** the campaign's ledgered spend at the end (milli-credits) */
  spentMilli: number;
  balanceMilli: number | null;
  finish: Finisher['totals'];
  message?: string;
}

const STOPPING: ReadonlySet<string> = new Set(['budget', 'rate-limit', 'create-error', 'wait-error', 'price', 'interrupted']);

/** The summary of a run that could not finish (it created nothing it did not ledger): for the pause-and-go-on path. */
function emptyRun(): GenerateSummary {
  return {
    campaign: LIBRARY_CAMPAIGN,
    budgetMilli: 0,
    spentMilli: 0,
    created: 0,
    adopted: 0,
    resumed: 0,
    charged: 0,
    failed: 0,
    downloaded: 0,
    rateLimited: 0,
    todoLeft: 0,
    skipped: 0,
    stop: 'create-error',
    createFailure: 'error',
    chargedJobIds: [],
    balanceBeforeMilli: 0,
    balanceAfterMilli: null,
    audit: null,
  };
}
/** after a passing hiccup of Higgsfield the run pauses this long and goes on — at most this many times in a row */
export const TRANSIENT_PAUSE_MS = 2 * 60_000;
export const MAX_TRANSIENT_STOPS = 5;

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(tmp, file);
}

export async function runLibrary(o: LibraryRunOptions, deps: LibraryRunDeps): Promise<LibraryRunSummary> {
  const { log } = deps;
  if (!o.dryRun) {
    if (o.spend !== true || o.budget === undefined || !Number.isFinite(o.budget) || o.budget <= 0) {
      throw new SpendRefused('нужны --spend и --budget N (кредиты): запись платная. Без них — только --dry-run');
    }
    if (o.budget > LIBRARY_MAX_BUDGET) throw new SpendRefused(`--budget ${o.budget} больше разрешённых владельцем ${LIBRARY_MAX_BUDGET} кредитов`);
  }
  const ov = overlayPaths(o.overlayDir);
  const units = o.units ?? weighUnits(libraryUnits(), o.usage);
  const snapshots = coverageSnapshots({ overlayDir: o.overlayDir, staticLibrary: o.staticLibrary, tools: o.tools });
  const makePlan = (mode: 'held' | 'retake'): LibraryPlan => {
    const snap = snapshots();
    const view = readOnDemandLedger(ov.ledgerFile);
    return planLibrary({
      units,
      covered: (u) => coveredWhy(u, view, snap, { mode, tools: o.tools !== null }),
      attempts: (u) => {
        const unit = { key: u.key, text: u.text, twins: twinKeysOf(u) };
        return unitAttempts(view, unit) + unitAttempts(snap.toolsView, unit);
      },
    });
  };

  const first = makePlan('held');
  const planFile = path.join(o.outDir, 'library.jobs.json');
  writeJsonAtomic(planFile, libraryJobsFile(first.jobs));
  const summary: LibraryRunSummary = {
    stop: 'done',
    plan: { total: first.total, covered: first.covered, planned: first.planned, retakes: first.retakes, milli: first.milli, jobs: first.jobs.length },
    left: { units: first.planned, jobs: first.jobs.length, milli: first.milli },
    created: 0,
    adopted: 0,
    resumed: 0,
    charged: 0,
    failed: 0,
    skipped: 0,
    rateLimited: 0,
    spentMilli: spentMilli(readOnDemandLedger(ov.ledgerFile).ledger, LIBRARY_CAMPAIGN),
    balanceMilli: null,
    finish: { batches: 0, processedJobs: 0, requeued: 0, verified: 0, published: 0, needsEar: 0, errors: 0 },
  };
  log(`библиотека: ${first.total} фраз; уже есть или в работе ${Object.values(first.covered).reduce((a, b) => a + b, 0)} (${Object.entries(first.covered).map(([k, v]) => `${k} ${v}`).join(', ') || '—'})`);
  log(`план: ${first.planned} фраз в ${first.jobs.length} заданиях, ${fmtCredits(first.milli)} кр. по цене SPEC; кампания «${LIBRARY_CAMPAIGN}» уже потратила ${fmtCredits(summary.spentMilli)} кр.`);
  if (o.dryRun) {
    const portions = Math.ceil(first.jobs.length / Math.max(1, o.portion));
    log(`--dry-run: ничего не вызывалось и не записывалось (кроме плана ${planFile}); запуск сделал бы ${portions} порций по ${o.portion} заданий`);
    for (const job of first.jobs.slice(0, 5)) log(`  ${fmtCredits(Math.ceil([...job.prompt].length / 50) * 150)} кр. «${job.prompt}»`);
    summary.stop = 'dry-run';
    return summary;
  }

  const startedAt = deps.now().toISOString();
  const jobsOf = (ids: readonly string[]): Map<string, GenJob> => {
    const all = readOnDemandLedger(ov.ledgerFile).ledger.jobs;
    const out = new Map<string, GenJob>();
    for (const id of ids) {
      const job = all.get(id)?.job;
      if (job !== undefined) out.set(id, job);
    }
    return out;
  };
  let lastPlan = first;
  let phase: 'main' | 'retake' = 'main';
  const progress = (extra: Record<string, unknown> = {}): void => {
    try {
      writeJsonAtomic(path.join(o.outDir, 'progress.json'), {
        startedAt,
        at: deps.now().toISOString(),
        phase,
        budget: o.budget,
        spentCredits: summary.spentMilli / 1000,
        balance: summary.balanceMilli === null ? null : summary.balanceMilli / 1000,
        plan: summary.plan,
        left: { units: lastPlan.planned, jobs: lastPlan.jobs.length, credits: lastPlan.milli / 1000 },
        recorded: { created: summary.created, adopted: summary.adopted, resumed: summary.resumed, charged: summary.charged, failed: summary.failed, skipped: summary.skipped, rateLimited: summary.rateLimited },
        finish: { ...finisher.totals, queuedJobs: finisher.pending, failed: finisher.failed },
        stop: summary.stop,
        ...extra,
      });
    } catch {
      // progress is a convenience: never a reason to stop recording
    }
  };
  const finisher: Finisher = new Finisher(deps.finish, jobsOf, deps, () => progress());
  // a stop between the download and the check: finish those first (free)
  const leftover = unfinishedJobs(readOnDemandLedger(ov.ledgerFile), ov.storeFile);
  if (leftover.length > 0) {
    log(`доделываю проверку ${leftover.length} уже записанных заданий`);
    finisher.add(leftover);
  }

  const busyWaitMs = o.busyWaitMs ?? 30 * 60_000;
  /** passing hiccups of Higgsfield in a row (reset by a portion that created jobs) */
  let transientStops = 0;
  let acceptAudit = o.acceptAudit === true;
  const maxPasses = o.maxPasses ?? 8;
  const t0 = deps.now().getTime();

  /**
   * One `runGenerate` into the overlay ledger (the whole spend protocol), waiting while the server has a job in flight
   * or holds the lock; its numbers go into the summary and its charged jobs to the finisher. A stop = why the run ends.
   */
  const generate = async (
    jobs: readonly GenJob[],
    mode: 'held' | 'retake',
    maxJobs?: number,
  ): Promise<{ run: GenerateSummary; transient?: string } | { stop: LibraryStop; message?: string }> => {
    let busyWaited = 0;
    for (;;) {
      try {
        const run = await runGenerate(
          {
            spend: true,
            budget: o.budget,
            jobs: libraryJobsFile(jobs),
            ...(maxJobs !== undefined ? { maxJobs } : {}),
            ledgerFile: ov.ledgerFile,
            mastersDir: ov.mastersDir,
            overlayDir: o.overlayDir,
            lockWaitMs: o.lockWaitMs,
            ...(o.tools !== null ? { otherLedgers: [o.tools.ledgerFile] } : {}),
            unitCovered: (piece, view) => coveredWhy(piece, view, snapshots(), { mode, tools: o.tools !== null }),
            shouldStop: deps.shouldStop,
            rebuildHint: 'voice:library-run собирает план заново сам',
            inFlight: o.inFlight,
            ...(acceptAudit ? { acceptAudit: true } : {}),
          },
          deps,
        );
        acceptAudit = false;
        summary.created += run.created;
        summary.adopted += run.adopted;
        summary.resumed += run.resumed;
        summary.charged += run.charged;
        summary.failed += run.failed;
        summary.skipped += run.skipped;
        summary.rateLimited += run.rateLimited;
        summary.spentMilli = run.spentMilli;
        summary.balanceMilli = run.balanceAfterMilli ?? summary.balanceMilli;
        finisher.add(run.chargedJobIds);
        if (run.audit?.ok === false) return { stop: 'audit', message: 'баланс Higgsfield не сошёлся с журналом — проверьте историю списаний; продолжить можно только с --accept-audit' };
        // a passing hiccup of Higgsfield (a 5xx or a dropped connection at a create, a wait without answer, the rate
        // limit): the run ended cleanly with the job's intent open — the caller pauses and goes on; the next run
        // resolves that intent from `generate list` first, so nothing is ever paid twice
        const transient =
          (run.stop === 'create-error' && (run.createFailure === 'unresolved' || run.createFailure === 'error')) || run.stop === 'wait-error' || run.stop === 'rate-limit';
        if (transient) return { run, transient: `${run.stop}${run.createFailure !== undefined ? ` (${run.createFailure})` : ''}` };
        if (STOPPING.has(run.stop)) return { stop: run.stop, ...(run.createFailure !== undefined ? { message: `Higgsfield: ${run.createFailure}` } : {}) };
        if (run.stop === 'max-jobs' && maxJobs !== 0) return { stop: 'max-jobs' };
        return { run };
      } catch (error) {
        // a Higgsfield call that failed where runGenerate has no answer of its own for it: a passing hiccup too
        if (error instanceof CliError) return { run: emptyRun(), transient: `${error.message}: ${error.result.stderr.split('\n')[0]?.slice(0, 120) ?? ''}` };
        const busy = (error instanceof SpendRefused && error.code === 'server-busy') || error instanceof LedgerLocked;
        if (busy && busyWaited < busyWaitMs && !deps.shouldStop()) {
          log(`сервер «Дозаписи» сейчас сам записывает фразу — жду минуту (${error instanceof Error ? error.message.slice(0, 100) : ''}…)`);
          busyWaited += 60_000;
          await deps.sleep(60_000);
          continue;
        }
        if (busy) return { stop: deps.shouldStop() ? 'interrupted' : 'busy', message: error instanceof Error ? error.message : String(error) };
        if (error instanceof SpendRefused) {
          log(`отказ (ничего не потрачено): ${error.message}`);
          return { stop: `refused:${error.code}`, message: error.message };
        }
        throw error;
      }
    }
  };

  // a crash left a library job pending (or an intent open): wait for it and download it first (free), never re-create it
  const before = readOnDemandLedger(ov.ledgerFile);
  const open = [...before.ledger.jobs.values()].filter((j) => j.campaign === LIBRARY_CAMPAIGN && j.state === 'pending').length + before.unresolved.filter((i) => i.campaign === LIBRARY_CAMPAIGN).length;
  let stopped: { stop: LibraryStop; message?: string } | null = null;
  if (open > 0) {
    log(`продолжаю ${open} заданий прошлого запуска (жду их и скачиваю записи — бесплатно)`);
    const r = await generate([], 'held', 0);
    if ('stop' in r) stopped = r;
  }

  outer: for (let pass = 1; pass <= maxPasses && stopped === null; pass++) {
    if (phase === 'retake') {
      // every take must be checked before a failed one may cost its take 2
      await finisher.drain();
      if (finisher.failed !== null) {
        stopped = { stop: 'finish-error', message: finisher.failed };
        break;
      }
    }
    const plan = pass === 1 && phase === 'main' && open === 0 ? first : makePlan(phase === 'main' ? 'held' : 'retake');
    lastPlan = plan;
    progress();
    if (plan.jobs.length === 0) {
      if (phase === 'main') {
        phase = 'retake';
        continue;
      }
      break;
    }
    if (pass > 1) log(`${phase === 'retake' ? 'вторые попытки' : 'новый проход'}: ${plan.planned} фраз${plan.retakes > 0 ? ` (из них повторов ${plan.retakes})` : ''} в ${plan.jobs.length} заданиях, ${fmtCredits(plan.milli)} кр.`);
    let progressed = false;
    for (let at = 0; at < plan.jobs.length; ) {
      if (deps.shouldStop()) {
        stopped = { stop: 'interrupted' };
        break outer;
      }
      if (finisher.failed !== null) {
        stopped = { stop: 'finish-error', message: finisher.failed };
        break outer;
      }
      const made = summary.created + summary.adopted;
      if (o.maxJobs !== undefined && made >= o.maxJobs) {
        stopped = { stop: 'max-jobs' };
        break outer;
      }
      const slice = plan.jobs.slice(at, at + Math.max(1, o.portion));
      const r = await generate(slice, phase === 'main' ? 'held' : 'retake', o.maxJobs === undefined ? undefined : o.maxJobs - made);
      if ('stop' in r) {
        stopped = r;
        break outer;
      }
      const run = r.run;
      if (r.transient !== undefined) {
        transientStops++;
        if (transientStops > MAX_TRANSIENT_STOPS) {
          stopped = { stop: run.stop, message: `Higgsfield не отвечает: ${r.transient}, ${transientStops - 1} раз подряд` };
          break outer;
        }
        log(`Higgsfield временно не ответил (${r.transient}) — пауза ${Math.round(TRANSIENT_PAUSE_MS / 60_000)} мин, потом продолжаю эту же порцию (незаконченное задание сначала сверю со списком Higgsfield)`);
        progress({ pausedUntil: new Date(deps.now().getTime() + TRANSIENT_PAUSE_MS).toISOString(), transientStops });
        await deps.sleep(TRANSIENT_PAUSE_MS);
        // the same slice again: what was created is in the ledger now (never created twice), the rest follows
        continue;
      }
      if (run.created + run.adopted > 0) transientStops = 0;
      at += slice.length;
      if (run.created + run.adopted + run.resumed > 0) progressed = true;
      const minutes = (deps.now().getTime() - t0) / 60_000;
      const done = summary.created + summary.adopted;
      const rate = done > 0 ? minutes / done : 0;
      const jobsLeft = plan.jobs.length - at;
      log(
        `порция: +${run.charged} записано${run.failed > 0 ? `, неудачных ${run.failed}` : ''}${run.skipped > 0 ? `, пропущено ${run.skipped}` : ''}; всего заданий ${done}, потрачено ${fmtCredits(summary.spentMilli)} из ${fmtCredits(Math.round((o.budget ?? 0) * 1000))} кр.` +
          `${summary.balanceMilli !== null ? `, на счёте ${fmtCredits(summary.balanceMilli)}` : ''}; осталось в проходе ${jobsLeft} заданий${rate > 0 ? ` (≈ ${Math.round(jobsLeft * rate)} мин)` : ''}`,
      );
      progress();
    }
    if (!progressed) {
      if (phase === 'main') {
        phase = 'retake';
        continue;
      }
      break;
    }
  }
  if (stopped !== null) {
    summary.stop = stopped.stop;
    if (stopped.message !== undefined) summary.message = stopped.message;
  }
  log('жду, пока проверятся последние записи…');
  await finisher.drain();
  if (finisher.failed !== null && summary.stop === 'done') {
    summary.stop = 'finish-error';
    summary.message = finisher.failed;
  }
  summary.finish = { ...finisher.totals };
  const end = makePlan(phase === 'main' ? 'held' : 'retake');
  lastPlan = end;
  summary.left = { units: end.planned, jobs: end.jobs.length, milli: end.milli };
  summary.spentMilli = spentMilli(readOnDemandLedger(ov.ledgerFile).ledger, LIBRARY_CAMPAIGN);
  progress({ finished: true });
  return summary;
}

/** The stop file of a running `voice:library-run` (touch it to stop cleanly after the jobs in flight). */
export function stopFileOf(outDir: string): string {
  return path.join(outDir, 'STOP');
}

export function stopRequested(outDir: string): boolean {
  return existsSync(stopFileOf(outDir));
}
