/**
 * «Дозапись голоса» — the paid-protocol primitives shared by the server's on-demand recorder (apps/server/src/voiceGen,
 * through its bridge, the only server file that imports tools) and `voice:generate` (the parent's runs and prefetch).
 * Node-only, no side effects on import. Every call to Higgsfield goes through an injected `RunCli`; tests use a fake.
 *
 * The overlay ledger `<overlay>/ledger.giselle-mm1.jsonl` is the ONE on-demand ledger of this Mac (outside every
 * checkout). It keeps the tools' line types and adds two, both ignored by the tools' `viewOf`:
 *
 *   intent   written (fsync'ed) BEFORE `generate create`: from here until a `created` or `absent` line with the same
 *            job key, the job may exist and may have been debited — the budget counts it at full price
 *   absent   the create made no job after all (three fresh `generate list` checks found nothing)
 *
 * A `created` line may carry `via` (how the id was learned: the create output, a `generate get` confirmation, or list
 * adoption) and `createShape` (the create output's key skeleton, values masked: the next paid job reveals the real
 * shape of `generate create --json` at no extra cost).
 *
 * Create path (`createJob`): intent → create → parse widely (never `job_set_id`) → accept the id only when the output
 * carries our prompt or a free `generate get` confirms it → otherwise adopt from `generate list` (a job with exactly our
 * prompt and voice, unknown to both ledgers, created ≥ intent − 5 s) → `created`. Never re-create blindly. An intent
 * the create left open is resolved later by `adoptIntents` (adopted, or `absent` after three empty list checks).
 *
 * The same primitives run `voice:generate` (./generate.ts): on the committed tools ledger without intent lines, on the
 * overlay ledger (the parent's prefetch) with them. Every generator on this Mac
 * holds the machine-wide lock `<overlay>/higgsfield.lock` (`lockGlobal`, ./ledger.ts) around its paid calls.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BACKOFF_FIRST_MS, BACKOFF_MAX_MS, LIST_PAGE_SIZE, MAX_CREATE_TRIES, VOICE_KEY } from './config.ts';
import type { DownloadResult } from './generate.ts';
import { DONE_FAILED, createArgs, getArgs, isJobId, isOurVoice, isRateLimited, listArgs, parseJobs } from './higgsfield.ts';
import type { CliResult, HfJob, RunCli } from './higgsfield.ts';
import { keyOfJob } from './jobs.ts';
import type { GenJob } from './jobs.ts';
import { appendLedgerLine, viewOf } from './ledger.ts';
import type { CreatedLine, LedgerJob, LedgerLine, LedgerView } from './ledger.ts';

// shared with the tools' own modules (one definition each): the wait arguments, the machine-wide lock
export { GLOBAL_LOCK, WAIT_INTERVAL } from './config.ts';
export { waitArgs } from './higgsfield.ts';
export { lockGlobal } from './ledger.ts';

// ── Constants ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The server's campaign in the overlay ledger. */
export const ONDEMAND_CAMPAIGN = 'ondemand';
/** The parent's paid prefetch run into the overlay (`voice:generate --campaign prefetch --ledger <overlay>/…`). */
export const PREFETCH_CAMPAIGN = 'prefetch';
/** On-demand takes start here, so their clip and job ids never collide with a static-library take of the same prompt. */
export const ONDEMAND_TAKE_BASE = 101;
/** Paid attempts per unit key, ever (the parent's `redo` verdict allows one more; `reject` blocks it). */
export const MAX_PAID_ATTEMPTS = 2;
/** The overlay ledger's file name (inside the overlay folder). */
export const OVERLAY_LEDGER = `ledger.${VOICE_KEY}.jsonl`;
/** List adoption accepts a job created at most this long before its intent (clock skew between us and the provider). */
export const ADOPT_SLACK_MS = 5_000;
/** An intent is `absent` only after this many fresh empty list checks … */
export const ABSENT_AFTER_CHECKS = 3;
/** … this far apart (jobs appear in the list 0–1.5 s after the create). */
export const ADOPT_CHECK_MS = 1_000;

// ── Ledger lines and the view ───────────────────────────────────────────────────────────────────────────────────────

export interface IntentLine {
  ev: 'intent';
  at: string;
  run: string;
  campaign: string;
  /** the job key (`keyOfJob(job)`) the `created` / `absent` line resolves it by */
  key: string;
  /** the SPEC price of `job.prompt` — counted in full while the intent is unresolved */
  milli: number;
  job: GenJob;
}

export interface AbsentLine {
  ev: 'absent';
  at: string;
  run: string;
  key: string;
  /** how many fresh list checks found nothing */
  checks: number;
}

/** How a created job's id was learned. */
export type CreateVia = 'parse' | 'get' | 'list';

export type OnDemandCreatedLine = CreatedLine & { via?: CreateVia; createShape?: string };

export type OnDemandLine = LedgerLine | OnDemandCreatedLine | IntentLine | AbsentLine;

export interface OnDemandView {
  /** the tools' view of the same lines (intent / absent lines ignored) */
  ledger: LedgerView;
  /** intents without a later `created` / `absent` line of their key, oldest first — each counts at full price */
  unresolved: IntentLine[];
}

/** The view of overlay-ledger lines: the tools' view plus the unresolved intents. */
export function onDemandViewOf(lines: readonly OnDemandLine[], broken = 0): OnDemandView {
  let open: IntentLine[] = [];
  for (const line of lines) {
    if (line.ev === 'intent') open.push(line);
    else if (line.ev === 'created' || line.ev === 'absent') {
      const key = line.key;
      open = open.filter((i) => i.key !== key);
    }
  }
  return { ledger: viewOf(lines.filter((l): l is LedgerLine => l.ev !== 'intent' && l.ev !== 'absent'), broken), unresolved: open };
}

/** The raw lines of a ledger (a missing file = none); a torn last line is counted as broken, like the tools' reader. */
export function readOnDemandLines(file: string): { lines: OnDemandLine[]; broken: number } {
  const lines: OnDemandLine[] = [];
  let broken = 0;
  if (existsSync(file)) {
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (raw.trim() === '') continue;
      try {
        const line = JSON.parse(raw) as OnDemandLine;
        if (typeof line === 'object' && line !== null && typeof line.ev === 'string') lines.push(line);
        else broken++;
      } catch {
        broken++;
      }
    }
  }
  return { lines, broken };
}

/** Reads an overlay ledger (a missing file = empty); a torn last line is counted as broken, like the tools' reader. */
export function readOnDemandLedger(file: string): OnDemandView {
  const { lines, broken } = readOnDemandLines(file);
  return onDemandViewOf(lines, broken);
}

/** Which unit a count is about: its key, and — when given — its current words and the twin keys that share them. */
export interface AttemptUnit {
  key: string;
  /** only pieces with exactly these words count (a take of older words under a shifted key is another unit) */
  text?: string;
  /** keys whose words are the same (`alsoKeysOf`): one take serves them all, so their attempts are shared */
  twins?: ReadonlySet<string>;
}

function jobHasUnit(job: GenJob, u: AttemptUnit): boolean {
  return job.pieces.some((p) => !('discard' in p) && (p.key === u.key || u.twins?.has(p.key) === true) && (u.text === undefined || p.text === u.text));
}

/**
 * Paid attempts at a unit: ledgered jobs holding it that did not fail (charged or still pending) plus unresolved
 * intents holding it. A failed job was not charged and does not count. With `text`, only pieces with exactly those
 * words count: when writers insert a wording, a key's number shifts to new words that were never recorded, and the
 * old words' attempts must not give them up. Compare with `MAX_PAID_ATTEMPTS` (+1 after the parent's `redo`, which
 * the caller reads from the review file).
 */
export function unitAttempts(view: OnDemandView, unit: string | AttemptUnit): number {
  const u = typeof unit === 'string' ? { key: unit } : unit;
  let n = 0;
  for (const job of view.ledger.jobs.values()) if (job.state !== 'failed' && jobHasUnit(job.job, u)) n++;
  for (const intent of view.unresolved) if (jobHasUnit(intent.job, u)) n++;
  return n;
}

/** The local day `YYYY-MM-DD` of a moment in an IANA time zone (default: this process's zone). */
export function localDay(at: Date | string, tz?: string): string {
  const date = typeof at === 'string' ? new Date(at) : at;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Spend by local day and in total (milli-credits), conservative (S1): charged jobs at their price, pending jobs and
 * unresolved intents at full price, failed jobs not at all. A job's day is the day of its `created` line, an intent's
 * the day of the intent. `campaign` undefined = every campaign.
 */
export function spentByDay(view: OnDemandView, tz?: string, campaign?: string): { days: Record<string, number>; totalMilli: number } {
  const days: Record<string, number> = {};
  let totalMilli = 0;
  const add = (at: string, milli: number): void => {
    const day = localDay(at, tz);
    days[day] = (days[day] ?? 0) + milli;
    totalMilli += milli;
  };
  for (const job of view.ledger.jobs.values()) {
    if (campaign !== undefined && job.campaign !== campaign) continue;
    if (job.state === 'charged' || job.state === 'pending') add(job.createdAt, job.milli);
  }
  for (const intent of view.unresolved) {
    if (campaign !== undefined && intent.campaign !== campaign) continue;
    add(intent.at, intent.milli);
  }
  return { days, totalMilli };
}

// ── Reading CLI output (pure) ───────────────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** What `generate create --json` told us: the job id (null = not certain), the prompt it echoed, its key skeleton. */
export interface ParsedCreate {
  jobId: string | null;
  /** the prompt the output carries for that job (`params.prompt` / `prompt`), null = none: confirm with `generate get` */
  prompt: string | null;
  /** the output's key skeleton, every value masked (`{job_set_id:str,job_ids:[str]}`), for the `created` line */
  shape: string;
}

const SHAPE_MAX = 400;

/** The key skeleton of a JSON value: keys kept (only safe-looking ones), values replaced by their type. */
function skeleton(value: unknown, depth: number): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${skeleton(value[0], depth + 1)}${value.length > 1 ? ',…' : ''}]`;
  if (isRecord(value)) {
    if (depth >= 4) return '{…}';
    const keys = Object.keys(value);
    const shown = keys.slice(0, 24).map((k) => `${/^[A-Za-z0-9_$.-]{1,40}$/.test(k) ? k : '?'}:${skeleton(value[k], depth + 1)}`);
    return `{${shown.join(',')}${keys.length > 24 ? ',…' : ''}}`;
  }
  return typeof value === 'string' ? 'str' : typeof value === 'number' ? 'num' : typeof value === 'boolean' ? 'bool' : '?';
}

function promptOf(job: Record<string, unknown>): string | null {
  const params = isRecord(job.params) ? job.params : {};
  return typeof params.prompt === 'string' ? params.prompt : typeof job.prompt === 'string' ? job.prompt : null;
}

/**
 * Parses `generate create --json` widely: a job object's `id` / `job_id` at the top, under `job` or `data`, the single
 * element of `jobs` / `items` / `data` / `results` (or of a top-level array), or the single element of `job_ids`.
 * NEVER `job_set_id` / `request_id`, never the `id` of an object that has a `job_set_id` (that is the set), and never a
 * guess among several ids (null: the caller adopts from the list, which also notices duplicates).
 */
export function parseCreated(stdout: string): ParsedCreate {
  const text = stdout.trim();
  if (text === '') return { jobId: null, prompt: null, shape: 'empty' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { jobId: null, prompt: null, shape: `non-json(${[...text].length})` };
  }
  let shape = skeleton(data, 0);
  if (shape.length > SHAPE_MAX) shape = `${shape.slice(0, SHAPE_MAX - 1)}…`;
  const own = (o: Record<string, unknown>): string | null => ('job_set_id' in o ? null : (str(o.id) ?? str(o.job_id)));
  const single = (list: unknown): Record<string, unknown> | null | 'many' => {
    if (!Array.isArray(list) || list.length === 0) return null;
    if (list.length > 1) return 'many';
    return isRecord(list[0]) ? list[0] : null;
  };
  const found = (job: Record<string, unknown>): ParsedCreate => ({ jobId: own(job), prompt: promptOf(job), shape });
  const none: ParsedCreate = { jobId: null, prompt: null, shape };

  if (Array.isArray(data)) {
    const one = single(data);
    return one && one !== 'many' ? found(one) : none;
  }
  if (!isRecord(data)) return none;
  if (own(data) !== null) return found(data);
  for (const k of ['job', 'data'] as const) {
    const inner = data[k];
    if (isRecord(inner) && own(inner) !== null) return found(inner);
  }
  for (const k of ['jobs', 'items', 'data', 'results'] as const) {
    const one = single(data[k]);
    if (one === 'many') return none;
    if (one && own(one) !== null) return found(one);
  }
  const ids = data.job_ids;
  if (Array.isArray(ids) && ids.length === 1 && str(ids[0]) !== null) return { jobId: ids[0] as string, prompt: promptOf(data), shape };
  return none;
}

/**
 * The error text of a failed CLI call: stderr plus, when stdout is JSON, only its error fields (`error`, `message`,
 * `detail`, `error.message`) — never the whole JSON (a «429» inside a `created_at` once caused a paid duplicate).
 */
function errorText(result: CliResult): string {
  const out = [result.stderr];
  try {
    const data: unknown = JSON.parse(result.stdout);
    if (isRecord(data)) {
      for (const k of ['error', 'message', 'detail'] as const) if (typeof data[k] === 'string') out.push(data[k] as string);
      if (isRecord(data.error) && typeof data.error.message === 'string') out.push(data.error.message);
    }
  } catch {
    // not JSON: stderr only
  }
  return out.join('\n');
}

const NO_CREDITS_RE =
  /insufficient\s+(?:credits?|balance|funds)|not\s+enough\s+(?:credits?|balance)|out\s+of\s+credits?|no\s+credits?\s+(?:left|remaining)|payment\s+required|\bHTTP\s*402\b/i;

/** The account has no credits for this job (exit ≠ 0 and the error says so): pause 'no-credits', never retry. */
export function isNoCredits(result: CliResult): boolean {
  return result.code !== 0 && NO_CREDITS_RE.test(errorText(result));
}

const AUTH_RE = /session\s+expired|not\s+(?:logged|signed)\s+in|log\s*in\s+required|unauthori[sz]ed|\bHTTP\s*40[13]\b|higgsfield\s+auth\s+login|(?:invalid|expired)\s+(?:access\s+)?token|token\s+(?:has\s+)?expired/i;

/** The Higgsfield sign-in is gone (exit ≠ 0 and the error says so): pause 'login' until the parent runs `higgsfield auth login`. */
export function isAuthProblem(result: CliResult): boolean {
  return result.code !== 0 && AUTH_RE.test(errorText(result));
}


function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find((l) => l !== '')?.slice(0, 300) ?? '';
}

// ── The paid steps ────────────────────────────────────────────────────────────────────────────────────────────────

export interface OnDemandDeps {
  runCli: RunCli;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  log: (line: string) => void;
}

/** Backoff before retry `attempt` (1-based) of a rate-limited call: 2 → 60 s, ±25 % jitter (SPEC §10). */
export function backoffMs(attempt: number, random: () => number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (attempt - 1));
  return Math.round(Math.min(BACKOFF_MAX_MS, base * (0.75 + 0.5 * random())));
}

export interface CreateJobInput {
  /** the overlay ledger (or the tools ledger when `runGenerate` uses it) — the intent and `created` lines go here */
  ledgerFile: string;
  campaign: string;
  run: string;
  job: GenJob;
  /** the SPEC price of `job.prompt` (`jobMilli`); the caller has checked the budget and the server price already */
  milli: number;
  /** job ids another ledger already owns (the tools ledger / the overlay ledger): never adopted */
  knownJobIds?: ReadonlySet<string>;
  /**
   * Write the intent line first (default true). `runGenerate` passes false for a ledger outside the overlay: the
   * committed tools ledger keeps its line types, and its list adoption keeps the tools' rule (no time window — there
   * is no intent to measure it from).
   */
  intent?: boolean;
  /** where the lines go (default: appended to `ledgerFile` and fsync'ed); `runGenerate` passes its own recorder */
  append?: (line: OnDemandLine) => void;
  /** told about every rate-limited create (the caller's counter) */
  onRateLimit?: () => void;
}

/**
 * The result of one create. `unresolved` = the create was ambiguous and no job was found yet: the intent stays open
 * (it counts at full price) until `adoptIntents` resolves it; `error` = the same without an intent (the tools ledger);
 * `duplicate` = two or more un-ledgered jobs matched our prompt (all are ledgered as spend, the caller stops);
 * `no-credits` / `login` = the account refused (the intent stays open until the list shows nothing).
 */
export type CreateOutcome =
  | { ok: true; jobId: string; via: CreateVia; shape: string }
  | { ok: false; reason: 'rate' | 'no-credits' | 'login' | 'unresolved' | 'duplicate' | 'error'; message: string };

/** Job ids a ledger file already owns (read fresh: another instance may share it). */
function ledgerJobIds(file: string): Set<string> {
  const ids = new Set<string>();
  for (const line of readOnDemandLines(file).lines) if (line.ev === 'created') ids.add(line.jobId);
  return ids;
}

/**
 * May a listed job be taken as ours? Exactly our prompt in our voice, not failed, unknown to both ledgers, and — when
 * there is an intent — created at or after the intent − ADOPT_SLACK_MS (an older orphan is somebody else's spend).
 */
function adoptable(j: HfJob, prompt: string, since: number | null, own: ReadonlySet<string>, known: ReadonlySet<string> | undefined): boolean {
  if (j.prompt !== prompt || !isOurVoice(j) || DONE_FAILED.has(j.status) || !isJobId(j.id)) return false;
  if (own.has(j.id) || known?.has(j.id) === true) return false;
  if (since === null) return true;
  const t = j.createdAt === null ? Number.NaN : Date.parse(j.createdAt);
  return Number.isFinite(t) && t >= since;
}

/**
 * One paid create, strictly after the caller's gates: intent (fsync) → `generate create` → `parseCreated` → confirm
 * (echoed prompt or a free `generate get`) → else one fresh look at `generate list` → `created` (fsync, with `via` /
 * `createShape`). Rate limit (exit ≠ 0 and `rate_limit_reached`): backoff 2 → 60 s, the list checked before every
 * retry, ≤ MAX_CREATE_TRIES. Any other failure is looked up in the list and never retried blindly.
 */
export async function createJob(input: CreateJobInput, deps: OnDemandDeps): Promise<CreateOutcome> {
  const { job, run, campaign, milli } = input;
  const key = keyOfJob(job);
  const append = input.append ?? ((line: OnDemandLine) => appendLedgerLine(input.ledgerFile, line));
  const at = (): string => deps.now().toISOString();
  const withIntent = input.intent !== false;
  const intentAt = deps.now();
  if (withIntent) append({ ev: 'intent', at: intentAt.toISOString(), run, campaign, key, milli, job });
  const since = withIntent ? intentAt.getTime() - ADOPT_SLACK_MS : null;
  let shape = 'none';
  const createdLine = (jobId: string, via: CreateVia, adopted: boolean): OnDemandCreatedLine => ({
    ev: 'created',
    at: at(),
    run,
    campaign,
    key,
    jobId,
    milli,
    job,
    ...(adopted ? { adopted: true as const } : {}),
    via,
    createShape: shape,
  });
  const created = (jobId: string, via: CreateVia): CreateOutcome => {
    append(createdLine(jobId, via, via === 'list'));
    return { ok: true, jobId, via, shape };
  };
  /** A fresh look at `generate list` for our job; null = nothing found (or the list could not be read). */
  const lookUp = async (): Promise<CreateOutcome | null> => {
    const listed = await deps.runCli(listArgs(LIST_PAGE_SIZE));
    if (listed.code !== 0) return null;
    const own = ledgerJobIds(input.ledgerFile);
    const found = parseJobs(listed.stdout).filter((j) => adoptable(j, job.prompt, since, own, input.knownJobIds));
    if (found.length === 1) return created(found[0]!.id, 'list');
    if (found.length === 0) return null;
    // two or more jobs we never ledgered: each may have been debited — all are spend, a person has to look
    for (const j of found) append(createdLine(j.id, 'list', true));
    deps.log(`в списке Higgsfield ${found.length} одинаковых задания с этим текстом — все записаны в журнал как траты; остановка`);
    return { ok: false, reason: 'duplicate', message: `${found.length} un-ledgered jobs match the prompt` };
  };
  /** A free `generate get`: does this id hold exactly our prompt in our voice? */
  const confirmed = async (jobId: string): Promise<boolean> => {
    const got = await deps.runCli(getArgs(jobId));
    if (got.code !== 0) return false;
    const hf = parseJobs(got.stdout).find((j) => j.id === jobId);
    return hf !== undefined && hf.prompt === job.prompt && isOurVoice(hf);
  };

  for (let attempt = 1; attempt <= MAX_CREATE_TRIES; attempt++) {
    if (attempt > 1) {
      // a rate-limited create may have made the job after all: look before every retry
      const found = await lookUp();
      if (found) return found;
    }
    const result = await deps.runCli(createArgs(job.prompt));
    if (isRateLimited(result)) {
      input.onRateLimit?.();
      if (attempt === MAX_CREATE_TRIES) break;
      const delay = backoffMs(attempt, deps.random);
      deps.log(`лимит запросов Higgsfield — жду ${Math.round(delay / 1000)} с (попытка ${attempt}/${MAX_CREATE_TRIES})`);
      await deps.sleep(delay);
      continue;
    }
    if (result.code === 0) {
      const parsed = parseCreated(result.stdout);
      shape = parsed.shape;
      const id = parsed.jobId !== null && isJobId(parsed.jobId) ? parsed.jobId : null;
      if (id !== null && parsed.prompt === job.prompt) return created(id, 'parse');
      if (id !== null && parsed.prompt === null && (await confirmed(id))) return created(id, 'get');
    }
    // Ambiguous (or refused): the job may or may not exist. Look before anything else; never retry blindly.
    const found = await lookUp();
    if (found) return found;
    const message = firstLine(errorText(result)) || `exit ${result.code}, no job id`;
    append({ ev: 'error', at: at(), run, key, stage: 'create', message });
    if (isNoCredits(result)) return { ok: false, reason: 'no-credits', message };
    if (isAuthProblem(result)) return { ok: false, reason: 'login', message };
    return { ok: false, reason: withIntent ? 'unresolved' : 'error', message };
  }
  return { ok: false, reason: 'rate', message: `rate limited ${MAX_CREATE_TRIES} times in a row` };
}

export interface AdoptIntentsInput {
  ledgerFile: string;
  run: string;
  knownJobIds?: ReadonlySet<string>;
  /** where the lines go (default: appended to `ledgerFile` and fsync'ed) */
  append?: (line: OnDemandLine) => void;
}

export interface AdoptSummary {
  /** intents resolved by a job found in `generate list` (a `created` line, `via: 'list'`) */
  adopted: { key: string; jobId: string }[];
  /** intents resolved as «no job was made» after ABSENT_AFTER_CHECKS empty checks (an `absent` line) */
  absent: string[];
  /** still unresolved (the list could not be read): they keep counting at full price */
  open: string[];
  /** keys where two or more un-ledgered jobs matched (all ledgered as spend; the caller pauses 'duplicate') */
  duplicate: string[];
}

/**
 * Resolves the ledger's unresolved intents (at start, and after an ambiguous create): up to ABSENT_AFTER_CHECKS fresh
 * `generate list --audio --json` calls ADOPT_CHECK_MS apart; a job with exactly the intent's prompt in our voice,
 * unknown to both ledgers, created at or after the intent − ADOPT_SLACK_MS is adopted (oldest intent first, one job
 * per intent). Only a check whose list could be read counts towards `absent`.
 */
export async function adoptIntents(input: AdoptIntentsInput, deps: OnDemandDeps): Promise<AdoptSummary> {
  const summary: AdoptSummary = { adopted: [], absent: [], open: [], duplicate: [] };
  const view = onDemandViewOf(readOnDemandLines(input.ledgerFile).lines);
  if (view.unresolved.length === 0) return summary;
  const append = input.append ?? ((line: OnDemandLine) => appendLedgerLine(input.ledgerFile, line));
  const at = (): string => deps.now().toISOString();
  const own = new Set(view.ledger.jobs.keys());
  const empty = new Map<IntentLine, number>();
  let pending = [...view.unresolved];
  for (let check = 1; check <= ABSENT_AFTER_CHECKS && pending.length > 0; check++) {
    if (check > 1) await deps.sleep(ADOPT_CHECK_MS);
    const listed = await deps.runCli(listArgs(LIST_PAGE_SIZE));
    if (listed.code !== 0) continue; // nothing learned: this check does not count
    const jobs = parseJobs(listed.stdout);
    const resolved = new Set<string>();
    for (const intent of pending) {
      if (resolved.has(intent.key)) continue;
      const t = Date.parse(intent.at);
      const found = jobs.filter((j) => adoptable(j, intent.job.prompt, Number.isFinite(t) ? t - ADOPT_SLACK_MS : null, own, input.knownJobIds));
      if (found.length === 0) {
        empty.set(intent, (empty.get(intent) ?? 0) + 1);
        continue;
      }
      for (const j of found) {
        own.add(j.id);
        append({ ev: 'created', at: at(), run: input.run, campaign: intent.campaign, key: intent.key, jobId: j.id, milli: intent.milli, job: intent.job, adopted: true, via: 'list' });
      }
      if (found.length === 1) summary.adopted.push({ key: intent.key, jobId: found[0]!.id });
      else summary.duplicate.push(intent.key);
      // a `created` line resolves every open intent of its key
      resolved.add(intent.key);
    }
    pending = pending.filter((i) => !resolved.has(i.key));
  }
  const done = new Set<string>();
  for (const intent of pending) {
    if (done.has(intent.key)) continue;
    done.add(intent.key);
    const checks = Math.max(...pending.filter((i) => i.key === intent.key).map((i) => empty.get(i) ?? 0));
    if (checks >= ABSENT_AFTER_CHECKS) {
      append({ ev: 'absent', at: at(), run: input.run, key: intent.key, checks });
      summary.absent.push(intent.key);
    } else summary.open.push(intent.key);
  }
  if (summary.adopted.length + summary.absent.length + summary.duplicate.length > 0) {
    deps.log(`незавершённые задания из журнала: найдено ${summary.adopted.length}, не созданы ${summary.absent.length}${summary.duplicate.length > 0 ? `, двойные ${summary.duplicate.length}` : ''}${summary.open.length > 0 ? `, ещё неясно ${summary.open.length}` : ''}`);
  }
  return summary;
}

export interface DownloadJobInput {
  ledgerFile: string;
  mastersDir: string;
  run: string;
  /** a charged job */
  job: LedgerJob;
  /** the result URL `generate wait` just returned (else the ledgered one, then a fresh one from `generate get`) */
  urlHint?: string;
  /** where the lines go (default: appended to `ledgerFile` and fsync'ed) */
  append?: (line: OnDemandLine) => void;
}

/**
 * Downloads a charged job's master to `<mastersDir>/<jobId>.mp3` (atomic, MP3-checked by `download`) and writes the
 * `downloaded` line; a failed download writes an `error` line and returns false (retried later, free). An expired CDN
 * link is replaced once by a fresh one from `generate get`.
 */
export async function downloadJob(
  input: DownloadJobInput,
  deps: Pick<OnDemandDeps, 'runCli' | 'now' | 'log'> & { download: (url: string, dest: string) => Promise<DownloadResult> },
): Promise<boolean> {
  const { job } = input;
  if (!isJobId(job.jobId)) throw new Error(`bad Higgsfield job id: ${JSON.stringify(job.jobId.slice(0, 40))}`);
  const append = input.append ?? ((line: OnDemandLine) => appendLedgerLine(input.ledgerFile, line));
  const at = (): string => deps.now().toISOString();
  mkdirSync(input.mastersDir, { recursive: true });
  const dest = path.join(input.mastersDir, `${job.jobId}.mp3`);
  const urls = [input.urlHint ?? job.resultUrl].filter((u): u is string => typeof u === 'string');
  for (let attempt = 0; attempt < 2; attempt++) {
    let url: string | null | undefined = urls[attempt];
    if (url === undefined) {
      // the CDN link may have expired: ask for the job again (free) for a fresh one
      const fresh = await deps.runCli(getArgs(job.jobId));
      url = fresh.code === 0 ? parseJobs(fresh.stdout).find((j) => j.id === job.jobId)?.resultUrl : null;
      if (url === undefined || url === null) break;
    }
    try {
      const got = await deps.download(url, dest);
      append({ ev: 'downloaded', at: at(), key: job.key, jobId: job.jobId, master: path.basename(dest), bytes: got.bytes, sha256: got.sha256 });
      return true;
    } catch (err) {
      append({ ev: 'error', at: at(), run: input.run, key: job.key, jobId: job.jobId, stage: 'download', message: err instanceof Error ? err.message : String(err) });
    }
  }
  deps.log(`мастер ${job.jobId} не скачан — повторю при следующем запуске (бесплатно)`);
  return false;
}
