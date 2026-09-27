/**
 * Post-game summary: accuracy, counts, journal statistics and the key moments for the review.
 */
import { Chess } from 'chess.js';
import type { GameEvent, GameSummary, KeyMoment, MotifId, MoveClass, MoveJudgement, PieceType } from '@gambit/shared';
import { finalJudgements, gameAccuracy, scoreToCp } from './eval.ts';
import { describeMotif } from './motifs.ts';
import { applyUci } from './pv.ts';

/** At most this many "learn from it" moments — a child's attention is short (research 07 §6.1). */
const MAX_NEGATIVE_MOMENTS = 3;
const NEGATIVE_CLASSES: readonly MoveClass[] = ['blunder', 'mistake', 'missedWin', 'inaccuracy'];
/**
 * Up to this curriculum stage an `inaccuracy` (< 10 win%) is never a key moment: it is above the
 * child's level, cannot be explained in the child's words and would turn «Найди ход лучше» into
 * "guess the engine move" (research 05 §4.1: errors above the level stay silent).
 */
export const INACCURACY_MOMENTS_FROM_STAGE = 5;

const MATE_MOTIFS: readonly MotifId[] = ['mateIn1', 'mateIn2', 'mateIn3', 'backRankMate'];

/** nominative, verb ending for "остал-", accusative pronoun */
const PIECE_RU: Record<PieceType, { name: string; stayed: string; it: string }> = {
  p: { name: 'пешка', stayed: 'осталась', it: 'её' },
  n: { name: 'конь', stayed: 'остался', it: 'его' },
  b: { name: 'слон', stayed: 'остался', it: 'его' },
  r: { name: 'ладья', stayed: 'осталась', it: 'её' },
  q: { name: 'ферзь', stayed: 'остался', it: 'его' },
  k: { name: 'король', stayed: 'остался', it: 'его' },
};

const ALLOWED_RU: Partial<Record<MotifId, string>> = {
  hangingPiece: 'Фигура осталась без защиты, и соперник мог её забрать.',
  freeCapture: 'Фигура осталась без защиты, и соперник мог её забрать.',
  badTrade: 'Размен вышел невыгодным: отдали больше, чем взяли.',
  fork: 'После этого хода соперник мог напасть сразу на две фигуры — это вилка.',
  pin: 'После этого хода фигура попадала под связку и не могла уйти.',
  skewer: 'Соперник мог напасть на важную фигуру, а за ней стояла ещё одна — это сквозной удар.',
  discoveredAttack: 'Соперник мог отойти фигурой и открыть нападение — это вскрытое нападение.',
  doubleCheck: 'Соперник мог объявить двойной шах — от него можно только убегать королём.',
  removeDefender: 'Соперник мог убрать защитника, и фигура осталась бы без охраны.',
  trappedPiece: 'Фигуру могли поймать: ей некуда было отступить.',
  backRankMate: 'Королю некуда было убежать с последней линии — грозил мат. Помогает «форточка».',
  mateIn1: 'После этого хода соперник мог поставить мат в один ход.',
  mateIn2: 'После этого хода соперник мог поставить мат в два хода.',
  mateIn3: 'После этого хода соперник мог поставить мат в три хода.',
  promotion: 'Пешка соперника могла пройти в ферзи.',
};

const MISSED_RU: Partial<Record<MotifId, string>> = {
  freeCapture: 'Здесь можно было забрать фигуру бесплатно.',
  hangingPiece: 'Здесь можно было выиграть фигуру: её защищали слишком слабо.',
  fork: 'Здесь была вилка — можно было напасть сразу на две фигуры.',
  pin: 'Здесь можно было выиграть связанную фигуру: она не могла уйти.',
  skewer: 'Здесь был сквозной удар: важная фигура уходит, а та, что за ней, остаётся под боем.',
  discoveredAttack: 'Здесь можно было отойти фигурой и открыть нападение.',
  doubleCheck: 'Здесь был двойной шах — очень сильный приём.',
  removeDefender: 'Здесь можно было сначала убрать защитника, а потом забрать фигуру.',
  trappedPiece: 'Здесь можно было поймать фигуру соперника: ей некуда отступать.',
  backRankMate: 'Здесь был мат по последней линии!',
  mateIn1: 'Здесь был мат в один ход!',
  mateIn2: 'Здесь был мат в два хода.',
  mateIn3: 'Здесь был мат в три хода.',
  promotion: 'Здесь пешка могла пройти в ферзи.',
};

const FOUND_RU: Partial<Record<MotifId, string>> = {
  freeCapture: 'Отлично замечено: фигура соперника стояла без защиты — и теперь она твоя!',
  hangingPiece: 'Отлично замечено: фигуру защищали слабо — и она выиграна!',
  fork: 'Красивая вилка — нападение сразу на две фигуры!',
  pin: 'Здорово использована связка!',
  skewer: 'Отличный сквозной удар!',
  discoveredAttack: 'Классное вскрытое нападение!',
  doubleCheck: 'Двойной шах — очень сильный ход!',
  removeDefender: 'Умно: сначала убран защитник, а потом забрана фигура.',
  trappedPiece: 'Фигура соперника поймана — отличная работа!',
  backRankMate: 'Мат по последней линии — супер!',
  mateIn1: 'Мат найден — супер!',
  mateIn2: 'Найден мат в два хода — здорово!',
  mateIn3: 'Найден мат в три хода — это очень сильно!',
  promotion: 'Пешка прошла в ферзи — отлично!',
};

/** The piece the refutation captures first, if the refutation starts with a capture. */
function firstCapturedPiece(j: MoveJudgement): PieceType | undefined {
  const first = j.refutationPvUci[0];
  if (!first) return undefined;
  try {
    return applyUci(new Chess(j.fenAfter), first)?.captured;
  } catch {
    return undefined;
  }
}

function explainNegative(j: MoveJudgement, motif: MotifId | undefined, side: 'allowed' | 'missed' | 'none'): string {
  if (side === 'allowed' && motif) {
    if (motif === 'hangingPiece' || motif === 'freeCapture') {
      const piece = firstCapturedPiece(j);
      if (piece && piece !== 'k') {
        const ru = PIECE_RU[piece];
        const name = ru.name[0]?.toUpperCase() + ru.name.slice(1);
        return `${name} ${ru.stayed} под боем — соперник мог ${ru.it} забрать.`;
      }
    }
    const text = ALLOWED_RU[motif];
    if (text) return text;
  }
  if (side === 'missed' && motif) {
    const text = MISSED_RU[motif];
    if (text) return text;
  }
  if (j.classification === 'missedWin') return 'Тут был подарок от соперника — можно было получить большой перевес.';
  if (j.materialLossPawns >= 2) return 'После этого хода терялся материал. Перед ходом проверь: всем фигурам спокойно?';
  // a neutral fact: it reads well before the task is solved AND after the better move was found
  return 'Другой ход давал позицию покрепче.';
}

function isMateMotif(m: MotifId | undefined): boolean {
  return m !== undefined && MATE_MOTIFS.includes(m);
}

/** Motif + side for a move that went wrong. Missed wins are told as "what you could have done". */
function negativeMotif(j: MoveJudgement): { motif: MotifId | undefined; side: 'allowed' | 'missed' | 'none' } {
  const preferMissed = j.classification === 'missedWin' || (isMateMotif(j.missedMotif) && !isMateMotif(j.allowedMotif));
  if (preferMissed && j.missedMotif) return { motif: j.missedMotif, side: 'missed' };
  if (j.allowedMotif) return { motif: j.allowedMotif, side: 'allowed' };
  if (j.missedMotif) return { motif: j.missedMotif, side: 'missed' };
  return { motif: undefined, side: 'none' };
}

/** How teachable a bad move is: concrete (motif / material) beats "the engine says −2". */
function teachingScore(j: MoveJudgement): number {
  const explainable = j.allowedMotif !== undefined || j.missedMotif !== undefined || j.materialLossPawns >= 2;
  return j.winPctLoss * (explainable ? 2 : 1);
}

function toKeyMoment(j: MoveJudgement, motif: MotifId | undefined, explanation: string): KeyMoment {
  const moment: KeyMoment = {
    ply: j.ply,
    fenBefore: j.fenBefore,
    playedSan: j.san,
    bestSan: j.bestSan,
    classification: j.classification,
    explanation,
  };
  if (motif) moment.motif = motif;
  return moment;
}

function pickKeyMoments(moves: MoveJudgement[], stage: number): KeyMoment[] {
  const negatives = moves
    .filter((j) => NEGATIVE_CLASSES.includes(j.classification))
    .filter((j) => j.classification !== 'inaccuracy' || stage >= INACCURACY_MOMENTS_FROM_STAGE)
    .sort((a, b) => teachingScore(b) - teachingScore(a) || a.ply - b.ply)
    .slice(0, MAX_NEGATIVE_MOMENTS)
    .map((j) => {
      const { motif, side } = negativeMotif(j);
      return toKeyMoment(j, motif, explainNegative(j, motif, side));
    });

  // One moment to be proud of: a best / excellent move that carried a recognisable idea.
  let positive: KeyMoment | undefined;
  for (const j of moves) {
    if (j.classification !== 'best' && j.classification !== 'excellent') continue;
    let motif: MotifId | undefined;
    try {
      motif = describeMotif(j.fenBefore, [j.uci, ...j.refutationPvUci])?.motif;
    } catch {
      motif = undefined;
    }
    if (!motif) continue;
    const candidate = toKeyMoment(j, motif, FOUND_RU[motif] ?? 'Отличный ход — лучший в этой позиции!');
    // Prefer mates, otherwise the first find of the game.
    if (!positive || (isMateMotif(motif) && !isMateMotif(positive.motif))) positive = candidate;
  }

  return [...negatives, ...(positive ? [positive] : [])].sort((a, b) => a.ply - b.ply);
}

function rankMotifs(motifs: MotifId[]): MotifId[] {
  const count = new Map<MotifId, number>();
  for (const m of motifs) count.set(m, (count.get(m) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

/**
 * Summary of one game from the child's judgements and the event journal.
 *
 *  - `accuracy` (lichess game accuracy, one decimal), `acpl` (mean centipawn loss with evals
 *    capped at ±1000, integer), `counts` and `keyMoments` use only the moves that stayed on the
 *    board: when a ply was judged more than once (take-back → retry) the last judgement wins.
 *  - `motifsAllowed` / `motifsMissed` look at ALL judgements, including taken-back attempts (the
 *    idea was still overlooked), most frequent first.
 *  - `takebacksOffered` / `takebacksAccepted` / `hintsUsed` are counted from the events
 *    (`hintGiven`, falling back to `hintRequested` when the journal has no `hintGiven` at all).
 *    A take-back the child asked for («Вернуть ход», `data.voluntary`) is not an accepted OFFER.
 *  - `keyMoments`: up to 3 instructive errors (win% loss, doubled when the reason is concrete:
 *    a motif or ≥ 2 pawns lost; an `inaccuracy` only from stage 5 — `stage` defaults to 1) plus at most one proud moment (a best/excellent move that carried
 *    a recognised motif), ordered by ply. Explanations are short, Russian, never blaming, and
 *    contain no move notation.
 */
export function summarizeGame(args: { judgements: MoveJudgement[]; events: GameEvent[]; openingName?: string; stage?: number }): GameSummary {
  const { judgements, events } = args;
  const moves = finalJudgements(judgements);

  const counts: Record<MoveClass, number> = { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, missedWin: 0 };
  let cpLossTotal = 0;
  for (const j of moves) {
    counts[j.classification] += 1;
    cpLossTotal += Math.max(0, scoreToCp(j.evalBefore) - scoreToCp(j.evalAfter));
  }

  const countEvents = (type: GameEvent['type']): number => events.filter((e) => e.type === type).length;
  const hintsGiven = countEvents('hintGiven');

  const wentWrong = judgements.filter((j) => NEGATIVE_CLASSES.includes(j.classification));
  const summary: GameSummary = {
    accuracy: Math.round(gameAccuracy(moves) * 10) / 10,
    acpl: moves.length > 0 ? Math.round(cpLossTotal / moves.length) : 0,
    counts,
    takebacksOffered: countEvents('takebackOffered'),
    takebacksAccepted: events.filter((e) => e.type === 'takebackAccepted' && e.data.voluntary !== true).length,
    hintsUsed: hintsGiven > 0 ? hintsGiven : countEvents('hintRequested'),
    motifsMissed: rankMotifs(wentWrong.flatMap((j) => (j.missedMotif ? [j.missedMotif] : []))),
    motifsAllowed: rankMotifs(wentWrong.flatMap((j) => (j.allowedMotif ? [j.allowedMotif] : []))),
    keyMoments: pickKeyMoments(moves, args.stage ?? 1),
  };
  if (args.openingName !== undefined) summary.openingName = args.openingName;
  return summary;
}

// ───────────────────────── take-backs ─────────────────────────

/** What became of one take-back: did the child really find something else — and something better? */
export interface TakebackOutcome {
  ply: number;
  /** the move that was taken back */
  attemptUci: string;
  attemptSan: string;
  /** the child asked for it («Вернуть ход») — it was not the coach's offer */
  voluntary: boolean;
  /** the move that finally stayed on the board at this ply (undefined: the game ended first, or it was never judged) */
  finalUci?: string;
  finalSan?: string;
  /** both the attempt and the final move were judged, so `changed` / `improved` are facts */
  known: boolean;
  /** a different move stayed on the board */
  changed: boolean;
  /** …and it lost fewer win% than the attempt: only then may anyone say «нашёл лучше» */
  improved: boolean;
}

/**
 * Pairs every `takebackAccepted` event with the judgement of the attempt and of the move that
 * stayed on the board at the same ply (`judgements` in journal order: attempts before the final
 * move). "Code proves": praise for «вернул ход и нашёл лучше» needs `improved`, not the button.
 */
export function takebackOutcomes(judgements: readonly MoveJudgement[], events: readonly GameEvent[]): TakebackOutcome[] {
  const out: TakebackOutcome[] = [];
  for (const event of events) {
    if (event.type !== 'takebackAccepted' || event.ply === undefined) continue;
    const attemptUci = typeof event.data.uci === 'string' ? event.data.uci : '';
    const attemptSan = typeof event.data.san === 'string' ? event.data.san : '';
    const atPly = judgements.filter((j) => j.ply === event.ply);
    const attempt = atPly.find((j) => j.uci === attemptUci);
    const final = atPly[atPly.length - 1];
    const outcome: TakebackOutcome = { ply: event.ply, attemptUci, attemptSan, voluntary: event.data.voluntary === true, known: false, changed: false, improved: false };
    if (attempt && final && final !== attempt) {
      outcome.finalUci = final.uci;
      outcome.finalSan = final.san;
      outcome.known = true;
      outcome.changed = final.uci !== attempt.uci;
      outcome.improved = outcome.changed && final.winPctLoss < attempt.winPctLoss;
    }
    out.push(outcome);
  }
  return out;
}
