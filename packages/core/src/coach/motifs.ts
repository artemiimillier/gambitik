/**
 * Kid-friendly Russian wording for tactical / strategic motifs.
 * Pure data + tiny lookups — no chess logic here.
 */
import type { MotifId } from '@gambit/shared';

/** Titles follow the Russian lichess theme names where one exists (research 06 §2.5). */
const MOTIF_TITLES: Readonly<Record<MotifId, string>> = {
  hangingPiece: 'Фигура без защиты',
  freeCapture: 'Бесплатное взятие',
  badTrade: 'Невыгодный размен',
  fork: 'Вилка',
  pin: 'Связка',
  skewer: 'Сквозной удар',
  discoveredAttack: 'Вскрытое нападение',
  doubleCheck: 'Двойной шах',
  removeDefender: 'Уничтожение защитника',
  trappedPiece: 'Ловля фигуры',
  backRankMate: 'Мат на последней линии',
  mateIn1: 'Мат в один ход',
  mateIn2: 'Мат в два хода',
  mateIn3: 'Мат в три хода',
  promotion: 'Превращение пешки',
  kingSafety: 'Безопасность короля',
  development: 'Развитие фигур',
  center: 'Борьба за центр',
};

/** 'fork' → 'Вилка' (capitalised, ready for a heading or a chip). */
export function motifTitleRu(m: MotifId): string {
  return MOTIF_TITLES[m];
}

/** Same title with a lower-case first letter, for use inside a sentence. */
export function motifTitleInlineRu(m: MotifId): string {
  const t = MOTIF_TITLES[m];
  return t.charAt(0).toLowerCase() + t.slice(1);
}

/** Motifs that mean "the king gets mated". */
export function isMateMotif(m: MotifId | undefined): boolean {
  return m === 'mateIn1' || m === 'mateIn2' || m === 'mateIn3' || m === 'backRankMate';
}

/**
 * What happened when the child ALLOWED this motif (the opponent gets to use it).
 * One short sentence, no notation, never blames the child — it describes the position.
 */
const ALLOWED_EXPLANATION: Readonly<Record<MotifId, string>> = {
  hangingPiece: 'Фигура осталась без защиты, и соперник может её забрать.',
  freeCapture: 'Соперник может забрать фигуру бесплатно — её никто не защищает.',
  badTrade: 'Размен получился невыгодным: отдаём больше, чем забираем.',
  fork: 'Соперник получает вилку — одна его фигура нападает сразу на две твои.',
  pin: 'Получается связка: фигура не может уйти, потому что за ней стоит фигура дороже.',
  skewer: 'Получается сквозной удар: дорогая фигура уходит, и пропадает та, что стояла за ней.',
  discoveredAttack: 'Соперник отходит одной фигурой и открывает нападение другой.',
  doubleCheck: 'Соперник даёт двойной шах — сразу двумя фигурами.',
  removeDefender: 'Соперник убирает защитника, и фигура за ним остаётся одна.',
  trappedPiece: 'Фигуре некуда отступить, и её можно поймать.',
  backRankMate: 'Появляется угроза мата на последней линии: королю нужна форточка.',
  mateIn1: 'Появляется угроза мата в один ход.',
  mateIn2: 'Появляется угроза мата в два хода.',
  mateIn3: 'Появляется угроза мата в три хода.',
  promotion: 'Пешка соперника прорывается к превращению.',
  kingSafety: 'Королю становится неуютно: вокруг него мало защитников.',
  development: 'Фигуры ещё спят дома, а соперник уже вывел свои.',
  center: 'Соперник забирает центр доски.',
};

/** What the child could have done (the best move realised this motif). Positive, "treasure" tone. */
const MISSED_EXPLANATION: Readonly<Record<MotifId, string>> = {
  hangingPiece: 'Фигура соперника стояла без защиты — её можно было забрать.',
  freeCapture: 'Тут было бесплатное взятие: фигуру соперника никто не защищал.',
  badTrade: 'Был выгодный размен: забираем больше, чем отдаём.',
  fork: 'Тут пряталась вилка — одним ходом напасть сразу на две фигуры.',
  pin: 'Тут пряталась связка: фигура соперника не смогла бы уйти.',
  skewer: 'Тут прятался сквозной удар: дорогая фигура уходит, а за ней стоит ещё одна.',
  discoveredAttack: 'Тут пряталось вскрытое нападение: одна фигура отходит, другая нападает.',
  doubleCheck: 'Тут был двойной шах — самый сильный шах на свете.',
  removeDefender: 'Можно было убрать защитника и потом забрать фигуру.',
  trappedPiece: 'Фигуру соперника можно было поймать — ей некуда было уйти.',
  backRankMate: 'Тут был мат на последней линии: король заперт своими пешками.',
  mateIn1: 'Тут был мат в один ход.',
  mateIn2: 'Тут был мат в два хода.',
  mateIn3: 'Тут был мат в три хода.',
  promotion: 'Пешка могла добежать до конца и превратиться в ферзя.',
  kingSafety: 'Был ход, после которого королю стало бы спокойнее.',
  development: 'Хорошо было вывести в игру ещё одну фигуру.',
  center: 'Хорошо было занять центр доски.',
};

export function motifExplanationRu(m: MotifId, role: 'allowed' | 'missed'): string {
  return role === 'allowed' ? ALLOWED_EXPLANATION[m] : MISSED_EXPLANATION[m];
}

/** "One thing to practise" — a growth-mindset sentence for the end of a game / review. */
const PRACTICE_LINE: Readonly<Record<MotifId, string>> = {
  hangingPiece: 'Потренируем вопрос «Это безопасно?» — чтобы каждая фигура была под защитой.',
  freeCapture: 'Потренируем зоркий глаз: что у соперника стоит без защиты?',
  badTrade: 'Потренируем счёт разменов: кто что забирает и кому это выгодно.',
  fork: 'Потренируемся замечать вилки заранее.',
  pin: 'Потренируемся замечать связки заранее.',
  skewer: 'Потренируем сквозной удар: смотрим, какие фигуры стоят на одной линии.',
  discoveredAttack: 'Потренируем вскрытое нападение: что откроется, когда фигура отойдёт?',
  doubleCheck: 'Потренируем двойной шах.',
  removeDefender: 'Потренируем тему «Убери защитника».',
  trappedPiece: 'Потренируемся проверять, есть ли у фигуры путь назад.',
  backRankMate: 'Потренируем мат на последней линии и форточку для короля.',
  mateIn1: 'Потренируем мат в один ход: перед ходом проверяем все шахи.',
  mateIn2: 'Потренируем мат в два хода.',
  mateIn3: 'Потренируем мат в три хода.',
  promotion: 'Потренируем проходные пешки и превращение.',
  kingSafety: 'Потренируемся прятать короля: рокировка и защитники рядом.',
  development: 'В следующей партии разбудим все фигуры пораньше.',
  center: 'В следующей партии поборемся за центр с первых ходов.',
};

export function motifPracticeLineRu(m: MotifId): string {
  return PRACTICE_LINE[m];
}

/** MotifId → lichess puzzle theme key (keys verified against the CSV in research 05/06). */
const MOTIF_TO_PUZZLE_THEME: Readonly<Record<MotifId, string | undefined>> = {
  hangingPiece: 'hangingPiece',
  freeCapture: 'hangingPiece',
  badTrade: undefined,
  fork: 'fork',
  pin: 'pin',
  skewer: 'skewer',
  discoveredAttack: 'discoveredAttack',
  doubleCheck: 'doubleCheck',
  removeDefender: 'capturingDefender',
  trappedPiece: 'trappedPiece',
  backRankMate: 'backRankMate',
  mateIn1: 'mateIn1',
  mateIn2: 'mateIn2',
  mateIn3: 'mateIn3',
  promotion: 'promotion',
  kingSafety: 'exposedKing',
  development: undefined,
  center: undefined,
};

export function motifToPuzzleTheme(m: MotifId): string | undefined {
  return MOTIF_TO_PUZZLE_THEME[m];
}

/**
 * The motif worth practising next: the most frequent one among what the child allowed
 * (defensive habits come first), then among what the child missed. Ties → first seen.
 */
export function pickPracticeMotif(summary: {
  motifsAllowed: readonly MotifId[];
  motifsMissed: readonly MotifId[];
}): MotifId | undefined {
  return mostFrequent(summary.motifsAllowed) ?? mostFrequent(summary.motifsMissed);
}

function mostFrequent(list: readonly MotifId[]): MotifId | undefined {
  const counts = new Map<MotifId, number>();
  for (const m of list) counts.set(m, (counts.get(m) ?? 0) + 1);
  let best: MotifId | undefined;
  let bestCount = 0;
  for (const [m, c] of counts) {
    if (c > bestCount) {
      best = m;
      bestCount = c;
    }
  }
  return best;
}
