/**
 * The game STRATEGY of «Учитель»: every game the teacher leads the child with one named
 * strategy from the library (`@gambit/content` STRATEGIES), announces it in ONE line at the start — «В этот раз
 * разыграем Итальянскую партию — быстро выводим фигуры и целимся в слабую точку. Начни пешкой на е четыре.» — and
 * explains the advised moves by it («по нашему плану …»).
 *
 * Pure helpers shared by ./events.ts (the intro) and ./teacher.ts (plan-aware reasons, the deviation line, the smart
 * strategist's replan). @gambit/core does not depend on @gambit/content: the strategy comes in structurally
 * (`TeachStrategy` = `GameStrategy` of the server merged with its library card). Chess truth stays with the engine and
 * the code: the strategy only adds a bonus / words to moves the engine already accepts; a replan may only CHOOSE among
 * the engine's candidates and is validated here (Latin-free, short, for this ply).
 */
import type { Color, ReplanRequest, ReplanResponse } from '@gambit/shared';
import { Chess } from 'chess.js';
import type { MoveIdea, MoveIdeaId } from './moveIdeas.ts';
import { parseSan, pieceNameRu, sanToSpokenRu, squareToSpokenRu } from './spoken.ts';
import type { Template, Voice } from './phrase.ts';

/** The strategy of one game as the teacher needs it (structurally: `GameStrategy` + the library `StrategyCard`). */
export interface TeachStrategy {
  strategyId: string;
  /** «Итальянская партия» */
  titleRu: string;
  /** «Итальянскую партию» (library `titleAccRu`); derived from the title when absent */
  titleAccRu?: string;
  /** one kid clause: «быстро выводим фигуры и целимся в слабую точку» */
  ideaRu: string;
  /** the strategist's own intro (≤ 20 words); used only when it passes `introFromStrategist` */
  introRu?: string;
  side?: Color;
  /**
   * which first opponent moves the card answers (library `against`). `'other'` for Black is a SYSTEM against any first
   * move: its main line starts with one example move, so only the child's own planned moves are compared — the
   * opponent never «leaves the road» of a system.
   */
  against?: 'any' | 'e4' | 'd4' | 'other';
  /** the child's planned moves along the main line (SAN) */
  lineSan?: readonly string[];
  /** the full main line from the initial position, both sides (SAN) — the opponent «leaves the road» when he deviates */
  mainLineSan?: readonly string[];
  /** child moves that serve the middlegame plan (SAN tags) */
  middlegameSan?: readonly string[];
  /** theme tags (`STRATEGY_THEMES` of @gambit/content) */
  themes?: readonly string[];
  /** the spoken steps / middlegame ideas of the card — the «why» of a plan move the explainer only calls «спокойный» */
  stepsRu?: readonly string[];
  middlegameRu?: readonly string[];
  /**
   * the GOALS of the plan as «мы» verb phrases (library `planGoalsRu`: «бьём по цепочке пешек ударом цэ пять») — what
   * the teacher keeps talking about once the game has left the main line (`planGoalRu`)
   */
  planGoalsRu?: readonly string[];
}

/** Why a move is «по нашему плану»: the next move of the main line, another planned move, a middlegame move, a theme, the replan. */
export type PlanFit = 'line' | 'lineLater' | 'middlegame' | 'theme' | 'replan';

/** Strategy themes → the move ideas that serve them (unknown themes are ignored). */
export const THEME_IDEAS: Readonly<Record<string, readonly MoveIdeaId[]>> = {
  center: ['centerPawn', 'fightCenter', 'supportCenter'],
  counterCenter: ['fightCenter', 'centerPawn'],
  castle: ['castle', 'prepareCastle'],
  f7: ['aimWeakSquare'],
  fortress: ['supportCenter', 'defend'],
  gambit: ['fightCenter'],
  openFile: ['rookOpenFile'],
  kingsideAttack: ['threatMate', 'aimWeakSquare'],
  queensideAttack: ['space'],
};

/** Words the teacher never says («не озвучивай часы — это и так видно»); the < 30 s «Поторопись!» is the one exception. */
export const CLOCK_WORDS_RE = /минут|секунд|часы|часов|время|времени/i;

/** The child has less than this on the clock → one «Поторопись!» (once a game). */
export const HURRY_MS = 30_000;

/** A strategist's text (intro / plan / why) is accepted only when it is plain Russian and short. */
export function cleanStrategistRu(text: string | null | undefined, maxWords: number): string | null {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t === '' || /[A-Za-z0-9<>{}[\]\\/=+#@$%^&*_|~`]/.test(t) || CLOCK_WORDS_RE.test(t)) return null;
  const words = t.split(' ').filter((w) => /[А-Яа-яЁё]/.test(w)).length;
  if (words === 0 || words > maxWords) return null;
  return t;
}

function sameSan(a: string, b: string): boolean {
  return a.replace(/[+#!?]+$/u, '') === b.replace(/[+#!?]+$/u, '');
}

/** «Итальянская партия» → «Итальянскую партию»: adjectives and the head noun of the title in the accusative. */
export function titleAccRu(title: string): string {
  const words = title.trim().split(/\s+/);
  const out: string[] = [];
  let done = false;
  for (const w of words) {
    if (done) {
      out.push(w);
      continue;
    }
    if (/ая$/u.test(w)) out.push(w.replace(/ая$/u, 'ую'));
    else if (/яя$/u.test(w)) out.push(w.replace(/яя$/u, 'юю'));
    else if (/я$/u.test(w)) {
      out.push(w.replace(/я$/u, 'ю'));
      done = true;
    } else if (/а$/u.test(w)) {
      out.push(w.replace(/а$/u, 'у'));
      done = true;
    } else {
      out.push(w);
      done = true;
    }
  }
  return out.join(' ');
}

/** The strategy's title for «разыграем …». */
export function strategyTitleAcc(s: Pick<TeachStrategy, 'titleRu' | 'titleAccRu'>): string {
  return s.titleAccRu?.trim() || titleAccRu(s.titleRu);
}

/** «пешкой на е четыре» / «конём на эф три» / «короткой рокировкой» — a move in the instrumental case, for «Начни …». */
export function moveInsRu(san: string): string {
  const p = parseSan(san);
  if (!p) return '';
  if (p.kind === 'castleShort') return 'короткой рокировкой';
  if (p.kind === 'castleLong') return 'длинной рокировкой';
  const to = squareToSpokenRu(p.to ?? '');
  if (!to) return '';
  if (p.capture || p.promotion || (p.piece !== 'p' && (p.fromFile || p.fromRank))) return '';
  return `${pieceNameRu(p.piece, 'ins')} на ${to}`;
}

/** The intro sentence's move part as a template: speech «Начни пешкой на е четыре.», bubble «Начни: e4.». */
function firstMoveSentence(san: string, fenBefore: string, childColor: Color): Template | null {
  const ins = moveInsRu(san);
  const verb = childColor === 'w' ? 'Начни' : 'Ответь';
  if (ins) return (v: Voice) => (v.mode === 'speech' ? `${verb} ${ins}.` : `${verb}: ${v.move(san, fenBefore)}.`);
  const spoken = sanToSpokenRu(san, fenBefore);
  if (spoken === 'этот ход') return null;
  return (v: Voice) => `Первый ход — ${v.move(san, fenBefore)}.`;
}

/**
 * The strategist's intro, accepted only when it is Latin-free, ≤ 20 words, has no clock words and names no square
 * other than the first move's own (the move itself is engine-verified in the library, free text is not).
 */
export function introFromStrategist(intro: string | undefined, firstSan: string | null): string | null {
  const t = cleanStrategistRu(intro, 20);
  if (!t) return null;
  const squares = [...t.matchAll(/(?<![а-яё])(а|бэ|цэ|дэ|е|эф|же|жэ|аш) (один|два|три|четыре|пять|шесть|семь|восемь)(?![а-яё])/gu)].map((m) => `${m[1] === 'жэ' ? 'же' : m[1]} ${m[2]}`);
  const allowed = firstSan ? squareToSpokenRu(parseSan(firstSan)?.to ?? '') : '';
  if (squares.some((sq) => sq !== allowed)) return null;
  // a named square must come with the right piece: «начни пешкой на е четыре», never «конём на е четыре»
  if (squares.length > 0 && firstSan) {
    const ins = moveInsRu(firstSan);
    const nom = sanToSpokenRu(firstSan);
    if (!(ins && t.includes(ins)) && !t.includes(nom)) return null;
  }
  return /[.!?…]$/u.test(t) ? t : `${t}.`;
}

/**
 * «В этот раз разыграем Итальянскую партию — быстро выводим фигуры и целимся в слабую точку. Начни пешкой на е
 * четыре.» — the one-line strategy intro. `first` = the child's first move of the strategy (null for Black before the
 * opponent's first move is known: then no move sentence). The strategist's own wording wins when it is valid.
 */
export function strategyIntroTemplate(s: TeachStrategy, first: { san: string; fenBefore: string } | null, childColor: Color): Template {
  const own = introFromStrategist(s.introRu, first?.san ?? null);
  const mentionsMove = own ? /(?<![а-яё])(начни|ответь|первый ход|ходи|пойди)(?![а-яё])/iu.test(own) : false;
  const moveSentence = first ? firstMoveSentence(first.san, first.fenBefore, childColor) : null;
  if (own) {
    // the strategist named the move in words: the bubble still shows it in notation
    if (mentionsMove || !moveSentence) return () => own;
    return (v) => `${own} ${moveSentence(v)}`;
  }
  const idea = s.ideaRu.trim().replace(/[.!…]+$/u, '');
  const head = `В этот раз разыграем ${strategyTitleAcc(s)}${idea ? ` — ${idea}` : ''}.`;
  return moveSentence ? (v) => `${head} ${moveSentence(v)}` : () => head;
}

// ─────────────────────────── where the game is on the strategy's road ───────────────────────────

export interface StrategyProgress {
  /** the game so far is a prefix of the main line */
  onLine: boolean;
  /** the child's next move of the main line (only while `onLine`) */
  nextSan: string | null;
  /** the first ply (1-based) where the game left the main line, and who left it */
  left: { ply: number; by: 'opponent' | 'child' } | null;
  /** the child's planned moves not played yet (order of the line) */
  remaining: string[];
}

/** Compares the game (`historySan`, from the initial position) with the strategy's main line. */
export function strategyProgress(s: TeachStrategy | null | undefined, historySan: readonly string[], childColor: Color): StrategyProgress | null {
  if (!s) return null;
  const main = s.mainLineSan ?? [];
  let i = 0;
  while (i < historySan.length && i < main.length && sameSan(historySan[i] as string, main[i] as string)) i++;
  const childFirst = childColor === 'w' ? 0 : 1;
  const played = historySan.filter((_, k) => k % 2 === childFirst);
  const remaining = (s.lineSan ?? []).filter((san) => !played.some((p) => sameSan(p, san)));
  if (s.against === 'other' && childColor === 'b') return systemProgress(s.lineSan ?? [], historySan, played, remaining);
  if (main.length === 0) return { onLine: false, nextSan: null, left: null, remaining };
  if (i === historySan.length) {
    const next = main[i];
    const childToMove = i % 2 === childFirst;
    return { onLine: true, nextSan: next && childToMove ? next : null, left: null, remaining };
  }
  if (i >= main.length) return { onLine: false, nextSan: null, left: null, remaining }; // the line simply ended
  const by: 'opponent' | 'child' = i % 2 === childFirst ? 'child' : 'opponent';
  return { onLine: false, nextSan: null, left: { ply: i + 1, by }, remaining };
}

/**
 * A Black system against any first move (`against: 'other'`, e.g. 1.b3 d5 2.… Nf6): the plan is the child's own
 * moves in order, whatever the opponent plays. On the road while the child played a prefix of `lineSan`; the child's
 * own other move leaves it (`by: 'child'`); the opponent never does.
 */
function systemProgress(line: readonly string[], historySan: readonly string[], played: readonly string[], remaining: string[]): StrategyProgress {
  let k = 0;
  while (k < played.length && k < line.length && sameSan(played[k] as string, line[k] as string)) k++;
  if (k < played.length && k < line.length) return { onLine: false, nextSan: null, left: { ply: 2 * k + 2, by: 'child' }, remaining };
  if (k >= line.length) return { onLine: false, nextSan: null, left: null, remaining };
  const childToMove = historySan.length % 2 === 1;
  return { onLine: true, nextSan: childToMove ? (line[k] as string) : null, left: null, remaining };
}

/** Is a legal move of `fen` (SAN) one of the strategy moves, and how? */
export function planFitOf(s: TeachStrategy | null | undefined, progress: StrategyProgress | null, san: string, ideas: readonly MoveIdea[], fen?: string): PlanFit | null {
  if (!s || !progress) return null;
  if (progress.nextSan && sameSan(progress.nextSan, san)) return 'line';
  if (progress.remaining.some((m) => sameSan(m, san)) && legalIn(fen, san)) return 'lineLater';
  if ((s.middlegameSan ?? []).some((m) => sameSan(m, san))) return 'middlegame';
  const themed = new Set((s.themes ?? []).flatMap((t) => THEME_IDEAS[t] ?? []));
  if (ideas.slice(0, 2).some((i) => themed.has(i.id))) return 'theme';
  return null;
}

function legalIn(fen: string | undefined, san: string): boolean {
  if (!fen) return true;
  try {
    return new Chess(fen).moves().some((m) => sameSan(m, san));
  } catch {
    return false;
  }
}

/** The child's next strategy move that is legal in `fen`: the main-line move while on the line, else the first legal planned one. */
export function strategyNextSan(s: TeachStrategy | null | undefined, historySan: readonly string[], childColor: Color, fen: string): string | null {
  const p = strategyProgress(s, historySan, childColor);
  if (!p) return null;
  if (p.nextSan && legalIn(fen, p.nextSan)) return p.nextSan;
  return p.remaining.find((m) => legalIn(fen, m)) ?? null;
}

const SQUARE_WORDS_RE = /(?<![а-яё])(а|бэ|цэ|дэ|е|эф|же|аш) (один|два|три|четыре|пять|шесть|семь|восемь)(?![а-яё])/u;
const VERB_RE = /[а-яё]{2,}(ет|ит|ёт|ут|ют|ат|ят)(ся)?(?![а-яё])/u;
const PIECE_STEMS: Readonly<Record<string, string>> = { p: 'пешк', n: 'кон', b: 'слон', r: 'ладь', q: 'ферз', k: 'корол' };

/**
 * The card's own words for a plan move whose «why» the explainer can only call «спокойный крепкий ход»: a step or a
 * middlegame idea about the same piece that names the move's square («ладья встаёт на е один и помогает центру»), or
 * — when the text names no square at all — the same piece («конь идёт длинным путём на королевский фланг»). The text
 * must say what the piece does (a verb). null when nothing fits: then the explainer's words stay.
 */
export function planStepRu(s: TeachStrategy | null | undefined, san: string): { textRu: string; namesMove: boolean } | null {
  if (!s) return null;
  const p = parseSan(san);
  if (!p) return null;
  const texts = [...(s.stepsRu ?? []), ...(s.middlegameRu ?? [])].map((t) => t.trim()).filter((t) => t !== '' && VERB_RE.test(t));
  if (p.kind !== 'move') {
    const castle = texts.find((t) => /^рокировка\s/u.test(t));
    return castle ? { textRu: castle, namesMove: true } : null;
  }
  const stem = PIECE_STEMS[p.piece] ?? '';
  const sq = squareToSpokenRu(p.to ?? '');
  const ofPiece = texts.filter((t) => t.startsWith(stem));
  const exact = ofPiece.find((t) => sq !== '' && new RegExp(`(?<![а-яё])${sq}(?![а-яё])`, 'u').test(t));
  if (exact) return { textRu: exact, namesMove: true };
  const general = ofPiece.find((t) => !SQUARE_WORDS_RE.test(t));
  return general ? { textRu: general, namesMove: false } : null;
}

/** A plan goal is at most this long (the library's own limit; anything longer is not said). */
export const PLAN_GOAL_MAX_WORDS = 12;
/** Stems of every case of the piece names («пешка / пешек / пешкой», «конь / коня / конём», «ладья / ладью»). */
const PIECE_ANY_CASE: Readonly<Record<string, string>> = { p: 'пеш', n: 'кон', b: 'слон', r: 'лад', q: 'ферз', k: 'корол' };

function mentions(text: string, stemOrWords: string): boolean {
  return new RegExp(`(?<![а-яё])${stemOrWords}`, 'u').test(text);
}

/** The clean goals of a strategy (Russian, ≤ 12 words, no clock words), without the end mark. */
function cleanGoals(s: TeachStrategy | null | undefined): string[] {
  return (s?.planGoalsRu ?? [])
    .map((g) => cleanStrategistRu(g, PLAN_GOAL_MAX_WORDS))
    .filter((g): g is string => g !== null)
    .map((g) => g.replace(/[.!…]+$/u, ''));
}

/**
 * The strategy's GOAL to say once the game has left the main line — the strategy goes on, only the moves change
 * («давим на цепочку пешек ударом c5»; «Соперник свернул с нашей дороги — теперь бьём по цепочке пешек ударом цэ
 * пять»). With the advised move (`san`): the goal that names its square with its piece — «прыгаем конём
 * на е четыре» for Кe4, a pawn strike «ударом цэ пять» for c5, «рокировкой» for castling (`namesMove`). Otherwise the
 * goals in turn (`turn` = plan lines said since the deviation), so the teacher does not repeat one line; with `fen`
 * and `color` a goal the position shows as reached («прячем короля рокировкой» after castling) is skipped
 * (`planGoalDone`). Only clean goals (Russian, ≤ 12 words, no clock words), without the end mark (the teacher puts them
 * inside a sentence); null without any.
 */
export function planGoalRu(s: TeachStrategy | null | undefined, opts: { san?: string; turn?: number; fen?: string; color?: Color } = {}): { textRu: string; namesMove: boolean } | null {
  const fitsHere = (g: string): boolean => !opts.fen || !opts.color || planGoalFits(g, opts.fen, opts.color);
  const all = cleanGoals(s);
  if (all.length === 0) return null;
  const p = opts.san ? parseSan(opts.san) : null;
  if (p && (p.kind === 'castleShort' || p.kind === 'castleLong')) {
    const castle = all.find((g) => mentions(g, 'рокировк') && fitsHere(g));
    if (castle) return { textRu: castle, namesMove: true };
  } else if (p) {
    const sq = squareToSpokenRu(p.to ?? '');
    const stem = PIECE_ANY_CASE[p.piece] ?? '';
    const exact = sq
      ? all.find((g) => {
          if (!new RegExp(`(?<![а-яё])${sq}(?![а-яё])`, 'u').test(g) || !fitsHere(g)) return false;
          if (stem !== '' && mentions(g, stem)) return true;
          // a pawn strike names only its square («ударом цэ пять») — never a goal about a piece on that square
          return p.piece === 'p' && !['n', 'b', 'r', 'q'].some((piece) => mentions(g, PIECE_ANY_CASE[piece] ?? ''));
        })
      : undefined;
    if (exact) return { textRu: exact, namesMove: true };
  }
  const fen = opts.fen;
  const color = opts.color;
  // a goal about what the board no longer (or not yet) shows is not said: «бьём по цепочке» with no chain (`planGoalFits`)
  const goals = fen && color ? all.filter((g) => !planGoalDone(g, fen, color) && planGoalFits(g, fen, color)) : all;
  if (goals.length === 0) return null;
  const turn = Math.max(0, Math.floor(opts.turn ?? 0));
  return { textRu: goals[turn % goals.length] as string, namesMove: false };
}

/** A bishop on one of these stands on a long diagonal (the fianchetto squares). */
const LONG_DIAGONAL: Readonly<Record<Color, readonly string[]>> = { w: ['b2', 'g2'], b: ['b7', 'g7'] };
const MINOR_HOME: Readonly<Record<Color, Readonly<Record<'n' | 'b', readonly string[]>>>> = {
  w: { n: ['b1', 'g1'], b: ['c1', 'f1'] },
  b: { n: ['b8', 'g8'], b: ['c8', 'f8'] },
};
const DEVELOP_GOAL_RE = /^(быстро )?вывод/u;
const LONG_DIAGONAL_RE = /длинн[а-яё]* диагонал/u;
const SQUARE_WORDS_ALL_RE = /(?<![а-яё])(а|бэ|цэ|дэ|е|эф|же|жэ|аш) (один|два|три|четыре|пять|шесть|семь|восемь)(?![а-яё])/gu;
const FILE_WORD: Readonly<Record<string, string>> = { а: 'a', бэ: 'b', цэ: 'c', дэ: 'd', е: 'e', эф: 'f', же: 'g', жэ: 'g', аш: 'h' };
const RANK_WORD: Readonly<Record<string, string>> = { один: '1', два: '2', три: '3', четыре: '4', пять: '5', шесть: '6', семь: '7', восемь: '8' };

/** The squares a goal names in words («цэ пять» → c5). */
function goalSquares(goal: string): string[] {
  return [...goal.matchAll(SQUARE_WORDS_ALL_RE)].map((m) => `${FILE_WORD[m[1] as string] ?? ''}${RANK_WORD[m[2] as string] ?? ''}`).filter((sq) => sq.length === 2);
}

/** The piece kinds a goal speaks about: the pieces it names, a pawn for «пешка» / «удар» (a pawn strike). */
function goalPieces(goal: string): string[] {
  const out = ['n', 'b', 'r', 'q'].filter((piece) => mentions(goal, PIECE_ANY_CASE[piece] ?? ''));
  if (mentions(goal, 'пеш') || mentions(goal, 'удар')) out.push('p');
  return out;
}

/** square → the piece letter of `color` standing there (from the FEN placement). */
function ownPieces(fen: string, color: Color): Map<string, string> {
  const out = new Map<string, string>();
  const rows = (fen.trim().split(/\s+/)[0] ?? '').split('/');
  rows.forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += Number(ch);
        continue;
      }
      const mine = color === 'w' ? ch === ch.toUpperCase() : ch === ch.toLowerCase();
      if (mine) out.set(`${'abcdefgh'[file] ?? ''}${8 - r}`, ch.toLowerCase());
      file += 1;
    }
  });
  return out;
}

/**
 * Is the goal already reached in `fen` (or impossible now) — then the teacher does not keep saying it: castling done
 * (the king left its square), a «выводим коней / слонов / фигуры» goal with no such piece at home, a «длинную
 * диагональ» goal with a bishop on b2 / g2 (b7 / g7), a goal whose every named square holds the piece it speaks of
 * («ударом цэ пять» with a pawn on c5), a goal about a piece the child no longer has. «держим …» goals go on.
 */
export function planGoalDone(goal: string, fen: string, color: Color): boolean {
  if (/^(крепко )?держим/u.test(goal)) return false;
  let mine: Map<string, string>;
  try {
    mine = ownPieces(fen, color);
  } catch {
    return false;
  }
  if (mine.size === 0) return false;
  const kingHome = color === 'w' ? 'e1' : 'e8';
  if (mentions(goal, 'рокировк')) return mine.get(kingHome) !== 'k';
  const pieces = goalPieces(goal);
  const has = (piece: string): boolean => [...mine.values()].includes(piece);
  if (LONG_DIAGONAL_RE.test(goal)) return LONG_DIAGONAL[color].some((sq) => mine.get(sq) === 'b') || !has('b');
  const squares = goalSquares(goal);
  if (DEVELOP_GOAL_RE.test(goal) && squares.length === 0) {
    const kinds: ('n' | 'b')[] = mentions(goal, 'фигур') ? ['n', 'b'] : (['n', 'b'] as const).filter((k) => pieces.includes(k));
    return kinds.length > 0 && kinds.every((k) => MINOR_HOME[color][k].every((sq) => mine.get(sq) !== k));
  }
  const named = pieces.filter((piece) => piece !== 'p');
  if (named.length > 0 && !named.some(has)) return true;
  if (squares.length === 0 || pieces.length === 0) return false;
  return pieces.some((piece) => squares.every((sq) => mine.get(sq) === piece));
}

const SQUARE_WORDS_GROUP = '(?:а|бэ|цэ|дэ|е|эф|же|жэ|аш) (?:один|два|три|четыре|пять|шесть|семь|восемь)';
/** «давим … на пешку дэ четыре» — the goal presses on the opponent's pawn on that square */
const PAWN_TARGET_RE = new RegExp(`(?<![а-яё])на пешку (${SQUARE_WORDS_GROUP})(?![а-яё])`, 'u');
/** «давим конями на пешку в центре» — on an opponent's pawn in the centre */
const CENTRE_PAWN_TARGET_RE = /(?<![а-яё])на пешку в центре(?![а-яё])/u;
/** «бьём по цепочке пешек», «ломаем цепочку» — the opponent's pawn chain */
const CHAIN_RE = /(?<![а-яё])цепоч/u;
/** «ударом цэ пять» — the strike of our pawn from that square */
const STRIKE_RE = new RegExp(`(?<![а-яё])ударом (${SQUARE_WORDS_GROUP})(?![а-яё])`, 'u');
/** «связываем коня соперника слоном на же пять» — a pin of the opponent's knight by our bishop on that square */
const KNIGHT_PIN_RE = new RegExp(`(?<![а-яё])связываем коня соперника слоном на (${SQUARE_WORDS_GROUP})(?![а-яё])`, 'u');

function squareAt(file: number, rank: number): string | null {
  return file >= 0 && file < 8 && rank >= 1 && rank <= 8 ? `${'abcdefgh'[file] ?? ''}${rank}` : null;
}

/** The squares a pawn of `color` on `sq` attacks. */
function pawnAttacks(sq: string, color: Color): string[] {
  const file = 'abcdefgh'.indexOf(sq[0] ?? '');
  const rank = Number(sq[1]) + (color === 'w' ? 1 : -1);
  return [squareAt(file - 1, rank), squareAt(file + 1, rank)].filter((x): x is string => x !== null);
}

/** The squares diagonally next to `sq`. */
function diagonalNeighbours(sq: string): string[] {
  const file = 'abcdefgh'.indexOf(sq[0] ?? '');
  const rank = Number(sq[1]);
  return [squareAt(file - 1, rank - 1), squareAt(file + 1, rank - 1), squareAt(file - 1, rank + 1), squareAt(file + 1, rank + 1)].filter((x): x is string => x !== null);
}

/**
 * Does the board still hold what a goal speaks about? (French, 1.e4 e6 2.d3: no «Соперник свернул с нашей дороги —
 * теперь бьём по цепочке пешек ударом цэ пять» with no white chain on the board.) The goal is NOT said when it presses
 * on the opponent's pawn «на пешку дэ четыре» and no pawn of his stands there («на пешку в центре»: none on d4 / e4 /
 * d5 / e5); when it speaks of his pawn CHAIN and he has no two pawns standing diagonally one behind the other — or the
 * named strike («ударом цэ пять») would not hit a pawn of the chain; when it pins his knight with our bishop on a square
 * and no knight of his stands next to that square diagonally. Every other goal fits (the child's own moves are the
 * advice's job).
 */
export function planGoalFits(goal: string, fen: string, color: Color): boolean {
  let theirs: Map<string, string>;
  try {
    theirs = ownPieces(fen, color === 'w' ? 'b' : 'w');
  } catch {
    return true;
  }
  if (theirs.size === 0) return true;
  const pawnOn = (sq: string): boolean => theirs.get(sq) === 'p';
  const target = PAWN_TARGET_RE.exec(goal);
  const targetSq = target ? goalSquares(target[1] as string)[0] : undefined;
  if (targetSq && !pawnOn(targetSq)) return false;
  if (CENTRE_PAWN_TARGET_RE.test(goal) && !['d4', 'e4', 'd5', 'e5'].some(pawnOn)) return false;
  if (CHAIN_RE.test(goal)) {
    const chain = new Set([...theirs.keys()].filter((sq) => pawnOn(sq) && diagonalNeighbours(sq).some(pawnOn)));
    if (chain.size === 0) return false;
    const strike = STRIKE_RE.exec(goal);
    const from = strike ? goalSquares(strike[1] as string)[0] : undefined;
    if (from && !pawnAttacks(from, color).some((sq) => chain.has(sq))) return false;
  }
  const pin = KNIGHT_PIN_RE.exec(goal);
  const bishopSq = pin ? goalSquares(pin[1] as string)[0] : undefined;
  if (bishopSq && !diagonalNeighbours(bishopSq).some((sq) => theirs.get(sq) === 'n')) return false;
  return true;
}

/**
 * The plan goal an advised move SERVES — proven by the code, never guessed (after the opponent left the road the
 * teacher must neither fall back to «развиваем фигуры» nor glue «по нашему плану» onto any engine move): the goal that
 * names the move's square with its piece, or castling (`planGoalRu`, `namesMove`); a «выводим …» goal of the moved
 * knight / bishop (or «фигуры») for a move the explainer calls developing; a «длинную диагональ» goal for a bishop to
 * b2 / g2 / b7 / g7. null = the move serves no goal of the plan.
 */
export function planGoalFor(
  s: TeachStrategy | null | undefined,
  a: { san: string; ideas?: readonly Pick<MoveIdea, 'id'>[]; fen?: string; color?: Color },
): { textRu: string; namesMove: boolean } | null {
  const exact = planGoalRu(s, { san: a.san, ...(a.fen && a.color ? { fen: a.fen, color: a.color } : {}) });
  if (exact?.namesMove) return exact;
  const p = parseSan(a.san);
  if (!p || p.kind !== 'move' || (p.piece !== 'n' && p.piece !== 'b')) return null;
  const fen = a.fen;
  const color = a.color;
  const goals = cleanGoals(s).filter((g) => !fen || !color || planGoalFits(g, fen, color));
  const stem = PIECE_ANY_CASE[p.piece] ?? '';
  if ((a.ideas ?? []).some((i) => i.id === 'develop')) {
    const develop = goals.find((g) => DEVELOP_GOAL_RE.test(g) && goalSquares(g).length === 0 && (mentions(g, stem) || mentions(g, 'фигур')));
    if (develop) return { textRu: develop, namesMove: false };
  }
  if (p.piece === 'b' && ['b2', 'g2', 'b7', 'g7'].includes(p.to ?? '')) {
    const diagonal = goals.find((g) => LONG_DIAGONAL_RE.test(g) && mentions(g, stem));
    if (diagonal) return { textRu: diagonal, namesMove: false };
  }
  return null;
}

// ─────────────────────────── the smart strategist's replan ───────────────────────────

/** The replan of THIS ply (its `preferredUci` / `whyRu` may be used), or null — a stale answer is dropped. */
export function freshReplan(replan: ReplanResponse | null | undefined, ply: number): ReplanResponse | null {
  if (!replan || replan.ply !== ply) return null;
  return replan;
}

/** The replan's words, cleaned: the plan (≤ 15 words) and the «why» (≤ 15 words); null parts are unusable. */
export function replanWords(replan: ReplanResponse | null | undefined): { planRu: string | null; whyRu: string | null } {
  if (!replan) return { planRu: null, whyRu: null };
  // (the words go inside a sentence — «По новому плану — конь на эф три: выводишь коня…», «Новый план: …»)
  const strip = (t: string | null): string | null => (t ? lowerFirstRu(t.replace(/[.!…]+$/u, '')) : null);
  return { planRu: strip(cleanStrategistRu(replan.planRu, 15)), whyRu: strip(cleanStrategistRu(replan.whyRu, 15)) };
}

/** «Выводишь коня» → «выводишь коня»; a word in capitals (an abbreviation) stays. */
function lowerFirstRu(text: string): string {
  const first = text.split(' ')[0] ?? '';
  if (first.length > 1 && first === first.toUpperCase()) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Candidates for POST /coach/replan (engine-accepted moves with code ideas) — the answer must pick one of them. */
export type ReplanCandidate = ReplanRequest['candidates'][number];

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** A speech-only voice (no child name, no gender needed by the intro). */
const SPEECH: Voice = {
  mode: 'speech',
  name: '',
  g: (masculine) => masculine,
  move: (san, fenBefore) => sanToSpokenRu(san, fenBefore),
  sq: (square) => squareToSpokenRu(square),
  hey: (rest) => rest.charAt(0).toUpperCase() + rest.slice(1),
};

/**
 * The spoken intro of a strategy as plain text — what the server's free `template` provider puts into
 * `GameStrategy.introRu`: White's first move from the initial position; Black's reply after `opponentFirstUci` (when
 * the strategy's first move is legal there), else the strategy without a move. Latin-free, ≤ 20 words for the library.
 */
export function strategyIntroRu(s: TeachStrategy, childColor: Color, opponentFirstUci?: string): string {
  let first: { san: string; fenBefore: string } | null = null;
  const san = s.lineSan?.[0];
  if (san) {
    try {
      const chess = new Chess(START_FEN);
      if (childColor === 'b') {
        const u = (opponentFirstUci ?? '').trim().toLowerCase();
        if (u.length >= 4) chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      }
      if (chess.turn() === childColor) {
        const fenBefore = chess.fen();
        const mv = chess.move(san);
        first = { san: mv.san, fenBefore };
      }
    } catch {
      first = null;
    }
  }
  const { introRu: _ignored, ...plain } = s;
  void _ignored;
  return strategyIntroTemplate(plain, first, childColor)(SPEECH).replace(/\s+/g, ' ').trim();
}
