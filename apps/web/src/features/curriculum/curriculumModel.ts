/**
 * Pure helpers of the «Путь пешки» screen: where a stage is relative to the child, how far the
 * numeric mastery criteria are, which themes can be drilled and the example lines of concept cards.
 */
import { Chess } from 'chess.js';
import type { Color, CurriculumStage, ProgressSnapshot } from '@gambit/shared';
import { applyUci } from '../puzzles/puzzleLine.ts';
import type { AppliedMove } from '../puzzles/puzzleLine.ts';

export type StageState = 'done' | 'current' | 'ahead';

export function stageState(stage: number, current: number): StageState {
  if (stage < current) return 'done';
  return stage === current ? 'current' : 'ahead';
}

/** Same window as the server's stage suggestion: the mean over the last five games. */
export const MASTERY_GAMES_WINDOW = 5;
/** The server also wants at least this many rated puzzles before it trusts the puzzle rating. */
export const MASTERY_MIN_PUZZLE_ATTEMPTS = 10;

export interface Criterion {
  id: 'puzzleRating' | 'blunders' | 'accuracy';
  /** kid-friendly name of the goal */
  label: string;
  /** e.g. «900 и выше» */
  target: string;
  /** e.g. «сейчас 742», null when there is nothing to measure yet */
  current: string | null;
  /** 0..100 for the progress bar */
  pct: number;
  met: boolean;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function pct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatOneDecimal(value: number): string {
  return (Math.round(value * 10) / 10).toString().replace('.', ',');
}

/**
 * Progress towards the numeric mastery criteria of a stage, from the child's own numbers.
 * It mirrors the server's promotion rule but is only a DISPLAY: the server decides the stage.
 */
export function masteryCriteria(stage: Pick<CurriculumStage, 'mastery'>, snapshot: Pick<ProgressSnapshot, 'profile' | 'games'>): Criterion[] {
  const { minPuzzleRating, maxBlundersPerGame, minAccuracy } = stage.mastery;
  const recent = [...snapshot.games].sort((a, b) => a.date.localeCompare(b.date)).slice(-MASTERY_GAMES_WINDOW);
  const out: Criterion[] = [];

  if (minPuzzleRating !== undefined) {
    const skill = snapshot.profile.puzzleRating;
    const hasData = skill.attempts > 0;
    const baseline = Math.max(0, minPuzzleRating - 500);
    out.push({
      id: 'puzzleRating',
      label: 'Рейтинг в задачах',
      target: `${minPuzzleRating} и выше`,
      current: hasData ? `сейчас ${Math.round(skill.rating)}` : null,
      pct: hasData ? pct(((skill.rating - baseline) / (minPuzzleRating - baseline)) * 100) : 0,
      met: skill.attempts >= MASTERY_MIN_PUZZLE_ATTEMPTS && skill.rating >= minPuzzleRating,
    });
  }

  if (maxBlundersPerGame !== undefined) {
    const avg = mean(recent.map((g) => g.blunders));
    out.push({
      id: 'blunders',
      label: 'Зевков за партию',
      target: `не больше ${formatOneDecimal(maxBlundersPerGame)}`,
      current: avg !== null ? `сейчас ${formatOneDecimal(avg)}` : null,
      pct: avg === null ? 0 : avg <= maxBlundersPerGame ? 100 : pct((maxBlundersPerGame / avg) * 100),
      met: avg !== null && recent.length >= MASTERY_GAMES_WINDOW && avg <= maxBlundersPerGame,
    });
  }

  if (minAccuracy !== undefined) {
    const avg = mean(recent.map((g) => g.accuracy));
    out.push({
      id: 'accuracy',
      label: 'Точность ходов',
      target: `${Math.round(minAccuracy)}% и выше`,
      current: avg !== null ? `сейчас ${Math.round(avg)}%` : null,
      pct: avg === null ? 0 : pct((avg / minAccuracy) * 100),
      met: avg !== null && recent.length >= MASTERY_GAMES_WINDOW && avg >= minAccuracy,
    });
  }
  return out;
}

/** Overall 0..100 progress of a stage for the small ring on the path: the mean of its criteria. */
export function stageProgressPct(criteria: readonly Criterion[]): number {
  const avg = mean(criteria.map((c) => (c.met ? 100 : c.pct)));
  return avg === null ? 0 : Math.round(avg);
}

export interface DrillTheme {
  theme: string;
  title: string;
  /** the child's rating in this theme, when there is one */
  rating: number | null;
}

/** Themes of a stage that make sense as a puzzle session (pseudo / unsuitable tags are skipped). */
export function drillThemes(
  stage: Pick<CurriculumStage, 'puzzleThemes'>,
  titles: Readonly<Record<string, string>>,
  notForDrill: readonly string[],
  themeSkills: ProgressSnapshot['profile']['themeSkills'] | undefined,
): DrillTheme[] {
  const seen = new Set<string>();
  const out: DrillTheme[] = [];
  for (const theme of stage.puzzleThemes) {
    if (seen.has(theme) || notForDrill.includes(theme) || !/^[A-Za-z0-9]+$/.test(theme)) continue;
    seen.add(theme);
    const skill = themeSkills && Object.hasOwn(themeSkills, theme) ? themeSkills[theme] : undefined;
    out.push({ theme, title: Object.hasOwn(titles, theme) ? (titles[theme] ?? theme) : theme, rating: skill && skill.attempts > 0 ? Math.round(skill.rating) : null });
  }
  return out;
}

/** The SAN line of a concept-card example, applied move by move. Stops silently at the first move that does not fit. */
export function exampleLine(fen: string, solutionSan: readonly string[]): AppliedMove[] {
  const out: AppliedMove[] = [];
  let current = fen;
  for (const san of solutionSan) {
    let uci: string;
    try {
      const move = new Chess(current).move(san);
      uci = `${move.from}${move.to}${move.promotion ?? ''}`;
    } catch {
      break;
    }
    const applied = applyUci(current, uci);
    if (!applied) break;
    out.push(applied);
    current = applied.fenAfter;
  }
  return out;
}

/** Zig-zag side of a stage card on wide screens. */
export function sideOf(index: number): 'left' | 'right' {
  return index % 2 === 0 ? 'left' : 'right';
}

// ───────────────────────── opening repertoire «по идеям» ─────────────────────────

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export interface RepertoireLineView {
  id: string;
  title: string;
  /** what the line is about — plain Russian, may be read aloud */
  idea: string;
  /** what to aim for once the model moves are over (newer content only) */
  nextIdea: string | null;
  /** the line shows a mistake to avoid, not a plan to follow */
  warning: boolean;
  /** the model moves from the initial position, already applied (never empty) */
  moves: AppliedMove[];
}

export interface RepertoireView {
  id: string;
  /** the colour the child plays in this part of the repertoire — the board is shown from this side */
  side: Color;
  title: string;
  against: string;
  fromStage: number;
  summary: string;
  keyIdeas: string[];
  watchOut: string[];
  lines: RepertoireLineView[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter((line) => line !== '') : [];
}

/**
 * The parts of the opening repertoire a stage shows: every entry taught from this stage or earlier.
 *
 * DEFENSIVE on purpose: `repertoire` is whatever @gambit/content exports today (the package is developed in
 * parallel). Anything that does not look like an entry, and every model line whose moves are not legal from
 * the initial position, is skipped silently — the screen then simply shows the one-line `openingFocus`.
 */
export function repertoireForStage(stage: number, repertoire: unknown): RepertoireView[] {
  if (!Array.isArray(repertoire)) return [];
  const out: RepertoireView[] = [];
  for (const raw of repertoire) {
    if (!isObject(raw)) continue;
    const id = text(raw.id);
    const title = text(raw.title);
    const fromStage = typeof raw.fromStage === 'number' && Number.isFinite(raw.fromStage) ? raw.fromStage : Number.NaN;
    if (id === '' || title === '' || Number.isNaN(fromStage) || fromStage > stage || !Array.isArray(raw.lines)) continue;

    const lines: RepertoireLineView[] = [];
    for (const rawLine of raw.lines) {
      if (!isObject(rawLine)) continue;
      const moves = exampleLine(START_FEN, texts(rawLine.movesSan));
      const lineTitle = text(rawLine.title);
      if (moves.length === 0 || lineTitle === '') continue;
      const nextIdea = text(rawLine.nextIdea);
      lines.push({ id: text(rawLine.id) || `${id}-${lines.length}`, title: lineTitle, idea: text(rawLine.idea), nextIdea: nextIdea === '' ? null : nextIdea, warning: rawLine.warning === true, moves });
    }
    if (lines.length === 0) continue;

    out.push({
      id,
      side: raw.side === 'b' ? 'b' : 'w',
      title,
      against: text(raw.against),
      fromStage,
      summary: text(raw.summary),
      keyIdeas: texts(raw.keyIdeas),
      watchOut: texts(raw.watchOut),
      lines,
    });
  }
  return out;
}
