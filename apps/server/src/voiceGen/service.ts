/**
 * «Дозапись голоса» (docs/voice-clips/ONDEMAND.md): the recorder. The browser asks for the sentences of an utterance that have no
 * recording (ids only: lesson parts, the quiz options sentence, or a whole catalogue sentence of an older event — a
 * greeting, an answer… — under ONE budget, dedup and queue); the server renders their words itself, drops every unit
 * that is covered (recorded, being recorded, or out of paid attempts — dedup by UNIT, S2), packs the rest into as few
 * paid jobs as the recipe allows and records them strictly one job at a time, resuming from the overlay ledger after a
 * restart.
 *
 * Before ANY Higgsfield call, free ones included, the gates run in this order: GAMBIT_CLIP_GEN, the DATA_DIR pin
 * (CLIP_GEN_DATA_DIR), not a temp DATA_DIR, a valid overlay ('no-overlay'), CLIP_GEN_BUDGET > 0, the CLI found, the
 * parent's switch, the breaker — then, for a new job, ffmpeg + whisper present and the caps on a FRESH ledger read
 * under the machine-wide lock (charged + pending + unresolved intents at full price, S1). A job already paid (its wait, download
 * and finish) is not held back by the caps or by missing tools (its finish waits for them).
 *
 * One job: global lock → adopt unresolved intents → audit → dedup again → caps → model probe (once) → the server's own
 * price (free) → the gates once more (the parent may have switched off meanwhile) → create (tools `createJob`: intent →
 * create → parse / get / list-adopt → created) → wait → charged → unlock → download → finish (the tools' process +
 * verify as children; only ASR-confirmed takes are published; a recogniser that could not run fails the finish, it
 * is no verdict) → a unit whose check really failed gets one paid take 2 alone, then it is given up (blocked). A paid
 * job whose download or finish fails every retry is noted `stuck` (not «recording» any more; the next start retries).
 *
 * A unit is the same unit under its twins' keys (the same words for another piece, or a whole catalogue sentence of
 * another line with exactly these words — «Привет!» of a greeting and of the game's hello —, `alsoKeysOf`) and only
 * for its words: attempts, verdicts and `blocked[]` of older words under a shifted key never give up the new ones.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ClipGenHealth,
  ClipGenOutcome,
  ClipGenPauseReason,
  ClipGenRequest,
  ClipGenRequestResult,
  ClipGenSettings,
  ClipGenStatus,
  CoachEventKind,
} from '@gambit/shared';
import { takesForUnit } from '@gambit/core';
import { dataDirPinned, overlayDirProblem } from '../config.ts';
import type { ServerConfig } from '../config.ts';
import { defaultTempRoots, isTempDir } from '../routes/health.ts';
import type { Db } from '../storage/db.ts';
import {
  CliError,
  DONE_FAILED,
  DONE_OK,
  LedgerLocked,
  MAX_PAID_ATTEMPTS,
  ONDEMAND_CAMPAIGN,
  ONDEMAND_TAKE_BASE,
  VOICE_KEY,
  adoptIntents,
  alsoKeysOf,
  appendLedger,
  auditBlocked,
  backoffMs,
  clipId,
  createJob,
  downloadJob,
  isAuthProblem,
  isDiscard,
  isRateLimited,
  isTransient,
  lockGlobal,
  lockLedger,
  looksLikeMp3,
  modelProblem,
  onDemandViewOf,
  parseJobs,
  readLedger,
  readOnDemandLedger,
  serverCostMilli,
  unitAttempts,
  waitArgs,
} from './bridge.ts';
import type {
  AdoptIntentsInput,
  AdoptSummary,
  CliResult,
  CreateJobInput,
  CreateOutcome,
  DownloadJobInput,
  DownloadResult,
  GenJob,
  LedgerJob,
  OnDemandDeps,
  OnDemandView,
  RunCli,
} from './bridge.ts';
import { Breaker } from './breaker.ts';
import type { BreakerReason } from './breaker.ts';
import { ClipGenSettingsStore, MIN_JOB_MILLI, capReached, nextLocalMidnight, spendOf } from './budget.ts';
import type { Caps } from './budget.ts';
import { Libraries, emptyOverlayState, fileStamp, overlayPaths, readOverlayState, tryLockFile, updateOverlayState } from './overlay.ts';
import type { LibraryState, OverlayPaths, OverlayState } from './overlay.ts';
import { buildJob, packUnits, renderSentence, unitFromPiece } from './render.ts';
import type { RenderedUnit } from './render.ts';
import { ChildRunner, SERVER_WAIT_TIMEOUT, createToolsFinish, higgsfieldRunCli, toolsProblem } from './runner.ts';
import type { FinishFn } from './runner.ts';

// ───────────────────────── limits ─────────────────────────

/**
 * Queue order: resumed work first (it is paid already), then the stage 1–2 options sentence (a non-reader's question),
 * then what the child waits for — a teacher turn, an answer, a hint, a greeting (its bubble is up the moment the app
 * opens) —, then reactions, then the rest (rarer moments). Among equal priorities the NEWEST request goes first: its
 * bubble may still be on screen, so its recording can still be heard in time (older ones wait, the oldest give way).
 */
export const PRIORITY = { resume: 100, quiz: 80, teach: 60, rerender: 50, react: 40, other: 30, piecePenalty: 10 } as const;
/** at most this many new-recording items wait; the lowest-priority, oldest one gives way ('queue-full' otherwise) */
export const QUEUE_MAX = 40;
/** a new-recording item older than this is dropped: the child has long moved on (the next occurrence asks again) */
export const ITEM_TTL_MS = 15 * 60_000;
/** a job still pending after this long is left pending (it counts at full price until the next start resumes it) */
export const WAIT_GIVE_UP_MS = 60 * 60_000;
/** re-try of a resumed wait / download / finish */
export const RESUME_BACKOFF_MS = 30_000;
const MAX_WAIT_TRIES = 8;
const MAX_DOWNLOAD_TRIES = 5;
const MAX_FINISH_TRIES = 3;
/** a new-recording item whose job failed or errored is tried once more, then dropped */
const MAX_RECORD_ERRORS = 1;
/** the tools probe (ffmpeg / whisper) is repeated after this long */
const TOOLS_PROBE_MS = 10 * 60_000;
/** waiting for another instance's publish lock: 40 × 250 ms */
const PUBLISH_LOCK_TRIES = 40;

// ───────────────────────── injectable parts ─────────────────────────

/** The paid protocol of the tools (docs/voice-clips/ONDEMAND.md) — the real one through the bridge, a fake in tests. */
export interface ClipGenProtocol {
  createJob(input: CreateJobInput, deps: OnDemandDeps): Promise<CreateOutcome>;
  adoptIntents(input: AdoptIntentsInput, deps: OnDemandDeps): Promise<AdoptSummary>;
  downloadJob(input: DownloadJobInput, deps: Pick<OnDemandDeps, 'runCli' | 'now' | 'log'> & { download: Downloader }): Promise<boolean>;
  lockGlobal(dir: string, o?: { waitMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<() => void>;
}

export type Downloader = (url: string, dest: string) => Promise<DownloadResult>;

/**
 * ContextOverrides.clipGen (tests): a fake runner is the ONLY way anything runs under vitest — without it the service
 * has no CLI at all (`no-cli`), whatever the config says (S5).
 */
export interface ClipGenOverrides {
  runCli?: RunCli;
  download?: Downloader;
  finish?: FinishFn;
  protocol?: Partial<ClipGenProtocol>;
  toolsProblem?: () => Promise<string | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** which folders count as temp; honoured only together with a fake `runCli` (it can never spend) */
  tempRoots?: readonly string[];
  /** the static library root (default apps/web/public/voice of the checkout) */
  staticLibraryDir?: string | null;
  /** the tools ledger of this checkout (default tools/voice-clips/ledger.giselle-mm1.jsonl) */
  toolsLedgerFile?: string | null;
  /** false: no wake-up timers (tests drive `run()` with a fake clock) */
  timers?: boolean;
}

export interface ClipGenServiceOptions {
  config: Pick<ServerConfig, 'clipGen' | 'dataDir'>;
  /** DATA_DIR is a throw-away folder: never spend (S4) */
  dataDirIsTemp: boolean;
  /** the validated overlay (null = off / refused) */
  overlay: OverlayPaths | null;
  settings: ClipGenSettingsStore;
  nickname: () => string | null;
  staticLibraryDir: string | null;
  toolsLedgerFile: string | null;
  runCli: RunCli | null;
  download: Downloader;
  finish: FinishFn;
  protocol: ClipGenProtocol;
  toolsProblem: () => Promise<string | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  log: (line: string) => void;
  timers: boolean;
  /** kills the running children (shutdown) */
  disposeChildren?: () => void;
}

// ───────────────────────── queue items ─────────────────────────

interface WorkBase {
  seq: number;
  priority: number;
  /** enqueued at (ms) */
  at: number;
  /** not before (ms) */
  notBefore: number;
}

type Work =
  | (WorkBase & { kind: 'record'; units: RenderedUnit[]; milli: number; errors: number })
  | (WorkBase & { kind: 'adopt' })
  | (WorkBase & { kind: 'wait'; jobId: string; since: number })
  | (WorkBase & { kind: 'download'; jobId: string; tries: number; urlHint?: string })
  | (WorkBase & { kind: 'finish'; jobId: string; tries: number });

type RecordWork = Extract<Work, { kind: 'record' }>;
/** `Omit` over each member of a union (a plain `Omit` would merge them) */
type NewWork = Work extends infer W ? (W extends Work ? Omit<W, 'seq' | 'at'> : never) : never;

/** What a gate says: off (the web hides the feature), paused (why and until when), or null = go. */
type Gate = { off: true } | { off: false; reason: ClipGenPauseReason; until: number | null } | null;

/**
 * 'stuck': held only by a paid job whose download or finish failed every retry — neither recorded nor being recorded;
 * 'ear': a take of the checkout's own library (the starter set) that the recogniser confirmed waits for the owner's ear
 */
type UnitState = 'voiced' | 'inflight' | 'queued' | 'given-up' | 'stuck' | 'ear' | 'missing';

/** What a request / a dedup needs of a unit (a ledgered piece is one too; `alone` only matters for a lead). */
type UnitRef = Pick<RenderedUnit, 'key' | 'text'> & { alone?: boolean };

interface Knowledge {
  lib: LibraryState;
  view: OnDemandView;
  notes: OverlayState;
}

const uid = (u: Pick<RenderedUnit, 'key' | 'text'>): string => `${u.key}|${u.text}`;

function priorityOf(kind: CoachEventKind | undefined, units: readonly RenderedUnit[]): number {
  let p: number;
  if (units.some((u) => u.kind === 'frag')) p = PRIORITY.quiz;
  else if (kind === 'teachTurn' || kind === 'answer' || kind === 'hint' || kind === 'greeting') p = PRIORITY.teach;
  else if (kind === 'teachReaction' || kind === 'praise' || kind === 'encourage' || kind === 'botMoveComment') p = PRIORITY.react;
  else p = PRIORITY.other;
  // a piece variant is heard less often than a wording without a piece
  return units.some((u) => u.piece) ? p - PRIORITY.piecePenalty : p;
}

/** Spoken-order groups: a lead said before its tail stays with the tail (the tag between them makes the lead fall). */
function groupsOf(units: readonly RenderedUnit[]): RenderedUnit[][] {
  const groups: RenderedUnit[][] = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i] as RenderedUnit;
    const next = units[i + 1];
    if (u.role === 'lead' && !u.alone && next?.role === 'tail') {
      groups.push([u, next]);
      i++;
    } else groups.push([u]);
  }
  return groups;
}

/** The kept pieces of a ledgered job with their clip ids (what the finish publishes). */
function jobUnits(job: GenJob): { id: string; key: string; text: string }[] {
  const out: { id: string; key: string; text: string }[] = [];
  job.pieces.forEach((piece, cut) => {
    if (!isDiscard(piece)) out.push({ id: clipId(VOICE_KEY, job.prompt, cut, job.take), key: piece.key, text: piece.text });
  });
  return out;
}

const BREAKER_TIMED: ReadonlySet<ClipGenPauseReason> = new Set<ClipGenPauseReason>(['login', 'rate', 'no-credits', 'unresolved', 'tool-busy', 'failing']);

// ───────────────────────── the service ─────────────────────────

export class ClipGenService {
  private readonly o: ClipGenServiceOptions;
  private readonly breaker: Breaker;
  private readonly libraries: Libraries;
  private readonly run: string;
  private readonly pinOk: boolean;
  private queue: Work[] = [];
  private seq = 0;
  private running: Set<string> | null = null;
  private pumping: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  private started = false;
  private modelChecked = false;
  private tools: { problem: string | null; at: number } | null = null;
  /** a cap met at create time, so the queue does not spin on an item that does not fit (lifted at midnight / restart) */
  private capHold: { reason: 'day-cap' | 'total-cap'; until: number | null } | null = null;
  private viewCache: { stamp: string; view: OnDemandView } | null = null;
  private notesCache: { stamp: string; notes: OverlayState } | null = null;
  private toolsLedgerCache: { stamp: string; audit: boolean; ids: ReadonlySet<string>; view: OnDemandView } | null = null;
  /** `key|text` → the keys whose words are the same (the unit's own included): content lookups, cached */
  private readonly twinCache = new Map<string, ReadonlySet<string>>();

  constructor(options: ClipGenServiceOptions) {
    this.o = options;
    const stateFile = options.overlay?.state ?? null;
    this.breaker = new Breaker({
      now: options.now,
      load: () => (stateFile === null ? { failingTrips: 0, lastTripAt: null } : readOverlayState(stateFile)),
      save: (memory) => {
        if (stateFile !== null) this.safely(() => updateOverlayState(stateFile, (s) => Object.assign(s, memory)));
      },
    });
    // the checkout's own unit store and verdicts lie next to its tools ledger (tools/voice-clips/)
    const toolsDir = options.toolsLedgerFile === null ? null : dirname(options.toolsLedgerFile);
    this.libraries = new Libraries({
      staticDir: options.staticLibraryDir,
      overlay: options.overlay,
      tools: toolsDir === null ? null : { units: join(toolsDir, `units.${VOICE_KEY}.json`), review: join(toolsDir, `review.${VOICE_KEY}.json`) },
    });
    this.run = `server-${new Date(options.now()).toISOString()}`;
    this.pinOk = dataDirPinned(options.config.clipGen, options.config.dataDir);
  }

  // ── what the routes read ──

  /** The overlay folder when it is valid and exists: its phrases are served, flag or not. */
  overlayDir(): string | null {
    const dir = this.o.overlay?.dir ?? null;
    return dir !== null && fileStamp(dir) !== '-' ? dir : null;
  }

  health(): ClipGenHealth {
    const overlay = this.overlayDir() !== null;
    const gate = this.gate(this.knowledge(false), 'spend');
    if (gate === null) return { state: 'ready', overlay };
    if (gate.off) return { state: 'off', overlay };
    return { state: 'paused', reason: gate.reason, until: gate.until, overlay };
  }

  status(): ClipGenStatus {
    const k = this.knowledge(false);
    const spend = spendOf(k.view, new Date(this.o.now()));
    return {
      health: this.health(),
      enabled: this.o.settings.get().enabled,
      queue: this.queueLength(),
      busy: this.running !== null,
      overlay: k.lib.overlay,
      spent: { today: spend.today, todayMilli: spend.todayMilli, totalMilli: spend.totalMilli, prefetchMilli: spend.prefetchMilli },
      caps: this.caps(),
      givenUp: this.givenUp(k),
      recorded: this.recorded(k),
      stuck: this.stuckJobs(k).length,
    };
  }

  settings(): ClipGenSettings {
    return this.o.settings.get();
  }

  /** The parent's switch / cap (never under automation — the route checks). Switching on wakes the queue. */
  setSettings(settings: ClipGenSettings): ClipGenStatus {
    const saved = this.o.settings.set(settings);
    this.o.log(`[clip-gen] the parent set recording ${saved.enabled ? 'on' : 'off'}, ${saved.dailyCapMilli / 1000} credits a day`);
    if (this.capHold?.reason === 'day-cap') this.capHold = null;
    this.kick();
    return this.status();
  }

  /** Jobs waiting (new recordings and resumed work). */
  queueLength(): number {
    return this.queue.length;
  }

  // ── a request from the browser ──

  request(body: ClipGenRequest): ClipGenRequestResult {
    const now = this.o.now();
    this.expire(now);
    const k = this.knowledge(false);
    const gate = this.gate(k, 'spend');
    const nickname = this.o.nickname();
    const results: { outcome: ClipGenOutcome; keys: string[] }[] = [];
    /** sentences that need recording: their result index and their missing units as spoken-order groups */
    const wanted: { index: number; groups: RenderedUnit[][] }[] = [];
    // by the words: twins in one request («он уйдёт» for the knight and the bishop) are one unit to record
    const taken = new Set<string>();
    for (const sentence of body.sentences) {
      const rendered = renderSentence(sentence, { nickname });
      if (!rendered.ok) {
        results.push({ outcome: 'invalid', keys: [] });
        continue;
      }
      const keys = rendered.units.map((u) => u.key);
      const states = rendered.units.map((u) => (taken.has(this.idOf(u)) ? 'queued' : this.unitState(u, k)));
      if (states.every((s) => s === 'voiced')) results.push({ outcome: 'voiced', keys });
      else if (states.includes('given-up')) results.push({ outcome: 'given-up', keys });
      // a paid take that could not be finished, or a starter-set take waiting for the owner's ear: not «recording» (the
      // bubble would promise a voice for good) and nothing is paid — the owner's next step brings it
      else if (states.includes('stuck') || states.includes('ear')) results.push({ outcome: 'paused', keys });
      else if (!states.includes('missing')) results.push({ outcome: states.includes('queued') ? 'queued' : 'recording', keys });
      else {
        const missing = rendered.units.filter((_u, i) => states[i] === 'missing');
        for (const u of missing) taken.add(this.idOf(u));
        wanted.push({ index: results.length, groups: groupsOf(missing) });
        results.push({ outcome: 'queued', keys });
      }
    }
    if (wanted.length > 0) {
      const refuse = (outcome: ClipGenOutcome): void => {
        for (const w of wanted) (results[w.index] as { outcome: ClipGenOutcome }).outcome = outcome;
      };
      // a timed pause that lifts soon keeps the items; anything else refuses now
      const queueable = gate === null || (!gate.off && BREAKER_TIMED.has(gate.reason) && gate.until !== null && gate.until - now <= ITEM_TTL_MS);
      if (gate !== null && !queueable) refuse(!gate.off && (gate.reason === 'day-cap' || gate.reason === 'total-cap') ? 'budget' : 'paused');
      else {
        const priority = priorityOf(body.kind, wanted.flatMap((w) => w.groups.flat()));
        const packs = packUnits(wanted.flatMap((w) => w.groups))
          .map((units) => ({ units, built: buildJob(units, ONDEMAND_TAKE_BASE) }))
          .filter((p): p is { units: RenderedUnit[]; built: NonNullable<ReturnType<typeof buildJob>> } => p.built !== null);
        const newMilli = packs.reduce((sum, p) => sum + p.built.milli, 0);
        const queuedMilli = this.queue.reduce((sum, w) => sum + (w.kind === 'record' ? w.milli : 0), 0);
        const spend = spendOf(k.view, new Date(now));
        if (packs.length === 0) refuse('invalid');
        else if (capReached(spend, queuedMilli + newMilli, this.caps()) !== null) refuse('budget');
        else if (!this.makeRoom(packs.length, priority)) refuse('queue-full');
        else for (const p of packs) this.enqueue({ kind: 'record', units: p.units, milli: p.built.milli, errors: 0, priority, notBefore: 0 });
      }
    }
    this.kick();
    return { results, health: this.health(), queue: this.queueLength() };
  }

  // ── lifecycle ──

  /**
   * Resume from the overlay ledger (file reads only; every CLI call waits for the gates): unresolved intents are
   * adopted, pending jobs waited for (never re-created), charged jobs downloaded and finished.
   */
  start(): void {
    if (this.started || this.disposed || !this.o.config.clipGen.enabled || this.o.overlay === null) return;
    this.started = true;
    const k = this.knowledge(true);
    if (k.view.unresolved.some((i) => i.campaign === ONDEMAND_CAMPAIGN)) this.enqueue({ kind: 'adopt', priority: PRIORITY.resume, notBefore: 0 });
    for (const job of k.view.ledger.jobs.values()) {
      if (job.campaign !== ONDEMAND_CAMPAIGN) continue;
      if (job.state === 'pending') this.enqueue({ kind: 'wait', jobId: job.jobId, since: Date.parse(job.createdAt) || this.o.now(), priority: PRIORITY.resume, notBefore: 0 });
      else if (job.state === 'charged' && job.master === undefined) this.enqueue({ kind: 'download', jobId: job.jobId, tries: 0, priority: PRIORITY.resume, notBefore: 0 });
      else if (job.state === 'charged' && k.notes.finished[job.jobId] === undefined) this.enqueue({ kind: 'finish', jobId: job.jobId, tries: 0, priority: PRIORITY.resume, notBefore: 0 });
    }
    const resumed = this.queue.length;
    if (resumed > 0) this.o.log(`[clip-gen] resuming ${resumed} job step(s) from the overlay ledger`);
    this.kick();
  }

  /** Stops the queue and kills the running children; a pending job stays in the ledger and is resumed next time. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.o.disposeChildren?.();
    await this.idle();
  }

  /** Resolves when the queue has nothing it can do right now (tests). */
  async idle(): Promise<void> {
    while (this.pumping !== null) await this.pumping;
  }

  /** Wakes the queue and waits until it rests (tests with a fake clock). */
  async runQueue(): Promise<void> {
    this.kick();
    await this.idle();
  }

  // ── gates ──

  private caps(): Caps {
    const cg = this.o.config.clipGen;
    return { dailyMilli: Math.min(this.o.settings.get().dailyCapMilli, cg.dailyMaxMilli), dailyMaxMilli: cg.dailyMaxMilli, totalMilli: cg.budgetMilli };
  }

  /**
   * The gates in their order (D7). `spend`: a new job — the caps must leave room for the cheapest one; `free`: resumed
   * work (waits, downloads, finishes of jobs already paid) is not held back by the caps.
   */
  private gate(k: Knowledge, purpose: 'spend' | 'free'): Gate {
    const cg = this.o.config.clipGen;
    if (!cg.enabled) return { off: true };
    if (!this.pinOk) return { off: false, reason: 'data-dir', until: null };
    if (this.o.dataDirIsTemp) return { off: false, reason: 'temp-data', until: null };
    // no overlay (VOICE_OVERLAY_DIR off or refused): nothing could be kept — the owner sees why on the parent's card
    if (this.o.overlay === null) return { off: false, reason: 'no-overlay', until: null };
    if (cg.budgetMilli <= 0) return { off: false, reason: 'no-budget', until: null };
    if (this.o.runCli === null) return { off: false, reason: 'no-cli', until: null };
    if (!this.o.settings.get().enabled) return { off: false, reason: 'parent-off', until: null };
    const pause = this.breaker.current();
    if (pause !== null) return { off: false, reason: pause.reason, until: pause.until };
    // waits and downloads need no ffmpeg / whisper: a job already paid is always brought home (a finish waits for them)
    if (purpose === 'free') return null;
    const now = this.o.now();
    // re-probed after TOOLS_PROBE_MS (the owner may have installed them meanwhile)
    if (this.tools !== null && this.tools.problem !== null && now - this.tools.at < TOOLS_PROBE_MS) return { off: false, reason: 'no-tools', until: null };
    if (this.capHold !== null && (this.capHold.until === null || this.capHold.until > now)) return { off: false, reason: this.capHold.reason, until: this.capHold.until };
    this.capHold = null;
    const cap = capReached(spendOf(k.view, new Date(now)), MIN_JOB_MILLI, this.caps());
    if (cap === 'total-cap') return { off: false, reason: 'total-cap', until: null };
    if (cap === 'day-cap') return { off: false, reason: 'day-cap', until: nextLocalMidnight(now) };
    return null;
  }

  /** ffmpeg and whisper are there (probed lazily, never before the other gates pass, again every 10 min). */
  private async toolsReady(): Promise<boolean> {
    const now = this.o.now();
    if (this.tools === null || now - this.tools.at >= TOOLS_PROBE_MS) {
      let problem: string | null;
      try {
        problem = await this.o.toolsProblem();
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      if (problem !== null && this.tools?.problem !== problem) this.o.log(`[clip-gen] cannot check recordings: ${problem} — nothing is recorded`);
      this.tools = { problem, at: now };
    }
    return this.tools.problem === null;
  }

  // ── what is recorded ──

  private knowledge(fresh: boolean): Knowledge {
    const lib = this.libraries.current();
    const paths = this.o.overlay;
    if (paths === null) return { lib, view: onDemandViewOf([]), notes: emptyOverlayState() };
    let view: OnDemandView;
    const stamp = fileStamp(paths.ledger);
    if (!fresh && this.viewCache?.stamp === stamp) view = this.viewCache.view;
    else {
      view = readOnDemandLedger(paths.ledger);
      this.viewCache = { stamp, view };
    }
    const notesStamp = fileStamp(paths.state);
    let notes: OverlayState;
    if (!fresh && this.notesCache?.stamp === notesStamp) notes = this.notesCache.notes;
    else {
      notes = readOverlayState(paths.state);
      this.notesCache = { stamp: notesStamp, notes };
    }
    return { lib, view, notes };
  }

  /**
   * The keys whose words are exactly `u`'s, its own included: «{Он} уйдёт» is the same «он уйдёт» for the knight, the
   * bishop and the king; «Привет!» is the same for the day greeting, the opener and the game's hello. One take serves
   * them all (the tools publish it under every twin, `alsoKeysOf`), so they are ONE unit for the dedup — before
   * publishing too, while its job is queued, pending or being finished.
   */
  private twins(u: Pick<RenderedUnit, 'key' | 'text'>): ReadonlySet<string> {
    const id = uid(u);
    let twins = this.twinCache.get(id);
    if (twins === undefined) {
      twins = new Set([u.key, ...alsoKeysOf(u.key, u.text)]);
      this.twinCache.set(id, twins);
    }
    return twins;
  }

  /** The dedup identity of a unit: its words under the first of its twin keys. */
  private idOf(u: Pick<RenderedUnit, 'key' | 'text'>): string {
    return `${[...this.twins(u)].sort()[0] ?? u.key}|${u.text}`;
  }

  /** Does this ledgered job (or intent) hold `u` — its words under its key or a twin's? */
  private holds(job: GenJob, u: Pick<RenderedUnit, 'key' | 'text'>): boolean {
    const twins = this.twins(u);
    return job.pieces.some((p) => !isDiscard(p) && p.text === u.text && twins.has(p.key));
  }

  /**
   * Paid attempts at `u`'s words (its twins share them): a key whose number now names other words starts afresh. Both
   * ledgers of this machine count — the overlay's and the checkout's tools ledger (the starter set, the owner's static
   * campaigns): the same words bought for the static library are an attempt too (MAX_PAID_ATTEMPTS machine-wide).
   */
  private attemptsOf(u: Pick<RenderedUnit, 'key' | 'text'>, k: Knowledge): number {
    const unit = { key: u.key, text: u.text, twins: this.twins(u) };
    return unitAttempts(k.view, unit) + unitAttempts(this.toolsLedger().view, unit);
  }

  /** A take of the checkout's own library with `u`'s words (under a twin key too) waits for the owner's ear. */
  private awaitsEar(u: Pick<RenderedUnit, 'key' | 'text'>, k: Knowledge): boolean {
    if (k.lib.awaitingEar.size === 0) return false;
    for (const key of this.twins(u)) if (k.lib.awaitingEar.has(`${key}|${u.text}`)) return true;
    return false;
  }

  private maxAttempts(u: Pick<RenderedUnit, 'key' | 'text'>, k: Knowledge): number {
    return MAX_PAID_ATTEMPTS + (k.lib.redo.has(uid(u)) ? 1 : 0);
  }

  /**
   * What a ledgered job that holds `u` says about it: 'open' — it is being recorded, downloaded, processed or checked
   * (its outcome for `u` is not known yet: it covers `u`, nothing is paid again); 'settled' — its outcome is known
   * (then only a usable published take covers `u`; a take that failed, or a `cont` take a lone lead cannot use, leaves
   * the attempts to decide); 'stuck' — paid, but its download or finish failed every retry (not «recording» any more).
   * The outcome is known from the server's note of a finished job, or — for the owner's prefetch, and for a server job
   * whose finish did not complete — from the tools' store: a split that did not match (`requeued`), or every take of
   * `u` really checked (`checks`). A take processed but not yet verified, or verified while the recogniser could not
   * run, is still open: paying for a take 2 then would buy the same words twice.
   */
  private jobFor(job: LedgerJob, u: Pick<RenderedUnit, 'key' | 'text'>, k: Knowledge): 'open' | 'settled' | 'stuck' {
    if (job.state === 'pending') return 'open';
    if (k.notes.finished[job.jobId] !== undefined || k.lib.requeued.has(job.jobId)) return 'settled';
    const twins = this.twins(u);
    const ids = jobUnits(job.job)
      .filter((x) => x.text === u.text && twins.has(x.key))
      .map((x) => x.id);
    if (ids.length > 0 && ids.every((id) => k.lib.checks.has(id))) return 'settled';
    return k.notes.stuck[job.jobId] !== undefined ? 'stuck' : 'open';
  }

  /**
   * Where a unit stands (dedup by UNIT, S2): published (exact key or the text index; a lead said alone needs a take that
   * falls) → given up by the owner or the tools (by its words) → being recorded (the running job, a queued item, a
   * ledgered job still open for it, an unresolved intent — twins count as the same unit) → stuck → a starter-set take waiting
   * for the owner's ear → out of paid attempts (S6, both ledgers) → missing.
   */
  private unitState(u: UnitRef, k: Knowledge, o: { self?: boolean } = {}): UnitState {
    const merged = k.lib.merged;
    // under a twin's key too: the static library publishes a take under its own key only
    const takes = [...this.twins(u)].flatMap((key) => takesForUnit(merged, key, u.text)).filter((id) => !(u.alone === true && merged.units[id]?.ctx === 'cont'));
    if (takes.length > 0) return 'voiced';
    // `blocked[]` names keys; it holds for these words only when they were ever paid for (a shifted key starts afresh)
    if (k.lib.rejected.has(uid(u)) || (merged.blocked.has(u.key) && this.attemptsOf(u, k) > 0)) return 'given-up';
    const id = this.idOf(u);
    // `self`: the dedup of the job being recorded — its own units are «running», other queued items do not cover them
    if (o.self !== true) {
      if (this.running?.has(id)) return 'inflight';
      if (this.queue.some((w) => w.kind === 'record' && w.units.some((x) => this.idOf(x) === id))) return 'queued';
    }
    let stuck = false;
    for (const job of k.view.ledger.jobs.values()) {
      if (job.state === 'failed' || !this.holds(job.job, u)) continue;
      const state = this.jobFor(job, u, k);
      if (state === 'open') return 'inflight';
      if (state === 'stuck') stuck = true;
    }
    if (k.view.unresolved.some((intent) => this.holds(intent.job, u))) return 'inflight';
    if (stuck) return 'stuck';
    if (this.awaitsEar(u, k)) return 'ear';
    if (this.attemptsOf(u, k) >= this.maxAttempts(u, k)) return 'given-up';
    return 'missing';
  }

  /** Unit keys given up (attempts used up without a usable take, blocked, rejected) — for the parent's card. */
  private givenUp(k: Knowledge): number {
    const keys = new Set<string>(k.lib.merged.blocked);
    for (const id of k.lib.rejected) keys.add(id.slice(0, id.indexOf('|')));
    const seen = new Set<string>();
    for (const job of k.view.ledger.jobs.values()) {
      for (const piece of job.job.pieces) {
        if (isDiscard(piece) || keys.has(piece.key) || seen.has(uid(piece))) continue;
        seen.add(uid(piece));
        if (this.unitState(piece, k, { self: true }) === 'given-up') keys.add(piece.key);
      }
    }
    return keys.size;
  }

  /** Distinct phrases this server recorded on demand that the overlay publishes (the owner's prefetch not counted). */
  private recorded(k: Knowledge): number {
    const keys = new Set<string>();
    for (const job of k.view.ledger.jobs.values()) {
      if (job.campaign !== ONDEMAND_CAMPAIGN || job.state !== 'charged') continue;
      for (const x of jobUnits(job.job)) if (k.lib.overlayIds.has(x.id)) keys.add(x.key);
    }
    return keys.size;
  }

  /** Paid jobs whose download or finish failed every retry and that no finish has settled since. */
  private stuckJobs(k: Knowledge): string[] {
    return Object.keys(k.notes.stuck).filter((jobId) => k.view.ledger.jobs.get(jobId)?.state === 'charged' && k.notes.finished[jobId] === undefined);
  }

  /**
   * A paid job's download or finish failed every retry: noted in state.json, so its phrases stop saying «recording» and
   * the parent's card tells the owner. Nothing is paid again for them; the next start tries the job once more.
   */
  private markStuck(jobId: string, step: 'download' | 'finish'): void {
    const paths = this.o.overlay;
    if (paths === null) return;
    this.o.log(`[clip-gen] job ${jobId}: its ${step} failed every retry — its phrases wait for the next start of the server (nothing is paid again)`);
    this.safely(() =>
      updateOverlayState(paths.state, (s) => {
        s.stuck[jobId] = { at: new Date(this.o.now()).toISOString(), step };
      }),
    );
  }

  /** The checkout's tools ledger: its audit, its job ids (never adopted by the server) and its paid attempts. */
  private toolsLedger(): { audit: boolean; ids: ReadonlySet<string>; view: OnDemandView } {
    const file = this.o.toolsLedgerFile;
    if (file === null) return { audit: false, ids: new Set(), view: onDemandViewOf([]) };
    const stamp = fileStamp(file);
    if (this.toolsLedgerCache?.stamp !== stamp) {
      try {
        const view = readLedger(file);
        this.toolsLedgerCache = { stamp, audit: auditBlocked(view) !== null, ids: new Set(view.jobs.keys()), view: { ledger: view, unresolved: [] } };
      } catch {
        this.toolsLedgerCache = { stamp, audit: false, ids: new Set(), view: onDemandViewOf([]) };
      }
    }
    return this.toolsLedgerCache;
  }

  // ── the queue ──

  private enqueue(work: NewWork): void {
    this.queue.push({ ...work, seq: ++this.seq, at: this.o.now() } as Work);
  }

  /** Room for `n` new items: the lowest-priority, oldest items below `priority` give way. */
  private makeRoom(n: number, priority: number): boolean {
    const records = (): RecordWork[] => this.queue.filter((w): w is RecordWork => w.kind === 'record');
    while (records().length + n > QUEUE_MAX) {
      const victim = records()
        .filter((w) => w.priority < priority)
        .sort((a, b) => a.priority - b.priority || a.seq - b.seq)[0];
      if (!victim) return false;
      this.queue = this.queue.filter((w) => w !== victim);
    }
    return true;
  }

  private expire(now: number): void {
    this.queue = this.queue.filter((w) => w.kind !== 'record' || now - w.at <= ITEM_TTL_MS);
  }

  /**
   * The next item: the highest priority; among equals, a new recording newest first (see PRIORITY), any other step (a
   * resumed wait, download, finish — paid already) in its order.
   */
  private next(now: number): Work | null {
    let best: Work | null = null;
    const before = (a: Work, b: Work): boolean => (a.kind === 'record' && b.kind === 'record' ? a.seq > b.seq : a.seq < b.seq);
    for (const w of this.queue) {
      if (w.notBefore > now) continue;
      if (best === null || w.priority > best.priority || (w.priority === best.priority && before(w, best))) best = w;
    }
    return best;
  }

  private kick(): void {
    if (this.disposed) return;
    if (this.pumping !== null) {
      // the running pump may already be past its last look at the queue: run once more after it
      this.again = true;
      return;
    }
    this.again = false;
    this.pumping = this.pump()
      .catch((error: unknown) => this.o.log(`[clip-gen] queue stopped: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.pumping = null;
        if (this.again) this.kick();
      });
  }

  private wakeAt(at: number | null): void {
    if (!this.o.timers || this.disposed || at === null) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, Math.max(0, at - this.o.now()) + 50);
    this.timer.unref();
  }

  private async pump(): Promise<void> {
    while (!this.disposed) {
      const now = this.o.now();
      this.expire(now);
      const work = this.next(now);
      if (work === null) {
        const later = this.queue.reduce<number | null>((min, w) => (min === null || w.notBefore < min ? w.notBefore : min), null);
        this.wakeAt(later);
        return;
      }
      const gate = this.gate(this.knowledge(false), work.kind === 'record' ? 'spend' : 'free');
      if (gate !== null) {
        this.wakeAt(gate.off ? null : gate.until);
        return;
      }
      if (work.kind === 'record' && !(await this.toolsReady())) return;
      // a request may have queued something more urgent meanwhile: pick again
      if (this.next(this.o.now()) !== work) continue;
      this.queue = this.queue.filter((w) => w !== work);
      // from now on its units count as being recorded (a request in the meantime must not queue them again)
      if (work.kind === 'record') this.running = new Set(work.units.map((u) => this.idOf(u)));
      try {
        await this.perform(work);
      } catch (error) {
        this.o.log(`[clip-gen] ${work.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
        this.breaker.failure();
        this.retryLater(work);
      } finally {
        if (work.kind === 'record') this.running = null;
      }
    }
  }

  /**
   * Puts resumed work back for later (bounded); a failed new recording is dropped after one retry; a paid job whose
   * download or finish ran out of retries is noted as stuck (never dropped in silence).
   */
  private retryLater(work: Work): void {
    const notBefore = this.o.now() + RESUME_BACKOFF_MS;
    if (work.kind === 'record') {
      if (work.errors < MAX_RECORD_ERRORS) this.queue.push({ ...work, errors: work.errors + 1, notBefore });
    } else if (work.kind === 'download') {
      if (work.tries + 1 < MAX_DOWNLOAD_TRIES) this.queue.push({ ...work, tries: work.tries + 1, notBefore });
      else this.markStuck(work.jobId, 'download');
    } else if (work.kind === 'finish') {
      if (work.tries + 1 < MAX_FINISH_TRIES) this.queue.push({ ...work, tries: work.tries + 1, notBefore });
      else this.markStuck(work.jobId, 'finish');
    } else this.queue.push({ ...work, notBefore });
  }

  private async perform(work: Work): Promise<void> {
    switch (work.kind) {
      case 'record':
        return this.record(work);
      case 'adopt':
        return this.adopt(work);
      case 'wait':
        return this.resumeWait(work);
      case 'download': {
        const job = this.knowledge(true).view.ledger.jobs.get(work.jobId);
        if (job === undefined || job.state !== 'charged') return;
        if (job.master !== undefined) return this.finishOrRetry(job, 0);
        return this.downloadAndFinish(job, work.urlHint, work.tries);
      }
      case 'finish': {
        const job = this.knowledge(true).view.ledger.jobs.get(work.jobId);
        if (job === undefined || job.state !== 'charged') return;
        return this.finishOrRetry(job, work.tries);
      }
    }
  }

  // ── the paid steps ──

  private deps(): OnDemandDeps {
    return { runCli: this.o.runCli as RunCli, now: () => new Date(this.o.now()), sleep: this.o.sleep, random: this.o.random, log: this.o.log };
  }

  /**
   * The machine-wide generator lock, then the overlay ledger's own lock (the tools take both, in this order), without
   * waiting: the owner's tool or another server is busy → 'tool-busy'. The server never waits while holding a lock.
   */
  private async lock(): Promise<(() => void) | null> {
    const paths = this.o.overlay as OverlayPaths;
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    let releaseGlobal: () => void;
    try {
      releaseGlobal = await this.o.protocol.lockGlobal(paths.dir, { waitMs: 0 });
    } catch (error) {
      if (!(error instanceof LedgerLocked)) throw error;
      this.breaker.pause('tool-busy');
      return null;
    }
    try {
      const releaseLedger = lockLedger(paths.ledger);
      return () => {
        releaseLedger();
        releaseGlobal();
      };
    } catch (error) {
      releaseGlobal();
      if (!(error instanceof LedgerLocked)) throw error;
      this.breaker.pause('tool-busy');
      return null;
    }
  }

  private pause(reason: BreakerReason, until?: number | null): void {
    this.breaker.pause(reason, until);
    this.o.log(`[clip-gen] paused: ${reason}`);
  }

  /** Unresolved intents first: until they are known, their jobs may exist (and count at full price). */
  private async resolveIntents(k: Knowledge): Promise<boolean> {
    if (k.view.unresolved.length === 0) return true;
    const summary = await this.o.protocol.adoptIntents({ ledgerFile: (this.o.overlay as OverlayPaths).ledger, run: this.run, knownJobIds: this.toolsLedger().ids }, this.deps());
    for (const adopted of summary.adopted) this.enqueue({ kind: 'wait', jobId: adopted.jobId, since: this.o.now(), priority: PRIORITY.resume, notBefore: 0 });
    if (summary.duplicate.length > 0) {
      this.pause('duplicate', null);
      return false;
    }
    if (summary.open.length > 0) {
      this.pause('unresolved');
      this.enqueue({ kind: 'adopt', priority: PRIORITY.resume, notBefore: this.o.now() + RESUME_BACKOFF_MS });
      return false;
    }
    return true;
  }

  private async adopt(_work: Work): Promise<void> {
    const release = await this.lock();
    if (release === null) {
      this.enqueue({ kind: 'adopt', priority: PRIORITY.resume, notBefore: this.o.now() + RESUME_BACKOFF_MS });
      return;
    }
    try {
      await this.resolveIntents(this.knowledge(true));
    } finally {
      release();
    }
  }

  /** The free model check, once per process: a changed model stops everything until the owner looks. */
  private async modelOk(): Promise<boolean> {
    if (this.modelChecked) return true;
    const runCli = this.o.runCli as RunCli;
    let last: CliResult | null = null;
    const spy: RunCli = async (args) => (last = await runCli(args));
    const problem = await modelProblem(spy);
    if (problem === null) {
      this.modelChecked = true;
      return true;
    }
    const result = last as CliResult | null;
    if (result !== null && isAuthProblem(result)) this.pause('login');
    else if (result !== null && isRateLimited(result)) this.pause('rate');
    else if (result !== null && result.code !== 0) this.breaker.failure();
    else {
      this.o.log(`[clip-gen] the Higgsfield model changed: ${problem}`);
      this.pause('model', null);
    }
    return false;
  }

  /** The server's own price (free) must equal the SPEC price the ledger and the caps count with. */
  private async priceOk(prompt: string, milli: number): Promise<boolean> {
    try {
      const server = await serverCostMilli(this.o.runCli as RunCli, prompt);
      if (server === milli) return true;
      this.o.log(`[clip-gen] price changed: Higgsfield asks ${server / 1000}, the SPEC price is ${milli / 1000} credits`);
      this.pause('price', null);
      return false;
    } catch (error) {
      const result = error instanceof CliError ? error.result : null;
      if (result !== null && isAuthProblem(result)) this.pause('login');
      else if (result !== null && isRateLimited(result)) this.pause('rate');
      else this.breaker.failure();
      return false;
    }
  }

  private async record(work: RecordWork): Promise<void> {
    const release = await this.lock();
    if (release === null) {
      this.queue.push(work);
      return;
    }
    let charged: { job: LedgerJob; urlHint: string } | null = null;
    try {
      let k = this.knowledge(true);
      if (!(await this.resolveIntents(k))) {
        this.queue.push(work);
        return;
      }
      k = this.knowledge(true);
      if (auditBlocked(k.view.ledger) !== null || this.toolsLedger().audit) {
        this.o.log('[clip-gen] a balance audit failed — nothing is recorded until the owner has looked (voice:generate --accept-audit)');
        this.pause('audit', null);
        this.queue.push(work);
        return;
      }
      // dedup again on the fresh ledger: another instance (or the owner's prefetch) may have recorded some units
      const units = work.units.filter((u) => this.unitState(u, k, { self: true }) === 'missing');
      if (units.length === 0) return;
      const [first, ...rest] = packUnits(groupsOf(units));
      if (first === undefined) return;
      const take = ONDEMAND_TAKE_BASE + Math.max(0, ...first.map((u) => this.attemptsOf(u, k)));
      const built = buildJob(first, take);
      if (built === null) {
        this.o.log('[clip-gen] a job was dropped: its prompt is not valid');
        return;
      }
      // a subset of a valid pack is one pack; should it ever not be, the rest waits for its own turn — queued only once
      // this pack has left the queue for good (a requeue below puts back the whole item)
      const queueRest = (): void => {
        for (const more of rest) {
          const next = buildJob(more, ONDEMAND_TAKE_BASE);
          if (next !== null) this.queue.push({ ...work, seq: ++this.seq, units: more, milli: next.milli });
        }
      };
      // the caps, on the fresh ledger, under the lock: every other generator's intent is already in it (S1)
      const now = this.o.now();
      const cap = capReached(spendOf(k.view, new Date(now)), built.milli, this.caps());
      if (cap !== null) {
        this.capHold = { reason: cap, until: cap === 'day-cap' ? nextLocalMidnight(now) : null };
        this.o.log(`[clip-gen] ${cap === 'day-cap' ? 'the daily cap' : 'the budget'} is reached — nothing more is recorded ${cap === 'day-cap' ? 'today' : 'until the owner raises CLIP_GEN_BUDGET'}`);
        this.queue.push(work);
        return;
      }
      this.running = new Set(first.map((u) => this.idOf(u)));
      if (!(await this.modelOk()) || !(await this.priceOk(built.job.prompt, built.milli))) {
        // a pause holds the queue anyway; a plain failure is not retried at once
        this.queue.push({ ...work, notBefore: this.o.now() + RESUME_BACKOFF_MS });
        return;
      }
      // the probes above take seconds: the parent may have switched recording off meanwhile (or the server is shutting
      // down) — the gates again, right before the paid call; the work goes back untouched, no intent is written
      if (this.disposed || this.gate(this.knowledge(false), 'spend') !== null) {
        this.queue.push(work);
        return;
      }
      const created = await this.o.protocol.createJob(
        { ledgerFile: (this.o.overlay as OverlayPaths).ledger, campaign: ONDEMAND_CAMPAIGN, run: this.run, job: built.job, milli: built.milli, knownJobIds: this.toolsLedger().ids },
        this.deps(),
      );
      if (!created.ok) {
        // an ambiguous create (its intent covers this pack) or a duplicate: the rest is still to do
        if (created.reason === 'unresolved' || created.reason === 'duplicate') queueRest();
        this.createFailed(work, created);
        return;
      }
      queueRest();
      const job = this.knowledge(true).view.ledger.jobs.get(created.jobId);
      if (job === undefined) throw new Error(`created job ${created.jobId} is not in the ledger`);
      let waited: Awaited<ReturnType<ClipGenService['waitFor']>>;
      try {
        waited = await this.waitFor(job);
      } catch (error) {
        // the job exists and may be charged: it is waited for again later, never re-created
        this.o.log(`[clip-gen] waiting for ${job.jobId} failed: ${error instanceof Error ? error.message : String(error)}`);
        waited = { state: 'pending' };
      }
      if (waited.state === 'charged') charged = { job: this.knowledge(true).view.ledger.jobs.get(job.jobId) ?? job, urlHint: waited.url };
      else if (waited.state === 'failed') {
        // the provider made no audio (not charged): the units are free again; one more try
        this.breaker.failure();
        if (work.errors < MAX_RECORD_ERRORS) this.queue.push({ ...work, units: first, milli: built.milli, errors: work.errors + 1, notBefore: this.o.now() + RESUME_BACKOFF_MS });
      } else {
        if (waited.state === 'login') this.pause('login');
        this.enqueue({ kind: 'wait', jobId: job.jobId, since: this.o.now(), priority: PRIORITY.resume, notBefore: this.o.now() + RESUME_BACKOFF_MS });
      }
    } finally {
      release();
      if (charged === null) this.running = null;
    }
    if (charged === null) return;
    try {
      await this.downloadAndFinish(charged.job, charged.urlHint, 0);
    } finally {
      this.running = null;
    }
  }

  private createFailed(work: RecordWork, created: Extract<CreateOutcome, { ok: false }>): void {
    this.o.log(`[clip-gen] create: ${created.reason}`);
    switch (created.reason) {
      case 'rate':
      case 'no-credits':
      case 'login':
        this.pause(created.reason);
        this.queue.push(work);
        return;
      case 'unresolved':
        // the intent counts at full price and covers its units until list adoption resolves it; ambiguous creates in a
        // row are a failure streak like any other
        this.pause('unresolved');
        this.breaker.failure();
        this.enqueue({ kind: 'adopt', priority: PRIORITY.resume, notBefore: this.o.now() + RESUME_BACKOFF_MS });
        return;
      case 'duplicate':
        this.pause('duplicate', null);
        return;
      case 'error':
        this.breaker.failure();
        if (work.errors < MAX_RECORD_ERRORS) this.queue.push({ ...work, errors: work.errors + 1, notBefore: this.o.now() + RESUME_BACKOFF_MS });
        return;
    }
  }

  private append(line: Parameters<typeof appendLedger>[1]): void {
    appendLedger((this.o.overlay as OverlayPaths).ledger, line);
  }

  /** `generate wait --interval 1s` until the job ends (free; a 5xx / rate limit is waited out). */
  private async waitFor(job: LedgerJob): Promise<{ state: 'charged'; url: string } | { state: 'failed' | 'pending' | 'login' }> {
    const at = (): string => new Date(this.o.now()).toISOString();
    const runCli = this.o.runCli as RunCli;
    for (let attempt = 1; attempt <= MAX_WAIT_TRIES; attempt++) {
      const result = await runCli(waitArgs(job.jobId, { timeout: SERVER_WAIT_TIMEOUT }));
      if (isRateLimited(result) || (isTransient(result) && attempt < MAX_WAIT_TRIES)) {
        await this.o.sleep(backoffMs(attempt, this.o.random));
        continue;
      }
      if (isAuthProblem(result)) return { state: 'login' };
      const hf = result.code === 0 ? parseJobs(result.stdout).find((j) => j.id === job.jobId) : undefined;
      if (hf === undefined) {
        this.append({ ev: 'error', at: at(), run: this.run, key: job.key, jobId: job.jobId, stage: 'wait', message: firstLine(result.stderr) || `exit ${result.code}` });
        return { state: 'pending' };
      }
      if (hf.status === DONE_OK && hf.resultUrl !== null) {
        this.append({ ev: 'charged', at: at(), key: job.key, jobId: job.jobId, campaign: job.campaign, milli: job.milli, status: hf.status, resultUrl: hf.resultUrl });
        return { state: 'charged', url: hf.resultUrl };
      }
      if (DONE_FAILED.has(hf.status)) {
        this.append({ ev: 'failed', at: at(), key: job.key, jobId: job.jobId, campaign: job.campaign, status: hf.status });
        return { state: 'failed' };
      }
      this.append({ ev: 'error', at: at(), run: this.run, key: job.key, jobId: job.jobId, stage: 'wait', message: `still ${hf.status} after wait` });
      return { state: 'pending' };
    }
    return { state: 'pending' };
  }

  /** A resumed pending job: wait under the lock (never re-create), then download and finish. */
  private async resumeWait(work: Extract<Work, { kind: 'wait' }>): Promise<void> {
    const pending = this.knowledge(true).view.ledger.jobs.get(work.jobId);
    if (pending === undefined || pending.state === 'failed') return;
    if (pending.state === 'charged') {
      this.enqueue({ kind: 'download', jobId: pending.jobId, tries: 0, priority: PRIORITY.resume, notBefore: 0 });
      return;
    }
    const release = await this.lock();
    if (release === null) {
      this.queue.push({ ...work, notBefore: this.o.now() + RESUME_BACKOFF_MS });
      return;
    }
    let charged: { job: LedgerJob; url: string } | null = null;
    try {
      const waited = await this.waitFor(pending);
      if (waited.state === 'charged') charged = { job: this.knowledge(true).view.ledger.jobs.get(pending.jobId) ?? pending, url: waited.url };
      else if (waited.state === 'pending' || waited.state === 'login') {
        if (waited.state === 'login') this.pause('login');
        if (this.o.now() - work.since < WAIT_GIVE_UP_MS) this.queue.push({ ...work, notBefore: this.o.now() + RESUME_BACKOFF_MS });
        else this.o.log(`[clip-gen] job ${pending.jobId} is still pending after an hour — it stays in the ledger (counted in full) until the next start`);
      }
    } finally {
      release();
    }
    if (charged !== null) await this.downloadAndFinish(charged.job, charged.url, 0);
  }

  private async downloadAndFinish(job: LedgerJob, urlHint: string | undefined, tries: number): Promise<void> {
    const paths = this.o.overlay as OverlayPaths;
    mkdirSync(paths.masters, { recursive: true, mode: 0o700 });
    const ok = await this.o.protocol.downloadJob(
      { ledgerFile: paths.ledger, mastersDir: paths.masters, run: this.run, job, ...(urlHint !== undefined ? { urlHint } : {}) },
      { runCli: this.o.runCli as RunCli, now: () => new Date(this.o.now()), log: this.o.log, download: this.o.download },
    );
    if (!ok) {
      this.breaker.failure();
      if (tries + 1 < MAX_DOWNLOAD_TRIES) this.enqueue({ kind: 'download', jobId: job.jobId, tries: tries + 1, priority: PRIORITY.resume, notBefore: this.o.now() + RESUME_BACKOFF_MS });
      else this.markStuck(job.jobId, 'download');
      return;
    }
    const downloaded = this.knowledge(true).view.ledger.jobs.get(job.jobId) ?? job;
    await this.finishOrRetry(downloaded, 0);
  }

  private async finishOrRetry(job: LedgerJob, tries: number): Promise<void> {
    const later = (next: number): void => {
      if (next < MAX_FINISH_TRIES) this.enqueue({ kind: 'finish', jobId: job.jobId, tries: next, priority: PRIORITY.resume, notBefore: this.o.now() + RESUME_BACKOFF_MS });
      else this.markStuck(job.jobId, 'finish');
    };
    if (!(await this.toolsReady())) {
      // nothing unchecked is ever published: the finish waits for ffmpeg / whisper (not a failure)
      this.enqueue({ kind: 'finish', jobId: job.jobId, tries, priority: PRIORITY.resume, notBefore: (this.tools?.at ?? this.o.now()) + TOOLS_PROBE_MS });
      return;
    }
    try {
      // another instance is publishing: not a failure, just later
      if (!(await this.finishJob(job))) return later(tries);
      this.breaker.success();
    } catch (error) {
      this.o.log(`[clip-gen] finish of ${job.jobId} failed: ${error instanceof Error ? error.message : String(error)}`);
      this.breaker.failure();
      later(tries + 1);
    }
  }

  /** Another instance may be publishing into the same overlay: wait a little for its lock (null = still busy). */
  private async publishLock(): Promise<(() => void) | null> {
    const paths = this.o.overlay as OverlayPaths;
    for (let attempt = 0; attempt < PUBLISH_LOCK_TRIES; attempt++) {
      const release = tryLockFile(paths.publishLock);
      if (release !== null) return release;
      await this.o.sleep(250);
    }
    return null;
  }

  /**
   * Process + verify + publish one charged, downloaded job (under the overlay's publish lock), note which of its units
   * failed the check, and give each such unit its one paid take 2 — alone, so no split can fail it again. false = the
   * publish lock stayed busy (retried later).
   */
  private async finishJob(job: LedgerJob): Promise<boolean> {
    const paths = this.o.overlay as OverlayPaths;
    const units = jobUnits(job.job);
    const release = await this.publishLock();
    if (release === null) return false;
    let failed: { key: string; text: string }[];
    try {
      const result = await this.o.finish({ jobId: job.jobId, units });
      const published = new Set(result.published);
      failed = units.filter((u) => !published.has(u.id));
      const at = new Date(this.o.now()).toISOString();
      updateOverlayState(paths.state, (s) => {
        s.finished[job.jobId] = { at, failed: failed.map((u) => u.key) };
        delete s.stuck[job.jobId];
      });
    } finally {
      release();
    }
    if (failed.length > 0) this.o.log(`[clip-gen] ${failed.length} of ${units.length} new phrase(s) did not pass the check`);
    const k = this.knowledge(true);
    for (const f of failed) {
      const unit = unitFromPiece(f);
      // `self`: this job's units are still marked as running
      if (unit === null || this.unitState(unit, k, { self: true }) !== 'missing') continue;
      const built = buildJob([unit], ONDEMAND_TAKE_BASE + this.attemptsOf(unit, k));
      if (built !== null) this.enqueue({ kind: 'record', units: [unit], milli: built.milli, errors: 0, priority: PRIORITY.rerender, notBefore: 0 });
    }
    return true;
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.o.log(`[clip-gen] cannot write the overlay notes: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '')
      ?.slice(0, 300) ?? ''
  );
}

// ───────────────────────── wiring (context.ts) ─────────────────────────

/** The real downloader: the injected fetch (tests: one that throws), 30 s, an MP3 check, tmp file + rename. */
export function fetchDownloader(fetchImpl: typeof fetch): Downloader {
  return async (url, dest) => {
    if (!/^https:\/\//i.test(url)) throw new Error('download: not an https URL');
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`download ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!looksLikeMp3(bytes)) throw new Error(`download is not an MP3 (${bytes.length} bytes)`);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = `${dest}.${process.pid}.part`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, dest);
    return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
}

export interface ClipGenWiring {
  config: ServerConfig;
  db: Db;
  nickname: () => string | null;
  fetchImpl: typeof fetch;
  log: (line: string) => void;
  overrides?: ClipGenOverrides;
}

/** Builds the service from the config (context.ts). Under vitest nothing real can run: no CLI, no finish, no probe. */
export function createClipGenService(w: ClipGenWiring): ClipGenService {
  const { config } = w;
  const cg = config.clipGen;
  const ov = w.overrides ?? {};
  const fake = ov.runCli !== undefined;
  const underTest = Boolean(process.env.VITEST);
  // defence in depth: a config built by hand skipped loadConfig's overlay check
  const overlayDir = cg.overlayDir !== null && overlayDirProblem(cg.overlayDir, config) === null ? cg.overlayDir : null;
  const overlay = overlayDir === null ? null : overlayPaths(overlayDir);
  const runner = new ChildRunner();
  // the real CLI never runs under vitest (S5): a test injects a fake runner or has no CLI at all
  const bin = fake || underTest ? null : cg.bin;
  const runCli = ov.runCli ?? (bin !== null ? higgsfieldRunCli(bin, runner) : null);
  const tempRoots = fake && ov.tempRoots !== undefined ? ov.tempRoots : defaultTempRoots();
  const refuse = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} is not available under vitest (inject a fake)`);
  };
  const finish: FinishFn = ov.finish ?? (overlay !== null && !underTest ? createToolsFinish({ repoRoot: config.repoRoot, overlay, workDir: join(tmpdir(), 'gambit-clipgen'), runner, log: w.log }) : refuse('the finish'));
  const protocol: ClipGenProtocol = { createJob, adoptIntents, downloadJob, lockGlobal, ...ov.protocol };
  const staticLibraryDir = ov.staticLibraryDir !== undefined ? ov.staticLibraryDir : join(config.repoRoot, 'apps', 'web', 'public', 'voice');
  const toolsLedgerFile = ov.toolsLedgerFile !== undefined ? ov.toolsLedgerFile : join(config.repoRoot, 'tools', 'voice-clips', `ledger.${VOICE_KEY}.jsonl`);
  if (cg.enabled && cg.overlayProblem !== null) w.log(`[clip-gen] VOICE_OVERLAY_DIR refused (${cg.overlayProblem}): it must be an absolute folder outside every checkout, DATA_DIR and the web build`);
  return new ClipGenService({
    config,
    dataDirIsTemp: isTempDir(config.dataDir, tempRoots),
    overlay,
    settings: new ClipGenSettingsStore(w.db, cg.dailyMaxMilli),
    nickname: w.nickname,
    staticLibraryDir,
    toolsLedgerFile,
    runCli,
    download: ov.download ?? (underTest && !fake ? refuse('a download') : fetchDownloader(w.fetchImpl)),
    finish,
    protocol,
    toolsProblem: ov.toolsProblem ?? (underTest ? async () => 'tools are not probed under vitest' : () => toolsProblem(runner)),
    now: ov.now ?? Date.now,
    sleep: ov.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: ov.random ?? Math.random,
    log: w.log,
    timers: ov.timers ?? true,
    disposeChildren: () => runner.dispose(),
  });
}
