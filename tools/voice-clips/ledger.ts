/**
 * The generation ledger `ledger.<voiceKey>.jsonl` (committed): one JSON line per event of a paid job, appended and
 * fsync'ed BEFORE the tool waits for anything, so a crash at any point can be resumed without paying twice.
 *
 *   created     a job exists at Higgsfield (written right after `generate create` returned its id, or when an
 *               un-ledgered identical job was found in `generate list` and adopted)
 *   charged     the job completed; `credits` is what it cost (the SPEC price of its prompt)
 *   failed      the job ended without audio (not charged: credits 0)
 *   downloaded  the master MP3 is on disk under `.masters/`
 *   error       a `create` that made no job (nothing charged) or a download that failed; informational
 *   balance     the account balance read before / after a run (audit trail; no e-mail, no ids)
 *   audit       after a run: did the balance fall by what the ledger says this run was charged? A failed audit
 *               stops every later run until the operator has looked and passes `--accept-audit` (a line `accepted`)
 *
 * The overlay ledger of «Дозапись голоса» (./ondemand.ts) adds `intent` (written before a create) and `absent` lines;
 * the readers here skip them, so the tools read either ledger.
 *
 * Budget accounting is conservative: a `created` job without a terminal line counts at its full price.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GLOBAL_LOCK, LOCK_POLL_MS } from './config.ts';
import type { GenJob } from './jobs.ts';

export interface CreatedLine {
  ev: 'created';
  at: string;
  run: string;
  campaign: string;
  key: string;
  jobId: string;
  milli: number;
  job: GenJob;
  adopted?: true;
  /** «Дозапись голоса» (./ondemand.ts): how the id was learned — the create output, a `generate get` confirmation, the list */
  via?: 'parse' | 'get' | 'list';
  /** the create output's key skeleton, values masked (`{job_set_id:str,job_ids:[str]}`): reveals the real shape for free */
  createShape?: string;
}

export interface ChargedLine {
  ev: 'charged';
  at: string;
  key: string;
  jobId: string;
  campaign: string;
  milli: number;
  status: string;
  resultUrl: string;
}

export interface FailedLine {
  ev: 'failed';
  at: string;
  key: string;
  jobId: string;
  campaign: string;
  status: string;
}

export interface DownloadedLine {
  ev: 'downloaded';
  at: string;
  key: string;
  jobId: string;
  master: string;
  bytes: number;
  sha256: string;
}

export interface ErrorLine {
  ev: 'error';
  at: string;
  run: string;
  key: string;
  jobId?: string;
  stage: 'create' | 'wait' | 'download';
  message: string;
}

export interface BalanceLine {
  ev: 'balance';
  at: string;
  run: string;
  when: 'before' | 'after';
  milli: number;
}

export interface AuditLine {
  ev: 'audit';
  at: string;
  run: string;
  ok: boolean;
  /** how much the balance fell during the run */
  deltaMilli?: number;
  /** what the ledger allows it to have fallen by (charged ↔ created in the run, both debit models of the provider) */
  minMilli?: number;
  maxMilli?: number;
  /** the operator looked at a failed audit and let the runs go on (`--accept-audit`) */
  accepted?: true;
}

export type LedgerLine = CreatedLine | ChargedLine | FailedLine | DownloadedLine | ErrorLine | BalanceLine | AuditLine;

/** The last audit of the ledger failed and nobody accepted it: no new run may spend. */
export function auditBlocked(view: Pick<LedgerView, 'lines'>): AuditLine | null {
  for (let i = view.lines.length - 1; i >= 0; i--) {
    const line = view.lines[i] as LedgerLine;
    if (line.ev === 'audit') return line.ok ? null : line;
  }
  return null;
}

export type JobState = 'pending' | 'charged' | 'failed';

/** Everything the ledger knows about one Higgsfield job. */
export interface LedgerJob {
  jobId: string;
  key: string;
  campaign: string;
  job: GenJob;
  milli: number;
  state: JobState;
  resultUrl?: string;
  master?: string;
  adopted: boolean;
  createdAt: string;
}

export interface LedgerView {
  lines: LedgerLine[];
  /** Lines that could not be parsed (a crash mid-append leaves at most one). */
  broken: number;
  jobs: Map<string, LedgerJob>;
  /** job key → job ids, in ledger order. */
  byKey: Map<string, string[]>;
}

export function readLedger(file: string): LedgerView {
  const lines: LedgerLine[] = [];
  let broken = 0;
  if (existsSync(file)) {
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (raw.trim() === '') continue;
      try {
        const line = JSON.parse(raw) as LedgerLine;
        if (typeof line === 'object' && line !== null && typeof line.ev === 'string') lines.push(line);
        else broken++;
      } catch {
        broken++;
      }
    }
  }
  return viewOf(lines, broken);
}

export function viewOf(lines: LedgerLine[], broken = 0): LedgerView {
  const jobs = new Map<string, LedgerJob>();
  const byKey = new Map<string, string[]>();
  for (const line of lines) {
    if (line.ev === 'created') {
      if (jobs.has(line.jobId)) continue;
      jobs.set(line.jobId, {
        jobId: line.jobId,
        key: line.key,
        campaign: line.campaign,
        job: line.job,
        milli: line.milli,
        state: 'pending',
        adopted: line.adopted === true,
        createdAt: line.at,
      });
      byKey.set(line.key, [...(byKey.get(line.key) ?? []), line.jobId]);
    } else if (line.ev === 'charged') {
      const job = jobs.get(line.jobId);
      if (job) {
        job.state = 'charged';
        job.milli = line.milli;
        job.resultUrl = line.resultUrl;
      }
    } else if (line.ev === 'failed') {
      const job = jobs.get(line.jobId);
      if (job) job.state = 'failed';
    } else if (line.ev === 'downloaded') {
      const job = jobs.get(line.jobId);
      if (job) job.master = line.master;
    }
  }
  return { lines, broken, jobs, byKey };
}

/** Credits a campaign has used: charged jobs at their price plus pending ones at their full price (conservative). */
export function spentMilli(view: LedgerView, campaign: string): number {
  let milli = 0;
  for (const job of view.jobs.values()) {
    if (job.campaign !== campaign) continue;
    if (job.state === 'charged' || job.state === 'pending') milli += job.milli;
  }
  return milli;
}

export function pendingJobs(view: LedgerView): LedgerJob[] {
  return [...view.jobs.values()].filter((job) => job.state === 'pending');
}

export function jobsOfKey(view: LedgerView, key: string): LedgerJob[] {
  return (view.byKey.get(key) ?? []).map((id) => view.jobs.get(id)).filter((job): job is LedgerJob => job !== undefined);
}

/** True when the file is non-empty and does not end with a newline (a crash cut the last line short). */
function endsMidLine(file: string): boolean {
  if (!existsSync(file)) return false;
  const size = statSync(file).size;
  if (size === 0) return false;
  const fd = openSync(file, 'r');
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** Appends one line (on a fresh line, even after a torn write) and forces it to disk before returning. */
export function appendLedger(file: string, line: LedgerLine): void {
  appendLedgerLine(file, line);
}

/**
 * `appendLedger` for any ledger line, the on-demand ones too (`intent` / `absent`, ./ondemand.ts): the tools' own
 * readers skip line types they do not know, so both kinds share one file and one fsync discipline.
 */
export function appendLedgerLine<L extends { ev: string }>(file: string, line: L): void {
  appendFileSync(file, `${endsMidLine(file) ? '\n' : ''}${JSON.stringify(line)}\n`, 'utf8');
  const fd = openSync(file, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class LedgerLocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerLocked';
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock file without a readable pid is held this long (an older writer between its create and its write). */
export const LOCK_UNREADABLE_GRACE_MS = 5_000;

/**
 * Creates `file` holding this process's pid, atomically: the pid goes into a private temp file first, which is then
 * hard-linked into place (`link` fails when the name exists). A reader never sees the file empty. Returns the file's
 * inode (the release checks it), or null when the name is taken.
 */
function createPidFile(file: string): number | null {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, String(process.pid), { flag: 'wx' });
  try {
    const ino = statSync(tmp).ino;
    linkSync(tmp, file);
    return ino;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
}

type Holder = { state: 'gone' } | { state: 'alive'; pid: number } | { state: 'young' } | { state: 'stale'; ino: number };

/** Who holds a pid file: its content and inode read through ONE descriptor, so both belong to the same file. */
function holderOf(file: string): Holder {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { state: 'gone' };
  }
  try {
    const st = fstatSync(fd);
    const pid = Number(readFileSync(fd, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) return pidAlive(pid) ? { state: 'alive', pid } : { state: 'stale', ino: st.ino };
    return Date.now() - st.mtimeMs < LOCK_UNREADABLE_GRACE_MS ? { state: 'young' } : { state: 'stale', ino: st.ino };
  } finally {
    closeSync(fd);
  }
}

/** Removes `file` only while it is still the one with inode `ino` holding our pid (never someone else's lock). */
function unlinkIfMine(file: string, ino: number): void {
  const now = holderOf(file);
  if (now.state !== 'alive' || now.pid !== process.pid) return;
  try {
    if (statSync(file).ino === ino) unlinkSync(file);
  } catch {
    // already gone
  }
}

/**
 * Takes a stale lock away under a small takeover lock `<lock>.takeover` (created the same way): its holder looks at
 * the lock AGAIN and removes it only while it is still the same stale file. Without it, two processes that both saw
 * the same dead pid could each remove "the" lock — the second one the lock the first had just created — and both
 * would believe they hold it. false = another process is taking it over right now (the caller answers «held»).
 */
function takeOverStale(lock: string, staleIno: number): boolean {
  const mutex = `${lock}.takeover`;
  const mine = createPidFile(mutex);
  if (mine === null) {
    // a takeover lock left by a process that died inside those few microseconds is removed; the next try goes on
    if (holderOf(mutex).state === 'stale') {
      try {
        unlinkSync(mutex);
      } catch {
        // someone else removed it
      }
    }
    return false;
  }
  try {
    const again = holderOf(lock);
    if (again.state === 'stale' && again.ino === staleIno) unlinkSync(lock);
    return true;
  } finally {
    unlinkIfMine(mutex, mine);
  }
}

export interface TryLockHooks {
  /** tests: runs after a stale holder was seen and before it is taken over (another process may act in between) */
  onStale?: () => void;
}

/**
 * One try at a pid lock file: the release function, or the pid of the live process holding it (0 = unknown). The file
 * appears with its pid already inside (`createPidFile`); a lock left by a dead process is taken over (`takeOverStale`);
 * a file without a pid is held for a few seconds (its writer may be between create and write); the release removes
 * the file only while it is still ours. The protocol of every generator lock (ledger, machine-wide, publish).
 */
export function tryLock(lock: string, hooks: TryLockHooks = {}): { release: () => void } | { holder: number } {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ino = createPidFile(lock);
    if (ino !== null) return { release: () => unlinkIfMine(lock, ino) };
    const holder = holderOf(lock);
    if (holder.state === 'gone') continue; // released between our two calls: try again
    if (holder.state === 'alive') return { holder: holder.pid };
    if (holder.state === 'young') return { holder: 0 };
    hooks.onStale?.();
    if (!takeOverStale(lock, holder.ino)) return { holder: 0 };
  }
  return { holder: 0 };
}

export interface LockWait {
  /** wait up to this long for a held lock (0 = fail at once) */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** told once when the lock is held and the caller has to wait */
  onWait?: (holder: number, lock: string) => void;
}

/**
 * Takes a pid lock, waiting up to `waitMs` (counted in the sleeps asked for, so a fake sleep makes it instant and
 * deterministic). Rejects with `LedgerLocked` when it stays held.
 */
export async function acquireLock(lock: string, o: LockWait & { held: (holder: number) => string }): Promise<() => void> {
  const waitMs = Math.max(0, o.waitMs ?? 0);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let told = false;
  for (let waited = 0; ; waited += LOCK_POLL_MS) {
    const got = tryLock(lock);
    if ('release' in got) return got.release;
    if (waited >= waitMs) throw new LedgerLocked(o.held(got.holder));
    if (!told) {
      o.onWait?.(got.holder, lock);
      told = true;
    }
    await sleep(LOCK_POLL_MS);
  }
}

function ledgerHeld(file: string): (holder: number) => string {
  return (holder) => (holder > 0 ? `another generator (pid ${holder}) is using ${file}; concurrency is 1` : `cannot lock ${file}`);
}

/**
 * The machine-wide generator lock `<dir>/higgsfield.lock` (the overlay folder, created 0700 when missing): every
 * generator on this Mac — the server's on-demand recorder and `voice:generate` in any checkout — holds it around its
 * paid calls, so they never overlap on the one Higgsfield account (a job of one would land inside the other's balance
 * audit). `waitMs` 0 (default) = fail at once.
 */
export async function lockGlobal(dir: string, o: LockWait = {}): Promise<() => void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, GLOBAL_LOCK);
  return acquireLock(lock, {
    ...o,
    held: (holder) =>
      `замок ${lock} держит другой генератор${holder > 0 ? ` (pid ${holder})` : ''}: сервер или другой voice:generate записывает голос тем же аккаунтом Higgsfield — повторите, когда он закончит`,
  });
}

export interface LockLedgerOptions extends LockWait {
  /** the overlay folder: its machine-wide lock (`lockGlobal`) is taken first and released last */
  globalDir?: string | null;
}

/**
 * One generator per ledger at a time (concurrency 1 across processes too): `<ledger>.lock` holds the pid. A lock left
 * by a dead process is taken over. Returns the release function.
 *
 * With options it is async: the machine-wide lock of `globalDir` first (so the tools and the server's on-demand
 * recorder never overlap), then the ledger lock, each waited for up to `waitMs`; the release frees both. Without
 * options it takes the ledger lock alone, at once (a caller that already holds `lockGlobal` — the server — uses this).
 */
export function lockLedger(file: string): () => void;
export function lockLedger(file: string, o: LockLedgerOptions): Promise<() => void>;
export function lockLedger(file: string, o?: LockLedgerOptions): (() => void) | Promise<() => void> {
  if (o === undefined) {
    const got = tryLock(`${file}.lock`);
    if ('release' in got) return got.release;
    throw new LedgerLocked(ledgerHeld(file)(got.holder));
  }
  return lockBoth(file, o);
}

async function lockBoth(file: string, o: LockLedgerOptions): Promise<() => void> {
  const releaseGlobal = o.globalDir ? await lockGlobal(o.globalDir, o) : null;
  try {
    const releaseLedger = await acquireLock(`${file}.lock`, { ...o, held: ledgerHeld(file) });
    return () => {
      releaseLedger();
      releaseGlobal?.();
    };
  } catch (err) {
    releaseGlobal?.();
    throw err;
  }
}
