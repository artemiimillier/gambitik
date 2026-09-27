/**
 * «Найди ход лучше!» — the solve-first exercise built from a KeyMoment of the finished game.
 * Pure logic: which move is the engine's best, what to answer to the child's try, and the local
 * 'reviewMoment' CoachEvent that reveals the answer. Nothing here evaluates chess by itself: a try is
 * compared with the recorded best move (or is a mate), and — when the judge engine could look at it
 * (./reviewTry.ts) — with the engine's numbers, so every good move counts, not only the engine's first choice.
 */
import { Chess } from 'chess.js';
import { moveNumberLabel, sanToBubbleRu, sanToSpokenRu } from '@gambit/core';
import type { BoardAnnotations, CoachEvent, Color, KeyMoment, MoveJudgement } from '@gambit/shared';
import { makeLocalEvent, pick, stripLatin } from '../puzzles/puzzleCoach.ts';
import type { Rng } from '../puzzles/puzzleCoach.ts';
import { applyUci, sideToMove } from '../puzzles/puzzleLine.ts';
import type { AppliedMove } from '../puzzles/puzzleLine.ts';
import { positionKey } from './reviewModel.ts';
import type { TryEvaluation } from './reviewTry.ts';

export const MAX_MOMENT_TRIES = 3;
/** A try that loses less than this many win% points against the engine's best move is a correct answer (= «хороший ход» and better). */
export const ACCEPT_TRY_LOSS_PCT = 5;
/** A try counts as «лучше, чем в партии» when it keeps at least this many win% points more than the played move. */
export const BETTER_THAN_PLAYED_MARGIN_PCT = 5;
/** «Показать ответ» appears after the first try — or after this long for a child who is stuck without trying. */
export const SHOW_ANSWER_DELAY_MS = 20_000;

export interface ResolvedMoment {
  moment: KeyMoment;
  /** side to move in `moment.fenBefore` — the child */
  color: Color;
  /** '12.' / '12…' */
  moveLabel: string;
  best: AppliedMove | null;
  /** what the child really played in the game */
  played: AppliedMove | null;
  judgement?: MoveJudgement;
  /** a «proud moment»: the played move WAS the best one — nothing to search for */
  isProud: boolean;
}

/** SAN (possibly with !/? marks, possibly without +/#) → the applied move, or null when it does not fit the position. */
function applySan(fen: string, san: string): AppliedMove | null {
  const clean = san.replace(/[!?]+$/g, '').trim();
  if (clean === '') return null;
  try {
    const move = new Chess(fen).move(clean);
    return applyUci(fen, `${move.from}${move.to}${move.promotion ?? ''}`);
  } catch {
    return null;
  }
}

export function resolveMoment(moment: KeyMoment, judgements: readonly MoveJudgement[]): ResolvedMoment {
  const key = positionKey(moment.fenBefore);
  const judgement = [...judgements].reverse().find((j) => positionKey(j.fenBefore) === key && j.san === moment.playedSan) ?? judgements.find((j) => positionKey(j.fenBefore) === key);
  const best = (judgement && judgement.san === moment.playedSan ? applyUci(moment.fenBefore, judgement.bestUci) : null) ?? applySan(moment.fenBefore, moment.bestSan);
  const played = (judgement && judgement.san === moment.playedSan ? applyUci(moment.fenBefore, judgement.uci) : null) ?? applySan(moment.fenBefore, moment.playedSan);
  const isProud = moment.classification === 'best' || moment.classification === 'excellent' || (best !== null && played !== null && best.uci === played.uci);
  return {
    moment,
    color: sideToMove(moment.fenBefore),
    moveLabel: moveNumberLabel(moment.fenBefore),
    best,
    played,
    ...(judgement ? { judgement } : {}),
    isProud,
  };
}

export type TryVerdict =
  /** exactly the engine's best move */
  | 'best'
  /** another move, but it checkmates — cannot be improved on */
  | 'mate'
  /** another move that the engine proves to be (almost) as good as the best one — a correct answer */
  | 'good'
  /** proven better than the move of the game, but a clearly stronger one exists — costs a try, said kindly */
  | 'better'
  /** the same move as in the game */
  | 'samePlayed'
  /** some other legal move the engine did not vouch for (or could not look at): only «not the recorded best» is claimed */
  | 'other'
  | 'illegal';

export function judgeTry(resolved: Pick<ResolvedMoment, 'moment' | 'best' | 'played'>, uci: string): TryVerdict {
  const tried = applyUci(resolved.moment.fenBefore, uci);
  if (!tried) return 'illegal';
  if (resolved.best && tried.uci === resolved.best.uci) return 'best';
  if (tried.isMate) return 'mate';
  if (resolved.played && tried.uci === resolved.played.uci) return 'samePlayed';
  return 'other';
}

/** Verdicts that end the search with success. */
export function isCorrectVerdict(verdict: TryVerdict): boolean {
  return verdict === 'best' || verdict === 'mate' || verdict === 'good';
}

/**
 * Upgrades an instant 'other' with the engine's evaluation of the try (null = the engine could not answer —
 * then nothing changes and nothing is claimed). Every other verdict is final as it is.
 */
export function refineVerdict(verdict: TryVerdict, evaluation: TryEvaluation | null, played: Pick<MoveJudgement, 'winPctLoss'> | undefined): TryVerdict {
  if (verdict !== 'other' || evaluation === null || !Number.isFinite(evaluation.winPctLoss)) return verdict;
  if (evaluation.winPctLoss < ACCEPT_TRY_LOSS_PCT) return 'good';
  if (played && played.winPctLoss - evaluation.winPctLoss >= BETTER_THAN_PLAYED_MARGIN_PCT) return 'better';
  return 'other';
}

/** «Показать ответ» is offered only after a real try — or after 20 s of looking at the position. */
export function canShowAnswer(tries: number, msSinceOpened: number): boolean {
  return tries >= 1 || msSinceOpened >= SHOW_ANSWER_DELAY_MS;
}

/** What the child already did with a task moment; a moment without an entry is still untouched. */
export type MomentProgress = 'tried' | 'found' | 'revealed';

/** Task moments (not the «proud» ones) the child has not even tried yet. */
export function untouchedTaskCount(moments: readonly Pick<ResolvedMoment, 'isProud'>[], progress: Readonly<Record<number, MomentProgress | undefined>>): number {
  return moments.filter((resolved, index) => !resolved.isProud && progress[index] === undefined).length;
}

/**
 * True solve-first: everything that PRINTS the answers — the written review, the
 * «какой ход сильнее» arrow of a task move — stays closed while a task is untouched. A grown-up (or a child who
 * is stuck) may open it anyway, but only after the same 20 s pause as «Показать ответ».
 */
export function answersUnlocked(untouchedTasks: number, openedByHand: boolean): boolean {
  return untouchedTasks === 0 || openedByHand;
}

/** A first gentle step before the answer: which piece to look at (yellow), never where it goes. */
export function hintAnnotations(resolved: Pick<ResolvedMoment, 'best'>): BoardAnnotations | null {
  return resolved.best ? { arrows: [], highlights: [{ square: resolved.best.from, color: 'yellow' }] } : null;
}

/** Short on-screen feedback for a try (the mascot stays quiet until the reveal). */
export function tryFeedbackRu(verdict: TryVerdict, triesLeft: number): string {
  switch (verdict) {
    case 'best':
      return 'Да! Это самый сильный ход.';
    case 'mate':
      return 'Мат! Сильнее не бывает.';
    case 'good':
      return 'Это тоже хороший ход!';
    case 'better':
      return triesLeft > 0 ? 'Этот ход лучше, чем в партии! А есть ещё сильнее — поищешь?' : 'Этот ход лучше, чем в партии! Смотри, какой ещё сильнее.';
    case 'samePlayed':
      return triesLeft > 0 ? 'Так было в партии. Поищи другой ход!' : 'Так было в партии. Смотри, что нашёл компьютер.';
    case 'other':
      return triesLeft > 0 ? 'Хорошая мысль! А компьютер нашёл ход посильнее. Попробуй ещё.' : 'Хорошая попытка! Смотри, что нашёл компьютер.';
    case 'illegal':
      return 'Так ходить нельзя. Попробуй другой ход.';
  }
}

/** Arrows of the reveal: green = the best move, red = what was played in the game. */
export function revealAnnotations(resolved: Pick<ResolvedMoment, 'best' | 'played' | 'isProud'>): BoardAnnotations {
  const arrows: BoardAnnotations['arrows'] = [];
  if (resolved.played && !resolved.isProud && resolved.played.uci !== resolved.best?.uci) arrows.push({ from: resolved.played.from, to: resolved.played.to, color: 'red' });
  if (resolved.best) arrows.push({ from: resolved.best.from, to: resolved.best.to, color: 'green' });
  return { arrows, highlights: [] };
}

/**
 * The phrase Гамбитик says when the answer is revealed.
 * `text` is Latin-free (moves are spoken in Russian words); the bubble may use Russian notation.
 */
export function buildReviewMomentEvent(
  resolved: ResolvedMoment,
  outcome: 'found' | 'revealed',
  rng: Rng = Math.random,
  /** the child's own good move when it was accepted although it is not the engine's first choice */
  alternative?: Pick<AppliedMove, 'san' | 'from' | 'to'>,
): CoachEvent {
  const { moment } = resolved;
  const bestSan = resolved.best?.san ?? moment.bestSan;
  const explanation = moment.explanation.trim();

  if (alternative && outcome === 'found' && !resolved.isProud) {
    const opener = pick(['Это тоже хороший ход!', 'Отличная находка — так тоже можно!'], rng);
    const board = revealAnnotations(resolved);
    return makeLocalEvent({
      kind: 'reviewMoment',
      priority: 1,
      pose: 'cheer',
      // gender-neutral on purpose (no past-tense verb about the child)
      text: `${opener} Твой ход — ${sanToSpokenRu(alternative.san, moment.fenBefore)}. А компьютеру больше всего нравится ${sanToSpokenRu(bestSan, moment.fenBefore)}.`,
      bubbleText: `${opener} Твой ход ${resolved.moveLabel} ${sanToBubbleRu(alternative.san)} тоже хорош. А компьютеру больше всего нравится ${sanToBubbleRu(bestSan)}.`,
      board: { arrows: [...board.arrows.filter((arrow) => arrow.color === 'green'), { from: alternative.from, to: alternative.to, color: 'blue' }], highlights: [] },
    });
  }

  if (resolved.isProud) {
    const opener = pick(['Вот этим ходом можно гордиться!', 'Смотри, какой сильный ход был в партии!'], rng);
    return makeLocalEvent({
      kind: 'reviewMoment',
      priority: 1,
      pose: 'cheer',
      text: `${opener} ${stripLatin(explanation)}`.trim(),
      bubbleText: `${opener} ${explanation}`.trim(),
      board: revealAnnotations(resolved),
    });
  }

  const opener =
    outcome === 'found'
      ? pick(['Нашёлся! Вот он, сильный ход.', 'Точно! Теперь этот ход твой.', 'Есть! Вот это работа головой!'], rng)
      : pick(['Смотри, какой ход тут прятался.', 'Вот что нашёл компьютер.', 'Давай посмотрим вместе.'], rng);
  // found: the child's own move IS the best one — «Сильнее было …» would contradict the praise right before it
  const spokenMove = outcome === 'found' ? `Это ${sanToSpokenRu(bestSan, moment.fenBefore)}.` : `Сильнее было: ${sanToSpokenRu(bestSan, moment.fenBefore)}.`;
  const bubbleMove = outcome === 'found' ? `Лучший ход — ${resolved.moveLabel} ${sanToBubbleRu(bestSan)}.` : `Сильнее было ${resolved.moveLabel} ${sanToBubbleRu(bestSan)}.`;
  return makeLocalEvent({
    kind: 'reviewMoment',
    priority: 1,
    pose: outcome === 'found' ? 'cheer' : 'talk',
    text: `${opener} ${spokenMove} ${stripLatin(explanation)}`.trim(),
    bubbleText: `${opener} ${bubbleMove} ${explanation}`.trim(),
    board: revealAnnotations(resolved),
  });
}

/**
 * What a task moment is called on its card. Never the head-on label of the child's move («Зевок», «Ошибка» —
 * research 08 §3.4): the move list keeps the chess marks, the invitation stays kind.
 */
function taskLabelRu(moment: Pick<KeyMoment, 'classification' | 'motif'>): string {
  if (moment.classification === 'missedWin') return 'Упущенный шанс';
  if (moment.motif === 'hangingPiece' || moment.motif === 'freeCapture') return 'Фигура под боем';
  return 'Трудный момент';
}

/** «Трудный момент на 12-м ходу» — caption of a moment card (every Russian ordinal takes «-м» in this case). */
export function momentCaptionRu(resolved: Pick<ResolvedMoment, 'moment' | 'moveLabel' | 'isProud'>): string {
  const label = resolved.isProud ? 'Сильный ход' : taskLabelRu(resolved.moment);
  const moveNumber = Number.parseInt(resolved.moveLabel, 10);
  return Number.isFinite(moveNumber) ? `${label} на ${moveNumber}-м ходу` : label;
}
