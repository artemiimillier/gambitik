/**
 * The turn half of the lesson of «Учитель» (docs/TEACHING.md §2.1–§2.7): after the bot's move `planTeachTurn`
 * (the chess truth, unchanged) gives the advice, the danger, the treasure and the opponent's idea; this module decides
 * the ONE moment of the turn (danger → treasure → quiz → «Сам» → mini-lesson → advice / quiet), builds its sentences
 * from the phrase book (only the kept parts are picked), ties the board cues to them and returns the next lesson memory.
 * Also the replies on the child's buttons: the quiz answer, «Совет», «Повтори», «Почему так?», «Что задумал
 * соперник?», and the theme at the start of the game.
 *
 * After the first 50-game run (§2.2): a danger is spoken of by its cadence (`dangerSpoken`: a check, a mate threat, a
 * piece losing ≥ 3 pawns always; the rest at most once in 3–4 turns; never right after the mistake words about the
 * same piece) — else the advice alone carries the rescue; blitz speaks one sentence except «можно не спасать» + advice,
 * a treasure, a mini-lesson with its advice; stage-5 «позже» keeps its rhythm; «Как я и говорил» only after the advice
 * was said in words.
 *
 * After the second run: the word cap narrows each part's bag, the BAG chooses the words (`fitLevel` / `compose`: every
 * part picks among all its fresh wordings within the room left for it — never «the shortest every time»); a droppable
 * sentence (danger, «можно не спасать», a mini-lesson, the opponent, the theme) whose fresh wordings do not fit is left
 * out rather than repeated, and no sentence of the last utterance is said again; a warning repeated about the same
 * piece is an «other» danger (`dangerCadenceClass`); blitz mini-lessons are one sentence, no danger mini in blitz; a
 * quiz answer that shows the advice arrow keeps the advice words (the opener and the truth give way), else no arrow.
 *
 * No generative AI: every word is a wording of @gambit/content; the squares only reach the board. Randomness only from
 * the book (`book.random()`) or the caller's `rng` — never Math.random. Lesson events carry `say` and `saySentences` (the
 * recorded voice: which parts make each sentence, the spoken quiz options as ids), no `brief`, no `clip`.
 */
import type {
  BoardAnnotations,
  CoachEvent,
  CoachEventKind,
  Color,
  CueKind,
  LessonCue,
  LessonQuiz,
  LessonQuizVoice,
  LessonSay,
  LessonSaySentence,
  MascotPose,
  PieceType,
  PositionFacts,
  QuizKind,
  Square,
  StudentProfile,
  TeachAdvice,
  TeachMoment,
  TeachSummary,
  Threat,
} from '@gambit/shared';
import { AIM_IDEAS, QUESTION_IDEAS, lessonLine, wordingFitsStage } from '@gambit/content';
import type { LessonLine, LessonThemeFamily } from '@gambit/content';
import { Chess } from 'chess.js';
import { opposite, parsePlacement, squareIndex } from '../../analysis/board.ts';
import { computePositionFacts } from '../../analysis/facts.ts';
import { findHanging } from '../../analysis/hanging.ts';
import { expandWording, usesGender, usesPiece } from '../clips/catalog.ts';
import { parseUci, resolveUciMove } from '../board.ts';
import type { ResolvedMove } from '../board.ts';
import { explainOpponentMove, isEarlyQueenMove, pickIdeas } from '../moveIdeas.ts';
import type { MoveIdea } from '../moveIdeas.ts';
import { isMateMotif } from '../motifs.ts';
import { countWords } from '../phrase.ts';
import type { Rng } from '../phrase.ts';
import { planTeachTurn, treasureRevealMs } from '../teacher.ts';
import type { AdviceCandidate, LessonTurnMemo, TeachContext, TeachDanger, TeachMemory, TeachPlan } from '../teacher.ts';
import { threatTargetPiece } from '../threats.ts';
import type { LessonBook, PickArgs, Picked } from './book.ts';
import { cueDrawable, cuesToBoard } from './board.ts';
import { resolveCue } from './cues.ts';
import type { CueFacts } from './cues.ts';
import type { LessonStartArgs } from './director.ts';
import { lessonEvent, lessonGender, lessonStage } from './event.ts';
import { claimsBest, isDeictic } from './lint.ts';
import { initialLessonMemory, restoreTeachMemory } from './memory.ts';
import { IDEA_MINI, adviceMiniTopics, dangerMiniTopic, decideMini, recallMiniTopic, whyMini } from './mini.ts';
import { mistakeSaidAbout } from './mistake.ts';
import type { MiniDecision } from './mini.ts';
import { dangerQuiz, quizDue, recallQuizKinds, turnQuiz } from './quiz.ts';
import type { QuizInput, QuizPlanX, Subjects } from './quiz.ts';
import { pieceLabel, quizOptionLabel, quizOptionsText } from './quizWords.ts';
import { joinSentence, renderUtterance } from './render.ts';
import type { Rendered } from './render.ts';
import { familyKingOf, familyOf, recallKeyOf, themeCardOf, themeLine, themeLink, themeStart } from './theme.ts';
import type { ThemeCard } from './theme.ts';
import { adviceSaves, allowBestClaim, engineProof, guardDanger, hangingLoss, ideaSquares, ideaVariant, pieceOn } from './truth.ts';
import type { EngineProof } from './truth.ts';
import type { AdviceShape, LessonMemory, LessonMomentKind, LessonTurnPlan, LessonTurnResult } from './types.ts';

// ═════════════════════════ constants ═════════════════════════

/** Words of one utterance (§2.2): stages 1–2, stages 3–5. Blitz: one sentence. */
export const LESSON_WORDS = { young: 16, old: 22 } as const;
/** A danger with its mini-lesson may hold three sentences (an exemption from the two-sentence limit). */
export const DANGER_MINI_WORDS = 32;
/** A mini-lesson and the advice it is about. */
export const MINI_WORDS = 40;
/** The answer to a quiz: right / wrong + the truth + the advice (the advice keeps its words: the arrow comes with it). */
export const ANSWER_WORDS = { young: 28, old: 30 } as const;
/** The advice of a quiz answer takes its room before the opener and the truth (`Sent.room`). */
const ANSWER_ADVICE_ROOM = 200;
/** Treasures per game: stage 1 — 3, stages 2–5 — 4; not more often than once in `TREASURE_EVERY` child turns. */
export const TREASURE_CAP = { young: 3, old: 4 } as const;
export const TREASURE_EVERY = 3;
/** «Сам»: the arrow after 8 s (stages 2–3) or 12 s (4–5); not more often than once in `SELF_EVERY` turns. */
export const SELF_REVEAL_MS = { mid: 8_000, old: 12_000 } as const;
export const SELF_EVERY = 3;
/** Stage 5 calm advice: the idea is said, the arrow comes after this long (or on «Совет»). */
export const REVEAL_LATER_MS = 15_000;
/** Quiet turns in a row: stage 1 / blitz 2, stage 5 3. */
export const QUIET_MAX = { base: 2, stage5: 3 } as const;
/**
 * «Опасность — не в каждом ходе» (§2.2): other threats and attacked pieces are spoken of at most once in 3 child turns,
 * a pawn at most once in 4 (stages 3–5 only) — counted from the last turn whose words spoke of any danger. A check, a
 * mate threat and our piece (not a pawn) that would lose ≥ `DANGER_ALWAYS_LOSS_CP` are always spoken of.
 */
export const DANGER_EVERY = { other: 3, pawn: 4 } as const;
export const DANGER_ALWAYS_LOSS_CP = 300;
/**
 * Stage 5 «позже» (§2.2): on every second calm advice at most, never right after another hidden-arrow turn, and only
 * while the hidden-arrow turns of the game (quiz, «Сам», treasure, «позже») with this one stay within this share (the
 * gate of the report is 35 %: the quizzes and treasures that come later need their room).
 */
export const REVEAL_LATER_SHARE = 0.3;
/** The cue kinds that give a hidden move away (never shown while the advice is hidden). */
const REVEALING: ReadonlySet<CueKind> = new Set<CueKind>(['move', 'capture', 'attacks', 'line', 'path', 'piece']);
/** Ideas that are the child's own safety — the «Сам» / quiet moments never hide them. */
const URGENT_IDEAS: ReadonlySet<string> = new Set(['mate', 'mateSoon', 'defendMate', 'answerCheck', 'escape', 'defend', 'block']);

/** The concept card of a mini-lesson topic (journal titles, `profile.conceptsIntroduced`). */
const TOPIC_CARD: Readonly<Record<string, string>> = {
  castle: 'opening-king-safety',
  development: 'opening-development',
  center: 'opening-center',
  earlyQueen: 'opening-early-queen',
  thinking: 'thinking-routine',
  hanging: 'hanging-piece',
  freeCapture: 'free-capture',
  mateInOne: 'mate-in-1',
  scholarsMate: 'scholars-mate',
  backRank: 'back-rank-mate',
  fork: 'fork',
  pin: 'pin',
  skewer: 'skewer',
  discovered: 'discovered-attack',
  removeDefender: 'remove-defender',
  trapped: 'trapped-piece',
  pieceValues: 'piece-values',
  passedPawn: 'promotion',
  stalemate: 'stalemate',
  mateTechnique: 'endgame-queen-mate',
};

// ═════════════════════════ the words kit ═════════════════════════

/** Who the words are for. */
export interface Words {
  stage: 1 | 2 | 3 | 4 | 5;
  g: 'm' | 'f';
}

export function wordsOf(profile: Pick<StudentProfile, 'stage' | 'address'>): Words {
  return { stage: lessonStage(profile), g: lessonGender(profile) };
}

/** One pre-written part of a sentence (a whole wording, a lead or a tail). */
export interface Part {
  pool: string;
  variant?: string | null;
  subjects?: Subjects;
  allowBest?: boolean;
  /** only wordings of at most this many sentences (a blitz mini-lesson: 1) */
  maxSentences?: number;
}

/** One sentence of an utterance, with its priority (the lower ones are dropped first when the words run out). */
export interface Sent {
  key: string;
  prio: number;
  parts: Part[];
  facts: CueFacts | null;
  extraCues?: CueKind[];
  noPartCues?: boolean;
  /** the advice is hidden: no cue may give the move away (and no pointing word for such a cue) */
  hide?: boolean;
  /** the advice arrow appears after the sentence was said (a calm advice, §2.2) */
  moveAtEnd?: boolean;
  /** never dropped for length */
  core?: boolean;
  /**
   * the order the sentences take their room in (higher first; default: `prio`) — the first one's bag chooses among the
   * most wordings, the later ones are shortened for it (a quiz answer: the advice first, the opener and the truth after)
   */
  room?: number;
  /**
   * a composed sentence (the spoken quiz options), no pool of its own; `quiz` = its options as ids for the recorded
   * voice (a `say` option indexes this literal's own `say`; `compose` shifts it into the event's)
   */
  literal?: { text: string; say: LessonSay[]; quiz?: LessonQuizVoice };
}

function deixisOk(kinds: readonly CueKind[], s: Sent): boolean {
  if (kinds.length === 0 || !s.facts || s.noPartCues) return false;
  return kinds.every((k) => !(s.hide && REVEALING.has(k)) && cueDrawable(resolveCue(k, s.facts as CueFacts, 0)));
}

export function partArgs(p: Part, s: Sent, w: Words): PickArgs {
  const line = lessonLine(p.pool);
  const subj = line?.subject;
  const piece = subj ? (p.subjects?.[subj] ?? null) : null;
  return {
    stage: w.stage,
    g: w.g,
    piece,
    variant: p.variant ?? null,
    deixis: deixisOk(line?.cue ?? [], s),
    allowBest: p.allowBest === true,
    ...(p.maxSentences !== undefined ? { maxSentences: p.maxSentences } : {}),
  };
}

/** One wording the book could pick: its number (1-based, as `Picked.n`), its words, its plays this game, its text. */
interface Cand {
  n: number;
  words: number;
  plays: number;
  text: string;
}

/** Sentences as the book counts them (./book.ts). */
function sentencesIn(text: string): number {
  return text.split(/(?<=[.!?…])\s+/u).filter((x) => /[а-яё]/iu.test(x)).length;
}

/** The expanded wordings of a line per set of arguments (the library is fixed: a line object is never changed). */
const EXPANDED = new WeakMap<LessonLine, Map<string, Omit<Cand, 'plays'>[]>>();

function expandedOf(line: LessonLine, args: PickArgs): Omit<Cand, 'plays'>[] {
  const key = [args.stage, args.g ?? '', args.piece ?? '', args.variant ?? '', args.deixis === false ? 0 : 1, args.allowBest === true ? 1 : 0, args.maxSentences ?? ''].join('|');
  let byArgs = EXPANDED.get(line);
  if (!byArgs) {
    byArgs = new Map();
    EXPANDED.set(line, byArgs);
  }
  const known = byArgs.get(key);
  if (known) return known;
  const out: Omit<Cand, 'plays'>[] = [];
  line.wordings.forEach((w, i) => {
    if (!wordingFitsStage(line, w, args.stage)) return;
    if (args.variant && w.when && !w.when.includes(args.variant)) return;
    if ((args.variant === undefined || args.variant === null) && w.when && line.variants && line.variants.length > 0) return;
    const needsPiece = usesPiece(w.t);
    if (needsPiece && !args.piece) return;
    const g = usesGender(w.t) ? (args.g ?? 'm') : undefined;
    const text = expandWording(w.t, { ...(needsPiece && args.piece ? { piece: args.piece } : {}), ...(g ? { g } : {}) });
    if (text === null) return;
    if (args.deixis === false && isDeictic(text)) return;
    if (args.allowBest !== true && line.role === 'lead' && claimsBest(text)) return;
    if (args.maxSentences !== undefined && sentencesIn(text) > args.maxSentences) return;
    out.push({ n: i + 1, words: countWords(text), text });
  });
  byArgs.set(key, out);
  return out;
}

/**
 * The wordings the book could pick for these arguments (the book's own filter, without picking; `avoid` aside), with
 * their plays in this game when the book is given.
 */
function candidatesOf(pool: string, args: PickArgs, book: LessonBook | null = null): Cand[] {
  const line = lessonLine(pool);
  if (!line) return [];
  const out: Cand[] = [];
  for (const c of expandedOf(line, args)) {
    if (args.maxWords !== undefined && c.words > args.maxWords) continue;
    out.push({ ...c, plays: book ? book.playsThisGame(pool, c.n) : 0 });
  }
  return out;
}

/** The longest wording the book may pick (words). */
export function maxWords(pool: string, args: PickArgs): number {
  return Math.max(0, ...candidatesOf(pool, args).map((c) => c.words));
}

/**
 * Sentences dropped rather than said again in a wording already heard this game (§2.11: the bag decides, the word cap
 * only narrows it — the first 50-game run heard the shortest danger wording 44 times when the cap chose the words).
 */
const DROPPABLE_KEYS: ReadonlySet<string> = new Set(['danger', 'letGo', 'mini', 'opp', 'theme', 'link']);

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^а-яa-z0-9]+/gu, ' ')
    .trim();
}

/** Are these words already in the last utterance (the same sentence twice in a row is never said)? */
function saidIn(text: string, last: string): boolean {
  const t = normalized(text);
  return t !== '' && last !== '' && ` ${normalized(last)} `.includes(` ${t} `);
}

/**
 * The bag of a part now (./book.ts): the wordings with the fewest plays this game — never one heard in the last
 * utterance while another is left.
 */
function bagOf(all: readonly Cand[], last: string): Cand[] {
  const fresh = all.filter((c) => !saidIn(c.text, last));
  const from = fresh.length > 0 ? fresh : [...all];
  const min = Math.min(...from.map((c) => c.plays));
  return from.filter((c) => c.plays === min);
}

/** One part to pick: the sentence and the part, the book's arguments, every wording it could pick and its bag. */
interface Slot {
  s: Sent;
  pi: number;
  args: PickArgs;
  all: Cand[];
  bag: Cand[];
  /** only its bag, or nothing (a droppable sentence) */
  strict: boolean;
}

/** The parts of the sentences in order (null = a part has no wording at all). */
function slotsOf(sents: readonly Sent[], w: Words, book: LessonBook | null, strictAll = false): Slot[] | null {
  const last = book?.lastSaid() ?? '';
  const out: Slot[] = [];
  for (const s of sents) {
    if (s.literal) continue;
    if (s.parts.length === 0) return null;
    for (let pi = 0; pi < s.parts.length; pi++) {
      const args = partArgs(s.parts[pi] as Part, s, w);
      const all = candidatesOf((s.parts[pi] as Part).pool, args, book);
      if (all.length === 0) return null;
      out.push({ s, pi, args, all, bag: bagOf(all, last), strict: strictAll || DROPPABLE_KEYS.has(s.key) });
    }
  }
  return out;
}

/**
 * How the words of an utterance fit its cap: 1 = every part from its bag (nothing heard again while an unheard wording
 * is left); 2 = the droppable parts from their bags, the required ones (the advice, the answer's opener and truth)
 * from any of their wordings; null = they do not fit.
 */
export type FitLevel = 1 | 2;

function setOf(x: Slot, level: FitLevel): Cand[] {
  return level === 1 || x.strict ? x.bag : x.all;
}

function reserveOf(x: Slot, level: FitLevel): number {
  return Math.min(...setOf(x, level).map((c) => c.words));
}

function levelOf(slots: readonly Slot[], room: number): FitLevel | null {
  for (const level of [1, 2] as const) if (slots.reduce((n, x) => n + reserveOf(x, level), 0) <= room) return level;
  return null;
}

function literalWords(sents: readonly Sent[]): number {
  return sents.reduce((n, s) => n + (s.literal ? countWords(s.literal.text) : 0), 0);
}

/** The order the sentences take their room in (`room`, else `prio`; the earlier sentence first on a tie). */
function roomOrder(list: readonly Sent[], idx: readonly number[]): number[] {
  const room = (i: number): number => (list[i] as Sent).room ?? (list[i] as Sent).prio;
  return [...idx].sort((a, b) => room(b) - room(a) || a - b);
}

/**
 * Can these sentences be said within `cap` words (§2.2 «Длина одной реплики») without a wording heard again (§2.11)?
 * The level (see `FitLevel`), or null. The words are not chosen here: `compose` lets the bag of each part choose among
 * all its wordings that fit the room left for it.
 */
export function fitLevel(sents: readonly Sent[], cap: number, w: Words, book: LessonBook | null = null): FitLevel | null {
  const slots = slotsOf(roomOrder(sents, sents.map((_, i) => i)).map((i) => sents[i] as Sent), w, book);
  return slots ? levelOf(slots, cap - literalWords(sents)) : null;
}

/** The sentences when they fit (`fitLevel`), else null. */
export function fitSents(sents: readonly Sent[], cap: number, w: Words, book: LessonBook | null = null): Sent[] | null {
  return fitLevel(sents, cap, w, book) !== null ? [...sents] : null;
}

/**
 * The first of the sentence sets that fits with every part from its bag; else the first that fits at all. Groups are
 * tried in order (a group of rescue-worded advices before the plain ones: its words matter more than fresh ones).
 */
function firstFit<T extends { sents: Sent[] }>(options: readonly T[], cap: number, w: Words, book: LessonBook, groups: readonly (readonly T[])[] = [options]): T | null {
  for (const group of groups) {
    const levels = group.map((o) => fitLevel(o.sents, cap, w, book));
    for (const level of [1, 2] as const) {
      const i = levels.findIndex((l) => l !== null && l <= level);
      if (i >= 0) return group[i] as T;
    }
  }
  return null;
}

/** The rescue-worded advices first, then the rest (`firstFit` groups). */
function rescueFirst<T extends { b: AdviceBuild }>(options: readonly T[]): T[][] {
  return [options.filter((o) => o.b.rescue), options.filter((o) => !o.b.rescue)];
}

/**
 * The book picks the parts in order: each from its bag (level 1 / a strict part) or from all its wordings (level 2),
 * among those within the room left after the reserve of the parts still to come — the bag, not the cap, chooses the
 * wording. Level null: over the cap (never silent) — the bag alone. The Picked per sentence; a sentence missing a part
 * is left out.
 */
function pickSlots(slots: readonly Slot[], level: FitLevel | null, room: number, book: LessonBook): Map<Sent, Picked[]> {
  const out = new Map<Sent, Picked[]>();
  const failed = new Set<Sent>();
  const last = book.lastSaid();
  let used = 0;
  for (let k = 0; k < slots.length; k++) {
    const x = slots[k] as Slot;
    if (failed.has(x.s)) continue;
    const pool = (x.s.parts[x.pi] as Part).pool;
    // (recounted now: an earlier part of this utterance may have taken a wording of the same pool)
    const all = candidatesOf(pool, x.args, book);
    let args: PickArgs = x.args;
    if (level === null) {
      const avoid = all.filter((c) => saidIn(c.text, last)).map((c) => c.n);
      if (avoid.length > 0) args = { ...args, avoid };
    } else {
      const rest = slots.slice(k + 1).reduce((n, y) => n + (failed.has(y.s) ? 0 : reserveOf(y, level)), 0);
      const budget = room - used - rest;
      const set = level === 1 || x.strict ? bagOf(all, last) : all.filter((c) => !saidIn(c.text, last));
      let fit = set.filter((c) => c.words <= budget);
      if (fit.length === 0) fit = all.filter((c) => c.words <= budget);
      if (fit.length > 0) {
        const keep = new Set(fit.map((c) => c.n));
        const avoid = all.filter((c) => !keep.has(c.n)).map((c) => c.n);
        args = { ...args, maxWords: budget, ...(avoid.length > 0 ? { avoid } : {}) };
      }
    }
    const got = book.pick(pool, args);
    if (!got) {
      // (the sentence is left out: its words so far give their room back)
      for (const p of out.get(x.s) ?? []) used -= countWords(p.text);
      failed.add(x.s);
      out.delete(x.s);
      continue;
    }
    used += countWords(got.text);
    out.set(x.s, [...(out.get(x.s) ?? []), got]);
  }
  return out;
}

function canSayPart(p: Part, s: Sent, w: Words, book: LessonBook): boolean {
  return book.has(p.pool, partArgs(p, s, w));
}

export function canSay(s: Sent, w: Words, book: LessonBook): boolean {
  return s.literal !== undefined || (s.parts.length > 0 && s.parts.every((p) => canSayPart(p, s, w, book)));
}

function sentMaxWords(s: Sent, w: Words): number {
  if (s.literal) return countWords(s.literal.text);
  return s.parts.reduce((n, p) => n + maxWords(p.pool, partArgs(p, s, w)), 0);
}

export interface Composed {
  rendered: Rendered;
  /** the keys of the sentences said, in order */
  keys: string[];
  /** what was picked per key (the first sentence with that key) */
  picked: Map<string, Picked[]>;
}

/**
 * Builds an utterance: the core sentences are always said, their words fitted together — each part's bag chooses
 * among all its wordings within the room left for it (the sentence with the most `room` first); the others are KEPT in
 * priority order while the sentences and the words allow, and only in a wording not heard yet this game. The utterance
 * is rendered in sentence order with each sentence's cues (hidden cues filtered, the calm advice arrow at 'end').
 */
export function compose(sents: readonly (Sent | null | undefined)[], o: { cap: number; maxSentences: number }, w: Words, book: LessonBook): Composed {
  const list = sents.filter((s): s is Sent => !!s);
  const chosen = new Map<number, Picked[] | null>();
  // 1. the core sentences, fitted together
  const coreIdx = roomOrder(
    list,
    list.map((s, i) => (s.core && canSay(s, w, book) ? i : -1)).filter((i) => i >= 0),
  );
  const coreSents = coreIdx.map((i) => list[i] as Sent);
  let used = literalWords(coreSents);
  const slots = slotsOf(coreSents, w, book);
  if (slots) {
    const picks = pickSlots(slots, levelOf(slots, o.cap - used), o.cap - used, book);
    coreIdx.forEach((i) => {
      const s = list[i] as Sent;
      if (s.literal) chosen.set(i, null);
      else if (picks.has(s)) chosen.set(i, picks.get(s) as Picked[]);
    });
    for (const p of picks.values()) used += countWords(joinSentence(p.map((x) => x.text)));
  }
  // 2. the others: in priority order, in a fresh wording that fits the words left
  const order = list.map((_, i) => i).sort((a, b) => (list[b] as Sent).prio - (list[a] as Sent).prio || a - b);
  for (const i of order) {
    const s = list[i] as Sent;
    if (s.core || chosen.has(i) || chosen.size >= o.maxSentences || !canSay(s, w, book)) continue;
    if (s.literal) {
      const n = countWords(s.literal.text);
      if (used + n <= o.cap) {
        chosen.set(i, null);
        used += n;
      }
      continue;
    }
    const sl = slotsOf([s], w, book, true);
    if (!sl || levelOf(sl, o.cap - used) === null) continue;
    const picks = pickSlots(sl, 1, o.cap - used, book).get(s);
    if (!picks) continue;
    chosen.set(i, picks);
    used += countWords(joinSentence(picks.map((x) => x.text)));
  }
  const sentences: string[] = [];
  const say: LessonSay[] = [];
  const saySentences: LessonSaySentence[] = [];
  const cues: LessonCue[] = [];
  const keys: string[] = [];
  const picked = new Map<string, Picked[]>();
  list.forEach((s, i) => {
    if (!chosen.has(i)) return;
    const index = sentences.length;
    keys.push(s.key);
    if (s.literal) {
      const base = say.length;
      const quiz = s.literal.quiz;
      sentences.push(s.literal.text);
      saySentences.push({
        text: s.literal.text,
        parts: [],
        ...(quiz ? { quiz: { kind: quiz.kind, options: quiz.options.map((o) => ('say' in o ? { say: o.say + base } : { piece: o.piece })) } } : {}),
      });
      say.push(...s.literal.say);
      return;
    }
    const picks = chosen.get(i) as Picked[];
    if (!picked.has(s.key)) picked.set(s.key, picks);
    const r = renderUtterance([{ parts: picks, facts: s.facts, ...(s.extraCues ? { cues: s.extraCues } : {}), ...(s.noPartCues ? { noPartCues: true } : {}) }]);
    if (r.text === '') return;
    const base = say.length;
    sentences.push(r.text);
    saySentences.push(...r.saySentences.map((x) => ({ ...x, parts: x.parts.map((k) => k + base) })));
    say.push(...r.say);
    for (const c of r.cues) {
      if (s.hide && REVEALING.has(c.kind)) continue;
      const cue: LessonCue = { ...c, sentence: index };
      if (s.hide && cue.arrows) delete cue.arrows;
      if (s.moveAtEnd && (c.kind === 'move' || c.kind === 'capture')) cue.at = 'end';
      cues.push(cue);
    }
  });
  return { rendered: { text: sentences.join(' '), sentences, say, saySentences, cues }, keys, picked };
}

function capFor(w: Words): number {
  return w.stage <= 2 ? LESSON_WORDS.young : LESSON_WORDS.old;
}

function teachSummary(moment: TeachMoment, ply: number, advice: TeachAdvice[], hidden: boolean, sentences: number, conceptId?: string | null): TeachSummary {
  return {
    moment,
    style: moment === 'mini' ? 'concept' : sentences <= 1 ? 'short' : 'full',
    ply,
    advice: hidden ? [] : advice,
    ...(conceptId ? { conceptId } : {}),
    reveal: hidden ? 'later' : 'now',
  };
}

function eventOf(kind: CoachEventKind, c: Composed, o: { pose: MascotPose; priority?: 0 | 1 | 2; teach?: TeachSummary; board?: BoardAnnotations | null; pauseClock?: boolean }): CoachEvent | null {
  if (c.rendered.text.trim() === '') return null;
  return lessonEvent({
    kind,
    rendered: c.rendered,
    pose: o.pose,
    ...(o.priority !== undefined ? { priority: o.priority } : {}),
    ...(o.pauseClock !== undefined ? { pauseClock: o.pauseClock } : {}),
    ...(o.teach ? { teach: o.teach } : {}),
    ...(o.board ? { board: o.board } : {}),
  });
}

function emptyBoard(): BoardAnnotations {
  return { arrows: [], highlights: [] };
}

function arrowBoard(advice: readonly TeachAdvice[]): BoardAnnotations {
  const arrows: BoardAnnotations['arrows'] = [];
  for (const a of advice) {
    const p = parseUci(a.uci);
    if (p) arrows.push({ from: p.from, to: p.to, color: a.arrow });
  }
  return { arrows, highlights: [] };
}

function toTeachAdvice(a: AdviceCandidate): TeachAdvice {
  return { uci: a.uci, san: a.san, source: a.source, arrow: 'green' };
}

// ═════════════════════════ the facts of a turn ═════════════════════════

/** What the lesson keeps in the plan besides the public `LessonTurnPlan` (runtime only; the game never persists a plan). */
export interface TurnPlanX extends LessonTurnPlan {
  x: {
    /** the danger after the poisoned-hanging guard (null = none; `plan.danger` may be the unguarded one) */
    danger: TeachDanger | null;
    /** its cadence class this turn (`dangerCadenceClass`: a warning repeated about the same piece is «other») */
    dangerCls?: DangerClass | null;
    /** the ideas the advice was told by (the «Почему так?» answer never repeats them) */
    told: { id: string; variant?: string }[];
    /** a theme link the advice could have (for «Почему так?»), even when it was not due */
    whyLink: string | null;
    /** the recalled concept of this game */
    recallKey: string | null;
    /** the child turn number */
    turnNo: number;
    /** a blitz game (one sentence, one mini-lesson a game) */
    blitz: boolean;
  };
}

interface Env {
  ctx: TeachContext;
  plan: TeachPlan;
  w: Words;
  blitz: boolean;
  book: LessonBook;
  rand: Rng;
  lm: LessonMemory;
  turnNo: number;
  primary: AdviceCandidate | null;
  mv: ResolvedMove | null;
  proof: EngineProof | null;
  card: ThemeCard | null;
  facts: PositionFacts | null;
}

function safeFacts(fen: string): PositionFacts | null {
  try {
    return computePositionFacts(fen);
  } catch {
    return null;
  }
}

function isBlitz(tc: TeachContext['tc']): boolean {
  return tc === 'blitz5' || tc === 'bullet1';
}

/** The child's previous move (replayed from `historySan`): the position before it and its UCI; null when unknown. */
export function childLastMove(ctx: Pick<TeachContext, 'historySan' | 'lastBotMove' | 'fen'>): { fenBefore: string; uci: string; san: string } | null {
  const h = ctx.historySan ?? [];
  if (!ctx.lastBotMove || h.length < 2) return null;
  try {
    const chess = new Chess();
    for (const san of h.slice(0, -2)) chess.move(san);
    const fenBefore = chess.fen();
    const m = chess.move(h[h.length - 2] as string);
    chess.move(h[h.length - 1] as string);
    if ((chess.fen().split(' ')[0] ?? '') !== (ctx.fen.split(' ')[0] ?? '')) return null;
    return { fenBefore, uci: `${m.from}${m.to}${m.promotion ?? ''}`, san: m.san };
  } catch {
    return null;
  }
}

/** Ideas whose king cue is the child's own king. */
const OWN_KING_IDEAS: ReadonlySet<string> = new Set(['castle', 'prepareCastle', 'answerCheck', 'defendMate', 'kingActivity']);

function adviceFacts(env: Pick<Env, 'ctx'>, a: AdviceCandidate, idea: MoveIdea | undefined): CueFacts {
  const sq = ideaSquares(idea, env.ctx.fen, a.uci);
  const mv = resolveUciMove(env.ctx.fen, a.uci);
  const own = (idea && OWN_KING_IDEAS.has(idea.id)) || !!mv?.isCastle;
  return {
    fen: env.ctx.fen,
    childColor: env.ctx.childColor,
    move: { uci: a.uci },
    ...(sq.target ? { target: sq.target } : {}),
    ...(sq.defended ? { defended: sq.defended } : {}),
    ...(sq.line ? { line: sq.line } : {}),
    ...(own ? { kingOf: env.ctx.childColor } : {}),
  };
}

function adviceSubjects(fen: string, a: AdviceCandidate, idea: MoveIdea | undefined): Subjects {
  const mv = resolveUciMove(fen, a.uci);
  const sq = ideaSquares(idea, fen, a.uci);
  const target = pieceOn(fen, sq.target) ?? (mv?.captured ?? null);
  const defended = pieceOn(fen, sq.defended);
  return { ...(mv ? { mover: mv.piece } : {}), ...(target ? { target } : {}), ...(defended ? { defended } : {}) };
}

// ═════════════════════════ the advice sentence (§2.3) ═════════════════════════

type LeadKind = 'rescue' | 'answer' | 'reveal' | 'why' | 'repeat';

interface AdviceOpts {
  shape?: AdviceShape | null;
  lead?: LeadKind | null;
  /** a theme tail instead of the idea's tail (blitz) */
  tail?: Part | null;
  hide?: boolean;
  moveAtEnd?: boolean;
  prio?: number;
  /** tell this idea (default: the advice's first) */
  idea?: MoveIdea;
  /** only shape A / C (short answers) */
  simple?: boolean;
  /**
   * the mate cannot be stopped (every move lets it in): shape A / C with the honest `v3.danger.lastStand` tail — never
   * an idea tail, «я проверил» or the castle sentence, which would call the move safe
   */
  lost?: boolean;
}

/** The advice's tail when the mate cannot be stopped: «— сыграем до конца!» (claims neither a rescue nor safety). */
const LAST_STAND: Part = { pool: 'v3.danger.lastStand' };

interface AdviceBuild {
  sents: Sent[];
  shape: AdviceShape | null;
  idea: MoveIdea | undefined;
  told: { id: string; variant?: string }[];
  /** its words say the rescue of a danger (the rescue lead, or the move's own rescue idea) */
  rescue?: boolean;
}

/**
 * The advice in one of the five shapes (§2.3), never the same shape twice in a row, shape A at most once in three:
 * A «Давай сходим {конём}» + idea; B «{зачем}» + «— значит, ходим {конём}»; C «{Конь} просится в бой» + idea;
 * D «{Цель}.» «Поможет {конь}.»; E «{Вопрос}?» «{Конь}!». A castle is its own whole sentence.
 */
function buildAdvice(env: Env, a: AdviceCandidate, o: AdviceOpts = {}): AdviceBuild | null {
  const { ctx, w, book } = env;
  const fen = ctx.fen;
  const mv = resolveUciMove(fen, a.uci);
  if (!mv) return null;
  const prio = o.prio ?? 95;
  const idea = o.idea ?? a.ideas.find((i) => !(i.id === 'castle' && mv.isCastle)) ?? a.ideas[0];
  const facts = adviceFacts(env, a, idea);
  const subjects = adviceSubjects(fen, a, idea);
  const base = (key: string, parts: Part[], extra: Partial<Sent> = {}): Sent => ({ key, prio, parts, facts, core: true, ...(o.hide ? { hide: true } : {}), ...(o.moveAtEnd ? { moveAtEnd: true } : {}), ...extra });
  // castling: a whole sentence (the move is its own reason)
  if (mv.isCastle && !o.lead && !o.lost) {
    const s = base('advice', [{ pool: mv.san.startsWith('O-O-O') ? 'v3.whole.castleLong' : 'v3.whole.castle' }]);
    if (canSay(s, w, book)) return { sents: [s], shape: null, idea, told: [{ id: 'castle' }] };
  }
  const variant = idea ? ideaVariant(idea, fen, a.uci, { mate: a.mate }) : undefined;
  const engineChecked = a.verifiedBy !== 'curated';
  let tail: Part | null = o.lost ? LAST_STAND : (o.tail ?? (idea ? { pool: `v3.idea.${idea.id}`, variant: variant ?? null, subjects } : null));
  const probeSent = base('advice', []);
  if (!o.lost && (!tail || !canSayPart(tail, probeSent, w, book))) tail = engineChecked ? { pool: 'v3.idea.none' } : null;
  if (tail && !canSayPart(tail, probeSent, w, book)) tail = null;
  const told = o.tail || o.lost ? [] : idea && tail?.pool.startsWith(`v3.idea.${idea.id}`) ? [{ id: idea.id, ...(variant ? { variant } : {}) }] : [];
  const allowBest = allowBestClaim(fen, ctx.analysis, a.uci);
  const planMove = a.planFit === 'line' || a.planFit === 'lineLater';
  const leadPool = (shape: 'A' | 'C'): string => {
    if (o.lead) return `v3.lead.${o.lead}`;
    if (shape === 'C') return 'v3.lead.subject';
    if (mv.captured) return 'v3.lead.capture';
    if (planMove && !o.lost && env.rand() < 0.5) return 'v3.lead.plan';
    return 'v3.lead.advice';
  };
  const aim = idea && AIM_IDEAS.includes(idea.id as (typeof AIM_IDEAS)[number]) ? { pool: `v3.aim.${idea.id}`, variant: variant ?? null } : null;
  const question = idea && QUESTION_IDEAS.includes(idea.id as (typeof QUESTION_IDEAS)[number]) ? { pool: `v3.q.${idea.id}`, subjects } : null;
  const helper: Part = { pool: 'v3.helper', subjects };
  const build = (shape: AdviceShape): Sent[] | null => {
    switch (shape) {
      case 'A':
      case 'C': {
        if (!tail) return null;
        const lead: Part = { pool: leadPool(shape), subjects, ...(allowBest ? { allowBest: true } : {}) };
        return [base('advice', [lead, tail])];
      }
      case 'B':
        if (!aim || o.tail) return null;
        return [base('advice', [aim, { pool: mv.captured ? 'v3.go.capture' : 'v3.go.move', subjects }])];
      case 'D':
        if (!aim || o.tail) return null;
        return [base('advice', [aim], { moveAtEnd: false }), base('advice2', [helper])];
      case 'E':
        if (!question || o.tail) return null;
        return [base('advice', [question], { moveAtEnd: false }), base('advice2', [helper])];
    }
  };
  const recent = env.lm.shapes;
  const last = recent[recent.length - 1];
  let shapes: AdviceShape[];
  if (o.shape) shapes = [o.shape];
  else if (o.lead || o.simple || o.lost) shapes = ['A', 'C'];
  else shapes = ['A', 'B', 'C', 'D', 'E'];
  if (env.blitz) shapes = shapes.filter((s) => s !== 'D' && s !== 'E');
  const fresh = shapes.filter((s) => s !== last && !(s === 'A' && recent.slice(-2).includes('A')));
  const ordered = [...shuffle(fresh.length > 0 ? fresh : shapes, env.rand), ...shapes];
  for (const shape of ordered) {
    const sents = build(shape);
    if (sents && sents.every((s) => canSay(s, w, book))) {
      const tellsIdea = shape === 'B' || shape === 'D' || shape === 'E';
      return { sents, shape, idea, told: tellsIdea && idea ? [{ id: idea.id, ...(variant ? { variant } : {}) }] : told };
    }
  }
  return null;
}

function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** The advice in its usual shape, then the one-sentence shapes one by one (shorter fall-backs for the word cap). */
function plainBuilds(env: Env, a: AdviceCandidate, o: AdviceOpts = {}): AdviceBuild[] {
  const out: (AdviceBuild | null)[] = [buildAdvice(env, a, o)];
  if (!o.shape) for (const shape of ['A', 'C', 'B'] as const) out.push(buildAdvice(env, a, { ...o, shape }));
  return out.filter((b): b is AdviceBuild => !!b);
}

/** The ideas that are the rescue of a danger themselves («— уведём его из-под удара», «— закроемся от шаха»). */
const RESCUE_IDEAS: ReadonlySet<string> = new Set(['escape', 'defend', 'block', 'answerCheck', 'defendMate']);

/**
 * The advice that deals with a danger (§2.2): when the move's main idea IS the rescue, that idea tells it in any of the
 * shapes («Давай сходим конём — уведём его из-под удара»); otherwise the rescue lead carries it before the main idea
 * («Спасаемся: ходим конём — и нападём на ладью»). Shorter shapes follow for the word cap.
 */
function rescueBuilds(env: Env, a: AdviceCandidate, o: Pick<AdviceOpts, 'prio' | 'moveAtEnd'> = {}): AdviceBuild[] {
  const first = a.ideas[0];
  const own = first && RESCUE_IDEAS.has(first.id) ? plainBuilds(env, a, { ...o, idea: first }).map((b) => ({ ...b, rescue: b.told.some((t) => RESCUE_IDEAS.has(t.id)) })) : [];
  const lead = buildAdvice(env, a, { ...o, lead: 'rescue' });
  return [...own, ...(lead ? [{ ...lead, rescue: true }] : []), ...plainBuilds(env, a, { ...o, simple: true })];
}

// ═════════════════════════ the danger cadence (§2.2 «Опасность — не в каждом ходе») ═════════════════════════

/** always: a check, a mate threat, our piece (not a pawn) losing ≥ 3 pawns; other: the rest; pawn: a pawn. */
export type DangerClass = 'always' | 'other' | 'pawn';

export function dangerClass(d: Pick<TeachDanger, 'kind' | 'piece' | 'squares'>, fen: string): DangerClass {
  if (d.kind === 'check' || d.kind === 'mate') return 'always';
  if (d.kind === 'hanging' && d.piece) {
    if (d.piece.piece === 'p') return 'pawn';
    return hangingLoss(fen, d.piece.square) >= DANGER_ALWAYS_LOSS_CP ? 'always' : 'other';
  }
  const pieces = d.squares.map((sq) => pieceOn(fen, sq)).filter((p): p is PieceType => !!p);
  return pieces.length > 0 && pieces.every((p) => p === 'p') ? 'pawn' : 'other';
}

/** The squares a danger is about (the piece under attack, the targets of a threat). */
function dangerSquares(d: Pick<TeachDanger, 'kind' | 'piece' | 'squares'>): Square[] {
  if (d.kind === 'hanging' && d.piece) return [d.piece.square];
  return [...d.squares];
}

/** Mistake concepts about one piece of ours (./mistake.ts): the reaction named it, with its square on the board. */
const PIECE_MISTAKES: ReadonlySet<string> = new Set(['ignoredDanger', 'hanging.undefended', 'hanging.cheaper', 'hanging.outnumbered', 'badTrade', 'fork', 'pin', 'skewer', 'discovered', 'removeDefender', 'trapped']);

/**
 * Did the mistake words right after the child's last move (the reaction, the take-back offer) just tell of this danger
 * (§2.2: then the danger is not repeated — the advice at once)? The same square of our piece: the victim the words
 * named (`mistakeSaidAbout` of ./mistake.ts). A record of a game saved before the victim was kept: the take-back mark
 * or the warning of the turn before (`lastDanger`) on that square, else the square the child's move went to. A check
 * and a mate threat are always said (§2.2 table).
 */
export function mistakeJustTold(lm: Pick<LessonMemory, 'mistakes' | 'lastDanger'>, ply: number, d: Pick<TeachDanger, 'kind' | 'piece' | 'squares'>): boolean {
  if (d.kind === 'check' || d.kind === 'mate') return false;
  const squares = dangerSquares(d);
  if (mistakeSaidAbout(lm, ply, squares)) return true;
  const old = lm.mistakes.filter((m) => m.ply === ply - 2 && m.victim === undefined && PIECE_MISTAKES.has(m.concept));
  if (old.length === 0) return false;
  const mark = lm.lastDanger;
  if (mark && mark.ply === ply - 2 && mark.square && squares.includes(mark.square)) return true;
  return old.some((m) => squares.includes(m.uci.slice(2, 4)));
}

export interface DangerCadenceArgs {
  danger: Pick<TeachDanger, 'kind' | 'piece' | 'squares'>;
  fen: string;
  stage: number;
  /** this child turn (1-based) and ply */
  turnNo: number;
  ply: number;
  lm: Pick<LessonMemory, 'mistakes' | 'lastDanger'>;
  /** the turns whose words spoke of a danger (`LessonTurnMemo.dangerTurns`) */
  dangerTurns: readonly number[];
  /** the advice deals with the danger */
  saves: boolean;
  /** SAN of the game (the warned piece stood still since the warning?); without it only the turn right after counts */
  historySan?: readonly string[];
}

/**
 * Did the piece stand on `square` from before the child's move at `fromPly` until now (no move from or to it, the
 * same piece on it all along)? false when the history does not reach back that far.
 */
function stoodSince(historySan: readonly string[], fromPly: number, square: Square): boolean {
  if (fromPly < 1 || historySan.length < fromPly) return false;
  try {
    const chess = new Chess();
    for (const san of historySan.slice(0, fromPly - 1)) chess.move(san);
    const piece = chess.get(square as Parameters<Chess['get']>[0]);
    if (!piece) return false;
    for (const san of historySan.slice(fromPly - 1)) {
      const m = chess.move(san);
      const now = chess.get(square as Parameters<Chess['get']>[0]);
      if (m.from === square || m.to === square || !now || now.type !== piece.type || now.color !== piece.color) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The warning of an earlier turn was about this very piece on this square, and the child let it stand (§2.2 after the
 * second 50-game run: 11 of the 90 stage-3 dangers were such repeats). A check and a mate threat are never repeats.
 */
export function warnedBefore(lm: Pick<LessonMemory, 'lastDanger'>, ply: number, d: Pick<TeachDanger, 'kind' | 'piece' | 'squares'>, historySan?: readonly string[]): boolean {
  if (d.kind === 'check' || d.kind === 'mate') return false;
  const mark = lm.lastDanger;
  if (!mark || !mark.square || mark.ply >= ply || mark.kind === 'check' || mark.kind === 'mate') return false;
  if (!dangerSquares(d).includes(mark.square)) return false;
  // (the turn right after: the child's one move could not have brought another piece onto that square)
  if (mark.ply === ply - 2) return true;
  return !!historySan && stoodSince(historySan, mark.ply, mark.square);
}

/**
 * The class a danger is spoken of by this turn: `dangerClass`, except that a warning repeated about the same piece on
 * the same square (the child ignored it) is «other» — at most once in 3 turns — unless it is a check or a mate threat.
 */
export function dangerCadenceClass(a: Pick<DangerCadenceArgs, 'danger' | 'fen' | 'lm' | 'ply' | 'historySan'>): DangerClass {
  const cls = dangerClass(a.danger, a.fen);
  return cls === 'always' && warnedBefore(a.lm, a.ply, a.danger, a.historySan) ? 'other' : cls;
}

/**
 * Is the danger spoken of this turn (§2.2)? Always for a check, a mate threat, a piece losing ≥ 3 pawns (not warned
 * about already: a repeated warning is «other»); other threats and attacked pieces at most once in 3 turns; a pawn
 * never at stages 1–2, at stages 3–5 at most once in 4 turns and only when the advice saves it (letting a pawn go
 * needs no words: the advice is stronger); never right after the mistake reaction told of the same piece.
 */
export function dangerSpoken(a: DangerCadenceArgs): boolean {
  if (mistakeJustTold(a.lm, a.ply, a.danger)) return false;
  const cls = dangerCadenceClass(a);
  if (cls === 'always') return true;
  const last = a.dangerTurns.length > 0 ? Math.max(...a.dangerTurns) : null;
  const gap = last === null ? Number.POSITIVE_INFINITY : a.turnNo - last;
  if (cls === 'pawn') return a.stage >= 3 && a.saves && gap >= DANGER_EVERY.pawn;
  return gap >= DANGER_EVERY.other;
}

/** The lesson turn's own memo of the game (tolerant: an older snapshot, a malformed field → the empty memo). */
export function turnMemoOf(mem: Pick<TeachMemory, 'lessonTurnMemo'> | null | undefined): LessonTurnMemo {
  const r = (mem?.lessonTurnMemo ?? {}) as Partial<Record<keyof LessonTurnMemo, unknown>>;
  const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : []);
  return {
    dangerTurns: nums(r.dangerTurns).slice(-8),
    laterTurns: nums(r.laterTurns).slice(-40),
    lastCalmLater: r.lastCalmLater === true,
    adviceSaidPly: typeof r.adviceSaidPly === 'number' && Number.isFinite(r.adviceSaidPly) ? r.adviceSaidPly : null,
  };
}

/** The turns before `turnNo` whose advice arrow was hidden at the start (quiz, «Сам», treasure, stage-5 «позже»). */
function hiddenTurnsBefore(lm: Pick<LessonMemory, 'quizzes' | 'selfTurns' | 'treasureTurns'>, memo: LessonTurnMemo, turnNo: number): Set<number> {
  const all = [...lm.quizzes.map((q) => q.turn), ...lm.selfTurns, ...lm.treasureTurns, ...memo.laterTurns];
  return new Set(all.filter((t) => t >= 1 && t < turnNo));
}

// ═════════════════════════ the other sentences ═════════════════════════

function threatOf(from: Square | undefined, to: Square | undefined, targets: Square[] = to ? [to] : []): Threat | null {
  return from && to ? { uci: `${from}${to}`, san: '', motif: 'hangingPiece', targetSquares: targets, gainCp: 0 } : null;
}

/** The danger sentence (§2.2 #1): «без защиты» only when nobody defends the piece (§6.2). */
function dangerSent(env: Env, d: TeachDanger): Sent {
  const { ctx } = env;
  const base: CueFacts = { fen: ctx.fen, childColor: ctx.childColor };
  const arrow = d.arrows[0];
  switch (d.kind) {
    case 'check':
      return { key: 'danger', prio: 100, core: true, parts: [{ pool: 'v3.danger.check' }], facts: { ...base, kingOf: ctx.childColor } };
    case 'mate': {
      const threat = threatOf(arrow?.from, arrow?.to, d.squares);
      return { key: 'danger', prio: 100, core: true, parts: [{ pool: 'v3.danger.mate' }], facts: { ...base, kingOf: ctx.childColor, ...(threat ? { threat } : {}) } };
    }
    case 'hanging': {
      const sq = d.piece?.square;
      let undefended = false;
      try {
        undefended = !!sq && (findHanging(ctx.fen).find((h) => h.square === sq)?.defenders.length ?? 1) === 0;
      } catch {
        undefended = false;
      }
      const threat = threatOf(arrow?.from, sq);
      return {
        key: 'danger',
        prio: 100,
        core: true,
        parts: [{ pool: undefended ? 'v3.danger.hanging.undefended' : 'v3.danger.hanging.attacked', subjects: d.piece ? { victim: d.piece.piece } : {} }],
        facts: { ...base, ...(sq ? { victim: sq } : {}), ...(threat ? { threat } : {}) },
      };
    }
    case 'threat': {
      const threat = threatOf(arrow?.from, arrow?.to, d.squares);
      return { key: 'danger', prio: 100, core: true, parts: [{ pool: d.conceptId === 'fork' ? 'v3.danger.fork' : 'v3.danger.threat' }], facts: { ...base, ...(threat ? { threat } : {}) } };
    }
  }
}

/**
 * The opponent's move in the §2.3 format: only when he threatens or took — stages 3–5 also when his move
 * has a clear idea. null = say nothing about it.
 */
function oppSent(env: Env): Sent | null {
  const { ctx, plan, w } = env;
  const o = plan.opponent;
  const bot = ctx.lastBotMove;
  if (!o || !bot) return null;
  const mv = resolveUciMove(bot.fenBefore, bot.uci);
  if (!mv) return null;
  const idea = o.ideas[0];
  const base: CueFacts = { fen: ctx.fen, childColor: ctx.childColor };
  // (news — he took or threatens — outranks the theme sentence; a plain idea of his move gives way to it)
  const S = (pool: string, subjects: Subjects = {}, facts: Partial<CueFacts> = {}, prio = 50): Sent => ({ key: 'opp', prio, parts: [{ pool, subjects }], facts: { ...base, ...facts } });
  if (mv.captured) return idea?.id === 'recapture' ? S('v3.opp.recapture', {}, {}, 60) : S('v3.opp.capture', { victim: mv.captured }, {}, 60);
  if (mv.givesCheck) return S('v3.opp.check', {}, { kingOf: ctx.childColor }, 60);
  if (idea?.id === 'threatMate' || (o.wants && isMateMotif(o.wants.motif))) {
    const threat = ctx.threat ?? o.wants ?? null;
    return S('v3.opp.threatMate', {}, { kingOf: ctx.childColor, ...(threat ? { threat } : {}) }, 60);
  }
  if (idea?.id === 'attack' && idea.squares[0]) {
    const sq = idea.squares[0];
    const victim = pieceOn(ctx.fen, sq);
    const threat = threatOf(mv.to, sq);
    if (victim) return S('v3.opp.attack', { victim }, { victim: sq, ...(threat ? { threat } : {}) }, 60);
  }
  if (w.stage < 3) return null;
  if (o.earlyQueen) return S('v3.opp.earlyQueen', {}, { piece: mv.to });
  if (idea?.id === 'aimWeakSquare') return S('v3.opp.aimWeak', {}, { kingOf: ctx.childColor });
  if (mv.isCastle) return S('v3.opp.castle', {}, { kingOf: opposite(ctx.childColor) });
  if (idea?.id === 'develop') return S('v3.opp.develop', { oppPiece: mv.piece }, { piece: mv.to });
  if (idea?.id === 'centerPawn') return S('v3.opp.centerPawn');
  return null;
}

function familyFacts(fen: string, childColor: Color, family: LessonThemeFamily | null): CueFacts {
  if (!family) return { fen, childColor };
  const kingOf = familyKingOf(family, childColor);
  let target: Square | undefined;
  try {
    const b = parsePlacement(fen);
    const k = b.findIndex((p) => !!p && p.type === 'k' && p.color === opposite(childColor));
    if (k >= 0 && family === 'kingsideAttack') target = `${'abcdefgh'[k % 8]}${Math.floor(k / 8) + 1}`;
  } catch {
    target = undefined;
  }
  return { fen, childColor, kingOf, ...(target ? { target } : {}) };
}

function miniSent(env: Env, m: MiniDecision, a: AdviceCandidate | null, prio: number, danger: TeachDanger | null): Sent {
  const { ctx } = env;
  const facts: CueFacts = a ? adviceFacts(env, a, a.ideas[0]) : { fen: ctx.fen, childColor: ctx.childColor };
  // our king: castling and the active king always; a check or a mate lesson only when it comes from a danger (after a
  // mate treasure it is about the opponent's king — the advice's own facts)
  const matingTopic = m.topic === 'checkEscape' || m.topic === 'backRank' || m.topic === 'mateInOne' || m.topic === 'scholarsMate';
  const own = m.topic === 'castle' || m.topic === 'kingActive' || (matingTopic && danger !== null);
  const victim = danger?.piece?.square;
  const arrow = danger?.arrows[0];
  const threat = danger && arrow ? threatOf(arrow.from, arrow.to, danger.squares) : null;
  return {
    key: 'mini',
    prio,
    // blitz: a lesson of one sentence (§2.2)
    parts: [{ pool: `v3.mini.${m.topic}.l${m.level}`, ...(env.blitz ? { maxSentences: 1 } : {}) }],
    facts: { ...facts, ...(own ? { kingOf: ctx.childColor } : {}), ...(victim ? { victim } : {}), ...(threat ? { threat } : {}) },
  };
}

interface DangerWords {
  sents: Sent[];
  /** the advice said with it (null: no advice words) */
  build: AdviceBuild | null;
  /** the mini-lesson fits in */
  mini: boolean;
}

/**
 * The words of a danger that is spoken of (§2.2), never over the cap (16 / 22 words; a danger with its mini-lesson
 * 32) and never in a danger wording heard already this game while another is left (§2.11 — the bag chooses among all
 * the wordings that fit, `fitLevel`): the variants in order — the most of the danger's words first — and in each the
 * advice shapes in order, every part fresh first; the first that fits wins.
 * - with the mini-lesson (its first time this game; never in blitz): danger + lesson (+ «можно не спасать») + advice;
 * - danger (+ «можно не спасать») + advice; blitz: the rescuing advice alone (its words say the rescue), or «можно не
 *   спасать» (with the danger's own highlight) + the stronger advice — never an arrow without words about the move;
 * - the danger sentence dropped (for length, or no fresh wording of it fits): «можно не спасать» + advice, or the
 *   rescuing advice alone.
 * A mate that cannot be stopped has no «можно не спасать»: its advice ends «— сыграем до конца!» (blitz: that alone).
 */
function dangerWords(env: Env, d: TeachDanger, o: { saves: boolean; mini: MiniDecision | null; cap: number }): DangerWords {
  const { w, blitz, primary, mv, book } = env;
  const dS = dangerSent(env, d);
  const dPool = dS.parts[0]?.pool ?? '';
  // «можно не спасать» is about a piece (§6.2): never after a check or a mate threat — an advice that does not stop a
  // mate threat means the mate cannot be stopped at all, and «есть ход сильнее» would be false
  const letGo: Sent | null =
    primary && !o.saves && (d.kind === 'hanging' || d.kind === 'threat')
      ? { key: 'letGo', prio: 96, core: true, parts: [{ pool: mv?.givesCheck ? 'v3.danger.letGo.check' : 'v3.danger.letGo.stronger' }], facts: null }
      : null;
  // «можно не спасать» without the danger sentence shows the danger's own highlight (the red square, the threat)
  const letGoCued: Sent | null = letGo && canSay(letGo, w, book) ? { ...letGo, facts: dS.facts, extraCues: [...(lessonLine(dPool)?.cue ?? [])] } : null;
  // the mate cannot be stopped: the danger and the advice with the honest «сыграем до конца» — no tail that calls the
  // move safe (the plain advice only when that tail has no words)
  const lost = d.kind === 'mate' && !o.saves;
  const lostBuilds = primary && lost ? plainBuilds(env, primary, { simple: true, lost: true }) : [];
  // (the rescue-worded advices are tried first in every variant: alone, the advice must say the rescue itself)
  const builds = primary ? (o.saves ? rescueBuilds(env, primary) : lostBuilds.length > 0 ? lostBuilds : plainBuilds(env, primary, { simple: true })) : [];
  // (no mini-lesson in blitz: one sentence there, §2.2)
  const miniS: Sent | null = o.mini && primary && !blitz ? { ...miniSent(env, o.mini, primary, 97, d), core: true } : null;
  const variants: { head: (Sent | null)[]; cap: number; mini: boolean }[] = [];
  if (miniS) variants.push({ head: [dS, miniS, letGo], cap: DANGER_MINI_WORDS, mini: true });
  if (!blitz) variants.push({ head: [dS, letGo], cap: o.cap, mini: false });
  if (letGoCued) variants.push({ head: [letGoCued], cap: o.cap, mini: false });
  variants.push({ head: [], cap: o.cap, mini: false });
  for (const v of variants) {
    const head = v.head.filter((s): s is Sent => !!s && canSay(s, w, book));
    if (v.mini && !head.includes(miniS as Sent)) continue;
    const options = builds.map((b) => ({ b, sents: [...head, ...b.sents] }));
    const got = firstFit(options, v.cap, w, book, rescueFirst(options));
    if (got) return { sents: got.sents, build: got.b, mini: v.mini };
  }
  // no advice words that fit (or none at all): the danger sentence and the first advice (blitz: the advice alone) —
  // never silent
  const b = builds[0] ?? null;
  if (blitz && b) return { sents: b.sents, build: b, mini: false };
  return { sents: [dS, ...(b?.sents ?? [])], build: b, mini: false };
}

// ═════════════════════════ lessonTurn ═════════════════════════

function recallKeyFor(lm: LessonMemory, history: TeachContext['lessonHistory']): string | null {
  return lm.theme.recalled ? recallKeyOf(history) : null;
}

/** The quiz kinds of a calm turn in the order to try: the first quiz of a game is «Что задумал соперник?», then the least asked; a recalled concept first. */
function quizKinds(lm: LessonMemory, recallKey: string | null): QuizKind[] {
  const base: QuizKind[] = ['oppIdea', 'canCapture', 'whichPiece', 'why'];
  const count = (k: QuizKind): number => lm.quizzes.filter((q) => q.kind === k).length;
  let kinds = lm.quizzes.length === 0 ? base : [...base].sort((a, b) => count(a) - count(b));
  const recall = recallQuizKinds(recallKey).filter((k) => kinds.includes(k));
  kinds = [...recall, ...kinds.filter((k) => !recall.includes(k))];
  return kinds;
}

/** The «Сам» prompt of the advice's idea (`v3.self.<kind>`). */
function selfKindOf(a: AdviceCandidate, idea: MoveIdea | undefined, phase: PositionFacts['phase'] | undefined): string {
  switch (idea?.id) {
    case 'develop':
      return 'develop';
    case 'centerPawn':
    case 'fightCenter':
    case 'supportCenter':
      return 'center';
    case 'attack':
      return 'attack';
    case 'castle':
    case 'prepareCastle':
      return 'castle';
    case 'improvePiece':
      return 'improve';
    case 'kingActivity':
    case 'passedPawn':
    case 'restrictKing':
    case 'opposition':
      return 'endgame';
    default:
      if (a.planFit === 'line' || a.planFit === 'lineLater' || a.planGoal) return 'plan';
      return phase === 'endgame' ? 'endgame' : 'generic';
  }
}

interface QuizWords {
  sents: Sent[];
  labels: { id: string; label: string; icon?: string }[];
}

/** The question, the button labels (picked now) and, at stages 1–2, the options said aloud. null = no words. */
function quizWords(env: Env, q: QuizPlanX): QuizWords | null {
  const { w, book } = env;
  const question: Sent = { key: 'question', prio: 100, core: true, parts: [{ pool: q.questionPool, subjects: q.questionSubjects }], facts: q.questionFacts };
  if (!canSay(question, w, book)) return null;
  for (const o of q.options) if (o.pool !== '' && !book.has(o.pool, { stage: w.stage, g: w.g })) return null;
  const labels: { id: string; label: string; icon?: string }[] = [];
  const say: LessonSay[] = [];
  // the options as ids, so the recorded voice rebuilds exactly these labels (quizWords.ts)
  const options: LessonQuizVoice['options'] = [];
  for (const o of q.options) {
    if (o.pool === '') {
      const piece = (o.subject ?? o.id) as PieceType;
      labels.push({ id: o.id, label: pieceLabel(piece, q.kind), ...(o.icon ? { icon: o.icon } : {}) });
      options.push({ piece });
      continue;
    }
    const got = book.pick(o.pool, { stage: w.stage, g: w.g });
    if (!got) return null;
    labels.push({ id: o.id, label: quizOptionLabel(got.text), ...(o.icon ? { icon: o.icon } : {}) });
    options.push({ say: say.length });
    say.push({ pool: got.pool, n: got.n, ...(got.g ? { g: got.g } : {}) });
  }
  const sents: Sent[] = [question];
  if (q.sayOptions && labels.length === 3) {
    const text = quizOptionsText(labels.map((l) => l.label) as [string, string, string]);
    sents.push({ key: 'options', prio: 90, parts: [], facts: null, literal: { text, say, quiz: { kind: q.kind, options } } });
  }
  return { sents, labels };
}

/**
 * One child turn: `planTeachTurn` + the lesson moment + the words. Returns the plan (with `plan.lesson`), what the board
 * and the voice do now, and the next TeachMemory (`memory.lesson` updated).
 */
export function lessonTurnImpl(ctx: TeachContext, book: LessonBook, rng?: Rng): { plan: TeachPlan; result: LessonTurnResult; memory: TeachMemory } {
  const rand: Rng = rng ?? (() => book.random());
  const mem0 = restoreTeachMemory(ctx.memory ?? null);
  const lm0 = mem0.lesson ?? initialLessonMemory();
  const plan = planTeachTurn({ ...ctx, memory: mem0 }, rand);
  const w = wordsOf(ctx.profile);
  const blitz = isBlitz(ctx.tc);
  const turnNo = lm0.turn + 1;
  const facts = ctx.facts ?? safeFacts(ctx.fen);
  const primary = plan.advice[0] ?? null;
  const mv = primary ? (resolveUciMove(ctx.fen, primary.uci) ?? null) : null;
  const env: Env = {
    ctx,
    plan,
    w,
    blitz,
    book,
    rand,
    lm: lm0,
    turnNo,
    primary,
    mv,
    proof: engineProof(ctx.fen, ctx.analysis, ctx.verified),
    card: themeCardOf(ctx.strategyCard, ctx.strategy),
    facts,
  };
  const history = ctx.historySan ?? [];
  const recallKey = recallKeyFor(lm0, ctx.lessonHistory);

  // (the follow streak is counted by lessonReaction, which sees whether the child moved by the shown arrow)
  const childLast = childLastMove(ctx);
  const followStreak = lm0.followStreak;

  const memo0 = turnMemoOf(mem0);

  // the chess truth of the moment
  const danger = guardDanger(plan.danger, { fen: ctx.fen, threat: ctx.threat, inCheck: facts?.inCheck ?? false });
  const saves = !!danger && !!primary && adviceSaves(danger, ctx.fen, primary.uci);
  // §2.2 «Опасность — не в каждом ходе»: a danger that is not spoken of leaves the advice alone (its rescue words)
  const cadence = danger ? { danger, fen: ctx.fen, stage: w.stage, turnNo, ply: ctx.ply, lm: lm0, dangerTurns: memo0.dangerTurns, saves, historySan: ctx.historySan ?? [] } : null;
  const dangerSaid = !!cadence && dangerSpoken(cadence);
  const dangerCls = cadence ? dangerCadenceClass(cadence) : null;
  const treasureCap = w.stage <= 1 ? TREASURE_CAP.young : TREASURE_CAP.old;
  const lastTreasure = lm0.treasureTurns[lm0.treasureTurns.length - 1];
  const treasureOk = !!plan.treasure && !dangerSaid && !!primary && lm0.treasureTurns.length < treasureCap && (lastTreasure === undefined || turnNo - lastTreasure >= TREASURE_EVERY);
  const oppThreat = !!plan.opponent && (plan.opponent.ideas.some((i) => ['attack', 'threatMate', 'check', 'fork'].includes(i.id)) || plan.opponent.san.includes('x'));
  const calm = !danger && !plan.treasure && !oppThreat;
  const rawMain = primary ? (safePick(primary.allIdeas, w.stage) ?? primary.ideas[0]) : undefined;
  const sameIdea = !!rawMain && !!mv && lm0.lastIdea?.id === rawMain.id && lm0.lastIdea.piece === mv.piece;
  const urgent = !!rawMain && URGENT_IDEAS.has(rawMain.id);

  const qin: QuizInput = {
    stage: w.stage,
    fen: ctx.fen,
    childColor: ctx.childColor,
    ply: ctx.ply,
    proof: env.proof,
    advice: primary ? { uci: primary.uci, san: primary.san } : null,
    opponent: plan.opponent && ctx.lastBotMove ? { uci: ctx.lastBotMove.uci, san: ctx.lastBotMove.san, fenBefore: ctx.lastBotMove.fenBefore, ideas: plan.opponent.ideas, earlyQueen: plan.opponent.earlyQueen } : null,
    threat: ctx.threat,
    lastChild: childLast,
    lastAdvice: lm0.lastAdvice,
    adviceShown: lm0.adviceShown,
    rng: rand,
  };
  const due = quizDue(lm0, turnNo, ctx.ply, w.stage, ctx.tc);

  // ── the moment (§2.2): first match wins ──
  let moment: LessonMomentKind = 'advice';
  let quiz: QuizPlanX | null = null;
  let quizW: QuizWords | null = null;
  let mini: MiniDecision | null = null;
  let selfKind: string | null = null;
  const has = (pool: string): boolean => book.has(pool, { stage: w.stage, g: w.g });
  if (danger && dangerSaid) {
    moment = 'danger';
    const mateAgainst = env.proof?.lines[0]?.mate !== undefined && env.proof?.lines[0]?.mate !== null && (env.proof?.lines[0]?.mate ?? 0) < 0;
    if (due && danger.kind !== 'mate' && !mateAgainst) {
      const q = dangerQuiz(qin, danger);
      const words = q ? quizWords(env, q) : null;
      if (q && words) {
        quiz = q;
        quizW = words;
      }
    }
    if (!quiz) {
      const topic = dangerMiniTopic(danger);
      const firstTime = lm0.lastDanger?.kind !== danger.kind;
      // (never in blitz: there a danger is its one sentence — the rescuing advice, or «можно не спасать» + advice)
      if (topic && firstTime && !blitz) mini = decideMini([topic], { stage: w.stage, blitz, lm: lm0, history: ctx.lessonHistory, recallTopic: recallMiniTopic(recallKey), has });
    }
  } else if (treasureOk) {
    moment = 'treasure';
  } else {
    // (not only in a calm turn: «Что задумал соперник? — Нападает» is the question when he attacked without a danger)
    if (due && primary && !plan.treasure) {
      for (const kind of quizKinds(lm0, recallKey)) {
        const q = turnQuiz(qin, [kind]);
        const words = q ? quizWords(env, q) : null;
        if (q && words) {
          quiz = q;
          quizW = words;
          moment = 'quiz';
          break;
        }
      }
    }
    const lastSelf = lm0.selfTurns[lm0.selfTurns.length - 1];
    if (moment !== 'quiz' && primary && calm && !urgent && !blitz && w.stage >= 2 && (followStreak >= 3 || sameIdea) && (lastSelf === undefined || turnNo - lastSelf >= SELF_EVERY)) {
      const kind = selfKindOf(primary, rawMain, facts?.phase);
      if (has(`v3.self.${kind}`)) {
        moment = 'self';
        selfKind = kind;
      } else if (has('v3.self.generic')) {
        moment = 'self';
        selfKind = 'generic';
      }
    }
    // (a danger left unsaid still leaves no room for a lesson about something else)
    if (moment === 'advice' && primary && turnNo >= 2 && !plan.treasure && !danger) {
      const topics = adviceMiniTopics({ fen: ctx.fen, childColor: ctx.childColor, ply: ctx.ply, turnNo, advice: { uci: primary.uci, san: primary.san, allIdeas: primary.allIdeas, mate: primary.mate }, opponent: plan.opponent ? { earlyQueen: plan.opponent.earlyQueen } : null, proof: env.proof });
      // blitz: of the advice minis only «как думать» (§2.2) — the danger minis come inside the danger
      // (and only a level that has a one-sentence wording: no mini-lesson in blitz without one)
      const miniHas = blitz ? (pool: string): boolean => book.has(pool, { stage: w.stage, g: w.g, maxSentences: 1 }) : has;
      mini = decideMini(blitz ? topics.filter((t) => t === 'thinking') : topics, { stage: w.stage, blitz, lm: lm0, history: ctx.lessonHistory, recallTopic: recallMiniTopic(recallKey), has: miniHas });
      if (mini) moment = 'mini';
    }
    const quietMax = w.stage >= 5 ? QUIET_MAX.stage5 : QUIET_MAX.base;
    if (moment === 'advice' && primary && calm && sameIdea && (w.stage <= 1 || blitz || w.stage >= 5) && lm0.quietStreak < quietMax) moment = 'quiet';
  }

  // ── the words and the board of the moment ──
  const adviceList: TeachAdvice[] = primary ? [toTeachAdvice(primary)] : [];
  // (assigned inside `adviceMoment` too: the casts keep TypeScript from narrowing them to their initial value)
  let event = null as CoachEvent | null;
  let board: BoardAnnotations = emptyBoard();
  let adviceHidden = false as boolean;
  let revealAfterMs = null as number | null;
  let revealLater = false as boolean;
  const hints: LessonTurnResult['hints'] = [];
  let lessonQuiz = null as LessonQuiz | null;
  let bark = null as string | null;
  let shape = null as AdviceShape | null;
  let told: { id: string; variant?: string }[] = [];
  let themeLinkSaid = null as string | null;
  let themeLineSaid = null as { pool: string; kind: string } | null;
  let oppSaid = null as { pool: string; square: Square | null } | null;
  let miniSaid = null as MiniDecision | null;
  /** the advice was said in words in this utterance («Совет» may then say «Как я и говорил») */
  let adviceSaid = false as boolean;
  /** a calm advice at stage 5 was given this turn (the «every second» rhythm of «позже») */
  let calmAdvice5 = false as boolean;
  const cap = capFor(w);
  const shownBoard = (c: Composed | null): BoardAnnotations => cuesToBoard(c?.rendered.cues ?? [], { sentence: 0, base: arrowBoard(adviceList) });

  /** Stage 5 «позже» (§2.2): every second calm advice at most, not right after a hidden-arrow turn, the share kept. */
  const laterOk = (): boolean => {
    if (memo0.lastCalmLater) return false;
    const hidden = hiddenTurnsBefore(lm0, memo0, turnNo);
    const prevHidden = hidden.has(turnNo - 1) || (lm0.lastAdvice?.hidden === true && lm0.lastAdvice.ply === ctx.ply - 2);
    return !prevHidden && hidden.size + 1 <= REVEAL_LATER_SHARE * turnNo;
  };

  /**
   * A danger not spoken of whose piece the advice saves (§2.2): just the advice, its words carry the rescue («Уведём
   * коня из-под удара — …»); the arrow at once.
   */
  const rescueMoment = (): boolean => {
    const p = primary as AdviceCandidate;
    const options = rescueBuilds(env, p).map((b) => ({ b, sents: b.sents }));
    const build = firstFit(options, cap, w, book, rescueFirst(options))?.b ?? null;
    if (!build) return false;
    const c = compose(build.sents, { cap, maxSentences: blitz ? 1 : 3 }, w, book);
    if (!c.keys.includes('advice')) return false;
    shape = build.shape;
    told = build.told;
    adviceSaid = true;
    event = eventOf('teachTurn', c, { pose: 'talk', teach: teachSummary('turn', ctx.ply, adviceList, false, c.rendered.sentences.length), board: arrowBoard(adviceList) });
    board = shownBoard(c);
    return true;
  };

  const adviceMoment = (): void => {
    if (!primary) return;
    // a danger left unsaid (§2.2): the advice that saves the piece says so itself; one that does not, simply advises
    if (danger && saves && rescueMoment()) return;
    if (w.stage >= 5 && calm) {
      calmAdvice5 = true;
      revealLater = laterOk();
    }
    const card = env.card;
    const link = themeLink({ card, blitz, fen: ctx.fen, childColor: ctx.childColor, advice: { uci: primary.uci, san: primary.san }, idea: primary.ideas[0], historySan: history, turnNo, lm: lm0 });
    const line = blitz ? null : themeLine({ stage: w.stage, childColor: ctx.childColor, ply: ctx.ply, turnNo, historySan: history, fen: ctx.fen, phase: facts?.phase, opening: isOpening(facts, ctx.ply), card, lm: lm0 });
    // (a danger left unsaid is not brought back by «Соперник напал на пешку» before an advice that lets it go)
    const oppS = blitz ? null : oppSent(env);
    const oppPool = oppS?.parts[0]?.pool ?? '';
    const opp = danger && (oppPool === 'v3.opp.attack' || oppPool === 'v3.opp.threatMate') ? null : oppS;
    const tail: Part | null = link?.kind === 'tail' ? { pool: link.pool } : null;
    let adv = buildAdvice(env, primary, { tail, hide: revealLater, moveAtEnd: !revealLater });
    const advTail = adv ? tail : null;
    if (!adv && tail) adv = buildAdvice(env, primary, { hide: revealLater, moveAtEnd: !revealLater });
    // a shape that fits the cap only by a wording heard already this game gives way to one whose words are all fresh
    if (adv && fitLevel(adv.sents, cap, w, book) !== 1) {
      const alt = firstFit([adv, ...plainBuilds(env, primary, { tail: advTail, hide: revealLater, moveAtEnd: !revealLater })], cap, w, book);
      if (alt) adv = alt;
    }
    // the §2.3 format: «Соперник напал на коня. Отвечаем конём — …» when both fit
    if (adv && opp && canSay(opp, w, book) && (adv.shape === 'A' || adv.shape === 'C')) {
      const est = adv.sents.reduce((n, s) => n + sentMaxWords(s, w), 0) + sentMaxWords(opp, w);
      if (est <= cap) {
        const answer = buildAdvice(env, primary, { lead: 'answer', tail: adv.shape && tail ? tail : null, hide: revealLater, moveAtEnd: !revealLater, shape: adv.shape });
        if (answer) adv = answer;
      }
    }
    // (the opening's name is said once a game — above a plain word about the opponent's move; a reminder below it)
    // «позже»: the theme sentences are hidden with the advice — the link's cues resolve against the advice move (its
    // lines, its piece, its capture), so none of them may show it before the arrow, nor a pointing word be chosen
    const hideLater = revealLater ? { hide: true } : {};
    const themeS: Sent | null = line ? { key: 'theme', prio: line.kind === 'named' ? 55 : 45, parts: [{ pool: line.pool }], facts: familyFacts(ctx.fen, ctx.childColor, familyOf(card)), ...hideLater } : null;
    const linkS: Sent | null = link && link.kind !== 'tail' ? { key: 'link', prio: 40, parts: [{ pool: link.pool }], facts: { ...adviceFacts(env, primary, primary.ideas[0]), ...(link.family ? { kingOf: familyKingOf(link.family, ctx.childColor) } : {}) }, ...hideLater } : null;
    const c = compose([themeS, opp, ...(adv?.sents ?? []), linkS], { cap, maxSentences: blitz ? 1 : 3 }, w, book);
    shape = adv?.shape ?? null;
    told = adv?.told ?? [];
    adviceSaid = c.keys.includes('advice');
    // (a blitz theme tail counts only when the advice said really carries it)
    const tailSaid = link?.kind === 'tail' && (c.picked.get('advice') ?? []).some((p) => p.pool === link.pool);
    if (c.keys.includes('link') || tailSaid) themeLinkSaid = link?.pool ?? null;
    if (line && c.keys.includes('theme')) themeLineSaid = line;
    if (opp && c.keys.includes('opp')) oppSaid = { pool: opp.parts[0]?.pool ?? '', square: opp.facts?.victim ?? opp.facts?.piece ?? null };
    adviceHidden = revealLater;
    revealAfterMs = revealLater ? REVEAL_LATER_MS : null;
    const sentences = c.rendered.sentences.length;
    event = eventOf('teachTurn', c, { pose: 'talk', teach: teachSummary('turn', ctx.ply, adviceList, adviceHidden, sentences), board: revealLater ? emptyBoard() : arrowBoard(adviceList) });
    board = revealLater ? cuesToBoard(c.rendered.cues, { sentence: 0 }) : shownBoard(c);
  };

  switch (moment) {
    case 'danger': {
      const d = danger as TeachDanger;
      const qc = quiz && quizW ? compose(quizW.sents, { cap: 40, maxSentences: 2 }, w, book) : null;
      lessonQuiz = quiz && quizW && qc ? quizOfPlan(quiz, quizW, qc, ctx.ply) : null;
      if (qc && lessonQuiz) {
        // the danger's quiz form (a): the question alone — the danger words would give the answer away
        adviceHidden = true;
        revealAfterMs = treasureRevealMs(w.stage) + 10_000;
        event = eventOf('teachTurn', qc, { pose: 'think', priority: d.kind === 'check' ? 2 : 1, teach: teachSummary('quiz', ctx.ply, adviceList, true, qc.rendered.sentences.length) });
        if (event) event = { ...event, quiz: lessonQuiz };
        board = cuesToBoard(qc.rendered.cues, { sentence: 0 });
        break;
      }
      quiz = null;
      const dw = dangerWords(env, d, { saves, mini, cap });
      const c = compose(dw.sents, { cap: dw.mini ? DANGER_MINI_WORDS : cap, maxSentences: 4 }, w, book);
      if (mini && dw.mini && c.keys.includes('mini')) miniSaid = mini;
      if (dw.build && c.keys.includes('advice')) {
        shape = dw.build.shape;
        told = dw.build.told;
        adviceSaid = true;
      }
      event = eventOf('teachTurn', c, {
        pose: 'think',
        priority: d.kind === 'mate' || d.kind === 'check' ? 2 : 1,
        teach: teachSummary(miniSaid ? 'mini' : 'turn', ctx.ply, adviceList, false, c.rendered.sentences.length, miniSaid ? TOPIC_CARD[miniSaid.topic] : null),
        board: arrowBoard(adviceList),
      });
      board = shownBoard(c);
      break;
    }
    case 'treasure': {
      const t = plan.treasure as NonNullable<TeachPlan['treasure']>;
      const { idea: tIdea, pool: kindPool } = treasureOf(plan);
      const victim = treasureOf(plan).subjects.target ?? null;
      const tFacts: CueFacts = { fen: ctx.fen, childColor: ctx.childColor, target: t.target, victim: t.target, piece: t.target, ...(t.kind === 'mate' ? { kingOf: opposite(ctx.childColor) } : {}) };
      const young = w.stage <= 2;
      const first: Sent = young
        ? { key: 'treasure', prio: 100, core: true, parts: [{ pool: kindPool, subjects: victim ? { target: victim } : {} }], facts: tFacts }
        : { key: 'treasure', prio: 100, core: true, parts: [{ pool: 'v3.treasure.hunt' }], facts: null };
      const ask: Sent = { key: 'ask', prio: 95, core: true, parts: [{ pool: 'v3.treasure.ask' }], facts: null };
      const c = compose([first, ask], { cap: 40, maxSentences: 2 }, w, book);
      if (c.rendered.text !== '') {
        adviceHidden = true;
        revealAfterMs = treasureRevealMs(w.stage);
        const targetHl: BoardAnnotations = { arrows: [], highlights: [{ square: t.target, color: 'yellow' }] };
        const now = young ? cuesToBoard(c.rendered.cues, { base: targetHl }) : emptyBoard();
        event = eventOf('teachTurn', c, { pose: 'think', teach: teachSummary('turn', ctx.ply, adviceList, true, c.rendered.sentences.length), board: now });
        board = now;
        if (young) hints.push({ atMs: 5_000, board: { arrows: [], highlights: [...now.highlights, { square: t.from, color: 'blue' }] } });
        else hints.push({ atMs: 8_000, board: targetHl });
        told = tIdea ? [{ id: tIdea.id }] : [];
      } else {
        moment = 'advice';
        adviceMoment();
      }
      break;
    }
    case 'quiz': {
      const q = quiz as QuizPlanX;
      const c = compose((quizW as QuizWords).sents, { cap: 40, maxSentences: 2 }, w, book);
      lessonQuiz = quizOfPlan(q, quizW as QuizWords, c, ctx.ply);
      if (!lessonQuiz) {
        quiz = null;
        moment = 'advice';
        adviceMoment();
        break;
      }
      adviceHidden = true;
      revealAfterMs = treasureRevealMs(w.stage) + 10_000;
      event = eventOf('teachTurn', c, { pose: 'think', teach: teachSummary('quiz', ctx.ply, adviceList, true, c.rendered.sentences.length) });
      if (event && lessonQuiz) event = { ...event, quiz: lessonQuiz };
      board = cuesToBoard(c.rendered.cues, { sentence: 0 });
      break;
    }
    case 'self': {
      const s: Sent = { key: 'self', prio: 100, core: true, parts: [{ pool: `v3.self.${selfKind}` }], facts: { fen: ctx.fen, childColor: ctx.childColor, kingOf: ctx.childColor } };
      const c = compose([s], { cap: 40, maxSentences: 2 }, w, book);
      adviceHidden = true;
      revealAfterMs = w.stage <= 3 ? SELF_REVEAL_MS.mid : SELF_REVEAL_MS.old;
      event = eventOf('teachTurn', c, { pose: 'think', teach: teachSummary('turn', ctx.ply, adviceList, true, c.rendered.sentences.length) });
      board = cuesToBoard(c.rendered.cues, { sentence: 0 });
      if (!event) {
        moment = 'advice';
        adviceMoment();
      }
      break;
    }
    case 'mini': {
      // the lesson + the advice it is about (blitz too): the arrow never points at a move nobody talked about (§2.2)
      const m = mini as MiniDecision;
      const p = primary as AdviceCandidate;
      const lesson: Sent = { ...miniSent(env, m, p, 100, null), core: true, moveAtEnd: true };
      const got = canSay(lesson, w, book)
        ? firstFit(
            plainBuilds(env, p, { simple: true, moveAtEnd: true, prio: 95 }).map((b) => ({ b, sents: [lesson, ...b.sents] })),
            MINI_WORDS,
            w,
            book,
          )
        : null;
      const adv: AdviceBuild | null = got?.b ?? null;
      const c = got ? compose(got.sents, { cap: MINI_WORDS, maxSentences: 4 }, w, book) : null;
      if (c && adv && c.keys.includes('mini') && c.keys.includes('advice')) {
        miniSaid = m;
        shape = adv.shape;
        told = adv.told;
        adviceSaid = true;
        event = eventOf('teachTurn', c, { pose: 'talk', teach: teachSummary('mini', ctx.ply, adviceList, false, c.rendered.sentences.length, TOPIC_CARD[m.topic] ?? null), board: arrowBoard(adviceList) });
        board = shownBoard(c);
      } else {
        moment = 'advice';
        adviceMoment();
      }
      break;
    }
    case 'quiet': {
      bark = book.pick('v3.bark.quiet', { stage: w.stage, g: w.g })?.text ?? null;
      board = arrowBoard(adviceList);
      told = rawMain ? [{ id: rawMain.id }] : [];
      break;
    }
    case 'advice':
      adviceMoment();
      break;
  }

  // ── the next lesson memory ──
  const lm: LessonMemory = {
    ...lm0,
    turn: turnNo,
    shapes: shape ? [...lm0.shapes, shape].slice(-4) : lm0.shapes,
    lastIdea: rawMain && mv && (moment === 'advice' || moment === 'quiet' || moment === 'mini' || moment === 'danger') ? { id: rawMain.id, piece: mv.piece } : lm0.lastIdea,
    quietStreak: moment === 'quiet' ? lm0.quietStreak + 1 : 0,
    followStreak: moment === 'self' ? 0 : followStreak,
    quizzes: lessonQuiz && quiz ? [...lm0.quizzes, { turn: turnNo, ply: ctx.ply, kind: quiz.kind, correct: null }] : lm0.quizzes,
    selfTurns: moment === 'self' ? [...lm0.selfTurns, turnNo] : lm0.selfTurns,
    treasureTurns: moment === 'treasure' ? [...lm0.treasureTurns, turnNo] : lm0.treasureTurns,
    minis: miniSaid ? [...lm0.minis, { turn: turnNo, ply: ctx.ply, topic: miniSaid.topic, level: miniSaid.level, slot: miniSaid.slot }] : lm0.minis,
    theme: {
      ...lm0.theme,
      named: lm0.theme.named || themeLineSaid?.kind === 'named',
      lastRemindTurn: themeLineSaid && (themeLineSaid.kind === 'remind' || themeLineSaid.kind === 'named' || themeLineSaid.kind === 'left') ? turnNo : lm0.theme.lastRemindTurn,
      links: themeLinkSaid ? [...lm0.theme.links, turnNo] : lm0.theme.links,
    },
    phaseSaid: {
      middlegame: lm0.phaseSaid.middlegame || themeLineSaid?.pool === 'v3.phase.middlegame',
      endgame: lm0.phaseSaid.endgame || themeLineSaid?.pool === 'v3.phase.endgame',
    },
    lastAdvice: primary ? { ply: ctx.ply, uci: primary.uci, san: primary.san, ideas: told, hidden: adviceHidden } : lm0.lastAdvice,
    adviceShown: primary && !adviceHidden ? [...lm0.adviceShown.filter((p) => p !== ctx.ply), ctx.ply].slice(-40) : lm0.adviceShown,
    lastDanger: moment === 'danger' && danger ? { ply: ctx.ply, square: danger.piece?.square ?? danger.squares[0] ?? null, kind: danger.kind } : lm0.lastDanger,
  };
  if (miniSaid) book.learner.miniTold(miniSaid.topic, miniSaid.level);

  const whyLink = primary
    ? (themeLink({ card: env.card, blitz: false, fen: ctx.fen, childColor: ctx.childColor, advice: { uci: primary.uci, san: primary.san }, idea: primary.ideas[0], historySan: history, turnNo, lm: lm0, force: true })?.pool ?? null)
    : null;
  const lessonPlan: TurnPlanX = {
    moment,
    shape,
    quiz,
    mini: miniSaid,
    self: selfKind,
    themeLink: themeLinkSaid,
    themeLine: themeLineSaid?.pool ?? null,
    opp: oppSaid,
    adviceHidden,
    revealAfterMs,
    revealLater,
    x: { danger, dangerCls, told, whyLink: whyLink && whyLink.startsWith('v3.why.') ? whyLink : null, recallKey, turnNo, blitz },
  };
  const memo: LessonTurnMemo = {
    // (a danger spoken of: its sentence, «можно не спасать», its quiz — the cadence counts from here)
    dangerTurns: moment === 'danger' ? [...memo0.dangerTurns.filter((t) => t !== turnNo), turnNo].slice(-8) : memo0.dangerTurns,
    laterTurns: revealLater ? [...memo0.laterTurns.filter((t) => t !== turnNo), turnNo].slice(-40) : memo0.laterTurns,
    lastCalmLater: calmAdvice5 ? revealLater : memo0.lastCalmLater,
    adviceSaidPly: adviceSaid ? ctx.ply : memo0.adviceSaidPly === ctx.ply ? null : memo0.adviceSaidPly,
  };
  const memory: TeachMemory = { ...plan.memory, lesson: lm, lessonTurnMemo: memo };
  const out: TeachPlan = { ...plan, memory, lesson: lessonPlan };
  const result: LessonTurnResult = { moment, event, board, advice: adviceList, adviceHidden, revealAfterMs, hints, quiz: lessonQuiz, bark };
  return { plan: out, result, memory };
}

/** The idea a gift is (as `planTeachTurn` found it: a mate, a free / winning capture, a tactic) and its line. */
function treasureOf(plan: TeachPlan): { idea: MoveIdea | undefined; pool: string; subjects: Subjects } {
  const t = plan.treasure;
  if (!t) return { idea: undefined, pool: 'v3.treasure.tactic', subjects: {} };
  const kindIds: readonly string[] =
    t.kind === 'mate' ? ['mate', 'mateSoon'] : t.kind === 'capture' ? ['freeCapture', 'winMaterial'] : ['fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'removeDefender', 'trappedPiece'];
  const idea = plan.advice[0]?.allIdeas.find((i) => kindIds.includes(i.id));
  const pool = t.kind === 'mate' ? 'v3.treasure.mate' : t.kind === 'capture' ? (idea?.id === 'freeCapture' ? 'v3.treasure.free' : 'v3.treasure.win') : idea?.id === 'fork' ? 'v3.treasure.fork' : 'v3.treasure.tactic';
  const victim = pieceOn(plan.fen, t.target);
  return { idea, pool, subjects: victim && victim !== 'k' ? { target: victim } : {} };
}

function safePick(ideas: readonly MoveIdea[], stage: number): MoveIdea | undefined {
  try {
    return pickIdeas(ideas, { stage, max: 1 })[0];
  } catch {
    return undefined;
  }
}

function isOpening(facts: PositionFacts | null, ply: number): boolean {
  return facts?.phase === 'opening' || (ply <= 20 && facts?.phase !== 'endgame');
}

function quizOfPlan(q: QuizPlanX, words: QuizWords, c: Composed, ply: number): LessonQuiz | null {
  const qi = c.keys.indexOf('question');
  if (qi < 0 || words.labels.length !== 3) return null;
  return { id: `q${ply}-${q.kind}`, kind: q.kind, ply, question: c.rendered.sentences[qi] ?? '', options: words.labels, correctId: q.correct };
}

// ═════════════════════════ after the turn: the child's buttons ═════════════════════════

function envOfPlan(plan: TeachPlan, memory: TeachMemory, book: LessonBook): Env {
  const lm = memory.lesson ?? initialLessonMemory();
  const ctx: TeachContext = { fen: plan.fen, ply: plan.ply, childColor: plan.childColor, profile: plan.profile, analysis: null };
  const primary = plan.advice[0] ?? null;
  return {
    ctx,
    plan,
    w: wordsOf(plan.profile),
    blitz: false,
    book,
    rand: () => book.random(),
    lm,
    turnNo: lm.turn,
    primary,
    mv: primary ? (resolveUciMove(plan.fen, primary.uci) ?? null) : null,
    proof: null,
    card: null,
    facts: null,
  };
}

function xOf(plan: TeachPlan): TurnPlanX['x'] | null {
  const l = plan.lesson as TurnPlanX | undefined;
  return l?.x ?? null;
}

function adviceShownNow(lm: LessonMemory, ply: number): LessonMemory {
  return { ...lm, adviceShown: [...lm.adviceShown.filter((p) => p !== ply), ply].slice(-40) };
}

/**
 * What the reveal / «Совет» / the answer tells the caller besides the public director result: `stopHints` — the advice
 * is on the board now, so the hint timers of the hidden advice (the treasure's steps, §2.7) must be cleared; no hint may
 * come after it. «Почему так?» on a still hidden advice keeps them (`stopHints: false`).
 */
export interface HintsStop {
  stopHints: boolean;
}

/** The mini-lesson topic a RIGHT answer of a quiz kind shows the child understood (§2.6: the next level needs it). */
export function quizShowsTopic(kind: QuizKind, correctId: string): string | null {
  switch (kind) {
    case 'danger':
      return 'hanging';
    case 'checkEscape':
      return 'checkEscape';
    case 'canCapture':
      return correctId === 'capYes' ? 'freeCapture' : 'pieceValues';
    case 'oppIdea':
      return 'thinking';
    default:
      return null;
  }
}

/** The child pressed a quiz button (null = skipped / timed out): right / wrong + the true explanation + the advice. */
export function lessonAnswerImpl(plan: TeachPlan, memory: TeachMemory, optionId: string | null, book: LessonBook): { event: CoachEvent; board: BoardAnnotations; correct: boolean | null; memory: TeachMemory } & HintsStop {
  const mem = restoreTeachMemory(memory);
  const lm0 = mem.lesson ?? initialLessonMemory();
  const env = envOfPlan(plan, mem, book);
  const { w } = env;
  const q = plan.lesson?.quiz as QuizPlanX | null | undefined;
  const primary = env.primary;
  const adviceList: TeachAdvice[] = primary ? [toTeachAdvice(primary)] : [];
  const correct = !q || optionId === null ? null : optionId === q.correct;
  const sents: Sent[] = [];
  if (correct === true) sents.push({ key: 'verdict', prio: 100, core: true, parts: [{ pool: 'v3.quiz.right' }], facts: null });
  if (correct === false) sents.push({ key: 'verdict', prio: 100, core: true, parts: [{ pool: 'v3.quiz.wrong' }], facts: null });
  const ex = q?.explain;
  if (ex?.kind === 'pool') sents.push({ key: 'explain', prio: 98, core: true, parts: [{ pool: ex.pool, subjects: ex.subjects, variant: ex.variant ?? null }], facts: ex.facts });
  if (ex?.kind === 'why') {
    sents.push({
      key: 'explain',
      prio: 98,
      core: true,
      parts: [
        { pool: 'v3.lead.why', subjects: { mover: ex.piece } },
        {
          pool: `v3.idea.${ex.idea.id}`,
          variant: ex.idea.variant ?? null,
          subjects: { mover: ex.piece, ...(ex.target ? { target: ex.target, defended: ex.target, victim: ex.target } : {}) },
        },
      ],
      facts: ex.facts,
      noPartCues: true,
      extraCues: ['lastMove'],
    });
  }
  // a truth sentence that cannot be said (no wording for its piece / stage) must not take the advice down with it
  for (let i = sents.length - 1; i >= 0; i--) {
    const s0 = sents[i] as Sent;
    if (s0.key === 'explain' && !canSay(s0, w, book)) sents.splice(i, 1);
  }
  const cap = w.stage <= 2 ? ANSWER_WORDS.young : ANSWER_WORDS.old;
  // the answer shows the advice arrow, so its words about the move are kept: the advice takes its room first, the
  // opener and the truth are shortened for it (their bags choose within what is left)
  let withAdvice: Sent[] | null = null;
  if (primary) {
    const prio = ex?.kind === 'advice' ? 99 : 90;
    const builds = [rescueAdviceOf(env, plan, primary, prio), ...plainBuilds(env, primary, { simple: true, prio })].filter((b): b is AdviceBuild => !!b);
    const got = firstFit(
      builds.map((b) => ({ sents: [...sents, ...b.sents.map((s) => ({ ...s, core: true, room: ANSWER_ADVICE_ROOM }))] })),
      cap,
      w,
      book,
    );
    withAdvice = got?.sents ?? null;
  }
  const c0 = withAdvice ? compose(withAdvice, { cap, maxSentences: 3 }, w, book) : null;
  // (the advice words did not fit: the arrow waits for «Совет» — never an arrow without words about the move, §2.2)
  const c = c0 ?? compose(sents, { cap, maxSentences: 3 }, w, book);
  const shown = !!primary && c.keys.includes('advice');
  const shownList = shown ? adviceList : [];
  const answerBoard = arrowBoard(shownList);
  const ev =
    eventOf('teachTurn', c, { pose: correct === true ? 'cheer' : 'talk', teach: teachSummary('answer', plan.ply, adviceList, !shown, c.rendered.sentences.length), board: answerBoard }) ??
    lessonEvent({ kind: 'teachTurn', rendered: { text: '', sentences: [], say: [], saySentences: [], cues: [] }, pose: 'talk', teach: teachSummary('answer', plan.ply, adviceList, !shown, 0), board: answerBoard });
  let lm = shown ? adviceShownNow(lm0, plan.ply) : lm0;
  // a right answer shows the concept (§2.6: the next level of its mini-lesson needs it) — once a game per quiz kind,
  // and only for a topic the child has already heard
  if (q && correct === true) {
    const topic = quizShowsTopic(q.kind, q.correct);
    const before = lm0.quizzes.some((x) => x.kind === q.kind && x.ply !== plan.ply && x.correct === true);
    if (topic && !before && (book.history().minis[topic]?.level ?? 0) >= 1) book.learner.miniShown(topic);
  }
  if (q) {
    let done = false;
    const quizzes = [...lm.quizzes]
      .reverse()
      .map((x) => {
        if (!done && x.ply === plan.ply && x.kind === q.kind) {
          done = true;
          return { ...x, correct };
        }
        return x;
      })
      .reverse();
    lm = { ...lm, quizzes };
  }
  const board = cuesToBoard(c.rendered.cues, { base: answerBoard });
  return { event: ev, board, correct, memory: withSaid({ ...mem, lesson: lm }, plan.ply, c.keys.includes('advice')), stopHints: shown || !primary };
}

/** The next memory with the «advice said in words» flag of this ply (set when said now, kept otherwise). */
function withSaid(mem: TeachMemory, ply: number, said: boolean): TeachMemory {
  if (!said) return mem;
  return { ...mem, lessonTurnMemo: { ...turnMemoOf(mem), adviceSaidPly: ply } };
}

/**
 * The advice of a plan whose danger it deals with, in one sentence (a quiz answer, «Совет» before any advice words):
 * its own rescue idea, else the rescue lead. null = no danger, or the advice does not save the piece.
 */
/** The turn's mate threat is not stopped by the advice — the mate cannot be stopped (`lost` of `dangerWords`). */
function mateLost(plan: TeachPlan, primary: AdviceCandidate): boolean {
  const danger = xOf(plan)?.danger ?? null;
  return danger?.kind === 'mate' && !adviceSaves(danger, plan.fen, primary.uci);
}

function rescueAdviceOf(env: Env, plan: TeachPlan, primary: AdviceCandidate, prio?: number): AdviceBuild | null {
  const danger = xOf(plan)?.danger ?? null;
  if (!danger || !adviceSaves(danger, plan.fen, primary.uci)) return null;
  const first = primary.ideas[0];
  const p = prio !== undefined ? { prio } : {};
  const own = first && RESCUE_IDEAS.has(first.id) ? buildAdvice(env, primary, { idea: first, simple: true, ...p }) : null;
  return own ?? buildAdvice(env, primary, { lead: 'rescue', ...p });
}

/**
 * The advice again, the arrows now: «Вот он: ход {конём}» + idea (reveal); «Напомню: …» + idea (repeat — only when the
 * advice was said in words this turn: never «Как я и говорил» without it); else the advice as if for the first time
 * («fresh»: its usual lead, the rescue lead after a danger).
 */
function adviceAgain(plan: TeachPlan, memory: TeachMemory, book: LessonBook, lead: 'reveal' | 'repeat' | 'fresh'): { event: CoachEvent; board: BoardAnnotations; memory: TeachMemory } & HintsStop {
  const mem = restoreTeachMemory(memory);
  const env = envOfPlan(plan, mem, book);
  const primary = env.primary;
  const adviceList: TeachAdvice[] = primary ? [toTeachAdvice(primary)] : [];
  const board0 = arrowBoard(adviceList);
  const told = mem.lesson?.lastAdvice?.ply === plan.ply ? (mem.lesson?.lastAdvice?.ideas ?? []) : [];
  let c: Composed = compose([], { cap: 0, maxSentences: 0 }, env.w, book);
  let lm = adviceShownNow(mem.lesson ?? initialLessonMemory(), plan.ply);
  let mini: MiniDecision | null = null;
  if (primary) {
    // «Повтори»: the same idea in fresh words (the bag of the book gives a new wording)
    const idea = told[0] ? (primary.ideas.find((i) => i.id === told[0]?.id) ?? primary.ideas[0]) : primary.ideas[0];
    // (a mate that cannot be stopped: the honest «сыграем до конца» again, never an idea tail that calls the move safe)
    const lost = mateLost(plan, primary);
    const again = (o: AdviceOpts): AdviceBuild | null => (lost ? buildAdvice(env, primary, { ...o, lost: true }) : null) ?? buildAdvice(env, primary, o);
    const adv = lead === 'fresh' ? (rescueAdviceOf(env, plan, primary) ?? again({ simple: true, ...(idea ? { idea } : {}) })) : again({ lead, ...(idea ? { idea } : {}) });
    // a gift's own mini-lesson waits until the gift is resolved (§2.6): after its reveal, when the tactic slot is free
    const shownBefore = mem.lesson?.adviceShown.includes(plan.ply) ?? false;
    // (not in blitz: its only mini-lesson is «как думать», §2.2)
    if (lead === 'reveal' && plan.treasure && !shownBefore && !(xOf(plan)?.blitz ?? false) && lm.minis.every((m) => m.ply !== plan.ply)) {
      const t = treasureOf(plan);
      const topic = plan.treasure.kind === 'mate' ? 'mateInOne' : t.idea?.id === 'freeCapture' ? 'freeCapture' : t.idea?.id === 'fork' ? 'fork' : null;
      if (topic) mini = decideMini([topic], { stage: env.w.stage, blitz: false, lm, history: book.history(), has: (pool) => book.has(pool, { stage: env.w.stage, g: env.w.g }) });
    }
    const miniS: Sent | null = mini ? { ...miniSent(env, mini, primary, 90, null), core: false } : null;
    if (adv) c = compose([...adv.sents, miniS], { cap: mini ? MINI_WORDS : 40, maxSentences: mini ? 4 : 2 }, env.w, book);
    if (mini && c.keys.includes('mini')) {
      lm = { ...lm, minis: [...lm.minis, { turn: lm.turn, ply: plan.ply, topic: mini.topic, level: mini.level, slot: mini.slot }] };
      book.learner.miniTold(mini.topic, mini.level);
    } else mini = null;
  }
  const teach = teachSummary(lead === 'reveal' ? 'reveal' : 'repeat', plan.ply, adviceList, false, c.rendered.sentences.length, mini ? TOPIC_CARD[mini.topic] : null);
  const event = eventOf('teachTurn', c, { pose: 'talk', priority: 1, teach, board: board0 }) ?? lessonEvent({ kind: 'teachTurn', rendered: c.rendered, pose: 'talk', teach, board: board0 });
  return { event, board: cuesToBoard(c.rendered.cues, { base: board0 }), memory: withSaid({ ...mem, lesson: lm }, plan.ply, c.keys.includes('advice')), stopHints: true };
}

/** Show a hidden advice (treasure / «Сам» / stage-5 reveal-later / an unanswered quiz); its hints stop (`stopHints`). */
export function lessonRevealImpl(plan: TeachPlan, memory: TeachMemory, book: LessonBook): { event: CoachEvent; board: BoardAnnotations; memory: TeachMemory } & HintsStop {
  return adviceAgain(plan, memory, book, 'reveal');
}

/**
 * «Совет» / «Повтори»: the advice again in fresh words; a hidden advice is revealed by it (its hints stop). «Как я и
 * говорил» (`v3.lead.repeat`) only when the advice was said in words this turn — else the advice as if new (§2.3).
 */
export function lessonRepeatImpl(plan: TeachPlan, memory: TeachMemory, book: LessonBook): { event: CoachEvent; board: BoardAnnotations; memory: TeachMemory } & HintsStop {
  const mem = restoreTeachMemory(memory);
  const shown = mem.lesson?.adviceShown.includes(plan.ply) ?? false;
  const hidden = plan.lesson?.adviceHidden === true && !shown;
  const said = turnMemoOf(mem).adviceSaidPly === plan.ply;
  return adviceAgain(plan, memory, book, hidden ? 'reveal' : said ? 'repeat' : 'fresh');
}

/** Hints of a hidden advice may still come (the caller's hint timer checks it): not after the advice was shown. */
export function lessonHintsLive(plan: TeachPlan, memory: TeachMemory | null | undefined): boolean {
  if (plan.lesson?.adviceHidden !== true) return false;
  return !(restoreTeachMemory(memory ?? null).lesson?.adviceShown.includes(plan.ply) ?? false);
}

/**
 * «Почему так?»: one level deeper than the last tail — the second idea of the move, the theme link, the idea's
 * mini-lesson at the child's level (`whyMini`; recorded in the learner model) — never the tail said with the advice (a
 * second press goes one step further). A treasure still hidden is not given away: its line again and «найдёшь сам?».
 * A hidden advice keeps its arrow hidden, and its hints (`stopHints: false`).
 */
export function lessonWhyImpl(plan: TeachPlan, memory: TeachMemory, book: LessonBook): { event: CoachEvent; memory: TeachMemory } & HintsStop {
  const mem = restoreTeachMemory(memory);
  const lm = mem.lesson ?? initialLessonMemory();
  const env = envOfPlan(plan, mem, book);
  const { w } = env;
  const primary = env.primary;
  const shown = lm.adviceShown.includes(plan.ply);
  const hidden = !shown && (plan.lesson?.adviceHidden ?? false);
  const adviceList: TeachAdvice[] = primary && !hidden ? [toTeachAdvice(primary)] : [];
  const board0 = arrowBoard(adviceList);
  const teach = (n: number): TeachSummary => teachSummary('repeat', plan.ply, primary ? [toTeachAdvice(primary)] : [], hidden, n);

  if (plan.treasure && hidden) {
    const c = compose(
      [
        { key: 'treasure', prio: 100, core: true, parts: [{ pool: w.stage <= 2 ? treasureOf(plan).pool : 'v3.treasure.hunt', subjects: treasureOf(plan).subjects }], facts: null },
        { key: 'ask', prio: 95, core: true, parts: [{ pool: 'v3.treasure.ask' }], facts: null },
      ],
      { cap: 40, maxSentences: 2 },
      w,
      book,
    );
    const event = eventOf('teachTurn', c, { pose: 'think', teach: teach(c.rendered.sentences.length), board: emptyBoard() }) ?? lessonEvent({ kind: 'teachTurn', rendered: c.rendered, pose: 'think', teach: teach(0), board: emptyBoard() });
    return { event, memory: mem, stopHints: false };
  }

  const told = lm.lastAdvice?.ply === plan.ply ? lm.lastAdvice.ideas : [];
  const toldIds = new Set(told.map((t) => t.id));
  const x = xOf(plan);
  const steps: (() => Sent[] | null)[] = [];
  // (the mini-lesson step records what it tells)
  let miniOfStep = null as { topic: string; level: 1 | 2 | 3 } | null;
  const MINI_STEP = 2;
  if (primary) {
    const facts = adviceFacts(env, primary, primary.ideas[0]);
    // 1. the second idea of the move
    steps.push(() => {
      const second = [...primary.ideas, ...primary.allIdeas].find((i) => !toldIds.has(i.id) && i.id !== 'quiet' && i.id !== 'centerControl');
      if (!second) return null;
      const adv = buildAdvice(env, primary, { lead: 'why', idea: second, hide: hidden });
      return adv?.sents ?? null;
    });
    // 2. the theme link
    steps.push(() => (x?.whyLink ? [{ key: 'link', prio: 100, core: true, parts: [{ pool: x.whyLink }], facts, ...(hidden ? { hide: true } : {}) }] : null));
    // 3. the idea's mini-lesson at the child's level (spaced across games)
    steps.push(() => {
      const idea = primary.ideas[0];
      const m = whyMini(idea ? IDEA_MINI[idea.id] : undefined, { stage: w.stage, lm, history: book.history(), has: (pool) => book.has(pool, { stage: w.stage, g: w.g }) });
      if (!m) return null;
      miniOfStep = m;
      return [{ key: 'mini', prio: 100, core: true, parts: [{ pool: `v3.mini.${m.topic}.l${m.level}` }], facts, ...(hidden ? { hide: true } : {}) }];
    });
    // 4. the same idea in other words (never the same wording; a mate that cannot be stopped: «сыграем до конца»)
    steps.push(() => {
      const idea = primary.ideas[0];
      const adv = buildAdvice(env, primary, { lead: 'why', ...(idea ? { idea } : {}), hide: hidden, ...(mateLost(plan, primary) ? { lost: true } : {}) });
      return adv?.sents ?? null;
    });
  }
  const start = mem.lessonWhy && mem.lessonWhy.ply === plan.ply ? mem.lessonWhy.step + 1 : 0;
  let c: Composed = compose([], { cap: 0, maxSentences: 0 }, w, book);
  let used = start;
  for (let k = 0; k < steps.length; k++) {
    const i = (start + k) % steps.length;
    const sents = (steps[i] as () => Sent[] | null)();
    if (!sents || !sents.every((s) => canSay(s, w, book))) continue;
    c = compose(sents, { cap: 40, maxSentences: 2 }, w, book);
    if (c.rendered.text !== '') {
      used = i;
      break;
    }
  }
  const told2 = used === MINI_STEP && c.keys.includes('mini') ? miniOfStep : null;
  if (told2) book.learner.miniTold(told2.topic, told2.level);
  const event = eventOf('teachTurn', c, { pose: 'talk', teach: teach(c.rendered.sentences.length), board: board0 }) ?? lessonEvent({ kind: 'teachTurn', rendered: c.rendered, pose: 'talk', teach: teach(0), board: board0 });
  return { event, memory: { ...mem, lessonWhy: { ply: plan.ply, step: used } }, stopHints: false };
}

/**
 * «Что задумал соперник?» chip: his threat or his idea in words (`v3.danger.*` / `v3.opp.*`); «тихий ход»
 * (`v3.opp.quiet`) only when the threat search finished with none — never a promise that nothing is dangerous.
 */
export function lessonOpponentImpl(args: { profile: StudentProfile; fenBefore: string; uci: string; childFen: string; threat: Threat | null | undefined }, book: LessonBook): { event: CoachEvent } {
  const w = wordsOf(args.profile);
  const mv = resolveUciMove(args.fenBefore, args.uci);
  const child: Color = mv ? opposite(mv.color) : 'w';
  let res: { ideas: MoveIdea[]; wants: Threat | null } = { ideas: [], wants: null };
  try {
    res = explainOpponentMove(args.fenBefore, args.uci, args.childFen, { threat: args.threat ?? null });
  } catch {
    res = { ideas: [], wants: null };
  }
  const idea = res.ideas[0];
  const base: CueFacts = { fen: args.childFen, childColor: child };
  const threat = args.threat ?? null;
  const cands: Sent[] = [];
  const S = (pool: string, subjects: Subjects = {}, facts: Partial<CueFacts> = {}): Sent => ({ key: 'opp', prio: 100, core: true, parts: [{ pool, subjects }], facts: { ...base, ...facts } });
  let inCheck = false;
  try {
    inCheck = new Chess(args.childFen).inCheck();
  } catch {
    inCheck = false;
  }
  if (inCheck) cands.push(S('v3.opp.check', {}, { kingOf: child }));
  const mate = threat && isMateMotif(threat.motif) ? threat : res.wants && isMateMotif(res.wants.motif) ? res.wants : null;
  if (mate) cands.push(S('v3.danger.mate', {}, { threat: mate, kingOf: child }));
  if (threat && threat.motif === 'fork') cands.push(S('v3.danger.fork', {}, { threat }));
  if (mv?.captured) cands.push(idea?.id === 'recapture' ? S('v3.opp.recapture') : S('v3.opp.capture', { victim: mv.captured }));
  if (idea?.id === 'attack' && idea.squares[0]) {
    const victim = pieceOn(args.childFen, idea.squares[0]);
    const t = threatOf(mv?.to, idea.squares[0]);
    if (victim) cands.push(S('v3.opp.attack', { victim }, { victim: idea.squares[0], ...(t ? { threat: t } : {}) }));
  }
  if (threat && !isMateMotif(threat.motif) && threat.motif !== 'fork') {
    const target = threatTargetPiece(args.childFen, threat);
    if (target) {
      let undefended = false;
      try {
        undefended = (findHanging(args.childFen).find((h) => h.square === target.square)?.defenders.length ?? 1) === 0;
      } catch {
        undefended = false;
      }
      cands.push(S(undefended ? 'v3.danger.hanging.undefended' : 'v3.danger.hanging.attacked', { victim: target.piece }, { victim: target.square, threat }));
    }
    cands.push(S('v3.danger.threat', {}, { threat }));
  }
  if (mv && isEarlyQueenMove(args.fenBefore, args.uci)) cands.push(S('v3.opp.earlyQueen', {}, { piece: mv.to }));
  if (idea?.id === 'aimWeakSquare') cands.push(S('v3.opp.aimWeak', {}, { kingOf: child }));
  if (mv?.isCastle) cands.push(S('v3.opp.castle', {}, { kingOf: opposite(child) }));
  if (idea?.id === 'develop' && mv) cands.push(S('v3.opp.develop', { oppPiece: mv.piece }, { piece: mv.to }));
  if (idea?.id === 'centerPawn') cands.push(S('v3.opp.centerPawn'));
  // (only a FINISHED search that found nothing allows «тихий ход»; an unknown threat is not «none»)
  if (args.threat === null) cands.push(S('v3.opp.quiet'));
  cands.push({ key: 'opp', prio: 100, core: true, parts: [{ pool: 'v3.mini.thinking.l1' }], facts: null });
  let c: Composed = compose([], { cap: 0, maxSentences: 0 }, w, book);
  for (const s of cands) {
    if (!canSay(s, w, book)) continue;
    c = compose([s], { cap: 40, maxSentences: 1 }, w, book);
    if (c.rendered.text !== '') break;
  }
  const event = eventOf('answer', c, { pose: 'think' }) ?? lessonEvent({ kind: 'answer', rendered: c.rendered, pose: 'think' });
  return { event };
}

/** «Поторопись!» — once a game (the caller decides when). The clock is not paused by it. */
export function lessonHurryImpl(profile: StudentProfile, book: LessonBook): CoachEvent {
  const w = wordsOf(profile);
  const c = compose([{ key: 'hurry', prio: 100, core: true, parts: [{ pool: 'v3.hurry' }], facts: null }], { cap: 20, maxSentences: 1 }, w, book);
  return lessonEvent({ kind: 'encourage', rendered: c.rendered, pose: 'talk', pauseClock: false });
}

// ═════════════════════════ the start of the game (§2.1, §2.9) ═════════════════════════

/**
 * The theme announcement (the family at stages 1–2 and for White before move 1; the card's name + idea at stages 3–5
 * when the game has not contradicted it) and, in one of two games after a takeaway, «Помнишь, в прошлый раз…».
 */
export function lessonGameStartImpl(args: LessonStartArgs, memory: TeachMemory, book: LessonBook): { events: CoachEvent[]; memory: TeachMemory } {
  const mem = restoreTeachMemory(memory);
  const lm = mem.lesson ?? initialLessonMemory();
  if (args.coachStyle !== 'teacher') return { events: [], memory: mem };
  const w = wordsOf(args.profile);
  const card = themeCardOf(args.strategyCard, args.strategy);
  const st = themeStart({ stage: w.stage, childColor: args.childColor, historySan: args.historySan, card, history: book.history() });
  const ply = args.historySan.length + 1;
  const events: CoachEvent[] = [];
  let announced = false;
  if (st.pool) {
    const c = compose([{ key: 'theme', prio: 100, core: true, parts: [{ pool: st.pool }], facts: familyFacts(args.fen, args.childColor, st.family) }], { cap: 40, maxSentences: 1 }, w, book);
    const ev = eventOf('gameStart', c, { pose: 'talk', teach: teachSummary('theme', ply, [], false, 1) });
    if (ev) {
      events.push(ev);
      announced = true;
    }
  }
  let recalled = false;
  if (st.recallKey) {
    const c = compose([{ key: 'recall', prio: 100, core: true, parts: [{ pool: `v3.recall.${st.recallKey}` }], facts: null }], { cap: 40, maxSentences: 1 }, w, book);
    const ev = eventOf('gameStart', c, { pose: 'talk', teach: teachSummary('theme', ply, [], false, 1) });
    if (ev) {
      events.push(ev);
      recalled = true;
    }
  }
  const next: LessonMemory = { ...lm, theme: { ...lm.theme, announced: lm.theme.announced || announced, named: lm.theme.named || (announced && st.named), recalled: lm.theme.recalled || recalled } };
  return { events, memory: { ...mem, lesson: next } };
}
