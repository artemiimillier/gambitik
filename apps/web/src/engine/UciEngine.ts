import type { EngineLine } from '@gambit/shared';
import { LineCollector, isCriticalErrorLine, isUciMove, parseBestmoveLine, parseInfoLine } from './parseUci.ts';
import { DEFAULT_ENGINE_URL, EngineError } from './types.ts';
import type {
  EngineErrorCode,
  EngineTransport,
  EngineTransportFactory,
  SearchRequest,
  SearchResult,
  UciOptionValue,
} from './types.ts';
import { createWorkerTransport } from './workerTransport.ts';

export interface UciEngineConfig {
  /** URL of the classic Stockfish worker. Ignored when `createTransport` is given. */
  workerUrl?: string;
  /** Transport factory; called for the first use and again after every fatal error. */
  createTransport?: EngineTransportFactory;
  /** UCI options applied during every handshake (so they survive an automatic restart). */
  options?: Record<string, UciOptionValue>;
  /** Max time for `uci` → `uciok` and `isready` → `readyok` (each). Default 20 s (covers the WASM download). */
  handshakeTimeoutMs?: number;
  /** Watchdog for searches without a movetime. Default 30 s. */
  defaultWatchdogMs?: number;
  /** Grace added to `movetimeMs` to form the watchdog. Default 5 s. */
  movetimeGraceMs?: number;
  /** How long a stopped search may take to deliver its final `bestmove`. Default 2 s. */
  stopTimeoutMs?: number;
  /** Depth used when a request has no depth / movetime / nodes limit. Default 12. */
  defaultDepth?: number;
  now?: () => number;
}

const DEFAULTS = {
  handshakeTimeoutMs: 20_000,
  defaultWatchdogMs: 30_000,
  movetimeGraceMs: 5_000,
  stopTimeoutMs: 2_000,
  defaultDepth: 12,
} as const;

type Timer = ReturnType<typeof setTimeout>;

interface SearchTask {
  kind: 'search';
  request: SearchRequest;
  cancelled: boolean;
  resolve: (result: SearchResult) => void;
  reject: (error: EngineError) => void;
}

interface CommandTask {
  kind: 'command';
  commands: string[];
  cancelled: boolean;
  resolve: () => void;
  reject: (error: EngineError) => void;
}

type Task = SearchTask | CommandTask;

interface ActiveSearch {
  task: SearchTask;
  collector: LineCollector;
  startedAt: number;
  /** The caller's promise is already settled (stop / timeout / crash); we only wait for the engine to go idle. */
  settled: boolean;
  timer: Timer | null;
  /** Resolves when the engine is idle again (bestmove seen) or the transport was killed. */
  release: () => void;
}

interface Waiter {
  token: string;
  resolve: () => void;
  reject: (error: EngineError) => void;
  timer: Timer;
}

function positiveInt(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  return rounded >= 1 ? rounded : null;
}

/** `position fen <fen> [moves ...]`. Whitespace is normalised so a FEN can never smuggle a second command. */
export function buildPositionCommand(request: Pick<SearchRequest, 'fen' | 'moves'>): string {
  const fen = request.fen.replace(/\s+/g, ' ').trim();
  const moves = request.moves ?? [];
  for (const move of moves) {
    if (!isUciMove(move)) throw new EngineError('critical-error', `not a UCI move: "${move}"`);
  }
  return moves.length > 0 ? `position fen ${fen} moves ${moves.join(' ')}` : `position fen ${fen}`;
}

/**
 * `go depth D movetime T nodes N searchmoves ...` — limits may be combined (the engine stops at the first one hit).
 * `searchmoves` MUST stay last: Stockfish treats every following token as a move.
 */
export function buildGoCommand(
  request: Pick<SearchRequest, 'depth' | 'movetimeMs' | 'nodes' | 'searchmoves'>,
  defaultDepth: number = DEFAULTS.defaultDepth,
): string {
  const parts: string[] = ['go'];
  const depth = positiveInt(request.depth);
  const movetime = positiveInt(request.movetimeMs);
  const nodes = positiveInt(request.nodes);
  if (depth !== null) parts.push('depth', String(depth));
  if (movetime !== null) parts.push('movetime', String(movetime));
  if (nodes !== null) parts.push('nodes', String(nodes));
  if (depth === null && movetime === null && nodes === null) parts.push('depth', String(defaultDepth));
  const searchmoves = request.searchmoves ?? [];
  if (searchmoves.length > 0) {
    for (const move of searchmoves) {
      if (!isUciMove(move)) throw new EngineError('invalid-searchmoves', `not a UCI move: "${move}"`);
    }
    parts.push('searchmoves', ...searchmoves);
  }
  return parts.join(' ');
}

function formatOption(name: string, value: UciOptionValue): string {
  const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();
  return `setoption name ${clean(name)} value ${clean(String(value))}`;
}

/**
 * Text-UCI wrapper around one Stockfish instance.
 *
 * - Searches are serialised: one `go` at a time, the next starts only after `bestmove`.
 * - Stockfish 19 WASM does NOT die on a bad position: it prints `info string CRITICAL ERROR` and then either
 *   searches some OTHER position or never answers the `go`. The search is rejected at once and the worker recycled.
 * - `bestmove (none)` rejects. A watchdog rejects and recycles the worker when `bestmove` never arrives.
 * - `stop()` rejects the running search immediately (with the partial lines) and every queued search.
 * - One UciEngine = one worker = one hash table. Never share an instance between the bot and the judge.
 */
export class UciEngine {
  private readonly factory: EngineTransportFactory;
  private readonly options: Map<string, UciOptionValue>;
  private readonly handshakeTimeoutMs: number;
  private readonly defaultWatchdogMs: number;
  private readonly movetimeGraceMs: number;
  private readonly stopTimeoutMs: number;
  private readonly defaultDepth: number;
  private readonly now: () => number;

  private transport: EngineTransport | null = null;
  private generation = 0;
  private initPromise: Promise<void> | null = null;
  private waiter: Waiter | null = null;
  private readonly queue: Task[] = [];
  private running: Task | null = null;
  private active: ActiveSearch | null = null;
  private pumping = false;
  private tainted = false;
  private disposed = false;
  private restarts = 0;

  constructor(source?: string | UciEngineConfig) {
    const config: UciEngineConfig = typeof source === 'string' ? { workerUrl: source } : (source ?? {});
    const url = config.workerUrl ?? DEFAULT_ENGINE_URL;
    this.factory = config.createTransport ?? (() => createWorkerTransport(url));
    this.options = new Map(Object.entries(config.options ?? {}));
    this.handshakeTimeoutMs = config.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs;
    this.defaultWatchdogMs = config.defaultWatchdogMs ?? DEFAULTS.defaultWatchdogMs;
    this.movetimeGraceMs = config.movetimeGraceMs ?? DEFAULTS.movetimeGraceMs;
    this.stopTimeoutMs = config.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs;
    this.defaultDepth = config.defaultDepth ?? DEFAULTS.defaultDepth;
    this.now = config.now ?? (() => performance.now());
  }

  /** How many times the worker had to be recreated after a fatal error (diagnostics). */
  get restartCount(): number {
    return this.restarts;
  }

  /** True while a search is running inside the engine. */
  get busy(): boolean {
    return this.active !== null;
  }

  /** Creates the worker if needed and completes the `uci` / `isready` handshake. */
  ready(): Promise<void> {
    if (this.disposed) return Promise.reject(new EngineError('disposed', 'engine disposed'));
    return this.ensureTransport();
  }

  /**
   * Sets a UCI option. The value is remembered and re-applied after an automatic restart.
   * Applied between searches (never in the middle of one). Safe to ignore the returned promise.
   */
  setOption(name: string, value: UciOptionValue): Promise<void> {
    this.options.set(name, value);
    // Not started yet: the handshake will apply it.
    if (this.transport === null && this.initPromise === null) return Promise.resolve();
    return this.enqueueCommands([formatOption(name, value)]);
  }

  /** `ucinewgame` (clears the hash). Queued behind running searches. */
  newGame(): Promise<void> {
    return this.enqueueCommands(['ucinewgame']);
  }

  search(request: SearchRequest): Promise<SearchResult> {
    if (this.disposed) return Promise.reject(new EngineError('disposed', 'engine disposed'));
    return new Promise<SearchResult>((resolve, reject) => {
      this.queue.push({ kind: 'search', request, cancelled: false, resolve, reject });
      void this.pump();
    });
  }

  /** Cancels the running search and every queued search; all of them reject with code 'stopped'. */
  stop(): void {
    for (const task of this.queue) {
      if (task.kind === 'search' && !task.cancelled) this.cancelTask(task, 'stopped', 'search superseded by stop()');
    }
    const running = this.running;
    if (running !== null && running.kind === 'search' && !running.cancelled && this.active === null) {
      // Still waiting for the handshake: never reaches the engine.
      this.cancelTask(running, 'stopped', 'search superseded by stop()');
    }
    const active = this.active;
    if (active !== null && !active.settled) {
      this.settleActive(active, new EngineError('stopped', 'search superseded by stop()', this.partialResult(active)));
      this.transport?.post('stop');
      // The engine answers `stop` with a final bestmove almost instantly; if it does not, it is hung.
      active.timer = setTimeout(() => this.killTransport(true), this.stopTimeoutMs);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = (): EngineError => new EngineError('disposed', 'engine disposed');
    for (const task of this.queue.splice(0)) {
      if (!task.cancelled) {
        task.cancelled = true;
        task.reject(error());
      }
    }
    if (this.running !== null && !this.running.cancelled && this.active === null) {
      this.running.cancelled = true;
      this.running.reject(error());
    }
    if (this.active !== null && !this.active.settled) this.settleActive(this.active, error());
    this.killTransport(false, error());
  }

  // ───────────────────────── internals ─────────────────────────

  private enqueueCommands(commands: string[]): Promise<void> {
    if (this.disposed) return Promise.reject(new EngineError('disposed', 'engine disposed'));
    const promise = new Promise<void>((resolve, reject) => {
      this.queue.push({ kind: 'command', commands, cancelled: false, resolve, reject });
      void this.pump();
    });
    // Callers may fire-and-forget; awaiting callers still observe the rejection.
    promise.catch(() => undefined);
    return promise;
  }

  private cancelTask(task: Task, code: EngineErrorCode, message: string): void {
    task.cancelled = true;
    task.reject(new EngineError(code, message));
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.disposed) {
        const task = this.queue.shift();
        if (task === undefined) break;
        if (task.cancelled) continue;
        this.running = task;
        try {
          await this.runTask(task);
        } finally {
          this.running = null;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runTask(task: Task): Promise<void> {
    if (this.tainted) this.killTransport(true);
    try {
      await this.ensureTransport();
    } catch (error) {
      if (!task.cancelled) {
        task.cancelled = true;
        task.reject(error instanceof EngineError ? error : new EngineError('init-failed', String(error)));
      }
      return;
    }
    if (task.cancelled || this.disposed) return;
    if (task.kind === 'command') await this.runCommands(task);
    else await this.runSearch(task);
  }

  private async runCommands(task: CommandTask): Promise<void> {
    const transport = this.transport;
    if (transport === null) {
      task.reject(new EngineError('worker-error', 'engine transport unavailable'));
      return;
    }
    try {
      await this.expect('readyok', () => {
        for (const command of task.commands) transport.post(command);
        transport.post('isready');
      });
      task.resolve();
    } catch (error) {
      this.killTransport(true);
      task.reject(error instanceof EngineError ? error : new EngineError('worker-error', String(error)));
    }
  }

  private runSearch(task: SearchTask): Promise<void> {
    const transport = this.transport;
    if (transport === null) {
      task.reject(new EngineError('worker-error', 'engine transport unavailable'));
      return Promise.resolve();
    }
    const request = task.request;
    let position: string;
    let go: string;
    try {
      position = buildPositionCommand(request);
      go = buildGoCommand(request, this.defaultDepth);
    } catch (error) {
      task.reject(error instanceof EngineError ? error : new EngineError('critical-error', String(error)));
      return Promise.resolve();
    }
    const multipv = Math.min(256, positiveInt(request.multipv) ?? 1);
    const movetime = positiveInt(request.movetimeMs);
    const watchdogMs =
      positiveInt(request.watchdogMs) ?? (movetime !== null ? movetime + this.movetimeGraceMs : this.defaultWatchdogMs);

    return new Promise<void>((release) => {
      const active: ActiveSearch = {
        task,
        collector: new LineCollector(),
        startedAt: this.now(),
        settled: false,
        timer: null,
        release,
      };
      this.active = active;
      active.timer = setTimeout(() => this.onWatchdog(active, watchdogMs), watchdogMs);
      transport.post(`setoption name MultiPV value ${multipv}`);
      transport.post(position);
      transport.post(go);
    });
  }

  private onWatchdog(active: ActiveSearch, watchdogMs: number): void {
    if (this.active !== active) return;
    active.timer = null;
    if (!active.settled) {
      this.settleActive(
        active,
        new EngineError('timeout', `no bestmove within ${watchdogMs} ms`, this.partialResult(active)),
      );
    }
    this.killTransport(true);
  }

  private handleLine(rawLine: string, generation: number): void {
    if (generation !== this.generation || this.disposed) return;
    const line = rawLine.trim();
    if (line.length === 0) return;

    const waiter = this.waiter;
    if (waiter !== null && line === waiter.token) {
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve();
      return;
    }

    if (isCriticalErrorLine(line)) {
      // Stockfish 19 WASM survives a rejected command, but its state no longer matches what we asked for:
      // depending on timing the following `go` searches some OTHER position or is silently dropped (no
      // `bestmove` at all — observed with the real worker build). Never wait for it: fail the search now
      // and recycle the worker.
      const active = this.active;
      if (active === null) {
        this.tainted = true;
        return;
      }
      if (!active.settled) this.settleActive(active, new EngineError('critical-error', line));
      this.killTransport(true);
      return;
    }

    const active = this.active;
    if (active === null) return;

    const info = parseInfoLine(line);
    if (info !== null) {
      if (active.collector.add(info) && !active.settled) {
        const onInfo = active.task.request.onInfo;
        if (onInfo !== undefined) {
          try {
            onInfo(active.collector.snapshot());
          } catch {
            // A faulty progress listener must never break the search.
          }
        }
      }
      return;
    }

    const best = parseBestmoveLine(line);
    if (best === null) return;

    if (active.timer !== null) clearTimeout(active.timer);
    active.timer = null;
    this.active = null;
    if (!active.settled) {
      active.settled = true;
      if (best.bestmove === null) {
        active.task.reject(new EngineError('no-move', 'engine returned "bestmove (none)"'));
      } else {
        const partial = this.partialResult(active);
        active.task.resolve({ ...partial, bestmove: best.bestmove, ponder: best.ponder });
      }
    }
    active.release();
  }

  private handleTransportError(error: Error, generation: number): void {
    if (generation !== this.generation || this.disposed) return;
    this.killTransport(true, new EngineError('worker-error', error.message));
  }

  private settleActive(active: ActiveSearch, error: EngineError): void {
    if (active.settled) return;
    active.settled = true;
    active.task.cancelled = true;
    if (active.timer !== null) clearTimeout(active.timer);
    active.timer = null;
    active.task.reject(error);
  }

  private partialResult(active: ActiveSearch): SearchResult {
    const lines: EngineLine[] = active.collector.snapshot();
    const best = lines[0];
    return {
      fen: active.task.request.fen,
      lines,
      bestmove: best?.pvUci[0] ?? '',
      ponder: best?.pvUci[1] ?? null,
      depth: best?.depth ?? 0,
      timeMs: Math.max(0, Math.round(this.now() - active.startedAt)),
    };
  }

  /**
   * Terminates the current transport. Pending waiters / searches are rejected with `reason`
   * (default: worker-error). With `countRestart` the next task transparently creates a fresh worker.
   */
  private killTransport(countRestart: boolean, reason?: EngineError): void {
    const transport = this.transport;
    this.generation += 1;
    this.transport = null;
    this.initPromise = null;
    this.tainted = false;
    if (transport !== null && countRestart) this.restarts += 1;

    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(reason ?? new EngineError('worker-error', 'engine worker was restarted'));
    }
    const active = this.active;
    if (active !== null) {
      this.active = null;
      if (!active.settled) this.settleActive(active, reason ?? new EngineError('worker-error', 'engine worker crashed'));
      if (active.timer !== null) clearTimeout(active.timer);
      active.timer = null;
      active.release();
    }
    if (transport !== null) {
      try {
        transport.terminate();
      } catch {
        // Nothing useful can be done about a transport that fails to die.
      }
    }
  }

  private ensureTransport(): Promise<void> {
    if (this.initPromise !== null) return this.initPromise;
    const promise = this.handshake();
    this.initPromise = promise;
    promise.catch(() => {
      // A failed handshake must not poison later attempts.
      if (this.initPromise === promise) this.killTransport(false);
    });
    return promise;
  }

  private async handshake(): Promise<void> {
    const generation = this.generation;
    let transport: EngineTransport;
    try {
      transport = this.factory();
    } catch (error) {
      throw new EngineError('init-failed', `cannot start the engine worker: ${String(error)}`);
    }
    this.transport = transport;
    transport.onLine((line) => this.handleLine(line, generation));
    transport.onError?.((error) => this.handleTransportError(error, generation));

    await this.expect('uciok', () => transport.post('uci'), 'init-failed');
    await this.expect(
      'readyok',
      () => {
        for (const [name, value] of this.options) transport.post(formatOption(name, value));
        transport.post('isready');
      },
      'init-failed',
    );
  }

  private expect(token: string, send: () => void, timeoutCode: EngineErrorCode = 'timeout'): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter !== null && this.waiter.timer === timer) this.waiter = null;
        reject(new EngineError(timeoutCode, `engine did not answer "${token}" within ${this.handshakeTimeoutMs} ms`));
      }, this.handshakeTimeoutMs);
      this.waiter = { token, resolve, reject, timer };
      send();
    });
  }
}
