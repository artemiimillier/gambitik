/**
 * Situation briefs for the CONVERSATIONAL voice layers (contracts: `CoachEvent.brief`).
 *
 * A brief is not a script. It tells the voice model WHAT is true on the board (engine-verified facts, in spoken
 * Russian) and WHAT this moment is for; the model says it in its own words. Four short lines:
 *
 *   Момент: what just happened in the game (one sentence).
 *   Факты: engine-verified facts — moves in spoken form («конь на эф три»), material in words, what hangs, what the
 *          opponent threatens, the change of chances in words («позиция была равной, стала почти проигранной»).
 *   Можно назвать: (teacher mode, docs/TEACHER-MODE.md §6.1) the ONLY moves of the child the model may say in this
 *          answer — the engine-checked advice with its arrow colour; an opponent's move only marked «ход соперника».
 *   Цель: what the coach should achieve (e.g. «предложи вернуть ход и спроси, что может сделать соперник»).
 *   Нельзя: what must not be said (e.g. «не называй лучший ход»).
 *
 * Rules enforced here and by the tests: no Latin letters at all (notation never reaches the model's mouth — the
 * guard below strips any that slip through), the child is «ученик» (third person — «ты» in the instructions is the
 * model itself), no centipawns / percentages, and the best move of the CURRENT position only at hint level 4.
 */
import { Chess } from 'chess.js';
import type { Color, HangingPiece, MotifId, PieceType, PositionFacts, Square, StudentProfile } from '@gambit/shared';
import { parseUci } from './board.ts';
import { motifTitleInlineRu } from './motifs.ts';
import { tidy } from './phrase.ts';
import { pieceNameRu, sanToSpokenRu, squareToSpokenRu } from './spoken.ts';

/** Briefs stay far below the 500-token limit of one Live context event (Russian ≈ 3–4 characters per token). */
export const MAX_BRIEF_CHARS = 1100;

/** A teacher-mode brief of the usual `full` style (docs/TEACHER-MODE.md §2.7); `short` ≤ 600, `concept` ≤ MAX_BRIEF_CHARS. */
export const MAX_TEACH_BRIEF_CHARS = 1000;

export interface BriefParts {
  /** what just happened — one sentence */
  moment: string;
  /** engine-verified facts, each a short sentence (empty entries are dropped) */
  facts?: readonly (string | null | undefined | false)[];
  /**
   * «Можно назвать» (teacher mode): the only moves of the child the model may say — «пешка на е четыре (зелёная
   * стрелка)»; an opponent's move is marked «(ход соперника, только как угрозу)». Omitted / empty → no line.
   */
  advice?: readonly (string | null | undefined | false)[];
  /** what the coach should achieve in this moment */
  goal: string | readonly string[];
  /** what must not be said / done */
  forbid?: readonly (string | null | undefined | false)[];
}

/** Last line of defence for «no Latin in a brief»: drops Latin tokens (notation, names) and tidies the rest. */
export function stripLatinRu(text: string): string {
  return /[A-Za-z]/.test(text) ? tidy(text.replace(/[A-Za-z][A-Za-z0-9+#=\-]*/g, '')) : text;
}

function sentence(text: string): string {
  const t = tidy(text);
  if (t === '') return '';
  const capital = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]»?$/u.test(capital) ? capital : `${capital}.`;
}

function clause(text: string): string {
  return tidy(text).replace(/[.;]+$/u, '');
}

function lowerFirstRu(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

/** «Момент: … / Факты: … / Можно назвать: … / Цель: … / Нельзя: …» — Latin-free, one line per part, empty parts omitted. */
export function composeBrief(parts: BriefParts): string {
  const facts = (parts.facts ?? []).filter((f): f is string => typeof f === 'string' && f.trim() !== '').map(sentence);
  const advice = (parts.advice ?? []).filter((a): a is string => typeof a === 'string' && a.trim() !== '').map(clause);
  const goals = (typeof parts.goal === 'string' ? [parts.goal] : parts.goal).filter((g) => g.trim() !== '').map(clause);
  const forbid = (parts.forbid ?? []).filter((f): f is string => typeof f === 'string' && f.trim() !== '').map(clause);
  const lines = [`Момент: ${sentence(parts.moment)}`];
  if (facts.length > 0) lines.push(`Факты: ${facts.join(' ')}`);
  if (advice.length > 0) lines.push(`Можно назвать: ${tidy(advice.join('; '))}.`);
  if (goals.length > 0) lines.push(`Цель: ${sentence(goals.map((g, i) => (i === 0 ? g : lowerFirstRu(g))).join('; '))}`);
  if (forbid.length > 0) lines.push(`Нельзя: ${sentence(forbid.map((f, i) => (i === 0 ? f : lowerFirstRu(f))).join('; '))}`);
  return lines.map(stripLatinRu).join('\n');
}

/** Forbid-lines shared by many briefs. */
export const FORBID_BEST_MOVE = 'не называй лучший ход и клетку, куда идти';
export const FORBID_SHAME = 'не ругай и не говори «зевок», «ошибка», «плохой ход»';
export const FORBID_LONG = 'не говори дольше трёх коротких предложений';
/** Teacher mode (docs/TEACHER-MODE.md §6.1): the «Можно назвать» line is the only list of the child's moves. */
export const FORBID_OTHER_MOVES = 'не называй других ходов ученика, кроме строки «Можно назвать»';
export const FORBID_BEST_WORD = 'не говори «лучший ход» — говори «хороший», «сильный»; никаких цифр и оценок';
export const FORBID_POPULARITY = 'не говори, что «все так играют» или «самый популярный ход», если этого нет в фактах';
export const FORBID_MOVE_FOR_CHILD = 'не делай ход за ученика: решает он';
/**
 * The coach never reads out what everybody sees («у тебя осталось четыре минуты…»). Every teacher brief forbids the
 * obvious — without the clock words themselves: no brief of the teacher contains them.
 */
export const FORBID_OBVIOUS = 'не называй очевидное: чей ход, цвет, циферблат';
/** The hard sentence budget of a teacher phrase (the web's voice frame follows `TEACH_TEXT_SENTENCES` of ./teacher.ts). */
export const FORBID_TWO_SENTENCES = 'не больше двух предложений';
/** With a game strategy: one step and its reason, never the whole plan again. */
export const FORBID_WHOLE_PLAN = 'не пересказывай весь план — только этот шаг и зачем он';

/** The shared FORBID_* lines speak of «ученик»; for a girl they say «ученица» (every brief agrees with `profile.address`). */
export function forbidFor(text: string, s: Pick<StudentWords, 'nom' | 'gen'>): string {
  if (s.nom === 'ученик') return text;
  return text.replace(/ученика/gu, s.gen).replace(/решает он/gu, 'решает она');
}

// ───────────────────────── words for numbers, material, chances ─────────────────────────

const SMALL_NUMBERS_ACC_F: readonly string[] = ['ноль', 'одну', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять'];

function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** 1 → «одну пешку», 3 → «три пешки», 12 → «12 пешек» (accusative, as in «больше на …» / «теряет …»). */
export function pawnsAccRu(n: number): string {
  const abs = Math.round(Math.abs(n));
  const word = pluralRu(abs, 'пешку', 'пешки', 'пешек');
  return `${SMALL_NUMBERS_ACC_F[abs] ?? String(abs)} ${word}`;
}

/** Material balance from the child's side: «материал равный» / «у ученика на две пешки больше» / «у соперника …». */
export function materialBalanceRu(facts: Pick<PositionFacts, 'material'>, child: Color, s: StudentWords = studentWords()): string {
  const diff = child === 'w' ? facts.material.diff : -facts.material.diff;
  if (diff === 0) return 'материал равный';
  return diff > 0 ? `материала у ${s.gen} больше на ${pawnsAccRu(diff)}` : `материала у соперника больше на ${pawnsAccRu(diff)}`;
}

type ChanceBand = 'winning' | 'good' | 'equal' | 'hard' | 'losing';

function chanceBand(pct: number): ChanceBand {
  if (!Number.isFinite(pct)) return 'equal';
  if (pct >= 90) return 'winning';
  if (pct >= 65) return 'good';
  if (pct > 35) return 'equal';
  if (pct > 10) return 'hard';
  return 'losing';
}

const CHANCE_NOM: Readonly<Record<ChanceBand, string>> = {
  winning: 'почти выигранная',
  good: 'хорошая',
  equal: 'примерно равная',
  hard: 'трудная',
  losing: 'почти проигранная',
};

const CHANCE_INS: Readonly<Record<ChanceBand, string>> = {
  winning: 'почти выигранной',
  good: 'хорошей',
  equal: 'примерно равной',
  hard: 'трудной',
  losing: 'почти проигранной',
};

/** Win chance (0..100, the CHILD's point of view) in words: «для ученика позиция хорошая» / «позиция примерно равная». */
export function winChanceWordsRu(pct: number, s: StudentWords = studentWords()): string {
  const band = chanceBand(pct);
  return band === 'equal' ? `позиция ${CHANCE_NOM[band]}` : `для ${s.gen} позиция ${CHANCE_NOM[band]}`;
}

/** «для ученика позиция была примерно равной, стала почти проигранной» / «… по-прежнему …» (child's point of view). */
export function winChanceChangeRu(beforePct: number, afterPct: number, s: StudentWords = studentWords()): string {
  const a = chanceBand(beforePct);
  const b = chanceBand(afterPct);
  if (a === b) return `для ${s.gen} позиция по-прежнему ${CHANCE_NOM[b]}`;
  return `для ${s.gen} позиция была ${CHANCE_INS[a]}, стала ${CHANCE_INS[b]}`;
}

/** Direction of a change of chances: the move made the position better / worse / kept it (child's view). */
export function chanceTrendRu(beforePct: number, afterPct: number): 'better' | 'worse' | 'same' {
  const a = chanceBand(beforePct);
  const b = chanceBand(afterPct);
  const order: readonly ChanceBand[] = ['losing', 'hard', 'equal', 'good', 'winning'];
  const d = order.indexOf(b) - order.indexOf(a);
  return d > 0 ? 'better' : d < 0 ? 'worse' : 'same';
}

// ───────────────────────── pieces, squares, lines ─────────────────────────

const COLOR_INS: Readonly<Record<Color, string>> = { w: 'белыми', b: 'чёрными' };

export function colorInsRu(c: Color): string {
  return COLOR_INS[c];
}

/** «конь на эф три» — a piece where it stands (never Latin). */
export function pieceOnRu(piece: PieceType, square: Square): string {
  const sq = squareToSpokenRu(square);
  return sq ? `${pieceNameRu(piece, 'nom')} на ${sq}` : pieceNameRu(piece, 'nom');
}

/** The child's pieces that can be won right now (SEE ≥ `minSeeCp`), most valuable first: «конь на эф три, пешка на е четыре». */
export function hangingListRu(hanging: readonly HangingPiece[], color: Color, minSeeCp = 100, max = 3): string | null {
  const list = hanging.filter((h) => h.color === color && h.piece !== 'k' && h.seeLossCp >= minSeeCp).slice(0, max);
  if (list.length === 0) return null;
  return list.map((h) => pieceOnRu(h.piece, h.square)).join(', ');
}

/** Spoken words for the first `maxPlies` moves of a SAN line played from `fen`: ['конь бьёт на цэ два, шах', …]. */
export function spokenLineRu(fen: string, sans: readonly string[], maxPlies = 3): string[] {
  const out: string[] = [];
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return out;
  }
  for (const san of sans.slice(0, maxPlies)) {
    const before = chess.fen();
    try {
      chess.move(san);
    } catch {
      break;
    }
    out.push(sanToSpokenRu(san, before));
  }
  return out;
}

/** Spoken form of a SAN move ('' when it is not a move of that position). */
export function spokenMoveRu(san: string, fenBefore?: string): string {
  const spoken = sanToSpokenRu(san, fenBefore);
  return spoken === 'этот ход' ? '' : spoken;
}

/** The child's pieces the opponent takes along `pvUci` (played from `fen`, opponent to move), in the accusative: ['ферзя']. */
export function capturedAlongRu(fen: string, pvUci: readonly string[], maxPlies = 4): string[] {
  const out: string[] = [];
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return out;
  }
  const attacker = chess.turn();
  for (const uci of pvUci.slice(0, maxPlies)) {
    const parts = parseUci(uci);
    if (!parts) break;
    try {
      const mv = chess.move({ from: parts.from, to: parts.to, promotion: parts.promotion });
      if (mv.color === attacker && mv.captured) out.push(pieceNameRu(mv.captured, 'acc'));
    } catch {
      break;
    }
  }
  return out;
}

/** «вилку» — a motif in the accusative for «соперник получает …». Kept short and child-friendly. */
const MOTIF_ACC: Readonly<Record<MotifId, string>> = {
  hangingPiece: 'незащищённую фигуру',
  freeCapture: 'бесплатное взятие',
  badTrade: 'выгодный для себя размен',
  fork: 'вилку',
  pin: 'связку',
  skewer: 'сквозной удар',
  discoveredAttack: 'вскрытое нападение',
  doubleCheck: 'двойной шах',
  removeDefender: 'уничтожение защитника',
  trappedPiece: 'ловлю фигуры',
  backRankMate: 'мат на последней линии',
  mateIn1: 'мат в один ход',
  mateIn2: 'мат в два хода',
  mateIn3: 'мат в три хода',
  promotion: 'превращение пешки',
  kingSafety: 'атаку на короля',
  development: 'перевес в развитии',
  center: 'центр',
};

export function motifAccRu(m: MotifId): string {
  return MOTIF_ACC[m];
}

/** «вилка (одна фигура нападает сразу на две)» — the title with a five-word explanation for the model. */
const MOTIF_GLOSS: Partial<Readonly<Record<MotifId, string>>> = {
  fork: 'одна фигура нападает сразу на две',
  pin: 'фигура не может уйти, за ней стоит фигура дороже',
  skewer: 'дорогая фигура уходит, и забирают ту, что за ней',
  discoveredAttack: 'одна фигура отходит, а другая нападает',
  doubleCheck: 'шах сразу двумя фигурами',
  removeDefender: 'забирают защитника, и фигура остаётся без защиты',
  trappedPiece: 'фигуре некуда отступить',
  backRankMate: 'король заперт своими пешками',
};

export function motifWithGlossRu(m: MotifId): string {
  const gloss = MOTIF_GLOSS[m];
  return gloss ? `${motifTitleInlineRu(m)} (${gloss})` : motifTitleInlineRu(m);
}

/**
 * The child in the third person, gender-agreed by `profile.address` («ученик сыграл» / «ученица сыграла»):
 * «ты» inside a brief would be ambiguous — the instructions call the MODEL «ты».
 */
export interface StudentWords {
  nom: string;
  gen: string;
  dat: string;
  acc: string;
  g(masculine: string, feminine: string): string;
}

export function studentWords(profile?: Pick<StudentProfile, 'address'>): StudentWords {
  const f = profile?.address === 'f';
  return {
    nom: f ? 'ученица' : 'ученик',
    gen: f ? 'ученицы' : 'ученика',
    dat: f ? 'ученице' : 'ученику',
    acc: f ? 'ученицу' : 'ученика',
    g: (masculine, feminine) => (f ? feminine : masculine),
  };
}

/** What a move ALLOWED, as the end of «после этого хода …» (kid-friendly, no notation). */
export const ALLOWED_AFTER: Readonly<Record<MotifId, string>> = {
  hangingPiece: 'фигура осталась без защиты',
  freeCapture: 'соперник забирает фигуру бесплатно',
  badTrade: 'размен получается невыгодным',
  fork: 'соперник ставит вилку',
  pin: 'получается связка',
  skewer: 'соперник наносит сквозной удар',
  discoveredAttack: 'соперник открывает нападение',
  doubleCheck: 'соперник даёт двойной шах',
  removeDefender: 'соперник убирает защитника',
  trappedPiece: 'фигуре некуда отступить',
  backRankMate: 'появляется угроза мата на последней линии',
  mateIn1: 'появляется угроза мата',
  mateIn2: 'появляется угроза мата',
  mateIn3: 'появляется угроза мата',
  promotion: 'пешка соперника бежит к превращению',
  kingSafety: 'королю становится опасно',
  development: 'фигуры остаются дома',
  center: 'центр достаётся сопернику',
};

/** «после этого хода соперник ставит вилку (одна фигура нападает сразу на две)» — what a move allowed, for briefs. */
export function allowedFactRu(m: MotifId): string {
  const gloss = MOTIF_GLOSS[m];
  return `после этого хода ${ALLOWED_AFTER[m]}${gloss ? ` (${gloss})` : ''}`;
}

/** First letter up: «ученик …» at the start of a sentence. */
export function capRu(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}
