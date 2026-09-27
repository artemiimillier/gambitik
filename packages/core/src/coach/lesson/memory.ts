/**
 * The lesson memory of one game (`TeachMemory.lesson`, docs/TEACHING.md §4.3) and a tolerant restore of the whole
 * `TeachMemory` from a saved game: an older or partial snapshot never leaves a field undefined.
 */
import type { PieceType, QuizKind } from '@gambit/shared';
import { initialTeachMemory } from '../teacher.ts';
import type { TeachMemory } from '../teacher.ts';
import type { AdviceShape, LessonMemory, MiniSlot, PendingTakeback } from './types.ts';

export function initialLessonMemory(): LessonMemory {
  return {
    v: 1,
    turn: 0,
    shapes: [],
    lastIdea: null,
    quietStreak: 0,
    followStreak: 0,
    quizzes: [],
    selfTurns: [],
    treasureTurns: [],
    praises: [],
    resultTurns: [],
    minis: [],
    theme: { announced: false, named: false, recalled: false, lastRemindTurn: null, links: [] },
    phaseSaid: { middlegame: false, endgame: false },
    mistakes: [],
    rulesSaid: [],
    slowerSaid: false,
    found: [],
    goalsDone: [],
    lastAdvice: null,
    adviceShown: [],
    lastDanger: null,
    pendingTakeback: null,
  };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function int(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
const PIECES: readonly string[] = ['p', 'n', 'b', 'r', 'q', 'k'];
const SHAPES: readonly string[] = ['A', 'B', 'C', 'D', 'E'];
const SLOTS: readonly string[] = ['opening', 'tactic', 'endgame'];
const QUIZ_KINDS: readonly string[] = ['oppIdea', 'whichPiece', 'canCapture', 'checkEscape', 'danger', 'why'];

/** Rebuilds a LessonMemory from anything (a saved game of any age); unknown or malformed parts take the defaults. */
export function restoreLessonMemory(raw: unknown): LessonMemory {
  const d = initialLessonMemory();
  const r = obj(raw);
  if (Object.keys(r).length === 0) return d;
  const nums = (v: unknown): number[] => arr(v).filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  const lastIdea = obj(r.lastIdea);
  const theme = obj(r.theme);
  const phase = obj(r.phaseSaid);
  const lastAdvice = obj(r.lastAdvice);
  const lastDanger = obj(r.lastDanger);
  return {
    v: 1,
    turn: int(r.turn, 0),
    shapes: arr(r.shapes).filter((x): x is AdviceShape => typeof x === 'string' && SHAPES.includes(x)).slice(-4),
    lastIdea: typeof lastIdea.id === 'string' && typeof lastIdea.piece === 'string' && PIECES.includes(lastIdea.piece) ? { id: lastIdea.id, piece: lastIdea.piece as PieceType } : null,
    quietStreak: int(r.quietStreak, 0),
    followStreak: int(r.followStreak, 0),
    quizzes: arr(r.quizzes)
      .map(obj)
      .filter((q) => typeof q.kind === 'string' && QUIZ_KINDS.includes(q.kind))
      .map((q) => ({ turn: int(q.turn, 0), ply: int(q.ply, 0), kind: q.kind as QuizKind, correct: typeof q.correct === 'boolean' ? q.correct : null })),
    selfTurns: nums(r.selfTurns),
    treasureTurns: nums(r.treasureTurns),
    praises: arr(r.praises)
      .map(obj)
      .filter((p) => typeof p.reason === 'string')
      .map((p) => ({ turn: int(p.turn, 0), reason: p.reason as string })),
    resultTurns: nums(r.resultTurns),
    minis: arr(r.minis)
      .map(obj)
      .filter((m) => typeof m.topic === 'string' && typeof m.slot === 'string' && SLOTS.includes(m.slot))
      .map((m) => ({ turn: int(m.turn, 0), ply: int(m.ply, 0), topic: m.topic as string, level: int(m.level, 1), slot: m.slot as MiniSlot })),
    theme: {
      announced: theme.announced === true,
      named: theme.named === true,
      recalled: theme.recalled === true,
      lastRemindTurn: typeof theme.lastRemindTurn === 'number' ? theme.lastRemindTurn : null,
      links: nums(theme.links),
    },
    phaseSaid: { middlegame: phase.middlegame === true, endgame: phase.endgame === true },
    mistakes: arr(r.mistakes)
      .map(obj)
      .filter((m) => typeof m.concept === 'string')
      .map((m) => ({
        turn: int(m.turn, 0),
        ply: int(m.ply, 0),
        concept: m.concept as string,
        uci: str(m.uci) ?? '',
        lossPawns: typeof m.lossPawns === 'number' ? m.lossPawns : 0,
        mated: m.mated === true,
        ...(m.victim === null || typeof m.victim === 'string' ? { victim: m.victim as string | null } : {}),
      })),
    rulesSaid: arr(r.rulesSaid).filter((x): x is string => typeof x === 'string'),
    slowerSaid: r.slowerSaid === true,
    found: arr(r.found)
      .map(obj)
      .filter((f) => f.kind === 'tactic' || f.kind === 'treasure' || f.kind === 'mate')
      .map((f) => ({ turn: int(f.turn, 0), ply: int(f.ply, 0), kind: f.kind as 'tactic' | 'treasure' | 'mate', ...(typeof f.motif === 'string' ? { motif: f.motif } : {}) })),
    goalsDone: arr(r.goalsDone).filter((x): x is string => typeof x === 'string'),
    lastAdvice:
      typeof lastAdvice.uci === 'string'
        ? {
            ply: int(lastAdvice.ply, 0),
            uci: lastAdvice.uci,
            san: str(lastAdvice.san) ?? '',
            ideas: arr(lastAdvice.ideas)
              .map(obj)
              .filter((i) => typeof i.id === 'string')
              .map((i) => ({ id: i.id as string, ...(typeof i.variant === 'string' ? { variant: i.variant } : {}) })),
            hidden: lastAdvice.hidden === true,
          }
        : null,
    adviceShown: nums(r.adviceShown),
    lastDanger: typeof lastDanger.kind === 'string' ? { ply: int(lastDanger.ply, 0), square: str(lastDanger.square), kind: lastDanger.kind } : null,
    pendingTakeback: restorePendingTakeback(r.pendingTakeback),
  };
}

/** The offered take-back until the reply (types.ts `PendingTakeback`); anything malformed is no pending take-back. */
function restorePendingTakeback(raw: unknown): PendingTakeback | null {
  const p = obj(raw);
  if (typeof p.uci !== 'string' || typeof p.ply !== 'number') return null;
  const c = obj(p.cue);
  const sq = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const color = (v: unknown): 'w' | 'b' | null => (v === 'w' || v === 'b' ? v : null);
  const line = obj(c.line);
  const threat = obj(c.threat);
  return {
    ply: int(p.ply, 0),
    uci: p.uci,
    childColor: color(p.childColor) ?? 'w',
    concept: str(p.concept),
    piece: typeof p.piece === 'string' && PIECES.includes(p.piece) ? (p.piece as PieceType) : null,
    square: sq(p.square),
    cue: {
      fen: str(c.fen) ?? '',
      victim: sq(c.victim),
      target: sq(c.target),
      piece: sq(c.piece),
      kingOf: color(c.kingOf),
      move: sq(c.move),
      line: sq(line.from) && sq(line.to) ? { from: line.from as string, to: line.to as string } : null,
      threat: typeof threat.uci === 'string' ? { uci: threat.uci, targets: arr(threat.targets).filter((t): t is string => typeof t === 'string') } : null,
    },
  };
}

/**
 * A TeachMemory from a saved game: the defaults of `initialTeachMemory()`, the saved scalar fields over them, and a
 * deep restore of `lesson` (a shallow merge would leave new lesson fields undefined).
 */
export function restoreTeachMemory(saved: unknown): TeachMemory {
  const base = initialTeachMemory();
  const r = obj(saved);
  const out: TeachMemory = { ...base };
  for (const [k, v] of Object.entries(r)) {
    if (k === 'lesson') continue;
    if (v === undefined) continue;
    (out as unknown as Record<string, unknown>)[k] = v;
  }
  out.lesson = restoreLessonMemory(r.lesson);
  return out;
}
