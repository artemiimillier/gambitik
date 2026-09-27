/**
 * Small text helpers for the markdown files: quality marks, labels, dates. Russian move notation
 * and the child's-eye game outcome come from @gambit/core — one implementation for the coach
 * bubbles, the reviews and the journals.
 */
import { childOutcome, sanToBubbleRu } from '@gambit/core';
import type { ChildOutcome } from '@gambit/core';
import type { Color, MoveClass, MoveJudgement, Termination } from '@gambit/shared';

export { childOutcome };
export type { ChildOutcome };

/** What a SAN string can consist of; anything else is client-supplied garbage and is rendered as inert text. */
export const SAN_RE = /^[A-Za-z0-9+#=-]{1,12}$/;

/** 'Nf3' → 'Кf3', 'exd8=Q+' → 'exd8=Ф+', 'O-O' → '0-0'; pawn moves stay as they are. */
export function sanToRu(san: string): string {
  if (!SAN_RE.test(san)) return mdInline(san).replace(/[`<>]/g, '').slice(0, 16);
  return sanToBubbleRu(san);
}

export function pvToRu(pv: readonly string[], limit = 6): string {
  return pv.slice(0, limit).map(sanToRu).join(' ');
}

/** Motifs that take more than a one-move look to find — a best move realising one earns '!!'. */
const DEEP_MOTIFS = new Set(['mateIn2', 'mateIn3', 'discoveredAttack', 'doubleCheck', 'removeDefender', 'trappedPiece', 'skewer']);

/**
 * Annotation mark of a judged move:
 *   ?? blunder · ? mistake / missed win · ?! inaccuracy ·
 *   !  best/excellent move that realises a tactical motif (or that the coach praised) ·
 *   !! best move that realises a deeper motif (mate in 2–3, discovered attack, double check, …).
 * Ordinary good moves carry no mark, as in a normal annotated game.
 */
export function qualityMark(j: Pick<MoveJudgement, 'classification' | 'missedMotif'>, praised = false): '' | '!!' | '!' | '?!' | '?' | '??' {
  switch (j.classification) {
    case 'blunder':
      return '??';
    case 'mistake':
    case 'missedWin':
      return '?';
    case 'inaccuracy':
      return '?!';
    case 'best':
      if (j.missedMotif !== undefined && DEEP_MOTIFS.has(j.missedMotif)) return '!!';
      return j.missedMotif !== undefined || praised ? '!' : '';
    case 'excellent':
      return j.missedMotif !== undefined || praised ? '!' : '';
    case 'good':
      return '';
  }
}

export const MOVE_CLASS_RU: Record<MoveClass, string> = {
  best: 'лучший ход',
  excellent: 'отличный ход',
  good: 'хороший ход',
  inaccuracy: 'неточность',
  mistake: 'ошибка',
  blunder: 'зевок',
  missedWin: 'упущенный выигрыш',
};

export const TERMINATION_RU: Record<Termination, string> = {
  checkmate: 'мат',
  resign: 'сдача',
  timeout: 'закончилось время',
  stalemate: 'пат',
  draw: 'ничья',
  abandoned: 'партия прервана',
};

export const OUTCOME_RU: Record<ChildOutcome, string> = {
  win: 'победа',
  loss: 'поражение',
  draw: 'ничья',
  unfinished: 'не доиграна',
};

export const COLOR_RU: Record<Color, string> = { w: 'белые', b: 'чёрные' };

const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** '21 сентября 2026, 17:42' in the machine's local time zone. */
export function formatDateTimeRu(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${d.getDate()} ${MONTHS_GENITIVE[d.getMonth()] ?? ''} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** '21.09.2026' in local time. */
export function formatDateShortRu(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** ms since game start → 'mm:ss' */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/** ISO 8601 with the local UTC offset, e.g. 2026-09-21T17:42:10+03:00 */
export function toLocalIso(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/**
 * Escapes text for a markdown table cell / inline use. HTML comments are neutralised too, so no
 * client- or LLM-supplied text can smuggle one of the block markers into a file.
 */
export function mdInline(text: string): string {
  return text
    .replace(/\r?\n+/g, ' ')
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '--&gt;')
    .replace(/\|/g, '\\|')
    .trim();
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Full move number of a 1-based ply. */
export function moveNumberOfPly(ply: number): number {
  return Math.max(1, Math.ceil(ply / 2));
}

/** Russian plural: pluralRu(4, 'ход', 'хода', 'ходов') → '4 хода'. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${n} ${word}`;
}
