/**
 * Types of the lesson engine of «Учитель» (docs/TEACHING.md §4.3): the modules of
 * ./ (turn, quiz, mini, praise, mistake, theme, end, director) and their callers (the game store, the report worker)
 * build against these.
 */
import type { BoardAnnotations, CoachEvent, LessonQuiz, PieceType, QuizKind, Square, TeachAdvice } from '@gambit/shared';

/** The moment of a child turn (docs/TEACHING.md §2.2), first match wins in this order. */
export type LessonMomentKind = 'danger' | 'treasure' | 'quiz' | 'self' | 'mini' | 'advice' | 'quiet';

/** How an advice sentence is built (§2.3): A piece→idea, B why→piece, C piece as subject, D goal then helper, E question and answer. */
export type AdviceShape = 'A' | 'B' | 'C' | 'D' | 'E';

/** The slot of a mini-lesson (§2.6): at most one opening and one tactic/safety mini per game (endgame counts as tactic). */
export type MiniSlot = 'opening' | 'tactic' | 'endgame';

/**
 * The rhythm of the lesson in one game — pure data inside `TeachMemory.lesson`, returned by every director function,
 * committed by the caller, saved in the game's snapshot. `restoreTeachMemory` (./memory.ts) rebuilds it field by field.
 */
export interface LessonMemory {
  v: 1;
  /** child turns this game (teacher turns planned) */
  turn: number;
  /** advice shapes of the last turns, newest last (≤ 4) */
  shapes: AdviceShape[];
  /** the main idea (id + piece) of the last advice — the same idea with the same piece is not repeated */
  lastIdea: { id: string; piece: PieceType } | null;
  /** consecutive `quiet` turns */
  quietStreak: number;
  /** consecutive child moves that followed the shown green arrow */
  followStreak: number;
  quizzes: { turn: number; ply: number; kind: QuizKind; correct: boolean | null }[];
  /** turns with a «Сам» moment */
  selfTurns: number[];
  /** turns with a treasure hunt */
  treasureTurns: number[];
  /** praise said this game (reason = pool suffix, e.g. 'castled', 'tactic.fork') */
  praises: { turn: number; reason: string }[];
  /** turns with a `v3.result.*` line */
  resultTurns: number[];
  minis: { turn: number; ply: number; topic: string; level: number; slot: MiniSlot }[];
  /** the theme sentences: announced (family or card), the opening name said, last reminder turn */
  theme: { announced: boolean; named: boolean; recalled: boolean; lastRemindTurn: number | null; links: number[] };
  phaseSaid: { middlegame: boolean; endgame: boolean };
  /**
   * mistakes explained this game (the reaction and the take-back offer); realized loss is filled in later (lessonEnd).
   * `victim` (optional, additive): the square of the child's piece the words named (null: a mate, a bad trade, a missed
   * gift…) — the turn half reads it (`mistakeSaidAbout` in ./mistake.ts) so the next danger does not say it again (§2.2).
   */
  mistakes: { turn: number; ply: number; concept: string; uci: string; lossPawns: number; mated: boolean; victim?: Square | null }[];
  /** concepts whose rule was said this game (the second time it is a question, or nothing) */
  rulesSaid: string[];
  slowerSaid: boolean;
  /** what the child found himself: tactic / treasure / mate */
  found: { turn: number; ply: number; kind: 'tactic' | 'treasure' | 'mate'; motif?: string }[];
  /** theme goals achieved by the child's own moves (goal keys) */
  goalsDone: string[];
  /** the last advice given (for «Зачем мы так сходили?», «followed», the hidden-arrow rules) */
  lastAdvice: { ply: number; uci: string; san: string; ideas: { id: string; variant?: string }[]; hidden: boolean } | null;
  /** plies whose advice arrow the child has seen (a hidden advice is not «followed») */
  adviceShown: number[];
  /** the last danger said (its square), to recognise an ignored warning */
  lastDanger: { ply: number; square: Square | null; kind: string } | null;
  /** the take-back offered and not answered yet (optional, additive; a game saved without it keeps it in `lastDanger`) */
  pendingTakeback?: PendingTakeback | null;
}

/**
 * An offered take-back until the reply (docs/TEACHING.md §2.8): at stages 3–5 the reply after «да» / «нет» names
 * this concept and only then shows its red square.
 */
export interface PendingTakeback {
  /** the offered move (the child's ply and uci) */
  ply: number;
  uci: string;
  childColor: 'w' | 'b';
  /** `v3.mistake.<concept>`; null = nothing provable */
  concept: string | null;
  /** the subject piece of the concept's words */
  piece: PieceType | null;
  /** the child's piece in danger (null for a mate, a bad trade…) */
  square: Square | null;
  /** the board facts of the concept (./cues.ts `CueFacts`, flattened to plain data) */
  cue: {
    fen: string;
    victim: Square | null;
    target: Square | null;
    piece: Square | null;
    kingOf: 'w' | 'b' | null;
    move: string | null;
    line: { from: Square; to: Square } | null;
    threat: { uci: string; targets: Square[] } | null;
  };
}

/** What `planTeachTurn` decided for this turn (TeachPlan.lesson). */
export interface LessonTurnPlan {
  moment: LessonMomentKind;
  /** the advice shape (advice / mini / answer); null when no advice sentence */
  shape: AdviceShape | null;
  /** a quiz to ask (moment 'quiz' or the danger-quiz form) */
  quiz: LessonQuizPlan | null;
  /** a mini-lesson to tell (moment 'mini', or inside 'danger') */
  mini: { topic: string; level: number; slot: MiniSlot } | null;
  /** a «Сам» prompt kind (`v3.self.<kind>`) */
  self: string | null;
  /** the theme link said with the advice: a `v3.why.*` / `v3.themeTail.*` / `v3.goal.*` pool */
  themeLink: string | null;
  /** the theme sentence of this turn: the opening name confirmed, a reminder, a phase chapter, «свернул с дороги» */
  themeLine: string | null;
  /** the opponent sentence pool (`v3.opp.*`) with its subject square, or null */
  opp: { pool: string; square: Square | null } | null;
  /** the advice arrow is hidden (quiz, «Сам», treasure, stage-5 reveal-later) and appears after `revealAfterMs` */
  adviceHidden: boolean;
  revealAfterMs: number | null;
  /** a stage-5 calm advice is told first and shown later */
  revealLater: boolean;
}

/** A quiz decided by the plan, before its words are picked (the truth is proven by ./truth.ts). */
export interface LessonQuizPlan {
  kind: QuizKind;
  /** option ids in display order; `correct` is one of them */
  options: { id: string; pool: string; subject?: PieceType | null; icon?: string }[];
  correct: string;
  /** the question pool and its subject piece */
  questionPool: string;
  subject?: PieceType | null;
  /** squares the answer explanation highlights */
  answerSquares: Square[];
}

/** The result of one child turn (docs/TEACHING.md §4.3): what the board shows and what is said. */
export interface LessonTurnResult {
  moment: LessonMomentKind;
  /** what Гамбитик says (null = silent: a quiet turn — then `bark` may hold a short sound word, no bubble) */
  event: CoachEvent | null;
  /** what the board shows at once (advice arrows unless hidden, the cue highlights of the first sentence) */
  board: BoardAnnotations;
  advice: TeachAdvice[];
  /** the advice arrow is not shown yet (quiz / «Сам» / treasure / stage-5 reveal-later) */
  adviceHidden: boolean;
  /** show the advice by itself after this many ms (null = only on an answer / «Совет») */
  revealAfterMs: number | null;
  /** treasure scaffolding: extra highlights at these times (§2.7) */
  hints: { atMs: number; board: BoardAnnotations }[];
  quiz: LessonQuiz | null;
  bark: string | null;
}
