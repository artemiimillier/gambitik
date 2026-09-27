/**
 * Small local CoachEvents for the puzzle trainer and the other secondary screens.
 * Everything here is ready-made Russian: warm, short, never shaming, gender-neutral towards the child
 * and free of Latin letters (the `text` is spoken verbatim by TTS).
 */
import type { BoardAnnotations, CoachEvent, CoachEventKind, HintLevel, MascotPose, PieceType, Square } from '@gambit/shared';

export type Rng = () => number;

let counter = 0;

function nextId(kind: CoachEventKind): string {
  counter = (counter + 1) % 1_000_000;
  return `screens-${kind}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Last line of defence for the "no Latin in `text`" contract (titles come from content data). */
export function stripLatin(text: string): string {
  return text
    .replace(/[A-Za-z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?:;…»])/g, '$1')
    .replace(/«\s+/g, '«')
    .trim();
}

export interface LocalEventSpec {
  kind: CoachEventKind;
  priority: 0 | 1 | 2;
  pose: MascotPose;
  text: string;
  /** defaults to `text` */
  bubbleText?: string;
  board?: BoardAnnotations;
  hintLevel?: HintLevel;
}

export function makeLocalEvent(spec: LocalEventSpec): CoachEvent {
  const event: CoachEvent = {
    id: nextId(spec.kind),
    kind: spec.kind,
    priority: spec.priority,
    text: stripLatin(spec.text),
    bubbleText: spec.bubbleText ?? spec.text,
    pose: spec.pose,
    pauseClock: false,
  };
  if (spec.board && (spec.board.arrows.length > 0 || spec.board.highlights.length > 0)) event.board = spec.board;
  if (spec.hintLevel !== undefined) event.hintLevel = spec.hintLevel;
  return event;
}

export function pick<T>(pool: readonly [T, ...T[]], rng: Rng = Math.random): T {
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return pool[index] ?? pool[0];
}

const PIECE_ACC_RU: Record<PieceType, string> = { p: 'пешку', n: 'коня', b: 'слона', r: 'ладью', q: 'ферзя', k: 'короля' };

// ───────────────────────── puzzle session ─────────────────────────

export function buildPuzzleSessionStart(themeTitle: string | undefined, rng: Rng = Math.random): CoachEvent {
  const opener = pick(['Решаем задачи!', 'Время задачек!', 'Разомнём голову!'], rng);
  const calm = pick(['Не спеши — времени сколько угодно.', 'Часов тут нет, думай спокойно.', 'Сначала смотрим — потом ходим!'], rng);
  const theme = themeTitle ? ` Тема: «${themeTitle}».` : '';
  return makeLocalEvent({ kind: 'greeting', priority: 1, pose: 'wave', text: `${opener}${theme} ${calm}` });
}

export interface PuzzleSolvedInfo {
  /** solved at the first try, without hints */
  clean: boolean;
  /** current streak of clean solutions (after this puzzle) */
  streak: number;
  /** Russian theme title to reveal, undefined in a theme-specific session */
  revealTitle?: string;
  /** the child played a different mate than the stored one */
  alternateMate?: boolean;
}

export function buildPuzzleSolved(info: PuzzleSolvedInfo, rng: Rng = Math.random): CoachEvent {
  let praise: string;
  if (info.alternateMate) {
    praise = pick(['Мат! Твой способ тоже отличный.', 'И так тоже мат! Здорово.'], rng);
  } else if (info.clean && info.streak >= 3 && info.streak % 5 !== 0) {
    praise = pick([`Уже ${info.streak} подряд! Вот это внимательность.`, `${info.streak} подряд с первой попытки! Так держать.`], rng);
  } else if (info.clean && info.streak > 0 && info.streak % 5 === 0) {
    praise = `И-го-го! ${info.streak} задач подряд с первой попытки!`;
  } else if (info.clean) {
    // «Так думают мастера» is kept for the game itself — one catchphrase must not follow the child everywhere
    praise = pick(['Точно! С первой попытки.', 'Верно! Хорошо всё проверено.', 'Есть! Отличное решение.', 'Да! Это было внимательно.'], rng);
  } else {
    praise = pick(['Получилось! Упорство победило.', 'Вот и решение! Здорово, что задача доведена до конца.', 'Есть! Вторая попытка — тоже попытка.'], rng);
  }
  const reveal = info.revealTitle ? ` Это тема «${info.revealTitle}».` : '';
  const milestone = info.clean && info.streak > 0 && info.streak % 5 === 0;
  return makeLocalEvent({ kind: 'praise', priority: milestone ? 1 : 0, pose: 'cheer', text: `${praise}${reveal}` });
}

export function buildPuzzleMiss(wrongAttempts: number, rng: Rng = Math.random): CoachEvent {
  const first = ['Почти! Попробуй ещё.', 'Не совсем. Посмотри ещё разок.', 'Хорошая мысль, но есть ход сильнее. Попробуй ещё!'] as const;
  const later = [
    'Проверь шахи, взятия и угрозы.',
    'Посмотри, какая фигура соперника стоит без защиты.',
    'Не выходит? Нажми на лампочку — подскажу.',
    'Трудная задача. Давай ещё попытку — или возьми подсказку.',
  ] as const;
  return makeLocalEvent({ kind: 'encourage', priority: 0, pose: 'think', text: pick(wrongAttempts <= 1 ? first : later, rng) });
}

export function buildPuzzleHint(step: 1 | 2, move: { from: Square; to: Square; piece: PieceType }, rng: Rng = Math.random): CoachEvent {
  if (step === 1) {
    // пешка and ладья are feminine in Russian, the other pieces masculine
    const dative = move.piece === 'p' || move.piece === 'r' ? 'ей' : 'ему';
    const text = pick(
      [`Посмотри на ${PIECE_ACC_RU[move.piece]} в синей рамке. Куда ${dative} лучше пойти?`, 'Ходить нужно фигурой в синей рамке. Найди для неё лучшую клетку!'],
      rng,
    );
    return makeLocalEvent({
      kind: 'hint',
      priority: 1,
      pose: 'think',
      hintLevel: 3,
      text,
      board: { arrows: [], highlights: [{ square: move.from, color: 'blue' }] },
    });
  }
  return makeLocalEvent({
    kind: 'hint',
    priority: 1,
    pose: 'talk',
    hintLevel: 4,
    text: pick(['Вот этот ход. Сыграй его и подумай, почему он сильный.', 'Смотри на зелёную стрелку. Сыграй ход и найди, в чём его сила.'], rng),
    board: { arrows: [{ from: move.from, to: move.to, color: 'green' }], highlights: [] },
  });
}

export function buildSolutionShown(rng: Rng = Math.random): CoachEvent {
  return makeLocalEvent({
    kind: 'encourage',
    priority: 1,
    pose: 'talk',
    text: pick(['Смотри, как это работает. Такая картинка ещё встретится — и ты её узнаешь!', 'Показываю решение. Запомни идею — она пригодится.'], rng),
  });
}

export function buildSessionSummary(stats: { total: number; solvedClean: number; stars: number }, rng: Rng = Math.random): CoachEvent {
  const opener = pick(['Задачи позади!', 'Готово! Отличная тренировка.', 'Вот и всё на этот раз!'], rng);
  const detail =
    stats.solvedClean > 0
      ? `С первой попытки решено: ${stats.solvedClean} из ${stats.total}.`
      : 'Задачи были трудные, и все доведены до конца — это главное.';
  return makeLocalEvent({ kind: 'encourage', priority: 1, pose: 'cheer', text: `${opener} ${detail}` });
}
