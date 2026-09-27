/**
 * The «Записи» demo replay (docs/voice-clips/SPEC.md §9, docs/voice-clips/demo-format.md): a harvested game — its moves
 * and the coach events the real builders produced for it — replayed through the REAL coach controller and clips layer,
 * with the child's clock held while Гамбитик is heard and a gentle stop when the child «moves» while he speaks. The
 * parent watches and listens to a real game; nothing is generated, nothing is paid.
 *
 * Pure: the file format (`parseClipsDemo`) and the replay engine (`createDemoReplay`, injected `say` / timers).
 * The dev-only screen is ./ClipsDemo.tsx (Settings, behind the parental lock, `?clipsDemo=<seed>`).
 */
import { Chess } from 'chess.js';
import type { CoachEvent, TimeControlId } from '@gambit/shared';

export interface DemoSay {
  event: CoachEvent;
  /** wait this long (ms) after the previous step before saying it */
  delayMs?: number;
}

export interface DemoPly {
  by: 'child' | 'bot';
  uci: string;
  /** how long this side thinks before the move (ms of wall time from its turn start) */
  thinkMs?: number;
  /** what the coach said after this move (in order) */
  after?: DemoSay[];
}

export interface ClipsDemoFile {
  v: 1;
  seed: string;
  title?: string;
  voiceKey?: string;
  timeControlId: TimeControlId;
  coachStyle?: 'teacher' | 'helper' | 'exam';
  childColor: 'w' | 'b';
  startFen?: string;
  /** the child's clock at the start (ms); absent = no clock (untimed) */
  clockMs?: number;
  /** said before the first move: greeting, game start / strategy intro */
  intro?: DemoSay[];
  plies: DemoPly[];
}

const SEED_RE = /^[A-Za-z0-9_-]{1,40}$/;
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const TIME_CONTROLS: readonly TimeControlId[] = ['training', 'rapid10', 'blitz5', 'bullet1'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEvent(raw: unknown): CoachEvent | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || typeof raw.kind !== 'string' || typeof raw.text !== 'string') return null;
  const priority = raw.priority === 0 || raw.priority === 2 ? raw.priority : 1;
  return {
    ...(raw as unknown as CoachEvent),
    priority,
    bubbleText: typeof raw.bubbleText === 'string' ? raw.bubbleText : raw.text,
    pose: typeof raw.pose === 'string' ? (raw.pose as CoachEvent['pose']) : 'talk',
    pauseClock: raw.pauseClock === true,
  };
}

function parseSays(raw: unknown, where: string, problems: string[]): DemoSay[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push(`${where}: not a list`);
    return [];
  }
  const out: DemoSay[] = [];
  raw.forEach((item, i) => {
    const event = isRecord(item) ? parseEvent(item.event) : null;
    if (!event) {
      problems.push(`${where}[${i}]: no event`);
      return;
    }
    out.push({ event, ...(isRecord(item) && typeof item.delayMs === 'number' && item.delayMs >= 0 ? { delayMs: item.delayMs } : {}) });
  });
  return out;
}

/**
 * A demo file as the replay trusts it: every move legal from the start position in order, every event well-formed.
 * `problems` lists what is wrong (empty = fine); `demo` is null when it cannot be replayed at all.
 */
export function parseClipsDemo(raw: unknown): { demo: ClipsDemoFile | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(raw) || raw.v !== 1) return { demo: null, problems: ['not a v1 demo file'] };
  const seed = typeof raw.seed === 'string' && SEED_RE.test(raw.seed) ? raw.seed : null;
  if (!seed) problems.push('seed');
  const timeControlId = TIME_CONTROLS.find((t) => t === raw.timeControlId) ?? null;
  if (!timeControlId) problems.push('timeControlId');
  const childColor = raw.childColor === 'w' || raw.childColor === 'b' ? raw.childColor : null;
  if (!childColor) problems.push('childColor');
  let chess: Chess;
  try {
    chess = new Chess(typeof raw.startFen === 'string' ? raw.startFen : undefined);
  } catch {
    return { demo: null, problems: [...problems, 'startFen'] };
  }
  const plies: DemoPly[] = [];
  if (!Array.isArray(raw.plies)) problems.push('plies');
  else {
    for (const [i, item] of raw.plies.entries()) {
      if (!isRecord(item) || (item.by !== 'child' && item.by !== 'bot') || typeof item.uci !== 'string' || !UCI_RE.test(item.uci)) {
        problems.push(`plies[${i}]: bad ply`);
        break;
      }
      const side = chess.turn() === childColor ? 'child' : 'bot';
      if (item.by !== side) {
        problems.push(`plies[${i}]: ${item.by} moves on ${side}'s turn`);
        break;
      }
      try {
        chess.move({ from: item.uci.slice(0, 2), to: item.uci.slice(2, 4), ...(item.uci.length > 4 ? { promotion: item.uci[4] } : {}) });
      } catch {
        problems.push(`plies[${i}]: illegal ${item.uci}`);
        break;
      }
      plies.push({
        by: item.by,
        uci: item.uci,
        ...(typeof item.thinkMs === 'number' && item.thinkMs >= 0 ? { thinkMs: item.thinkMs } : {}),
        after: parseSays(item.after, `plies[${i}].after`, problems),
      });
    }
  }
  if (!seed || !timeControlId || !childColor) return { demo: null, problems };
  const demo: ClipsDemoFile = {
    v: 1,
    seed,
    timeControlId,
    childColor,
    plies,
    intro: parseSays(raw.intro, 'intro', problems),
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(typeof raw.voiceKey === 'string' ? { voiceKey: raw.voiceKey } : {}),
    ...(raw.coachStyle === 'teacher' || raw.coachStyle === 'helper' || raw.coachStyle === 'exam' ? { coachStyle: raw.coachStyle } : {}),
    ...(typeof raw.startFen === 'string' ? { startFen: raw.startFen } : {}),
    ...(typeof raw.clockMs === 'number' && raw.clockMs > 0 ? { clockMs: raw.clockMs } : {}),
  };
  return { demo, problems };
}

// ───────────────────────── the replay ─────────────────────────

export interface DemoState {
  status: 'idle' | 'playing' | 'paused' | 'done' | 'stopped';
  ply: number;
  fen: string;
  lastMove: { from: string; to: string } | null;
  /** the child's clock (ms left); null = untimed */
  childMs: number | null;
  /** the child's clock stands (Гамбитик is speaking a phrase that holds it) */
  held: boolean;
  /** whose turn */
  turn: 'child' | 'bot';
  /** phrases said so far (ids) */
  said: string[];
  /** the child «moved» while he spoke this many times (the gentle stop) */
  graceStops: number;
}

export interface DemoReplayDeps {
  demo: ClipsDemoFile;
  /** the coach controller's say (resolves at the audible end) */
  say(event: CoachEvent): Promise<void>;
  /** the child moved while he speaks */
  stopSpeaking(opts: { grace: true }): void;
  /** true while the coach is audible (the gentle stop is only needed then) */
  speaking(): boolean;
  onState(state: DemoState): void;
  /** multiplies every wait (not the audio): 0.5 = twice as fast */
  speed?: number;
  now?: () => number;
  /** default think times when a ply has none */
  childThinkMs?: number;
  botThinkMs?: number;
}

export interface DemoReplay {
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  readonly state: DemoState;
}

/** The game's rule (gameStore `speechHoldsChildClock`): in 5 and 10 minutes ANY phrase holds the child's clock. */
function holdsClock(event: CoachEvent, tc: TimeControlId): boolean {
  return event.pauseClock || tc === 'blitz5' || tc === 'rapid10';
}

export function createDemoReplay(deps: DemoReplayDeps): DemoReplay {
  const { demo } = deps;
  const speed = deps.speed ?? 1;
  const now = deps.now ?? (() => Date.now());
  const chess = new Chess(demo.startFen);
  let holds = 0;
  let clockFrom: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** the step waiting on `timer`, and when it is due (a pause keeps what is left of the wait) */
  let pendingWait: { then: () => void; due: number } | null = null;
  let resumeWith: (() => void) | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  const state: DemoState = {
    status: 'idle',
    ply: 0,
    fen: chess.fen(),
    lastMove: null,
    childMs: demo.clockMs ?? null,
    held: false,
    turn: chess.turn() === demo.childColor ? 'child' : 'bot',
    said: [],
    graceStops: 0,
  };

  const publish = (): void => deps.onState({ ...state, said: [...state.said] });

  /** the child's clock runs on the child's turn while nothing holds it */
  function settleClock(): void {
    const t = now();
    if (clockFrom !== null && state.childMs !== null) state.childMs = Math.max(0, state.childMs - (t - clockFrom));
    clockFrom = state.status === 'playing' && state.turn === 'child' && holds === 0 && state.childMs !== null ? t : null;
    state.held = holds > 0;
  }

  function say(event: CoachEvent): void {
    const holding = holdsClock(event, demo.timeControlId);
    settleClock();
    if (holding) holds += 1;
    settleClock();
    state.said.push(event.id);
    publish();
    void deps
      .say(event)
      .catch(() => undefined)
      .finally(() => {
        settleClock();
        if (holding) holds = Math.max(0, holds - 1);
        settleClock();
        publish();
      });
  }

  function wait(ms: number, then: () => void): void {
    if (state.status !== 'playing') {
      resumeWith = () => wait(ms, then);
      return;
    }
    const delay = Math.max(0, ms * speed);
    pendingWait = { then, due: now() + delay };
    timer = setTimeout(() => {
      timer = null;
      const step = pendingWait;
      pendingWait = null;
      if (!step) return;
      if (state.status === 'playing') step.then();
      else resumeWith = step.then;
    }, delay);
  }

  function sayAll(list: readonly DemoSay[], then: () => void): void {
    const [first, ...rest] = list;
    if (!first) {
      then();
      return;
    }
    wait(first.delayMs ?? 150, () => {
      say(first.event);
      sayAll(rest, then);
    });
  }

  function playPly(i: number): void {
    const ply = demo.plies[i];
    if (!ply) {
      settleClock();
      state.status = 'done';
      clockFrom = null;
      stopTick();
      publish();
      return;
    }
    const think = ply.thinkMs ?? (ply.by === 'child' ? (deps.childThinkMs ?? 3500) : (deps.botThinkMs ?? 1200));
    wait(think, () => {
      // the child moves while Гамбитик is still talking: the game's gentle stop
      if (ply.by === 'child' && deps.speaking()) {
        state.graceStops += 1;
        deps.stopSpeaking({ grace: true });
      }
      settleClock();
      const move = chess.move({ from: ply.uci.slice(0, 2), to: ply.uci.slice(2, 4), ...(ply.uci.length > 4 ? { promotion: ply.uci[4] } : {}) });
      state.ply = i + 1;
      state.fen = chess.fen();
      state.lastMove = { from: move.from, to: move.to };
      state.turn = chess.turn() === demo.childColor ? 'child' : 'bot';
      settleClock();
      publish();
      sayAll(ply.after ?? [], () => playPly(i + 1));
    });
  }

  function startTick(): void {
    if (tick !== null || state.childMs === null) return;
    tick = setInterval(() => {
      settleClock();
      publish();
    }, 250);
  }

  function stopTick(): void {
    if (tick !== null) clearInterval(tick);
    tick = null;
  }

  return {
    get state() {
      return state;
    },
    start() {
      if (state.status !== 'idle') return;
      state.status = 'playing';
      settleClock();
      startTick();
      publish();
      sayAll(demo.intro ?? [], () => playPly(0));
    },
    pause() {
      if (state.status !== 'playing') return;
      settleClock();
      state.status = 'paused';
      settleClock();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const step = pendingWait;
      pendingWait = null;
      if (step) {
        const left = Math.max(0, step.due - now());
        resumeWith = () => wait(left / speed, step.then);
      }
      publish();
    },
    resume() {
      if (state.status !== 'paused') return;
      state.status = 'playing';
      settleClock();
      publish();
      const next = resumeWith;
      resumeWith = null;
      next?.();
    },
    stop() {
      settleClock();
      state.status = 'stopped';
      clockFrom = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pendingWait = null;
      resumeWith = null;
      stopTick();
      publish();
    },
  };
}

// ───────────────────────── a built-in sample (before any harvest exists) ─────────────────────────

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';

/**
 * A four-move sample in the demo format, so the screen can be checked before `voice:harvest` writes real games: the
 * events carry clip twins with catalogue ids; whatever is not recorded falls down the ladder, as in a real game.
 */
export function sampleClipsDemo(): ClipsDemoFile {
  const teach = (id: string, text: string, san: string, fen: string, ply: number): CoachEvent => ({
    id,
    kind: 'teachTurn',
    priority: 1,
    text,
    bubbleText: text,
    pose: 'think',
    pauseClock: true,
    teach: { moment: 'turn', style: 'short', ply, advice: [{ uci: '', san, source: 'engine', arrow: 'green' }] },
    clip: { sentences: [{ items: [{ line: 'teach.head.advice' }, { slot: 'ins', san, fen }], prio: 100, end: '.' }], generic: 'generic.teachTurn.turn', bark: 'think' },
  });
  return {
    v: 1,
    seed: 'sample',
    title: 'Пример: «Учитель», 5 минут, белые',
    timeControlId: 'blitz5',
    coachStyle: 'teacher',
    childColor: 'w',
    clockMs: 5 * 60_000,
    intro: [
      {
        event: {
          id: 'sample-hello',
          kind: 'greeting',
          priority: 1,
          text: 'Привет!',
          bubbleText: 'Привет!',
          pose: 'wave',
          pauseClock: false,
          clip: { sentences: [{ items: [{ line: 'hello.game' }], prio: 100, end: '!' }], generic: 'generic.greeting', bark: 'wave' },
        },
      },
      { event: teach('sample-t1', 'Мой совет — пешкой на е четыре.', 'e4', START, 1) },
    ],
    plies: [
      { by: 'child', uci: 'e2e4', thinkMs: 2500 },
      {
        by: 'bot',
        uci: 'e7e5',
        thinkMs: 1200,
        after: [{ event: teach('sample-t2', 'Мой совет — конём на эф три.', 'Nf3', AFTER_E4_E5, 3) }],
      },
      {
        by: 'child',
        uci: 'g1f3',
        thinkMs: 1200,
        after: [
          {
            event: {
              id: 'sample-praise',
              kind: 'praise',
              priority: 0,
              text: 'Отличный ход!',
              bubbleText: 'Отличный ход!',
              pose: 'cheer',
              pauseClock: false,
              clip: { sentences: [{ items: [{ line: 'generic.praise' }], prio: 100, end: '!' }], generic: 'generic.praise', bark: 'cheer' },
            },
          },
        ],
      },
      { by: 'bot', uci: 'b8c6', thinkMs: 1200 },
    ],
  };
}
