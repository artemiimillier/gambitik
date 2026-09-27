/**
 * The button quiz of «Учитель» (docs/TEACHING.md §2.4, §6.1): WHEN a question is due (the cadence), WHICH one,
 * and its three buttons — only when the code proved the answer (./truth.ts). No proof, no question.
 *
 * Pure decisions: no words are picked here (the lesson turn picks the question, the labels and the explanation from
 * the phrase book); randomness only through the `rng` argument.
 */
import type { Color, PieceType, QuizKind, Square, Threat, TimeControlId } from '@gambit/shared';
import { captureCandidates, opposite, parsePlacement, squareIndex, squareName } from '../../analysis/board.ts';
import { resolveUciMove } from '../board.ts';
import { explainMove } from '../moveIdeas.ts';
import type { MoveIdea } from '../moveIdeas.ts';
import type { Rng } from '../phrase.ts';
import type { TeachDanger } from '../teacher.ts';
import type { CueFacts } from './cues.ts';
import type { LessonMemory, LessonQuizPlan } from './types.ts';
import {
  GOAL_OPTIONS,
  OPTION_NEIGHBOURS,
  YOUNG_CATEGORIES,
  canCaptureProof,
  checkEscapeProof,
  dangerQuizProof,
  ideaOption,
  moveFacts,
  optionFalse,
  optionTrue,
  whichPieceProof,
} from './truth.ts';
import type { EngineProof, GoalOption } from './truth.ts';

/** The pieces the placeholders of a line take, by the line's `subject`. */
export type Subjects = Partial<Record<'mover' | 'target' | 'victim' | 'defended' | 'attacker' | 'oppPiece', PieceType>>;

// ───────────────────────── cadence (§2.4 «Частота») ─────────────────────────

/** A quiz at most once in this many child turns: 6 on stage 1, 5 on stages 2–3, 4 on stages 4–5. */
export function quizEvery(stage: number): number {
  return stage <= 1 ? 6 : stage <= 3 ? 5 : 4;
}

/** Quizzes per game: untimed 4 (stages 1–2) / 5 (3–5); 10 minutes 4; blitz 3. */
export function quizBudget(stage: number, tc: TimeControlId | undefined): number {
  if (tc === 'blitz5' || tc === 'bullet1') return 3;
  if (tc === 'rapid10') return 4;
  return stage <= 2 ? 4 : 5;
}

/** The first quiz of a game comes on the child's third turn at the earliest. */
export const QUIZ_FIRST_TURN = 3;

/**
 * Is a quiz due on child turn `turnNo` (1-based)? Also false when a quiz was already asked at this ply (a resumed game
 * re-plans the same ply: it gets the advice, not the question again).
 */
export function quizDue(lm: Pick<LessonMemory, 'quizzes'>, turnNo: number, ply: number, stage: number, tc: TimeControlId | undefined): boolean {
  if (turnNo < QUIZ_FIRST_TURN) return false;
  if (lm.quizzes.some((q) => q.ply === ply)) return false;
  if (lm.quizzes.length >= quizBudget(stage, tc)) return false;
  const last = lm.quizzes[lm.quizzes.length - 1];
  return !last || turnNo - last.turn >= quizEvery(stage);
}

// ───────────────────────── the plan of a quiz ─────────────────────────

/** How the truth is told after the answer (the plan carries it to `lessonAnswer`). */
export type QuizExplain =
  /** one whole wording of `pool` (an opponent line, a `v3.quiz.explain.*` line) */
  | { kind: 'pool'; pool: string; subjects: Subjects; facts: CueFacts; variant?: string }
  /** «Зачем мы так сходили?»: `v3.lead.why` + the idea tail of the child's previous move */
  | { kind: 'why'; idea: { id: string; variant?: string }; piece: PieceType; target?: PieceType | null; facts: CueFacts }
  /** the advice sentence itself is the explanation (whichPiece) */
  | { kind: 'advice' };

/** A quiz plan with what the lesson needs besides the public `LessonQuizPlan` (runtime only, never persisted). */
export interface QuizPlanX extends LessonQuizPlan {
  explain: QuizExplain;
  /** the facts the question's own cues are drawn from */
  questionFacts: CueFacts;
  /** the question's subjects (canCapture: the target; danger / whichPiece: none) */
  questionSubjects: Subjects;
  /** stages 1–2 say the options aloud after the question */
  sayOptions: boolean;
}

export interface QuizInput {
  stage: number;
  fen: string;
  childColor: Color;
  ply: number;
  proof: EngineProof | null;
  /** the primary advice */
  advice: { uci: string; san: string } | null;
  /** the bot's last move with its static ideas (plan.opponent) */
  opponent: { uci: string; san: string; fenBefore: string; ideas: readonly MoveIdea[]; earlyQueen: boolean } | null;
  /** the null-move threat of the child's position (after the bot's move) */
  threat: Threat | null | undefined;
  /** the child's previous move and the advice it followed (why) */
  lastChild: { fenBefore: string; uci: string } | null;
  lastAdvice: LessonMemory['lastAdvice'];
  adviceShown: readonly number[];
  rng: Rng;
}

const ICON: Readonly<Record<string, string>> = { capYes: '✓', capTrade: '⇄', capLose: '✗', escKing: 'k', escBlock: '▮', escCapture: '×' };

function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function pickSome<T>(items: readonly T[], n: number, rng: Rng): T[] {
  return shuffle(items, rng).slice(0, n);
}

function quizId(ply: number, kind: QuizKind): string {
  return `q${ply}-${kind}`;
}

// ───────────────────────── danger / checkEscape (inside the danger moment) ─────────────────────────

/** The danger moment's quiz form (a): «Что соперник может съесть?» for a hanging piece, «Шах! Как спасаемся?» for a check. */
export function dangerQuiz(inp: QuizInput, danger: TeachDanger | null): QuizPlanX | null {
  if (!danger) return null;
  if (danger.kind === 'check') return checkEscapeQuiz(inp);
  if (danger.kind !== 'hanging') return null;
  const proof = dangerQuizProof(inp.fen, danger, inp.childColor, inp.stage);
  if (!proof) return null;
  const types = shuffle([proof.correct, ...proof.distractors], inp.rng);
  const attackers = attackersOn(inp.fen, proof.victim, opposite(inp.childColor));
  const threat: Threat | null = attackers[0] ? { uci: `${attackers[0]}${proof.victim}`, san: '', motif: 'hangingPiece', targetSquares: [proof.victim], gainCp: 0 } : null;
  const facts: CueFacts = { fen: inp.fen, childColor: inp.childColor, victim: proof.victim, ...(threat ? { threat } : {}) };
  return {
    kind: 'danger',
    options: types.map((t) => ({ id: t, pool: '', subject: t, icon: t })),
    correct: proof.correct,
    questionPool: 'v3.quiz.q.danger',
    subject: null,
    answerSquares: [proof.victim],
    explain: { kind: 'pool', pool: 'v3.quiz.explain.danger', subjects: { victim: proof.correct }, facts },
    questionFacts: { fen: inp.fen, childColor: inp.childColor },
    questionSubjects: {},
    sayOptions: inp.stage <= 2,
  };
}

function attackersOn(fen: string, sq: Square, by: Color): Square[] {
  try {
    const b = parsePlacement(fen);
    return captureCandidates(b, squareIndex(sq), by).map(squareName);
  } catch {
    return [];
  }
}

function checkEscapeQuiz(inp: QuizInput): QuizPlanX | null {
  const proof = checkEscapeProof(inp.fen, inp.proof, inp.stage);
  if (!proof) return null;
  const ids = shuffle(['escKing', 'escBlock', 'escCapture'] as const, inp.rng);
  const checker = proof.checkers[0];
  const facts: CueFacts = { fen: inp.fen, childColor: inp.childColor, kingOf: inp.childColor, ...(proof.correct === 'escCapture' && checker ? { target: checker } : {}) };
  return {
    kind: 'checkEscape',
    options: ids.map((id) => ({ id, pool: `v3.quiz.opt.${id}`, icon: ICON[id] })),
    correct: proof.correct,
    questionPool: 'v3.quiz.q.checkEscape',
    subject: null,
    answerSquares: [proof.king, ...proof.checkers],
    explain: { kind: 'pool', pool: `v3.quiz.explain.${proof.correct}`, subjects: {}, facts: { ...facts, ...(inp.advice ? { move: { uci: inp.advice.uci } } : {}) } },
    questionFacts: { fen: inp.fen, childColor: inp.childColor, kingOf: inp.childColor },
    questionSubjects: {},
    sayOptions: inp.stage <= 2,
  };
}

// ───────────────────────── the quiz moment ─────────────────────────

/**
 * The quiz of a calm turn: the kinds in the order of preference (the first proven one wins). Never with a treasure or a
 * danger (those moments come first).
 */
export function turnQuiz(inp: QuizInput, kinds: readonly QuizKind[]): QuizPlanX | null {
  for (const kind of kinds) {
    const q =
      kind === 'oppIdea' ? oppIdeaQuiz(inp) : kind === 'whichPiece' ? whichPieceQuiz(inp) : kind === 'canCapture' ? canCaptureQuiz(inp) : kind === 'why' ? whyQuiz(inp) : null;
    if (q) return q;
  }
  return null;
}

/** The opponent's idea → the line that explains it (null: no quiz — the truth could not be told). */
function oppExplain(correct: GoalOption, idea: MoveIdea | undefined, f: NonNullable<ReturnType<typeof moveFacts>>, inp: QuizInput): { pool: string; subjects: Subjects; facts: CueFacts } | null {
  const base: CueFacts = { fen: inp.fen, childColor: inp.childColor };
  switch (correct) {
    case 'attack': {
      const victimSq = idea?.squares[0];
      const victim = victimSq ? f.b1[squareIndex(victimSq)]?.type : undefined;
      if (!victimSq || !victim) return null;
      const threat: Threat = { uci: `${f.mv.to}${victimSq}`, san: '', motif: 'hangingPiece', targetSquares: [victimSq], gainCp: 0 };
      return { pool: 'v3.opp.attack', subjects: { victim }, facts: { ...base, victim: victimSq, threat } };
    }
    case 'capture':
      if (!f.mv.captured) return null;
      return idea?.id === 'recapture' ? { pool: 'v3.opp.recapture', subjects: {}, facts: base } : { pool: 'v3.opp.capture', subjects: { victim: f.mv.captured }, facts: base };
    case 'develop':
      return { pool: 'v3.opp.develop', subjects: { oppPiece: f.mv.piece }, facts: { ...base, piece: f.mv.to } };
    case 'center':
      return idea?.id === 'centerPawn' ? { pool: 'v3.opp.centerPawn', subjects: {}, facts: base } : null;
    case 'castle':
      return { pool: 'v3.opp.castle', subjects: {}, facts: { ...base, kingOf: f.mover } };
    case 'check':
      return { pool: 'v3.opp.check', subjects: {}, facts: { ...base, kingOf: inp.childColor } };
    case 'mate':
      return inp.threat ? { pool: 'v3.opp.threatMate', subjects: {}, facts: { ...base, threat: inp.threat, kingOf: inp.childColor } } : null;
    case 'aimWeak':
      return { pool: 'v3.opp.aimWeak', subjects: {}, facts: { ...base, kingOf: inp.childColor } };
    case 'queenOut':
      return { pool: 'v3.opp.earlyQueen', subjects: {}, facts: { ...base, piece: f.mv.to } };
    default:
      return null;
  }
}

/**
 * «Как думаешь, что задумал соперник?» — the answer is the first idea the explainer gives his move (or his early
 * queen); every wrong button is provably false for (position before, his move, position after); a button that says
 * almost the same as the answer is never a wrong one.
 */
export function oppIdeaQuiz(inp: QuizInput): QuizPlanX | null {
  const o = inp.opponent;
  if (!o) return null;
  const f = moveFacts(o.fenBefore, o.uci);
  if (!f) return null;
  const young = inp.stage <= 2;
  const idea = o.ideas[0];
  let correct: GoalOption | null = null;
  if (o.earlyQueen && !young) correct = 'queenOut';
  else if (idea) correct = ideaOption(idea.id);
  if (!correct) return null;
  if (young && !YOUNG_CATEGORIES.includes(correct)) return null;
  if (!optionTrue(correct, f)) return null;
  const explain = oppExplain(correct, idea, f, inp);
  if (!explain) return null;
  const all = young ? YOUNG_CATEGORIES : GOAL_OPTIONS;
  const near = OPTION_NEIGHBOURS[correct];
  const wrong = all.filter((opt) => opt !== correct && !near.includes(opt) && optionFalse(opt, f, { threatAfter: inp.threat }));
  if (wrong.length < 2) return null;
  const ids = shuffle([correct, ...pickSome(wrong, 2, inp.rng)], inp.rng);
  const prefix = young ? 'v3.quiz.cat.' : 'v3.quiz.opt.';
  return {
    kind: 'oppIdea',
    options: ids.map((id) => ({ id, pool: `${prefix}${id}` })),
    correct,
    questionPool: 'v3.quiz.q.oppIdea',
    subject: null,
    answerSquares: [f.mv.from, f.mv.to],
    explain: { kind: 'pool', ...explain },
    questionFacts: { fen: inp.fen, childColor: inp.childColor },
    questionSubjects: {},
    sayOptions: young,
  };
}

/** «Какой фигурой лучше пойти?» — the three piece types, the answer proven by the closure rule. */
export function whichPieceQuiz(inp: QuizInput): QuizPlanX | null {
  if (!inp.advice) return null;
  const proof = whichPieceProof(inp.fen, inp.proof, inp.advice.uci);
  if (!proof) return null;
  const types = shuffle([proof.correct, ...proof.distractors], inp.rng);
  return {
    kind: 'whichPiece',
    options: types.map((t) => ({ id: t, pool: '', subject: t, icon: t })),
    correct: proof.correct,
    questionPool: 'v3.quiz.q.whichPiece',
    subject: null,
    answerSquares: [],
    explain: { kind: 'advice' },
    questionFacts: { fen: inp.fen, childColor: inp.childColor },
    questionSubjects: {},
    sayOptions: inp.stage <= 2,
  };
}

/** «Выгодно ли съесть {коня}?» — free / trade / lose, one target, every capturer in the same bucket. */
export function canCaptureQuiz(inp: QuizInput): QuizPlanX | null {
  const proof = canCaptureProof(inp.fen, inp.proof, inp.advice?.uci ?? null);
  if (!proof) return null;
  const ids = ['capYes', 'capTrade', 'capLose'] as const;
  const facts: CueFacts = { fen: inp.fen, childColor: inp.childColor, move: { uci: proof.uci }, target: proof.target };
  let explainFacts: CueFacts = facts;
  if (proof.bucket !== 'capYes') {
    // who takes back: the explanation shows the recapture as the threat arrow
    const mv = resolveUciMove(inp.fen, proof.uci);
    const back = mv ? attackersOn(mv.fenAfter, proof.target, opposite(inp.childColor))[0] : undefined;
    if (back) explainFacts = { ...facts, threat: { uci: `${back}${proof.target}`, san: '', motif: 'hangingPiece', targetSquares: [proof.target], gainCp: 0 } };
  }
  return {
    kind: 'canCapture',
    options: ids.map((id) => ({ id, pool: `v3.quiz.opt.${id}`, icon: ICON[id] })),
    correct: proof.bucket,
    questionPool: 'v3.quiz.q.canCapture',
    subject: proof.victim,
    answerSquares: [proof.target, proof.from],
    explain: { kind: 'pool', pool: `v3.quiz.explain.${proof.bucket}`, subjects: { target: proof.victim }, facts: explainFacts },
    questionFacts: facts,
    questionSubjects: { target: proof.victim },
    sayOptions: inp.stage <= 2,
  };
}

/** Ideas too vague to be the answer of «Зачем мы так сходили?». */
const VAGUE_IDEAS: ReadonlySet<string> = new Set(['quiet', 'improvePiece', 'centerControl']);

/**
 * «Зачем мы так сходили?» (stages 3–5): about the child's previous move when it was the advice he saw; the answer is the
 * first idea stored when the advice was given (never recomputed on the new position); wrong buttons provably false.
 */
export function whyQuiz(inp: QuizInput): QuizPlanX | null {
  if (inp.stage < 3) return null;
  const la = inp.lastAdvice;
  const lc = inp.lastChild;
  if (!la || !lc || la.hidden || !inp.adviceShown.includes(la.ply) || la.uci.toLowerCase() !== lc.uci.toLowerCase()) return null;
  const idea = la.ideas[0];
  if (!idea || VAGUE_IDEAS.has(idea.id)) return null;
  const correct = ideaOption(idea.id);
  if (!correct) return null;
  const f = moveFacts(lc.fenBefore, lc.uci);
  if (!f || !optionTrue(correct, f)) return null;
  const said = new Set(la.ideas.map((i) => ideaOption(i.id)).filter((x): x is GoalOption => x !== null));
  const near = OPTION_NEIGHBOURS[correct];
  const wrong = GOAL_OPTIONS.filter((opt) => opt !== correct && !said.has(opt) && !near.includes(opt) && optionFalse(opt, f, { staticMate: true }));
  if (wrong.length < 2) return null;
  const ids = shuffle([correct, ...pickSome(wrong, 2, inp.rng)], inp.rng);
  const lastMove = { uci: lc.uci };
  // the piece the idea is about (attack / capture: the opponent's piece; defend: ours) — an idea tail with a target
  // subject («— и нападём на {коня}») cannot be said without it
  const targetSq = explainMove({ fen: lc.fenBefore, uci: lc.uci }).find((i) => i.id === idea.id)?.squares[0] ?? null;
  const targetPiece = targetSq ? (parsePlacement(lc.fenBefore)[squareIndex(targetSq)]?.type ?? null) : null;
  return {
    kind: 'why',
    options: ids.map((id) => ({ id, pool: `v3.quiz.opt.${id}` })),
    correct,
    questionPool: 'v3.quiz.q.why',
    subject: f.mv.piece,
    answerSquares: [f.mv.from, f.mv.to],
    explain: { kind: 'why', idea: { id: idea.id, ...(idea.variant ? { variant: idea.variant } : {}) }, piece: f.mv.piece, target: targetPiece, facts: { fen: inp.fen, childColor: inp.childColor, lastMove, ...(targetSq ? { target: targetSq } : {}) } },
    questionFacts: { fen: inp.fen, childColor: inp.childColor, lastMove },
    questionSubjects: {},
    sayOptions: false,
  };
}

/** The quiz kinds of a recall key (the concept recalled at the start of the game gets priority, §2.9). */
export function recallQuizKinds(key: string | null): QuizKind[] {
  if (!key) return [];
  if (key.startsWith('quiz.')) return [key.slice(5) as QuizKind];
  switch (key) {
    case 'mistake.hanging':
    case 'mistake.ignoredDanger':
      return ['canCapture'];
    case 'mistake.missedTreasure':
    case 'mistake.badTrade':
      return ['canCapture'];
    case 'mistake.fork':
    case 'mistake.mate':
    case 'mistake.backRank':
    case 'mistake.pin':
    case 'mistake.tactic':
    case 'mistake.earlyQueen':
      return ['oppIdea'];
    default:
      return [];
  }
}
