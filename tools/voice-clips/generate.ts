/**
 * `voice:generate` — the ONLY paid step (SPEC §10 «Spend protocol»). Agents never pass `--spend` without the parent's
 * explicit OK.
 *
 *  1. Refuse, with ZERO CLI calls, unless both `--spend` and a positive `--budget` are given and every prompt is valid.
 *  2. Lock the ledger (concurrency 1, also across processes) — with an overlay folder («Дозапись голоса») first the
 *     machine-wide `<overlay>/higgsfield.lock` (waited for: the server holds it ≈ 5 s per phrase), and refuse, with
 *     zero CLI calls, while the overlay ledger has another campaign's job in flight (S7: its debit or refund would
 *     land inside this run's audit) — unless `--resume-server-jobs`: then this run first brings those jobs home itself
 *     (free: `generate list` / `wait` / `get` and the download, charged lines into the overlay ledger), before its
 *     balance is read. A server that may not resume them (recording switched off, no budget) would block it forever.
 *  3. `account status` (balance) and `model get text2speech_v2` (params unchanged) — refuse on any doubt.
 *  4. Resume: an intent a crash left open is looked up in `generate list` (overlay ledger only); every ledgered job
 *     without a terminal line is polled with `generate wait --interval 1s`, never re-created; charged jobs without a
 *     master are downloaded (a fresh URL from `generate get` when the old one fails).
 *  5. Todo = jobs whose key the ledger does not know (a key whose jobs only failed may be retried, ≤ 2 failures).
 *     The campaign's ledgered charges (pending ones at full price) + the next job must stay within `--budget`;
 *     `--max-jobs` caps new jobs per run; the remaining budget must not exceed the balance; the server's own price
 *     (`generate cost`, free) of EVERY prompt must equal the SPEC price the ledger and the budget count with, checked
 *     right before its create — the first one before anything is created (refusal), a later one stops the run.
 *  6. Per job, strictly one at a time: adopt an un-ledgered identical job from `generate list` if there is one;
 *     otherwise `generate create … --json` (no --wait) ⇒ `created` line (fsync) ⇒ `generate wait` ⇒ `charged` /
 *     `failed` ⇒ download the master immediately (CDN URLs expire) ⇒ `downloaded`.
 *     A rate limit is exit ≠ 0 plus `rate_limit_reached` in stderr, nothing else: back off 2 → 60 s with jitter,
 *     look in `generate list` for an identical prompt before every retry, ≤ 8 tries. Any other create failure is
 *     ambiguous: adopt from the list if the job exists, otherwise stop the run (never retry blindly).
 *     The create itself is `createJob` of ./ondemand.ts (shared with the server): the output is parsed widely (never a
 *     `job_set_id`), an id without our prompt is confirmed by a free `generate get`, and the `created` line records
 *     how the id was learned (`via`) and the output's masked key skeleton (`createShape`). Into the overlay ledger an
 *     `intent` line is written (fsync) before the create and counted at full price until it is resolved — and, right
 *     before, every piece of the job is checked BY UNIT (`unitCovered`, ./dedup.ts): a plan made hours ago does not
 *     know what the server recorded since (in other prompts), so a job with a covered piece is skipped, never paid.
 *     The same check runs for a static campaign (the tools ledger) while the machine has an overlay: the server records
 *     whole catalogue sentences on demand under the static library's own keys, so the two libraries now overlap.
 *  7. Audit: the balance read after the run must have fallen by what the ledger charged in this run (between the jobs
 *     charged and the jobs created, whichever way the provider debits). A mismatch is written to the ledger and every
 *     later run refuses — with zero CLI calls — until the parent has looked and passes `--accept-audit`.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LIST_PAGE_SIZE, MAX_CREATE_TRIES, MAX_FAILED_PER_KEY } from './config.ts';
import { creditsToMilli, fmtCredits, jobMilli, promptProblem } from './cost.ts';
import type { UnitCovered } from './dedup.ts';
import { CliError, DONE_FAILED, DONE_OK, accountMilli, isOurVoice, isRateLimited, isTransient, listArgs, modelProblem, parseJobs, serverCostMilli, waitArgs } from './higgsfield.ts';
import type { HfJob, RunCli } from './higgsfield.ts';
import { isDiscard, keyOfJob } from './jobs.ts';
import type { GenJob, JobsFile } from './jobs.ts';
import { appendLedgerLine, auditBlocked, jobsOfKey, lockLedger, pendingJobs, spentMilli } from './ledger.ts';
import type { AuditLine, LedgerJob, LedgerView } from './ledger.ts';
import { OVERLAY_LEDGER, adoptIntents, backoffMs, createJob, downloadJob, onDemandViewOf, readOnDemandLedger, readOnDemandLines } from './ondemand.ts';
import type { OnDemandLine, OnDemandView } from './ondemand.ts';
import { overlayPaths } from './overlay.ts';

export { backoffMs } from './ondemand.ts';

export const SPEND_RULE = 'Правило: --spend передаёт только владелец или агент с его явным OK в чате; без --spend и --budget инструмент ничего не вызывает.';

/**
 * Why a run refused before it could spend (a caller that loops over runs — `voice:library-run` — stops, waits or
 * retries by it): the flags or prompts, a failed balance audit, a changed model, a changed price, a balance below the
 * run's need, the server's job in flight (S7).
 */
export type RefusalCode = 'flags' | 'audit' | 'model' | 'price' | 'balance' | 'server-busy';

export class SpendRefused extends Error {
  readonly code: RefusalCode;
  constructor(message: string, code: RefusalCode = 'flags') {
    super(message);
    this.name = 'SpendRefused';
    this.code = code;
  }
}

export interface GenerateOptions {
  spend: boolean;
  /** Credits (e.g. 15). The campaign's whole ledgered spend, across runs, stays within it. */
  budget: number | undefined;
  jobs: JobsFile;
  /** At most this many NEW jobs in this run (0 = only resume pending jobs and downloads). */
  maxJobs?: number;
  ledgerFile: string;
  mastersDir: string;
  /** the parent looked at the last failed balance audit and lets the runs go on */
  acceptAudit?: boolean;
  /**
   * «Дозапись голоса»: the overlay folder of this Mac (absent / null = none). The run then holds its machine-wide
   * `higgsfield.lock` for its whole length (it never overlaps the server's on-demand recorder), refuses — with zero CLI
   * calls — while the overlay ledger has another campaign's job in flight (S7: that job's debit or refund would land
   * inside this run's balance audit), and never adopts a job that ledger owns. When `ledgerFile` IS the overlay ledger
   * (the parent's prefetch) the run writes intent lines and counts unresolved ones in the budget, as the server does.
   */
  overlayDir?: string | null;
  /** how long to wait for the machine-wide lock (the server holds it ≈ 5 s per phrase); default 0 = refuse at once */
  lockWaitMs?: number;
  /** more ledgers whose job ids are never adopted (the tools ledger, when the run writes into the overlay) */
  otherLedgers?: readonly string[];
  /**
   * is this unit already recorded, blocked, or in a job of the overlay ledger? Asked right before each create — with
   * the overlay ledger's view, whichever ledger the run writes (the prefetch, or a static campaign while the machine
   * has an overlay): a job with a covered piece is skipped (./dedup.ts `unitCoverage`)
   */
  unitCovered?: UnitCovered;
  /**
   * S7 without the server: bring the overlay ledger's jobs of other campaigns home first (free: list / wait / get and
   * the download into `<overlay>/.masters`), instead of refusing while they are in flight
   */
  resumeServerJobs?: boolean;
  /**
   * Asked before every NEW job (never in the middle of one): true = stop here, cleanly — the run finishes the job it
   * is on, reads the balance, audits and returns `stop: 'interrupted'` (Ctrl-C of `voice:library-run`).
   */
  shouldStop?: () => boolean;
  /** the command that rebuilds the plan, for the log line of a job skipped by the dedup (default: by the ledger) */
  rebuildHint?: string;
  /**
   * How many created jobs may be waited for at once (default 1: strictly one job at a time). The creates stay strictly
   * sequential — intent, create, `created` line, one after the other —; only the `generate wait` and the download of
   * jobs already in the ledger overlap (the provider renders a job in ≈ 3 s, and the next create's CLI round trips take
   * as long). The budget counts every job in flight at full price, a failed wait stops the creates, and the run waits
   * for every job in flight before it reads the balance, so the audit sees them all.
   */
  inFlight?: number;
}

export interface DownloadResult {
  bytes: number;
  sha256: string;
}

export interface GenerateDeps {
  runCli: RunCli;
  /** Fetches `url` into `dest` atomically; throws on anything that is not a non-empty MP3. */
  download: (url: string, dest: string) => Promise<DownloadResult>;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => Date;
  log: (line: string) => void;
}

export type StopReason = 'done' | 'budget' | 'max-jobs' | 'rate-limit' | 'create-error' | 'wait-error' | 'price' | 'interrupted';

export interface GenerateSummary {
  campaign: string;
  budgetMilli: number;
  /** Campaign spend in the ledger after the run (pending jobs — and, in the overlay, unresolved intents — at full price). */
  spentMilli: number;
  created: number;
  adopted: number;
  resumed: number;
  charged: number;
  failed: number;
  downloaded: number;
  rateLimited: number;
  todoLeft: number;
  /** jobs of the file not created because a piece of them is already covered (the plan is out of date) */
  skipped: number;
  stop: StopReason;
  /** why the create stopped the run (`stop: 'create-error' | 'rate-limit'`): the account's answer, as `createJob` read it */
  createFailure?: 'rate' | 'no-credits' | 'login' | 'unresolved' | 'duplicate' | 'error';
  /** the jobs this run saw charged (its own, adopted or resumed ones), in that order: what a caller processes next */
  chargedJobIds: string[];
  balanceBeforeMilli: number;
  balanceAfterMilli: number | null;
  /** the balance audit of this run (null: the balance after the run could not be read) */
  audit: Pick<AuditLine, 'ok' | 'deltaMilli' | 'minMilli' | 'maxMilli'> | null;
}

/** Tolerance of the audit (rounding of the provider's credits to 0.01). */
export const AUDIT_EPS_MILLI = 10;

/** Step 1: flags and prompts. Throws before anything touches the CLI or the disk. */
export function assertSpendAllowed(opts: Pick<GenerateOptions, 'spend' | 'budget' | 'jobs' | 'maxJobs'>): number {
  if (opts.spend !== true) throw new SpendRefused(`нет --spend: генерация платная, запуск без него ничего не делает. ${SPEND_RULE}`);
  if (opts.budget === undefined || !Number.isFinite(opts.budget) || opts.budget <= 0) {
    throw new SpendRefused(`нужен --budget N (кредиты, > 0) вместе с --spend. ${SPEND_RULE}`);
  }
  if (opts.maxJobs !== undefined && (!Number.isInteger(opts.maxJobs) || opts.maxJobs < 0)) throw new SpendRefused('--max-jobs must be an integer ≥ 0');
  for (const [index, job] of opts.jobs.jobs.entries()) {
    const problem = promptProblem(job.prompt);
    if (problem !== null) throw new SpendRefused(`job #${index + 1}: ${problem}`);
  }
  return creditsToMilli(opts.budget);
}

/**
 * Jobs of the file that still need a (new) Higgsfield job. `open` = job keys of unresolved intents (the overlay): such
 * a create may have made the job, so it is never repeated until `adoptIntents` has resolved it.
 */
export function todoJobs(file: JobsFile, view: LedgerView, open: ReadonlySet<string> = new Set()): GenJob[] {
  return file.jobs.filter((job) => {
    const key = keyOfJob(job);
    if (open.has(key)) return false;
    const known = jobsOfKey(view, key);
    if (known.some((j) => j.state !== 'failed')) return false;
    return known.length < MAX_FAILED_PER_KEY;
  });
}

/**
 * S7: what the overlay ledger has in flight that is not this run's own (a pending job, an intent nobody resolved yet).
 * `own` = this run's campaign when it writes into the overlay ledger itself (it resumes those), else null.
 */
export function overlayBusy(view: OnDemandView, own: string | null): string[] {
  const foreign = (campaign: string): boolean => own === null || campaign !== own;
  return [
    ...pendingJobs(view.ledger)
      .filter((j) => foreign(j.campaign))
      .map((j) => `${j.jobId} («${j.campaign}»)`),
    ...view.unresolved.filter((i) => foreign(i.campaign)).map((i) => `без номера («${i.campaign}», ${i.at})`),
  ];
}

export async function runGenerate(opts: GenerateOptions, deps: GenerateDeps): Promise<GenerateSummary> {
  const budgetMilli = assertSpendAllowed(opts);
  const { runCli, log } = deps;
  const campaign = opts.jobs.campaign;
  const maxJobs = opts.maxJobs ?? Number.POSITIVE_INFINITY;
  mkdirSync(path.dirname(opts.ledgerFile), { recursive: true });
  mkdirSync(opts.mastersDir, { recursive: true });
  const overlayDir = opts.overlayDir ?? null;
  const overlayLedger = overlayDir === null ? null : path.join(overlayDir, OVERLAY_LEDGER);
  /** the run writes into the overlay ledger itself (the parent's prefetch): intent lines, as the server's */
  const intents = overlayLedger !== null && path.resolve(opts.ledgerFile) === path.resolve(overlayLedger);
  const waitMs = opts.lockWaitMs ?? 0;
  const release =
    overlayDir === null
      ? lockLedger(opts.ledgerFile)
      : await lockLedger(opts.ledgerFile, {
          globalDir: overlayDir,
          waitMs,
          sleep: deps.sleep,
          onWait: (holder, lock) => log(`замок ${lock} занят${holder > 0 ? ` (pid ${holder})` : ''} — наверное, сервер записывает фразу; жду до ${Math.round(waitMs / 1000)} с`),
        });
  try {
    const initial = readOnDemandLines(opts.ledgerFile);
    if (initial.broken > 0) log(`внимание: в журнале ${initial.broken} повреждённых строк (обрыв записи?) — они пропущены`);
    const lines: OnDemandLine[] = [...initial.lines];
    let od: OnDemandView = onDemandViewOf(lines);
    let view: LedgerView = od.ledger;
    const run = deps.now().toISOString();
    const at = () => deps.now().toISOString();
    /** ids of the jobs this run created itself, adopted from the provider's list, and the charges recorded in it */
    const createdHere = new Set<string>();
    const adoptedHere = new Set<string>();
    const chargedHere = new Set<string>();

    const summary: GenerateSummary = {
      campaign,
      budgetMilli,
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
      stop: 'done',
      chargedJobIds: [],
      balanceBeforeMilli: 0,
      balanceAfterMilli: null,
      audit: null,
    };
    /** Every line of this run goes through here (the primitives of ./ondemand.ts too): file (fsync), view, counters. */
    const record = (line: OnDemandLine) => {
      appendLedgerLine(opts.ledgerFile, line);
      lines.push(line);
      od = onDemandViewOf(lines);
      view = od.ledger;
      if (line.ev === 'created') {
        if (line.adopted === true) {
          adoptedHere.add(line.jobId);
          summary.adopted++;
        } else {
          createdHere.add(line.jobId);
          summary.created++;
        }
      }
    };
    /** job keys of unresolved intents of this ledger (only the overlay ledger has intents) */
    const openKeys = (): Set<string> => new Set(od.unresolved.map((i) => i.key));
    /** the campaign's spend: charged + pending at full price, plus its unresolved intents at full price (S1) */
    const spent = (): number => spentMilli(view, campaign) + od.unresolved.filter((i) => i.campaign === campaign).reduce((n, i) => n + i.milli, 0);

    /** job ids another ledger owns: never adopted (the overlay's when writing the tools ledger, and the other way round) */
    const knownJobIds = new Set<string>();
    for (const file of [...(opts.otherLedgers ?? []), ...(overlayLedger !== null && !intents ? [overlayLedger] : [])]) {
      if (path.resolve(file) === path.resolve(opts.ledgerFile)) continue;
      for (const line of readOnDemandLines(file).lines) if (line.ev === 'created') knownJobIds.add(line.jobId);
    }

    // S7. A server job in flight: its debit or refund would land inside this run's balance audit.
    if (overlayLedger !== null && overlayDir !== null) {
      const busyNow = (): string[] => overlayBusy(intents ? od : readOnDemandLedger(overlayLedger), intents ? campaign : null);
      let busy = busyNow();
      if (busy.length > 0 && opts.resumeServerJobs === true) {
        // adopting into the overlay ledger never takes a job this run's own (tools) ledger already owns
        const ownIds = intents ? [] : readOnDemandLines(opts.ledgerFile).lines.flatMap((l) => (l.ev === 'created' ? [l.jobId] : []));
        await resumeForeignJobs({ overlayDir, overlayLedger, own: intents ? campaign : null, append: intents ? record : null, run, knownJobIds: new Set([...knownJobIds, ...ownIds]) }, deps);
        busy = busyNow();
      }
      if (busy.length > 0) {
        throw new SpendRefused(
          `сервер ещё ждёт ${busy.length === 1 ? 'задание' : `задания (${busy.length})`} ${busy.slice(0, 3).join(', ')} в ${overlayLedger} — его списание или возврат попали бы в сверку баланса этого запуска. ` +
            (opts.resumeServerJobs === true
              ? 'Довести их сейчас не удалось (Higgsfield не ответил или задание ещё идёт) — повторите через несколько минут.'
              : 'Сервер доводит свои задания сам, только пока дозапись включена (GAMBIT_CLIP_GEN=1, CLIP_GEN_BUDGET и переключатель родителя в настройках) — включите её и запустите сервер или подождите. Иначе добавьте --resume-server-jobs: этот запуск сам бесплатно дождётся и скачает их.'),
          'server-busy',
        );
      }
    }

    // 7 (of the previous run). A balance that did not match the ledger stops everything until the parent has looked.
    const blocked = auditBlocked(view);
    if (blocked) {
      if (opts.acceptAudit !== true) {
        throw new SpendRefused(
          `после прошлого запуска баланс Higgsfield не сошёлся с журналом (списано ${fmtCredits(blocked.deltaMilli ?? 0)} кр., по журналу ${fmtCredits(blocked.minMilli ?? 0)}–${fmtCredits(blocked.maxMilli ?? 0)}) — проверьте историю списаний; продолжить можно только с --accept-audit`,
          'audit',
        );
      }
      record({ ev: 'audit', at: at(), run, ok: true, accepted: true });
      log('расхождение баланса прошлого запуска принято владельцем (--accept-audit)');
    }

    // 3. Pre-flight: balance and model params.
    const balance = await accountMilli(runCli);
    summary.balanceBeforeMilli = balance;
    record({ ev: 'balance', at: at(), run, when: 'before', milli: balance });
    const modelIssue = await modelProblem(runCli);
    if (modelIssue !== null) throw new SpendRefused(`модель изменилась: ${modelIssue} — цены и рецепты надо перепроверить`, 'model');

    const close = async (): Promise<GenerateSummary> => {
      summary.spentMilli = spent();
      summary.todoLeft = todoJobs(opts.jobs, view, openKeys()).length;
      try {
        summary.balanceAfterMilli = await accountMilli(runCli);
        record({ ev: 'balance', at: at(), run, when: 'after', milli: summary.balanceAfterMilli });
      } catch (err) {
        log(`баланс после запуска не прочитан: ${err instanceof CliError ? err.message : String(err)}`);
      }
      if (summary.balanceAfterMilli !== null) {
        // the provider may debit at create (then every job created here counts, failed ones until their refund) or at
        // completion (then every charge recorded here counts, a resumed job's too): the fall must lie between
        let minMilli = 0;
        let maxMilli = 0;
        for (const job of view.jobs.values()) {
          const mine = createdHere.has(job.jobId);
          const charged = chargedHere.has(job.jobId);
          if (mine && charged) minMilli += job.milli;
          if (mine || charged || adoptedHere.has(job.jobId)) maxMilli += job.milli;
        }
        // a create of this run whose job is still unresolved (the CLI gave no id and the list did not show it yet) may
        // have been made and debited: it belongs to the upper bound too (else a «exit 0, no job id» create of our own
        // reads as a mismatch)
        for (const intent of od.unresolved) if (intent.run === run) maxMilli += intent.milli;
        const deltaMilli = summary.balanceBeforeMilli - summary.balanceAfterMilli;
        const ok = deltaMilli >= minMilli - AUDIT_EPS_MILLI && deltaMilli <= maxMilli + AUDIT_EPS_MILLI;
        summary.audit = { ok, deltaMilli, minMilli, maxMilli };
        record({ ev: 'audit', at: at(), run, ok, deltaMilli, minMilli, maxMilli });
        if (!ok) {
          log(`ВНИМАНИЕ: баланс упал на ${fmtCredits(deltaMilli)} кр., а по журналу этого запуска — ${fmtCredits(minMilli)}–${fmtCredits(maxMilli)}. Следующие запуски остановлены до проверки (--accept-audit).`);
        }
      }
      return summary;
    };

    const download = async (job: LedgerJob, urlHint?: string): Promise<boolean> => {
      const ok = await downloadJob({ ledgerFile: opts.ledgerFile, mastersDir: opts.mastersDir, run, job, ...(urlHint !== undefined ? { urlHint } : {}), append: record }, deps);
      if (ok) summary.downloaded++;
      return ok;
    };

    /** Polls one job to its end. Returns false when the run must stop (the job stays pending in the ledger). */
    const finish = async (job: LedgerJob): Promise<boolean> => {
      for (let attempt = 1; attempt <= MAX_CREATE_TRIES; attempt++) {
        const result = await runCli(waitArgs(job.jobId));
        if (isRateLimited(result)) {
          summary.rateLimited++;
          await deps.sleep(backoffMs(attempt, deps.random));
          continue;
        }
        // waiting is free: a 5xx or a dropped connection is waited out instead of stopping the whole run
        if (isTransient(result) && attempt < MAX_CREATE_TRIES) {
          const delay = backoffMs(attempt, deps.random);
          log(`Higgsfield временно недоступен (${firstLine(result.stderr)}) — жду ${Math.round(delay / 1000)} с и снова спрашиваю про ${job.jobId}`);
          await deps.sleep(delay);
          continue;
        }
        const hf = result.code === 0 ? parseJobs(result.stdout).find((j) => j.id === job.jobId) : undefined;
        if (hf === undefined) {
          record({ ev: 'error', at: at(), run, key: job.key, jobId: job.jobId, stage: 'wait', message: firstLine(result.stderr) || `exit ${result.code}` });
          log(`ожидание ${job.jobId} не удалось — задание осталось в журнале, следующий запуск его дождётся`);
          return false;
        }
        if (hf.status === DONE_OK && hf.resultUrl !== null) {
          record({ ev: 'charged', at: at(), key: job.key, jobId: job.jobId, campaign: job.campaign, milli: job.milli, status: hf.status, resultUrl: hf.resultUrl });
          chargedHere.add(job.jobId);
          summary.charged++;
          summary.chargedJobIds.push(job.jobId);
          const charged = view.jobs.get(job.jobId);
          if (charged) await download(charged, hf.resultUrl);
          return true;
        }
        if (DONE_FAILED.has(hf.status)) {
          record({ ev: 'failed', at: at(), key: job.key, jobId: job.jobId, campaign: job.campaign, status: hf.status });
          summary.failed++;
          log(`задание ${job.jobId} завершилось со статусом ${hf.status} (без списания)`);
          return true;
        }
        record({ ev: 'error', at: at(), run, key: job.key, jobId: job.jobId, stage: 'wait', message: `still ${hf.status} after wait` });
        return false;
      }
      log(`ожидание ${job.jobId}: лимит запросов не отпустил — задание осталось в журнале`);
      return false;
    };

    // 4. Resume: an intent a crash left open is looked up first (the overlay); pending jobs are waited for, never
    //    re-created; charged ones without a master are downloaded.
    if (intents && od.unresolved.length > 0) await adoptIntents({ ledgerFile: opts.ledgerFile, run, knownJobIds, append: record }, deps);
    for (const job of pendingJobs(view)) {
      summary.resumed++;
      log(`продолжаю задание из журнала ${job.jobId} (${job.campaign})`);
      if (!(await finish(job))) {
        summary.stop = 'wait-error';
        return await close();
      }
    }
    for (const job of view.jobs.values()) {
      if (job.state === 'charged' && job.master === undefined) await download(job);
    }

    // 5. Todo, budget, balance, pricing.
    const todo = todoJobs(opts.jobs, view, openKeys());
    const remaining = budgetMilli - spent();
    const todoMilli = todo.reduce((sum, job) => sum + jobMilli(job.prompt), 0);
    const cap = Number.isFinite(maxJobs) ? todo.slice(0, maxJobs).reduce((sum, job) => sum + jobMilli(job.prompt), 0) : todoMilli;
    const need = Math.min(remaining, cap);
    if (todo.length > 0 && maxJobs > 0 && need > balance) {
      throw new SpendRefused(`на счёте ${fmtCredits(balance)} кр., а запуск может потратить до ${fmtCredits(need)} — пополните счёт или уменьшите --budget`, 'balance');
    }
    /** the server's own price of a prompt (free), asked once per prompt; null = it differs from ours */
    const priced = new Map<string, number>();
    const priceProblem = async (prompt: string): Promise<string | null> => {
      const server = priced.get(prompt) ?? (await serverCostMilli(runCli, prompt));
      priced.set(prompt, server);
      const ours = jobMilli(prompt);
      return server === ours ? null : `цена изменилась: Higgsfield просит ${fmtCredits(server)} кр. за задание, по SPEC ${fmtCredits(ours)} — остановка`;
    };
    /**
     * The price check, and a Higgsfield that did not answer it (a 5xx, a dropped connection): nothing is created, the
     * run ends cleanly — balance read, audit written — as a create error a caller may retry (an unanswered
     * `generate cost` must not throw out of the run with jobs in flight).
     */
    const askPrice = async (prompt: string): Promise<{ problem: string | null } | { unreachable: string }> => {
      try {
        return { problem: await priceProblem(prompt) };
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        return { unreachable: `${error.message}${error.result ? `: ${firstLine(error.result.stderr)}` : ''}` };
      }
    };
    if (todo.length > 0 && maxJobs > 0 && remaining >= jobMilli(todo[0]!.prompt)) {
      const asked = await askPrice(todo[0]!.prompt);
      if ('unreachable' in asked) {
        log(`Higgsfield не ответил на вопрос о цене (${asked.unreachable}) — ничего не создано`);
        record({ ev: 'error', at: at(), run, key: keyOfJob(todo[0]!), stage: 'create', message: `cost: ${asked.unreachable}` });
        summary.stop = 'create-error';
        summary.createFailure = 'error';
        return await close();
      }
      if (asked.problem !== null) throw new SpendRefused(asked.problem, 'price');
    }

    // 6. One job at a time.
    let listCache: HfJob[] | null = null;
    const listed = async (fresh: boolean): Promise<HfJob[]> => {
      if (listCache === null || fresh) {
        const result = await runCli(listArgs(LIST_PAGE_SIZE));
        listCache = result.code === 0 ? parseJobs(result.stdout) : [];
      }
      return listCache;
    };
    /** An un-ledgered job with exactly this prompt in our voice (a create that did happen after all). */
    const orphan = async (prompt: string, fresh: boolean): Promise<HfJob | undefined> =>
      (await listed(fresh)).find((j) => j.prompt === prompt && isOurVoice(j) && !view.jobs.has(j.id) && !knownJobIds.has(j.id) && !DONE_FAILED.has(j.status));

    // jobs created (or adopted) by this loop that are still being waited for (`inFlight` > 1 only)
    const inFlight = Math.max(1, Math.floor(opts.inFlight ?? 1));
    const running = new Set<Promise<void>>();
    let waitFailed = false;
    let thrown: { error: unknown } | null = null;
    const track = (work: Promise<boolean>): void => {
      const tracked: Promise<void> = work
        .then(
          (ok) => {
            if (!ok) waitFailed = true;
          },
          (error: unknown) => {
            waitFailed = true;
            thrown ??= { error };
          },
        )
        .finally(() => running.delete(tracked));
      running.add(tracked);
    };

    try {
      for (const job of todo) {
        if (waitFailed) {
          summary.stop = 'wait-error';
          break;
        }
        const key = keyOfJob(job);
        const price = jobMilli(job.prompt);
        if (spent() + price > budgetMilli) {
          summary.stop = 'budget';
          break;
        }
        if (summary.created >= maxJobs) {
          summary.stop = 'max-jobs';
          break;
        }
        if (opts.shouldStop?.() === true) {
          summary.stop = 'interrupted';
          break;
        }

        let jobId: string | null = null;
        const existing = await orphan(job.prompt, false);
        if (existing) {
          record({ ev: 'created', at: at(), run, campaign, key, jobId: existing.id, milli: price, job, adopted: true });
          log(`нашёл уже созданное задание ${existing.id} с тем же текстом — беру его, новое не создаю`);
          jobId = existing.id;
        }
        // dedup by unit, under the locks, right before the create: the server may have recorded a piece of this job since
        // the plan was made — in another prompt, so the job key above could not see it. Into the overlay (the prefetch)
        // and for a static campaign alike: the server records catalogue sentences under the static library's keys too
        if (jobId === null && opts.unitCovered !== undefined) {
          const overlayView = intents || overlayLedger === null ? od : readOnDemandLedger(overlayLedger);
          const covered = job.pieces.flatMap((p) => {
            if (isDiscard(p)) return [];
            const why = opts.unitCovered?.(p, overlayView) ?? null;
            return why === null ? [] : [`«${p.text}» ${why}`];
          });
          if (covered.length > 0) {
            summary.skipped++;
            const rebuild = opts.rebuildHint ?? (intents ? 'pnpm teach:report --prefetch-plan … --overlay …' : `pnpm voice:plan --tier ${campaign}`);
            log(`пропускаю задание «${job.prompt}»: ${covered.join('; ')} — план устарел, соберите его заново (${rebuild})`);
            continue;
          }
        }
        // every job is priced by the server right before its create: the budget and the ledger count the SPEC price
        if (jobId === null) {
          const asked = await askPrice(job.prompt);
          if ('unreachable' in asked) {
            log(`Higgsfield не ответил на вопрос о цене (${asked.unreachable}) — задание не создано`);
            record({ ev: 'error', at: at(), run, key, stage: 'create', message: `cost: ${asked.unreachable}` });
            summary.stop = 'create-error';
            summary.createFailure = 'error';
            break;
          }
          const problem = asked.problem;
          if (problem !== null) {
            log(problem);
            record({ ev: 'error', at: at(), run, key, stage: 'create', message: problem });
            summary.stop = 'price';
            break;
          }
        }
        if (jobId === null) {
          // intent (overlay) → create → parse / get / list → `created`; rate limits backed off with a look before every retry
          const outcome = await createJob(
            { ledgerFile: opts.ledgerFile, campaign, run, job, milli: price, knownJobIds, intent: intents, append: record, onRateLimit: () => void summary.rateLimited++ },
            deps,
          );
          if (!outcome.ok) {
            summary.stop = outcome.reason === 'rate' ? 'rate-limit' : 'create-error';
            summary.createFailure = outcome.reason;
            if (outcome.reason === 'no-credits') log('на счёте Higgsfield не хватает кредитов — остановка');
            else if (outcome.reason === 'login') log('вход в Higgsfield истёк — выполните `higgsfield auth login` и повторите');
            else if (outcome.reason === 'unresolved') log('создалось ли задание, неясно — следующий запуск сначала посмотрит список Higgsfield (пока оно считается потраченным)');
            break;
          }
          jobId = outcome.jobId;
          // (the CLI's create output carries no id: the job this create made is read back from `generate list` — the
          // normal way, not a second job; `createJob` logs a real adoption itself)
        }
        const ledgered = view.jobs.get(jobId);
        if (ledgered === undefined) continue;
        if (inFlight === 1) {
          if (!(await finish(ledgered))) {
            summary.stop = 'wait-error';
            break;
          }
          continue;
        }
        track(finish(ledgered));
        while (running.size >= inFlight) await Promise.race(running);
      }
    } catch (error) {
      // anything unexpected: the jobs in flight still end in the ledger before this run lets go of its locks
      while (running.size > 0) await Promise.race(running);
      throw error;
    }
    // every job in flight ends in the ledger (charged, failed or left pending) before the balance is read
    while (running.size > 0) await Promise.race(running);
    if (thrown !== null) throw (thrown as { error: unknown }).error;
    // a job left pending outweighs a plain end of the loop (the next run must wait for it first)
    if (waitFailed && (summary.stop === 'done' || summary.stop === 'max-jobs' || summary.stop === 'interrupted' || summary.stop === 'budget')) summary.stop = 'wait-error';
    return await close();
  } finally {
    release();
  }
}

/** `generate wait` for one job (free): a rate limit or a 5xx is waited out; null = no answer about it. */
async function waitFree(jobId: string, deps: GenerateDeps): Promise<HfJob | null> {
  for (let attempt = 1; attempt <= MAX_CREATE_TRIES; attempt++) {
    const result = await deps.runCli(waitArgs(jobId));
    if (isRateLimited(result) || (isTransient(result) && attempt < MAX_CREATE_TRIES)) {
      await deps.sleep(backoffMs(attempt, deps.random));
      continue;
    }
    return result.code === 0 ? (parseJobs(result.stdout).find((j) => j.id === jobId) ?? null) : null;
  }
  return null;
}

/**
 * `--resume-server-jobs` (S7 without the server): the overlay ledger's jobs of other campaigns that are still in flight
 * are brought home by this run, for free, BEFORE it reads the balance — so their debits and refunds land before its
 * audit window. Unresolved intents are looked up in `generate list` (adopted or `absent`), pending jobs waited for
 * (`charged` / `failed`), and a charged master downloaded into `<overlay>/.masters`; the server's next finish (or the
 * parent's `voice:process --overlay`) publishes it. Needed when the server may not resume them itself: recording switched
 * off by the parent, GAMBIT_CLIP_GEN=0, no CLIP_GEN_BUDGET. The lines go into the overlay ledger under its own lock
 * (the server takes it too), or through `append` when this run writes that ledger itself (its lock is held already).
 */
async function resumeForeignJobs(
  o: { overlayDir: string; overlayLedger: string; own: string | null; append: ((line: OnDemandLine) => void) | null; run: string; knownJobIds: ReadonlySet<string> },
  deps: GenerateDeps,
): Promise<void> {
  const release = o.append === null ? lockLedger(o.overlayLedger) : () => undefined;
  const append = o.append ?? ((line: OnDemandLine) => appendLedgerLine(o.overlayLedger, line));
  const foreign = (campaign: string): boolean => o.own === null || campaign !== o.own;
  const at = (): string => deps.now().toISOString();
  try {
    if (readOnDemandLedger(o.overlayLedger).unresolved.some((i) => foreign(i.campaign))) {
      await adoptIntents({ ledgerFile: o.overlayLedger, run: o.run, knownJobIds: o.knownJobIds, append }, deps);
    }
    for (const job of pendingJobs(readOnDemandLedger(o.overlayLedger).ledger).filter((j) => foreign(j.campaign))) {
      deps.log(`довожу задание сервера ${job.jobId} («${job.campaign}») — бесплатно: жду его и скачиваю запись`);
      const hf = await waitFree(job.jobId, deps);
      if (hf === null) {
        append({ ev: 'error', at: at(), run: o.run, key: job.key, jobId: job.jobId, stage: 'wait', message: 'no answer while resuming a server job' });
      } else if (hf.status === DONE_OK && hf.resultUrl !== null) {
        append({ ev: 'charged', at: at(), key: job.key, jobId: job.jobId, campaign: job.campaign, milli: job.milli, status: hf.status, resultUrl: hf.resultUrl });
        const charged = readOnDemandLedger(o.overlayLedger).ledger.jobs.get(job.jobId);
        if (charged) await downloadJob({ ledgerFile: o.overlayLedger, mastersDir: overlayPaths(o.overlayDir).mastersDir, run: o.run, job: charged, urlHint: hf.resultUrl, append }, deps);
      } else if (DONE_FAILED.has(hf.status)) {
        append({ ev: 'failed', at: at(), key: job.key, jobId: job.jobId, campaign: job.campaign, status: hf.status });
      }
    }
  } finally {
    release();
  }
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find((l) => l !== '')?.slice(0, 300) ?? '';
}

/** The real downloader: fetch → check it is an MP3 → tmp file → rename. */
export async function downloadMaster(url: string, dest: string): Promise<DownloadResult> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!looksLikeMp3(bytes)) throw new Error(`download is not an MP3 (${bytes.length} bytes)`);
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.part`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, dest);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function looksLikeMp3(bytes: Uint8Array): boolean {
  if (bytes.length < 256) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // «ID3»
  return bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0; // MPEG frame sync
}
