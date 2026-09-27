/**
 * Test doubles for the game controller: a scripted judge engine, a scripted bot and a recording coach.
 * No Worker, DOM, network or timers of their own — `createGameController` runs on them under plain Node.
 */
import { Chess } from 'chess.js';
import type {
  AnalysisResult,
  AnalyzeOptions,
  BotMove,
  CoachEvent,
  CoachToolHost,
  ConversationState,
  EngineLine,
  GameRecord,
  MascotPose,
  GameThought,
  IBotEngine,
  IJudgeEngine,
  PersonaId,
  StudentProfile,
  Talkativeness,
} from '@gambit/shared';
import { defaultStudentProfile } from '../gameStore.ts';
import type { GameCoach, GameConversationInfo, GameDeps, GameSoundName, GameTimings, KeyValueStorage } from '../gameTypes.ts';

export function positionKey(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

/** One principal variation from the side-to-move's point of view. */
export interface ScriptedLine {
  cp?: number;
  mate?: number;
  pv: string[];
}

interface DelayedSearch {
  partial: { fen: string; lines: EngineLine[] } | null;
  reject: (error: Error) => void;
}

class StoppedError extends Error {
  readonly code = 'stopped';
  readonly partial: { fen: string; lines: EngineLine[] } | null;

  constructor(partial: { fen: string; lines: EngineLine[] } | null) {
    super('search superseded by stop()');
    this.partial = partial;
  }
}

/**
 * Judge engine that "knows" only what the test scripts: every unscripted position is dead equal (cp 0) with the
 * first legal moves as candidate lines, so every unscripted move is judged as fine.
 */
export class FakeJudge implements IJudgeEngine {
  readonly calls: { fen: string; opts: AnalyzeOptions }[] = [];
  /** 'ok' answers at once, 'reject' fails every search, 'hang' never answers until stop() */
  mode: 'ok' | 'reject' | 'hang' = 'ok';
  readyFails = false;
  stops = 0;
  disposed = false;
  /** teacher tests: 'ok' searches answer after this many ms (0 = at once); stop() rejects them with their partial lines */
  searchDelayMs = 0;
  /** with a delay: the lines are reported at once through `onProgress` at this depth (null = no progress reports) */
  progressDepth: number | null = null;
  /**
   * Honour `searchmoves`: only scripted lines of those moves (unscripted ones at cp 0). Off by default — the other
   * tests rely on the plain script (judgeMove's own `searchmoves` search).
   */
  honorSearchmoves = false;
  private readonly script = new Map<string, ScriptedLine[]>();
  private hanging: { fen: string; reject: (error: Error) => void }[] = [];
  private delayed: DelayedSearch[] = [];

  /** Scripts the analysis of the position reached by playing `sanMoves` from the start. */
  scriptAfter(sanMoves: readonly string[], lines: ScriptedLine[]): string {
    const chess = new Chess();
    for (const san of sanMoves) chess.move(san);
    this.script.set(positionKey(chess.fen()), lines);
    return chess.fen();
  }

  scriptFen(fen: string, lines: ScriptedLine[]): void {
    this.script.set(positionKey(fen), lines);
  }

  ready(): Promise<void> {
    return this.readyFails ? Promise.reject(new Error('worker failed to load')) : Promise.resolve();
  }

  analyze(fen: string, opts: AnalyzeOptions): Promise<AnalysisResult> {
    this.calls.push({ fen, opts });
    if (this.mode === 'reject') return Promise.reject(new Error('engine crashed'));
    if (this.mode === 'hang') {
      return new Promise<AnalysisResult>((_, reject) => {
        this.hanging.push({ fen, reject });
      });
    }
    const chess = new Chess(fen);
    const legal = chess.moves({ verbose: true }).map((m) => `${m.from}${m.to}${m.promotion ?? ''}`);
    if (legal.length === 0) return Promise.reject(new Error('no legal moves'));
    const depth = opts.depth ?? 12;
    const wanted = Math.max(1, opts.multipv ?? 1);
    const scripted = this.script.get(positionKey(fen));
    let source: ScriptedLine[] = scripted ?? legal.slice(0, wanted).map((uci) => ({ cp: 0, pv: [uci] }));
    const only = opts.searchmoves;
    if (this.honorSearchmoves && only && only.length > 0) {
      const allowed = (scripted ?? []).filter((line) => line.pv[0] !== undefined && only.includes(line.pv[0]));
      source = allowed.length > 0 ? allowed : only.filter((uci) => legal.includes(uci)).map((uci) => ({ cp: 0, pv: [uci] }));
    }
    const lines: EngineLine[] = source.slice(0, wanted).map((line, index) => ({
      multipv: index + 1,
      depth,
      cp: line.mate === undefined ? (line.cp ?? 0) : null,
      mate: line.mate ?? null,
      pvUci: line.pv,
    }));
    const bestmove = lines[0]?.pvUci[0] ?? (legal[0] as string);
    const result: AnalysisResult = { fen, lines, bestmove, depth, timeMs: 1 };
    if (this.searchDelayMs <= 0) return Promise.resolve(result);
    const progressLines = this.progressDepth === null ? null : lines.map((line) => ({ ...line, depth: Math.min(depth, this.progressDepth ?? depth) }));
    const onProgress = (opts as AnalyzeOptions & { onProgress?: (lines: EngineLine[]) => void }).onProgress;
    if (progressLines && onProgress) onProgress(progressLines);
    return new Promise<AnalysisResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const entry: DelayedSearch = {
        partial: progressLines ? { fen, lines: progressLines } : null,
        reject: (error) => {
          if (timer !== null) clearTimeout(timer);
          reject(error);
        },
      };
      timer = setTimeout(() => {
        this.delayed = this.delayed.filter((d) => d !== entry);
        resolve(result);
      }, this.searchDelayMs);
      this.delayed.push(entry);
    });
  }

  stop(): void {
    this.stops += 1;
    const pending = this.hanging;
    this.hanging = [];
    for (const search of pending) search.reject(new StoppedError(null));
    const delayed = this.delayed;
    this.delayed = [];
    for (const search of delayed) search.reject(new StoppedError(search.partial));
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }
}

/** Plays the queued replies (UCI or SAN); afterwards the first legal move. */
export class FakeBot implements IBotEngine {
  readonly asked: { fen: string; personaId: PersonaId; moveNumber: number; remainingMs: number | null }[] = [];
  replies: string[] = [];
  thinkMs = 0;
  mode: 'ok' | 'reject' | 'illegal' = 'ok';
  disposed = false;

  ready(): Promise<void> {
    return Promise.resolve();
  }

  pickMove(fen: string, personaId: PersonaId, ctx: { moveNumber: number; remainingMs: number | null }): Promise<BotMove> {
    this.asked.push({ fen, personaId, ...ctx });
    if (this.mode === 'reject') return Promise.reject(new Error('bot worker crashed'));
    if (this.mode === 'illegal') return Promise.resolve({ uci: 'a1a8', thinkMs: this.thinkMs });
    const chess = new Chess(fen);
    const next = this.replies.shift();
    let uci: string | null = null;
    if (next !== undefined) {
      try {
        const move = chess.move(/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(next) ? { from: next.slice(0, 2), to: next.slice(2, 4), promotion: next[4] } : next);
        uci = `${move.from}${move.to}${move.promotion ?? ''}`;
      } catch {
        throw new Error(`FakeBot: scripted reply ${next} is illegal in ${fen}`);
      }
    } else {
      const first = chess.moves({ verbose: true })[0];
      if (first) uci = `${first.from}${first.to}${first.promotion ?? ''}`;
    }
    if (uci === null) return Promise.reject(new Error('no legal moves'));
    return Promise.resolve({ uci, thinkMs: this.thinkMs });
  }

  dispose(): void {
    this.disposed = true;
  }
}

export class FakeCoach implements GameCoach {
  readonly said: CoachEvent[] = [];
  toolHost: CoachToolHost | null = null;
  stopCalls = 0;
  /** the coach's talkativeness setting (teacher mode reads it for the length of its words); undefined = not exposed */
  talkativeness: Talkativeness | undefined = undefined;
  activity = 0;
  annotationClears = 0;
  /** when set, say() resolves only after releaseSpeech() */
  holdSpeech = false;
  /** with `holdSpeech`: only the phrases it accepts are held (null = every phrase) */
  holdOnly: ((event: CoachEvent) => boolean) | null = null;
  private waiting: (() => void)[] = [];
  private hintListeners: (() => void)[] = [];
  private transcriptListeners: ((who: 'child' | 'coach', text: string) => void)[] = [];

  say(event: CoachEvent): Promise<void> {
    this.said.push(event);
    if (!this.holdSpeech || (this.holdOnly !== null && !this.holdOnly(event))) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  releaseSpeech(): void {
    const pending = this.waiting;
    this.waiting = [];
    for (const resolve of pending) resolve();
  }

  /** the options of every stopSpeaking() call, in order (`{ grace: true }` = the child moved while he spoke) */
  readonly stopOptions: ({ clearBubble?: boolean; grace?: boolean } | undefined)[] = [];

  stopSpeaking(opts?: { clearBubble?: boolean; grace?: boolean }): void {
    this.stopCalls += 1;
    this.stopOptions.push(opts);
    this.releaseSpeech();
  }

  setToolHost(host: CoachToolHost | null): void {
    this.toolHost = host;
  }

  onHintRequested(cb: () => void): () => void {
    this.hintListeners.push(cb);
    return () => {
      this.hintListeners = this.hintListeners.filter((l) => l !== cb);
    };
  }

  noteActivity(): void {
    this.activity += 1;
  }

  clearAnnotations(): void {
    this.annotationClears += 1;
  }

  onTranscript(cb: (who: 'child' | 'coach', text: string) => void): () => void {
    this.transcriptListeners.push(cb);
    return () => {
      this.transcriptListeners = this.transcriptListeners.filter((l) => l !== cb);
    };
  }

  pressHintButton(): void {
    for (const listener of [...this.hintListeners]) listener();
  }

  /** silent context notes for the conversational voice model (VoiceLayer.pushContext) */
  readonly context: string[] = [];

  pushContext(note: string): void {
    this.context.push(note);
  }

  hear(who: 'child' | 'coach', text: string): void {
    for (const listener of [...this.transcriptListeners]) listener(who, text);
  }

  // ───── conversational session (optional GameCoach extras) ─────
  readonly gameStarts: GameConversationInfo[] = [];
  readonly gameEnds: { result: string; termination: string }[] = [];
  private conversationListeners: ((state: ConversationState) => void)[] = [];

  onGameStart(info: GameConversationInfo): void {
    this.gameStarts.push(info);
  }

  onGameEnd(info: { result: string; termination: string }): void {
    this.gameEnds.push(info);
  }

  onConversationState(cb: (state: ConversationState) => void): () => void {
    this.conversationListeners.push(cb);
    return () => {
      this.conversationListeners = this.conversationListeners.filter((l) => l !== cb);
    };
  }

  /** the voice session reports a new state (e.g. 'listening' once the conversation is open) */
  setConversation(state: ConversationState): void {
    for (const listener of [...this.conversationListeners]) listener(state);
  }

  kinds(): string[] {
    return this.said.map((event) => event.kind);
  }

  // ───── the lesson (optional GameCoach extras, docs/TEACHING.md §4.4) ─────
  /** the server's `health.ai.runtime`: off by default, as on the child's machine (no strategist re-plans) */
  runtimeAiOn = false;
  runtimeAi(): boolean {
    return this.runtimeAiOn;
  }

  /** «Спроси» hidden for the quiz card: the current value and every change, in order */
  askSuppressed = false;
  readonly askSuppressedLog: boolean[] = [];
  setAskSuppressed(suppressed: boolean): void {
    this.askSuppressed = suppressed;
    this.askSuppressedLog.push(suppressed);
  }

  /** poses without words (a quiet turn's nod, joy over a find) */
  readonly poses: { pose: MascotPose; ms: number }[] = [];
  showPose(pose: MascotPose, ms: number): void {
    this.poses.push({ pose, ms });
  }

  /**
   * `coach.speaksAloud()` (§4.6): true = the phrase is «heard», the game waits for say() to end (as a real voice); false =
   * only the bubble (the silent layer, muted, «не озвучено») — the calm advice's arrow after the reading time.
   */
  aloud = true;
  speaksAloudCalls = 0;
  speaksAloud(): boolean {
    this.speaksAloudCalls += 1;
    return this.aloud;
  }

  get hintListenerCount(): number {
    return this.hintListeners.length;
  }

  /** «Дозапись голоса» G2: every ply and take-back the game told the coach about */
  boardChanges = 0;
  noteBoardChange(): void {
    this.boardChanges += 1;
  }

  private lateSpeechListeners: ((speaking: boolean) => void)[] = [];
  onLateSpeech(cb: (speaking: boolean) => void): () => void {
    this.lateSpeechListeners.push(cb);
    return () => {
      this.lateSpeechListeners = this.lateSpeechListeners.filter((l) => l !== cb);
    };
  }

  /** G2: a phrase recorded while its bubble was up starts (true) / stops (false) sounding */
  setLateSpeech(speaking: boolean): void {
    for (const listener of [...this.lateSpeechListeners]) listener(speaking);
  }
}

export class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  /** simulate a full / blocked localStorage */
  failWrites = false;

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export const FAST_TIMINGS: Partial<GameTimings> = {
  engineReadyTimeoutMs: 200,
  profileTimeoutMs: 200,
  judgeTimeoutMs: 400,
  postGameJudgeTimeoutMs: 400,
  postGameBudgetMs: 5_000,
  botTimeoutMs: 400,
  minBotDelayMs: 0,
  hintWaitMs: 20,
  botBubbleMs: 10_000,
  // effectively off unless a test asks for it
  threatWarningDelayMs: 3_600_000,
  threatSearchDepth: 8,
  threatSearchMovetimeMs: 50,
  silenceNudgeMs: 3_600_000,
  silenceNudgeRepeatMs: 3_600_000,
  evaluateMoveTimeoutMs: 400,
  evaluateMoveMovetimeMs: 50,
  saveRetryDelayMs: 0,
  // the diary question answers itself at once unless a test asks for time to type
  childNoteWaitMs: 0,
  thoughtsSendDelayMs: 0,
  declineReasonsMs: 60_000,
  // the lesson: the advice arrow right after its sentence (the fake coach «says» it at once), the quiz card a short moment
  adviceArrowMinMs: 0,
  adviceArrowPerWordMs: 0,
  adviceArrowMaxMs: 0,
  quizCloseMs: 30,
};

export interface TestHarness {
  deps: GameDeps;
  judge: FakeJudge;
  bot: FakeBot;
  coach: FakeCoach;
  storage: MemoryStorage;
  saved: GameRecord[];
  sounds: GameSoundName[];
  logs: string[];
  celebrations: { count: number };
  /** how many of the next saveGame calls fail (Infinity = the server is down) */
  saveFailures: { remaining: number; error: Error };
  /** POST /games/:id/thoughts calls that reached the «server» */
  thoughts: { gameId: string; thoughts: GameThought[] }[];
  /** how many of the next appendThoughts calls fail, and with what (an error with `status` 409 = «too-old») */
  thoughtFailures: { remaining: number; error: Error };
  profile: StudentProfile;
}

export function createTestHarness(overrides: { timings?: Partial<GameTimings>; profile?: Partial<StudentProfile> } = {}): TestHarness {
  const judge = new FakeJudge();
  const bot = new FakeBot();
  const coach = new FakeCoach();
  const storage = new MemoryStorage();
  const saved: GameRecord[] = [];
  const sounds: GameSoundName[] = [];
  const logs: string[] = [];
  const celebrations = { count: 0 };
  const saveFailures = { remaining: 0, error: new Error('network') };
  const thoughts: TestHarness['thoughts'] = [];
  const thoughtFailures = { remaining: 0, error: new Error('network') };
  const profile: StudentProfile = { ...defaultStudentProfile(new Date('2026-09-21T10:00:00Z')), nickname: 'Лёва', ...overrides.profile };
  let seed = 7;

  const deps: GameDeps = {
    judge,
    bot,
    coach,
    loadProfile: () => Promise.resolve(profile),
    saveGame: (record) => {
      if (saveFailures.remaining > 0) {
        saveFailures.remaining -= 1;
        return Promise.reject(saveFailures.error);
      }
      saved.push(record);
      return Promise.resolve({ id: record.id });
    },
    appendThoughts: (gameId, list) => {
      if (thoughtFailures.remaining > 0) {
        thoughtFailures.remaining -= 1;
        return Promise.reject(thoughtFailures.error);
      }
      thoughts.push({ gameId, thoughts: [...list] });
      return Promise.resolve({ gameId, added: list.length, total: list.length });
    },
    lookupOpening: () => Promise.resolve(undefined),
    storage,
    playSound: (name) => sounds.push(name),
    celebrate: () => {
      celebrations.count += 1;
    },
    now: () => Date.now(),
    wallClock: () => new Date(),
    // deterministic, never 0.5+ twice in a row for the "bot bubble" coin — a tiny LCG
    rng: () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    },
    timings: { ...FAST_TIMINGS, ...overrides.timings },
    log: (message, error) => logs.push(error instanceof Error ? `${message}: ${error.message}` : message),
  };
  return { deps, judge, bot, coach, storage, saved, sounds, logs, celebrations, saveFailures, thoughts, thoughtFailures, profile };
}
