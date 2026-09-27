/**
 * Pure helpers that turn a finished game into its persistent form: id, PGN (main line with clock comments),
 * summary, effort stars and the GameRecord contract.
 */
import { buildPgn, summarizeGame, takebackOutcomes } from '@gambit/core';
import type { PgnMove, TakebackOutcome } from '@gambit/core';
import type {
  CoachStyle,
  Color,
  GameEvent,
  GameRecord,
  GameResult,
  GameSummary,
  MoveJudgement,
  Persona,
  Termination,
  TimeControl,
} from '@gambit/shared';
import type { GameConfig, MoveEntry, OpeningLookup, StarsBreakdown } from './gameTypes.ts';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Games shorter than this (child's moves) are not worth a journal entry when abandoned or given up at once. */
export const MIN_CHILD_MOVES_TO_SAVE = 2;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** `g-20260921-134501-k3x9qa` — sortable, URL-safe, matches the server's `[A-Za-z0-9_-]{1,64}`. */
export function makeGameId(date: Date, rng: () => number = Math.random): string {
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += ID_ALPHABET[Math.min(ID_ALPHABET.length - 1, Math.floor(rng() * ID_ALPHABET.length))];
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `g-${day}-${time}-${suffix}`;
}

export function resultFor(winner: Color | null): GameResult {
  return winner === null ? '1/2-1/2' : winner === 'w' ? '1-0' : '0-1';
}

/** Value of the standard PGN `Termination` tag. */
function terminationTag(termination: Termination): string {
  switch (termination) {
    case 'timeout':
      return 'time forfeit';
    case 'abandoned':
      return 'abandoned';
    case 'checkmate':
    case 'resign':
    case 'stalemate':
    case 'draw':
      return 'normal';
  }
}

function timeControlTag(timeControl: TimeControl): string {
  if (timeControl.initialMs === null) return '-';
  return `${Math.round(timeControl.initialMs / 1000)}+${Math.round(timeControl.incrementMs / 1000)}`;
}

export interface PgnArgs {
  config: GameConfig;
  persona: Persona;
  timeControl: TimeControl;
  nickname: string;
  startedAt: Date;
  moves: readonly MoveEntry[];
  result: GameResult;
  termination: Termination;
  opening?: OpeningLookup;
}

/** Main line only; `[%clk]` comments when the game was timed. Re-readable by chess.js `loadPgn`. */
export function buildGamePgn(args: PgnArgs): string {
  const { config, persona, timeControl, startedAt } = args;
  const child = args.nickname.trim() === '' ? 'Ученик' : args.nickname.trim();
  const bot = `${persona.name} (бот)`;
  const headers: Record<string, string> = {
    Event: `Гамбитик: ${timeControl.label}${config.examMode ? ', экзамен' : ''}`,
    Site: 'Гамбитик',
    Date: `${startedAt.getFullYear()}.${pad(startedAt.getMonth() + 1)}.${pad(startedAt.getDate())}`,
    Round: '-',
    White: config.childColor === 'w' ? child : bot,
    Black: config.childColor === 'b' ? child : bot,
    TimeControl: timeControlTag(timeControl),
    Termination: terminationTag(args.termination),
  };
  headers[config.childColor === 'w' ? 'BlackElo' : 'WhiteElo'] = String(persona.nominalElo);
  if (args.opening) {
    headers.ECO = args.opening.eco;
    headers.Opening = args.opening.name;
  }
  const moves: PgnMove[] = args.moves.map((move) => (move.clockMs === null ? { san: move.san } : { san: move.san, clkMs: move.clockMs }));
  return buildPgn({ headers, moves, result: args.result });
}

// ───────────────────────── stars ─────────────────────────

/** A resignation after this many own moves still counts as «played the game». */
export const MIN_CHILD_MOVES_FOR_FINISH = 12;
export const CAREFUL_MAX_BLUNDERS = 1;
/** Hints are help, not a fault — but leaning on them costs half a star, and being shown the move again and again another half. */
export const HINTS_FOR_PENALTY = 3;
export const SHOWN_MOVES_FOR_PENALTY = 2;

/**
 * «Думаем вместе с Гамбитиком» is earned by THINKING again, not by pressing the button: an accepted
 * offer counts unless the judgements prove that the very same move was simply replayed. Without `outcomes`
 * (older callers) every accepted offer counts.
 */
function tookASecondLook(summary: Pick<GameSummary, 'takebacksAccepted'>, outcomes: readonly TakebackOutcome[] | undefined): boolean {
  if (summary.takebacksAccepted <= 0) return false;
  if (!outcomes) return true;
  const offered = outcomes.filter((outcome) => !outcome.voluntary);
  if (offered.length === 0) return true;
  return offered.some((outcome) => !outcome.known || outcome.changed);
}

export function computeStars(args: {
  termination: Termination;
  childMoves: number;
  summary: Pick<GameSummary, 'counts' | 'takebacksOffered' | 'takebacksAccepted' | 'hintsUsed'>;
  /** hints of level 4 (the move was shown) */
  movesShown: number;
  /** `takebackOutcomes(judgements, events)` — what became of every take-back */
  takebacks?: readonly TakebackOutcome[];
}): StarsBreakdown {
  const { termination, summary } = args;
  if (args.childMoves <= 0) return { total: 0, finished: false, careful: false, listened: false, hintPenalty: 0 };
  const playedOut = termination === 'checkmate' || termination === 'stalemate' || termination === 'draw' || termination === 'timeout';
  const finished = playedOut || (termination === 'resign' && args.childMoves >= MIN_CHILD_MOVES_FOR_FINISH);
  const careful = summary.counts.blunder <= CAREFUL_MAX_BLUNDERS;
  const listened = summary.takebacksOffered === 0 || tookASecondLook(summary, args.takebacks);
  let hintPenalty = 0;
  if (summary.hintsUsed >= HINTS_FOR_PENALTY) hintPenalty += 0.5;
  if (args.movesShown >= SHOWN_MOVES_FOR_PENALTY) hintPenalty += 0.5;

  const earned = (finished ? 1 : 0) + (careful ? 1 : 0) + (listened ? 1 : 0);
  // effort is never rewarded with nothing: whoever played gets at least half a star
  const floor = finished ? 1 : 0.5;
  const total = Math.max(floor, Math.min(3, earned - hintPenalty));
  return { total, finished, careful, listened, hintPenalty };
}

// ───────────────────────── record ─────────────────────────

/** Taken-back attempts first, then the move that stayed — `finalJudgements` relies on "last per ply wins". */
export function orderJudgements(judgements: readonly MoveJudgement[]): MoveJudgement[] {
  return judgements.map((judgement, index) => ({ judgement, index })).sort((a, b) => a.judgement.ply - b.judgement.ply || a.index - b.index).map((x) => x.judgement);
}

/**
 * Summary of a game whose journal contains taken-back attempts.
 *
 * `summarizeGame` treats the LAST judgement of a ply as the move that stayed on the board. That breaks when a
 * taken-back attempt is the only judgement of its ply (the game ended before the retry, or the retry could not
 * be judged): the blunder the child took back would count against them. So accuracy, counts and key moments
 * are computed without the taken-back attempts, while the motif lists still see them (the idea WAS overlooked).
 */
export function summarizeWithTakebacks(args: {
  judgements: readonly MoveJudgement[];
  takenBack: ReadonlySet<MoveJudgement>;
  events: readonly GameEvent[];
  openingName?: string;
  /** curriculum stage of the child: decides which slips are worth a key moment (default 1) */
  stage?: number;
}): GameSummary {
  const ordered = orderJudgements(args.judgements);
  const events = [...args.events];
  const full = summarizeGame({ judgements: ordered, events, openingName: args.openingName, stage: args.stage });
  if (!ordered.some((j) => args.takenBack.has(j))) return full;
  const onBoard = ordered.filter((j) => !args.takenBack.has(j));
  const clean = summarizeGame({ judgements: onBoard, events, openingName: args.openingName, stage: args.stage });
  return { ...clean, motifsAllowed: full.motifsAllowed, motifsMissed: full.motifsMissed };
}

/** How many take-backs ended with a provably better move — the only ones the coach may praise as «нашёл лучше». */
export function countImprovedTakebacks(judgements: readonly MoveJudgement[], events: readonly GameEvent[]): number {
  return takebackOutcomes(orderJudgements(judgements), events).filter((outcome) => outcome.improved).length;
}

export interface RecordArgs extends PgnArgs {
  id: string;
  endedAt: Date;
  events: readonly GameEvent[];
  /** every judgement of the child's moves, taken-back attempts included */
  judgements: readonly MoveJudgement[];
  /** the judgements (same object identity) of attempts that did not stay on the board */
  takenBack?: ReadonlySet<MoveJudgement>;
  /** curriculum stage of the child (key-moment selection) */
  stage?: number;
  /** how the coach helped (TEACHER-MODE §7.5); default: the config's concrete style, else derived from examMode */
  coachStyle?: CoachStyle;
}

/** The concrete coach style of a config ('auto' / absent → what examMode says: exam, else helper). */
export function recordCoachStyle(config: Pick<GameConfig, 'examMode' | 'coachStyle'>): CoachStyle {
  const style = config.coachStyle;
  if (style === 'teacher' || style === 'helper' || style === 'exam') return style;
  return config.examMode ? 'exam' : 'helper';
}

export function buildGameRecord(args: RecordArgs): GameRecord {
  const judgements = orderJudgements(args.judgements);
  const events = [...args.events];
  const openingName = args.opening ? (args.opening.nameRu ?? args.opening.name) : undefined;
  const summary = summarizeWithTakebacks({ judgements, takenBack: args.takenBack ?? new Set(), events, openingName, stage: args.stage });
  return {
    id: args.id,
    startedAt: args.startedAt.toISOString(),
    endedAt: args.endedAt.toISOString(),
    personaId: args.config.personaId,
    timeControlId: args.config.timeControlId,
    childColor: args.config.childColor,
    result: args.result,
    termination: args.termination,
    pgn: buildGamePgn(args),
    events,
    judgements,
    summary,
    examMode: args.config.examMode,
    coachStyle: args.coachStyle ?? recordCoachStyle(args.config),
  };
}
