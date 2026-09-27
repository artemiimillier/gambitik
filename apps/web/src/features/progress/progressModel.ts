/**
 * Pure data shaping for the progress dashboard (no React, no Recharts): chart rows, theme ranking,
 * trends and Russian number formatting.
 */
import type { Color, GameResult, PersonaId, ProgressSnapshot } from '@gambit/shared';

export const MAX_CHART_GAMES = 30;
export const MAX_RATING_POINTS = 60;
/** A theme needs a few attempts before we call it strong or weak. */
export const MIN_THEME_ATTEMPTS = 5;
export const THEME_MARGIN = 75;

function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export interface GameChartPoint {
  /** 1-based number of the game on the chart («партия 7») */
  n: number;
  gameId: string;
  dateLabel: string;
  accuracy: number;
  blunders: number;
  personaId: PersonaId;
  result: GameResult;
}

export function isGameChartPoint(value: unknown): value is GameChartPoint {
  return typeof value === 'object' && value !== null && 'gameId' in value && 'accuracy' in value && 'blunders' in value;
}

/** The last `limit` games, oldest first (the server already sends them oldest → newest). */
export function toGameChartData(games: ProgressSnapshot['games'], limit = MAX_CHART_GAMES): GameChartPoint[] {
  const sorted = [...games].sort((a, b) => a.date.localeCompare(b.date));
  const offset = Math.max(0, sorted.length - limit);
  return sorted.slice(offset).map((game, i) => ({
    n: offset + i + 1,
    gameId: game.gameId,
    dateLabel: shortDate(game.date),
    accuracy: Math.round(Math.max(0, Math.min(100, game.accuracy))),
    blunders: Math.max(0, Math.round(game.blunders)),
    personaId: game.personaId,
    result: game.result,
  }));
}

export interface RatingChartPoint {
  n: number;
  dateLabel: string;
  rating: number;
}

export function isRatingChartPoint(value: unknown): value is RatingChartPoint {
  return typeof value === 'object' && value !== null && 'rating' in value && 'dateLabel' in value;
}

/** Thins a long history to at most `limit` points, always keeping the first and the last one. */
export function toRatingChartData(history: ProgressSnapshot['puzzleRatingHistory'], limit = MAX_RATING_POINTS): RatingChartPoint[] {
  const sorted = [...history].filter((p) => Number.isFinite(p.rating)).sort((a, b) => a.date.localeCompare(b.date));
  const step = sorted.length > limit ? (sorted.length - 1) / (limit - 1) : 1;
  const picked = sorted.length > limit ? Array.from({ length: limit }, (_, i) => sorted[Math.round(i * step)]) : sorted;
  return picked.flatMap((point, i) => (point ? [{ n: i + 1, dateLabel: shortDate(point.date), rating: Math.round(point.rating) }] : []));
}

/** Clean y-axis bounds around the data, snapped to `step`. */
export function niceDomain(values: readonly number[], step = 50, pad = 25): [number, number] {
  if (values.length === 0) return [0, step];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const low = Math.floor((min - pad) / step) * step;
  const high = Math.ceil((max + pad) / step) * step;
  return [Math.max(0, low), high === low ? low + step : high];
}

export type Trend = 'up' | 'down' | 'flat' | 'none';

/** Average of the last `window` values against the `window` before them. */
export function trendOf(values: readonly number[], window = 5, tolerance = 2): Trend {
  if (values.length < 4) return 'none';
  const size = Math.min(window, Math.floor(values.length / 2));
  const avg = (list: readonly number[]) => list.reduce((sum, v) => sum + v, 0) / list.length;
  const recent = avg(values.slice(-size));
  const before = avg(values.slice(-2 * size, -size));
  if (recent - before > tolerance) return 'up';
  if (before - recent > tolerance) return 'down';
  return 'flat';
}

export function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

export type ThemeLevel = 'strong' | 'weak' | 'steady' | 'new';

export interface ThemeRow {
  theme: string;
  title: string;
  rating: number;
  attempts: number;
  solved: number;
  solvedPct: number;
  level: ThemeLevel;
  /** 0..100 — bar length on a common scale */
  bar: number;
}

/**
 * Themes sorted strongest first. 'strong' / 'weak' compare a theme with the child's OWN overall puzzle
 * rating (never with other children) and need MIN_THEME_ATTEMPTS attempts; fewer attempts = 'new'.
 */
export function rankThemes(table: ProgressSnapshot['themeTable'], overallRating: number): ThemeRow[] {
  const rated = table.filter((row) => row.attempts > 0 && Number.isFinite(row.rating));
  if (rated.length === 0) return [];
  const floor = Math.min(300, ...rated.map((row) => row.rating));
  const ceiling = Math.max(overallRating + 200, ...rated.map((row) => row.rating + 50));
  return rated
    .map((row): ThemeRow => {
      const level: ThemeLevel = row.attempts < MIN_THEME_ATTEMPTS ? 'new' : row.rating >= overallRating + THEME_MARGIN ? 'strong' : row.rating <= overallRating - THEME_MARGIN ? 'weak' : 'steady';
      return {
        theme: row.theme,
        title: row.title,
        rating: Math.round(row.rating),
        attempts: row.attempts,
        solved: row.solved,
        solvedPct: row.attempts > 0 ? Math.round((row.solved / row.attempts) * 100) : 0,
        level,
        bar: Math.max(4, Math.min(100, Math.round(((row.rating - floor) / (ceiling - floor)) * 100))),
      };
    })
    .sort((a, b) => b.rating - a.rating || b.attempts - a.attempts);
}

export const THEME_LEVEL_LABEL: Record<ThemeLevel, string> = {
  strong: 'получается',
  weak: 'потренировать',
  steady: 'ровно',
  new: 'мало задач',
};

/** «2 ч 15 мин», «40 мин», «меньше минуты». */
export function formatMinutesRu(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return 'меньше минуты';
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} мин`;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

export type ChildOutcome = 'win' | 'loss' | 'draw' | 'unfinished';

export function outcomeFor(result: GameResult, childColor: Color): ChildOutcome {
  if (result === '1/2-1/2') return 'draw';
  if (result === '*') return 'unfinished';
  return (result === '1-0') === (childColor === 'w') ? 'win' : 'loss';
}

export const OUTCOME_LABEL: Record<ChildOutcome, string> = { win: 'Победа', loss: 'Поражение', draw: 'Ничья', unfinished: 'Не доиграна' };

/** «21 сентября, 14:05» */
export function formatDateTimeRu(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}
