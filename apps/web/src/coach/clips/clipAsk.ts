/**
 * What Гамбитик says in the no-microphone mode (docs/voice-clips/SPEC.md §8.2, §8.3): the «Спроси» chips, a poke, the
 * post-game thought chips and his recorded replies. Every event here carries its clip twin (`CoachEvent.clip`) —
 * catalogue line ids, never free text — so «Записи» can say it; `text` / `bubbleText` say the same for the bubble and
 * for the other voices (the first wording of the line; the dock shows the take really heard, coachController).
 *
 * The line ids are exactly `CLIP_TAP_LINES` of @gambit/core (clipAsk.test.ts checks it): the tools force every one of
 * them into the Starter tier. «Почему так?» in «Учитель» is the core's `buildTeachWhy` (the advice with its reason).
 * Decisions: the opponent's move and his threat are named WITHOUT squares (the board highlights them);
 * Гамбитик speaks of himself as a boy («я готов», «я заметил»).
 */
import { Chess } from 'chess.js';
import { isMateMotif, mateInOneThreat, pieceGenderRu, pieceNameRu } from '@gambit/core';
import type { BoardAnnotations, ClipItem, ClipUtterance, CoachEvent, MascotPose, PieceType, Threat } from '@gambit/shared';

export type AskKind = 'why' | 'opponent' | 'hint' | 'repeat';

export interface AskChip {
  kind: AskKind;
  label: string;
  /** a big emoji-free glyph the dock draws (icons stay inline SVG / text) */
  icon: string;
}

/**
 * The «Спроси» chips of a game (SPEC §8.2): «Почему так?», «Что задумал соперник?», «Совет» (teacher) / «Подсказка»,
 * «Повтори». An exam has no chips at all (it is silent until the end); a game without hints has no hint chip.
 */
export function askChipsFor(o: { coachStyle: 'teacher' | 'helper' | 'exam' | null; hintAvailable: boolean }): AskChip[] {
  if (o.coachStyle === 'exam') return [];
  const chips: AskChip[] = [
    { kind: 'why', label: 'Почему так?', icon: '?' },
    { kind: 'opponent', label: 'Что задумал соперник?', icon: '♞' },
  ];
  if (o.hintAvailable) chips.push({ kind: 'hint', label: o.coachStyle === 'teacher' ? 'Совет' : 'Подсказка', icon: '★' });
  chips.push({ kind: 'repeat', label: 'Повтори', icon: '↻' });
  return chips;
}

let answerSeq = 0;

function answerEvent(a: {
  id: string;
  kind?: CoachEvent['kind'];
  text: string;
  pose: MascotPose;
  items: ClipItem[];
  end: '.' | '!' | '?';
  generic: string;
  moment?: string;
  pauseClock?: boolean;
  /** a second, optional sentence (dropped first when the phrase must be short) */
  more?: { items: ClipItem[]; end: '.' | '!' | '?'; text: string };
  board?: BoardAnnotations;
}): CoachEvent {
  const sentences = [{ items: a.items, prio: 100, end: a.end }, ...(a.more ? [{ items: a.more.items, prio: 60, end: a.more.end }] : [])];
  const clip: ClipUtterance = { sentences, generic: a.generic, bark: a.pose, ...(a.moment ? { moment: a.moment } : {}) };
  const text = a.more ? `${a.text} ${a.more.text}` : a.text;
  return { id: a.id, kind: a.kind ?? 'answer', priority: 1, text, bubbleText: text, pose: a.pose, pauseClock: a.pauseClock ?? true, clip, ...(a.board ? { board: a.board } : {}) };
}

// ───────────────────────── a poke ─────────────────────────

/** An idle tap on Гамбитик: his recorded catchphrase (the `poke` pool), the free voices say `text`. */
export function pokeClip(pose: MascotPose): ClipUtterance {
  return { sentences: [{ items: [{ line: 'poke' }], prio: 100, end: '!' }], generic: 'generic.answer.poke', bark: pose };
}

// ───────────────────────── «Почему так?» without anything to explain ─────────────────────────

/** Nothing to explain (no advice, no judged move): a question back — never «это хороший ход». */
export function whyNothingEvent(): CoachEvent {
  answerSeq += 1;
  return answerEvent({
    id: `ask-why-${answerSeq}`,
    text: 'Давай подумаем вместе: какая фигура ещё не в игре?',
    pose: 'think',
    items: [{ line: 'ask.why.think' }],
    end: '?',
    generic: 'generic.answer.why',
    moment: 'why',
  });
}

// ───────────────────────── «Что задумал соперник?» ─────────────────────────

const VALUE: Readonly<Record<PieceType, number>> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

function yourAcc(piece: PieceType): string {
  return pieceGenderRu(piece) === 'f' ? 'твою' : 'твоего';
}

function staticMateThreat(fen: string): Threat | null {
  try {
    return mateInOneThreat(fen);
  } catch {
    return null;
  }
}

/**
 * «Что задумал соперник?» — his THREAT first (named WITHOUT its square, the board highlights it): `threat`
 * is the null-move threat of the position on the board (the child to move) the game has already searched — undefined
 * when it is not known (then only the static mate-in-one check), null when the engine found none. A mate, a fork, a
 * piece of the child he wants to take, some other idea. Without a threat: his last move in one short sentence (a check,
 * a capture, castling, an attack on a piece, a developed piece, a pawn move) and — when the engine really found
 * nothing — «Пока ничего страшного он не задумал». Board facts only (chess.js), never the engine's line or a square.
 */
export function opponentAnswerEvent(last: { san: string; fenBefore: string } | null, threat?: Threat | null): CoachEvent {
  answerSeq += 1;
  const id = `ask-opp-${answerSeq}`;
  const generic = 'generic.botMoveComment.opponent';
  const none = (): CoachEvent =>
    answerEvent({ id, text: 'Соперник ещё не ходил — ход за тобой!', pose: 'talk', items: [{ line: 'ask.opp.notYet' }], end: '!', generic, moment: 'opponent' });
  if (!last) return none();
  let chess: Chess;
  let move: ReturnType<Chess['move']>;
  try {
    chess = new Chess(last.fenBefore);
    move = chess.move(last.san);
  } catch {
    return none();
  }
  const piece = move.piece as PieceType;
  const child = move.color === 'w' ? 'b' : 'w';
  const make = (text: string, items: ClipItem[], pose: MascotPose, end: '.' | '!', extra: { more?: { items: ClipItem[]; end: '.' | '!' | '?'; text: string }; board?: BoardAnnotations } = {}): CoachEvent =>
    answerEvent({ id, text, pose, items, end, generic, moment: 'opponent', ...extra });

  // his check needs an answer right now (and a null-move threat does not exist in check)
  if (move.san.endsWith('#') || move.san.endsWith('+')) return make('Соперник объявил шах — спасай короля!', [{ line: 'opp.check' }], 'oops', '!');

  // what he threatens is worth more than what he did
  const t = threat ?? staticMateThreat(chess.fen());
  if (t) {
    const board: BoardAnnotations = { arrows: [], highlights: t.targetSquares.slice(0, 3).map((square) => ({ square, color: 'red' as const })) };
    const extra = board.highlights.length > 0 ? { board } : {};
    if (isMateMotif(t.motif)) return make('Он грозит матом!', [{ line: 'ask.opp.mate' }], 'oops', '!', extra);
    if (t.motif === 'fork') return make('Он готовит вилку!', [{ line: 'ask.opp.fork' }], 'oops', '!', extra);
    const target = t.targetSquares.map((sq) => chess.get(sq as Parameters<Chess['get']>[0])).find((cell) => cell && cell.color === child && cell.type !== 'k');
    if (target) {
      const p = target.type as PieceType;
      return make(`Он хочет забрать ${yourAcc(p)} ${pieceNameRu(p, 'acc')}!`, [{ line: 'ask.opp.hanging', piece: p }], 'oops', '!', extra);
    }
    return make('Он что-то задумал — посмотри внимательно!', [{ line: 'ask.opp.threat' }], 'think', '!', extra);
  }

  // no threat: what he did — and «nothing dangerous» only when the engine really looked
  const calm = threat === null ? { more: { items: [{ line: 'ask.opp.none' }] as ClipItem[], end: '.' as const, text: 'Пока ничего страшного он не задумал.' } } : {};
  if (move.captured) {
    const taken = move.captured as PieceType;
    return make(`Соперник забрал ${yourAcc(taken)} ${pieceNameRu(taken, 'acc')}.`, [{ line: 'opp.took', piece: taken }], 'oops', '.', calm);
  }
  if (move.flags.includes('k') || move.flags.includes('q')) return make('Соперник сделал рокировку.', [{ line: 'opp.castled' }], 'talk', '.', calm);

  // an attack: the most valuable piece of the child the moved piece now hits (the king is a check, handled above)
  let target: PieceType | null = null;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== child || cell.type === 'k' || cell.type === 'p') continue;
      const hitters = chess.attackers(cell.square, move.color);
      if (hitters.includes(move.to) && (target === null || VALUE[cell.type as PieceType] > VALUE[target])) target = cell.type as PieceType;
    }
  }
  if (target) return make(`Соперник напал на ${yourAcc(target)} ${pieceNameRu(target, 'acc')}!`, [{ line: 'opp.attack', piece: target }], 'oops', '!');

  const home = move.color === 'w' ? '1' : '8';
  if ((piece === 'n' || piece === 'b') && move.from.endsWith(home)) return make(`Соперник вывел ${pieceNameRu(piece, 'acc')}.`, [{ line: 'opp.developed', piece }], 'talk', '.', calm);
  if (piece === 'p') return make('Соперник пошёл пешкой.', [{ line: 'opp.pawn' }], 'talk', '.', calm);
  return make(`Соперник пошёл ${pieceNameRu(piece, 'ins')}.`, [{ line: 'opp.moved', piece }], 'talk', '.', calm);
}

// ───────────────────────── «Повтори» ─────────────────────────

/** Kinds whose words are about the position on the board (the move just made, the advice, a danger, a hint). */
const POSITION_KINDS: ReadonlySet<CoachEvent['kind']> = new Set(['hint', 'explainBest', 'threatWarning', 'botMoveComment', 'teachTurn', 'teachReaction', 'takebackOffer', 'reviewMoment']);

/**
 * Is this phrase about the position it was said in — arrows / squares, advice, a judged move, a motif, a named move,
 * the opponent's move? Such a phrase is not replayed by «Повтори» once the board changed; a timeless one («давай
 * вспомним два вопроса», a poke, a thought reply) is.
 */
export function isAboutThePosition(event: CoachEvent): boolean {
  if (event.board !== undefined || event.teach !== undefined || event.judgement !== undefined || event.motif !== undefined) return true;
  if (POSITION_KINDS.has(event.kind)) return true;
  const moment = event.clip?.moment;
  if (moment === 'opponent' || moment === 'why') return true;
  return (event.clip?.sentences ?? []).some((x) => x.items.some((i) => 'slot' in i));
}

/** The last phrase again: a new id (the queue treats it as new), the same words, twin and arrows. */
export function repeatEvent(last: CoachEvent): CoachEvent {
  answerSeq += 1;
  return { ...last, id: `${last.id}-again-${answerSeq}`, priority: 1 };
}

/**
 * «Повтори» after the board changed (a move, a take-back): the last phrase was about another position — its arrows and
 * its move would be wrong now, so it is not replayed; a short recorded line says so instead (no board, no move).
 */
export function repeatStaleEvent(): CoachEvent {
  answerSeq += 1;
  return answerEvent({
    id: `ask-repeat-${answerSeq}`,
    text: 'Это я про прошлый ход говорил — смотри на доску!',
    pose: 'talk',
    items: [{ line: 'ask.repeat.stale' }],
    end: '!',
    generic: 'generic.answer.repeat',
    moment: 'repeat',
  });
}

// ───────────────────────── after the game: «Как тебе партия?» ─────────────────────────

export const THOUGHT_QUESTION_RU = 'Как тебе партия?';
/** at most this many taps per game (SPEC §8.3) */
export const THOUGHT_TAPS_MAX = 2;

export type ThoughtChipId = 'easy' | 'hard' | 'goodMove' | 'mistake' | 'rematch';

export interface ThoughtChip {
  id: ThoughtChipId;
  icon: string;
  /** the child's words, gendered by `address` (the button's accessible name and the journal line) */
  label: string;
  /** the words under the icon on the small tile of the result card */
  short: string;
}

const g = (address: 'm' | 'f', m: string, f: string): string => (address === 'f' ? f : m);

export function thoughtChips(address: 'm' | 'f'): ThoughtChip[] {
  return [
    { id: 'easy', icon: '🙂', label: 'Было легко', short: 'Легко' },
    { id: 'hard', icon: '😅', label: 'Было трудно', short: 'Трудно' },
    { id: 'goodMove', icon: '⭐', label: g(address, 'Я нашёл хороший ход', 'Я нашла хороший ход'), short: g(address, 'Нашёл ход', 'Нашла ход') },
    { id: 'mistake', icon: '💡', label: g(address, 'Понял свою ошибку', 'Поняла свою ошибку'), short: g(address, 'Понял ошибку', 'Поняла ошибку') },
    { id: 'rematch', icon: '🔁', label: 'Хочу реванш!', short: 'Реванш!' },
  ];
}

export function isThoughtChipId(value: unknown): value is ThoughtChipId {
  return value === 'easy' || value === 'hard' || value === 'goodMove' || value === 'mistake' || value === 'rematch';
}

/** What the child's tap says in the journal: the chip's words and how they came («— выбрал кнопкой»). */
export function thoughtText(chip: ThoughtChipId, address: 'm' | 'f'): string {
  const label = thoughtChips(address).find((c) => c.id === chip)?.label ?? '';
  return `${label} (${g(address, 'выбрал', 'выбрала')} кнопкой)`;
}

/** His recorded reply to a thought chip — warm, short, as a boy («я готов», «я заметил»). */
export function thoughtReplyEvent(chip: ThoughtChipId): CoachEvent {
  answerSeq += 1;
  const replies: Record<ThoughtChipId, { text: string; pose: MascotPose; end: '.' | '!' }> = {
    easy: { text: 'Легко? Тогда в следующий раз позовём соперника посильнее!', pose: 'cheer', end: '!' },
    hard: { text: 'Трудно — значит, ты растёшь!', pose: 'talk', end: '!' },
    goodMove: { text: 'Здорово! Я тоже заметил этот ход.', pose: 'cheer', end: '.' },
    mistake: { text: 'Молодец! Найти свою ошибку — это уже победа.', pose: 'cheer', end: '.' },
    rematch: { text: 'Давай! Я готов к реваншу!', pose: 'wave', end: '!' },
  };
  const r = replies[chip];
  return answerEvent({ id: `thought-${chip}-${answerSeq}`, text: r.text, pose: r.pose, items: [{ line: `thought.${chip}` }], end: r.end, generic: 'generic.answer.thought', moment: 'thought', pauseClock: false });
}
