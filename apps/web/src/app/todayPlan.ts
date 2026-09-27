/**
 * «План на сегодня» — a soft, never blocking suggestion strip on the home screen
 * (research 05 / 08 §1.5): разминка задачами → партия → разбор. Pure logic, no DOM.
 *
 * Nothing is ever locked: every step can be opened at any time, the plan only marks what is
 * already done today and points at one next step. When all three are done the strip suggests a
 * natural stopping point instead of "one more".
 */
import type { GameListItem } from '@gambit/shared';
import type { Route } from './router.ts';
import { readJsonObject, writeJson } from './shellSettings.ts';
import type { KeyValueStorage } from './shellSettings.ts';

export type PlanStepId = 'warmup' | 'game' | 'review';

export interface PlanStep {
  id: PlanStepId;
  title: string;
  /** one short line for the child */
  hint: string;
  done: boolean;
  /** the single step Гамбитик points at; at most one step has it */
  suggested: boolean;
  /** where a tap leads; null = nothing to open yet (no game to review) */
  target: Route | null;
}

export interface TodayPlan {
  steps: PlanStep[];
  allDone: boolean;
  /** short line above the strip */
  headline: string;
}

/** The warm-up really is three puzzles (research 08 §1.5): that many open, that many tick the step. */
export const WARMUP_PUZZLES = 3;

export interface TodayPlanInput {
  now: Date;
  /** newest first, as returned by GET /games */
  games: readonly GameListItem[];
  /** ids of the games whose review was opened today (see the day log below) */
  reviewedToday: readonly string[];
  /** puzzles finished today on this computer (see the day log below) */
  puzzlesToday: number;
}

function warmupHint(puzzlesToday: number): string {
  const left = WARMUP_PUZZLES - puzzlesToday;
  if (left === 2) return 'Ещё две задачи для разгона';
  if (left === 1) return 'Ещё одна задача для разгона';
  return 'Три задачи для разгона';
}

/** Local calendar day, e.g. '2026-09-21'. */
export function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function isSameLocalDay(iso: string | null | undefined, now: Date): boolean {
  if (!iso) return false;
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && localDayKey(date) === localDayKey(now);
}

export function buildTodayPlan(input: TodayPlanInput): TodayPlan {
  const { now, games, reviewedToday } = input;
  const puzzlesToday = Number.isFinite(input.puzzlesToday) ? Math.max(0, Math.trunc(input.puzzlesToday)) : 0;
  const todaysGames = games.filter((game) => isSameLocalDay(game.startedAt, now));
  const latestToday = todaysGames[0];
  const latestAny = games[0];

  const warmupDone = puzzlesToday >= WARMUP_PUZZLES;
  const gameDone = latestToday !== undefined;
  const reviewDone = todaysGames.some((game) => reviewedToday.includes(game.id));
  const reviewGame = latestToday ?? latestAny;

  const steps: PlanStep[] = [
    {
      id: 'warmup',
      title: 'Разминка',
      hint: warmupHint(puzzlesToday),
      done: warmupDone,
      suggested: false,
      // a SHORT session: the plan promises three puzzles, not the standard ten
      target: { name: 'puzzles', warmup: true },
    },
    {
      id: 'game',
      title: 'Партия',
      hint: 'Сыграй с соперником',
      done: gameDone,
      suggested: false,
      target: { name: 'new' },
    },
    {
      id: 'review',
      title: 'Разбор',
      hint: reviewGame ? 'Посмотрим партию вместе' : 'Появится после партии',
      done: reviewDone,
      suggested: false,
      target: reviewGame ? { name: 'review', gameId: reviewGame.id } : null,
    },
  ];

  // the review is only worth suggesting once there is a game from today to look at
  const next = steps.find((step) => !step.done && step.target !== null && (step.id !== 'review' || gameDone));
  if (next) next.suggested = true;

  const allDone = steps.every((step) => step.done);
  const doneCount = steps.filter((step) => step.done).length;
  const headline = allDone
    ? 'На сегодня отлично! Продолжим завтра?'
    : doneCount === 0
      ? 'План на сегодня — можно начать с любого шага'
      : 'План на сегодня — уже кое-что сделано!';

  return { steps, allDone, headline };
}

// ───────────────────────── day log (what was done today on this computer) ─────────────────────────

export const DAY_LOG_STORAGE_KEY = 'gambit.day';
const MAX_REVIEWED_IDS = 50;

export interface DayLog {
  day: string;
  reviewed: string[];
  /** puzzles finished today (solved or shown) */
  puzzles: number;
}

export function loadDayLog(storage: KeyValueStorage | null, now: Date): DayLog {
  const day = localDayKey(now);
  const raw = readJsonObject(storage, DAY_LOG_STORAGE_KEY);
  if (raw.day !== day) return { day, reviewed: [], puzzles: 0 };
  const reviewed = Array.isArray(raw.reviewed) ? raw.reviewed.filter((id): id is string => typeof id === 'string').slice(-MAX_REVIEWED_IDS) : [];
  const puzzles = typeof raw.puzzles === 'number' && Number.isInteger(raw.puzzles) && raw.puzzles > 0 ? Math.min(raw.puzzles, 10_000) : 0;
  return { day, reviewed, puzzles };
}

/** Remembers that the review of `gameId` was opened today; yesterday's entries are dropped. */
export function markReviewedToday(storage: KeyValueStorage | null, gameId: string, now: Date): DayLog {
  const log = loadDayLog(storage, now);
  if (log.reviewed.includes(gameId)) return log;
  const next: DayLog = { ...log, reviewed: [...log.reviewed, gameId].slice(-MAX_REVIEWED_IDS) };
  writeJson(storage, DAY_LOG_STORAGE_KEY, next);
  return next;
}

/** One more puzzle was finished today; yesterday's count is dropped. */
export function notePuzzleDoneToday(storage: KeyValueStorage | null, now: Date): DayLog {
  const log = loadDayLog(storage, now);
  const next: DayLog = { ...log, puzzles: log.puzzles + 1 };
  writeJson(storage, DAY_LOG_STORAGE_KEY, next);
  return next;
}
