/**
 * Tiny typed hash router — pure part (no DOM): `Route` union, `parseHash`, `formatRoute`.
 * The DOM binding (`useRoute`, `navigate`) lives in navigation.ts.
 *
 *   #/                                   home
 *   #/new                                new-game wizard
 *   #/play?persona=&tc=&color=&coach=    live game; coach = teacher | helper | exam (docs/TEACHER-MODE.md §1.3)
 *                                        (a link's `exam=1` also means coach=exam; nothing = helper)
 *   #/review/:id                         post-game review
 *   #/puzzles[?theme=][&warmup=1]        puzzles (warmup = the three-puzzle «разминка» of the today plan)
 *   #/progress                           progress dashboard
 *   #/path                               curriculum «Путь пешки»
 *   #/settings                           settings
 *   #/playground[?tool=ui]               dev harnesses (lazy-loaded)
 *
 * Anything that does not parse falls back to a safe route (home, or the wizard for a broken
 * #/play link) — a child must never land on a dead end.
 */
import { coachStylesFor, defaultCoachStyle } from '@gambit/core';
import { PERSONA_IDS, TIME_CONTROL_IDS } from '@gambit/shared';
import type { CoachStyle, Color, PersonaId, TimeControlId } from '@gambit/shared';

export type PlaygroundTool = 'mascot' | 'ui';

export type Route =
  | { name: 'home' }
  | { name: 'new' }
  | {
      name: 'play';
      personaId: PersonaId;
      timeControlId: TimeControlId;
      childColor: Color;
      /** how Гамбитик helps in this game; always one the time control offers (see `allowedCoachStyle`) */
      coachStyle: CoachStyle;
      /** derived: `coachStyle === 'exam'` (kept for the GameScreen prop and older readers) */
      examMode: boolean;
    }
  | { name: 'review'; gameId: string }
  | { name: 'puzzles'; theme?: string; warmup?: boolean }
  | { name: 'progress' }
  | { name: 'path' }
  | { name: 'settings' }
  | { name: 'playground'; tool: PlaygroundTool };

export type RouteName = Route['name'];
export type PlayRoute = Extract<Route, { name: 'play' }>;

export const HOME_ROUTE: Route = { name: 'home' };

// ───────────────────────── coach style (docs/TEACHER-MODE.md §1.2–§1.3) ─────────────────────────

export const COACH_STYLES: readonly CoachStyle[] = ['teacher', 'helper', 'exam'];

/**
 * The stage a link or a snapshot without a known stage is judged at when its style is not offered: 5, explicitly
 * (docs/TEACHING.md §2.10 — a fixed value, independent of TEACHER_DEFAULT_MAX_STAGE). With the current table every such
 * fallback is 'helper' anyway: training, 10 and 5 minutes offer all three styles, and bullet offers none.
 */
export const ROUTER_UNKNOWN_STAGE = 5;
const UNKNOWN_STAGE = ROUTER_UNKNOWN_STAGE;

export function isCoachStyle(value: unknown): value is CoachStyle {
  return COACH_STYLES.some((style) => style === value);
}

/**
 * The style a game with this time control really runs: an offered style stays, anything else becomes
 * `defaultCoachStyle(tc, stage)`. Bullet offers none — the coach is silent there — and gets the harmless 'helper'
 * (never 'exam': a one-minute game is never an exam, so its links and records keep `examMode: false`).
 */
export function allowedCoachStyle(timeControlId: TimeControlId, style: CoachStyle, stage: number = UNKNOWN_STAGE): CoachStyle {
  return coachStylesFor(timeControlId).includes(style) ? style : defaultCoachStyle(timeControlId, stage);
}

/** A #/play route with a checked style and `examMode` derived from it. */
export function playRoute(a: { personaId: PersonaId; timeControlId: TimeControlId; childColor: Color; coachStyle: CoachStyle; stage?: number }): PlayRoute {
  const coachStyle = allowedCoachStyle(a.timeControlId, a.coachStyle, a.stage);
  return { name: 'play', personaId: a.personaId, timeControlId: a.timeControlId, childColor: a.childColor, coachStyle, examMode: coachStyle === 'exam' };
}

/** `coach=` wins; an old link's `exam=1` means «Экзамен»; nothing (or junk) means «Подсказчик», the behaviour before teacher mode. */
function coachStyleFromQuery(query: URLSearchParams): CoachStyle {
  const coach = query.get('coach');
  if (isCoachStyle(coach)) return coach;
  return query.get('exam') === '1' ? 'exam' : 'helper';
}

/** Same rule as the server's `?theme=` query validation: a lichess theme key. */
const THEME_PATTERN = /^[A-Za-z0-9]{1,40}$/;
const MAX_GAME_ID_LENGTH = 128;

function isPersonaId(value: string | null): value is PersonaId {
  return value !== null && PERSONA_IDS.some((id) => id === value);
}

function isTimeControlId(value: string | null): value is TimeControlId {
  return value !== null && TIME_CONTROL_IDS.some((id) => id === value);
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Returns a valid theme key or undefined (the puzzles screen then serves the adaptive mix). */
export function normalizeTheme(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return THEME_PATTERN.test(value) ? value : undefined;
}

/** Accepts `location.hash` in any shape: '', '#', '#/', '#/play?…', '/play', 'play'. */
export function parseHash(hash: string): Route {
  let rest = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryStart = rest.indexOf('?');
  const query = new URLSearchParams(queryStart === -1 ? '' : rest.slice(queryStart + 1));
  if (queryStart !== -1) rest = rest.slice(0, queryStart);
  const segments = rest.split('/').filter((segment) => segment !== '');
  const [head, second, ...extra] = segments;

  if (head === undefined) return HOME_ROUTE;

  switch (head) {
    case 'new':
      return second === undefined ? { name: 'new' } : HOME_ROUTE;

    case 'play': {
      if (second !== undefined) return HOME_ROUTE;
      const persona = query.get('persona');
      const timeControl = query.get('tc');
      // a broken or hand-edited link: let the child choose again instead of guessing
      if (!isPersonaId(persona) || !isTimeControlId(timeControl)) return { name: 'new' };
      return playRoute({
        personaId: persona,
        timeControlId: timeControl,
        childColor: query.get('color') === 'b' ? 'b' : 'w',
        coachStyle: coachStyleFromQuery(query),
      });
    }

    case 'review': {
      if (second === undefined || extra.length > 0) return HOME_ROUTE;
      const gameId = safeDecode(second);
      if (gameId === null || gameId.trim() === '' || gameId.length > MAX_GAME_ID_LENGTH) return HOME_ROUTE;
      return { name: 'review', gameId };
    }

    case 'puzzles': {
      if (second !== undefined) return HOME_ROUTE;
      const theme = normalizeTheme(query.get('theme'));
      return { name: 'puzzles', ...(theme === undefined ? {} : { theme }), ...(query.get('warmup') === '1' ? { warmup: true } : {}) };
    }

    case 'progress':
      return second === undefined ? { name: 'progress' } : HOME_ROUTE;

    case 'path':
      return second === undefined ? { name: 'path' } : HOME_ROUTE;

    case 'settings':
      return second === undefined ? { name: 'settings' } : HOME_ROUTE;

    case 'playground':
      if (second !== undefined) return HOME_ROUTE;
      return { name: 'playground', tool: query.get('tool') === 'ui' ? 'ui' : 'mascot' };

    default:
      return HOME_ROUTE;
  }
}

/** Canonical hash of a route; `parseHash(formatRoute(r))` deep-equals `r` for every valid route. */
export function formatRoute(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'new':
      return '#/new';
    case 'play': {
      const query = new URLSearchParams({
        persona: route.personaId,
        tc: route.timeControlId,
        color: route.childColor,
        coach: allowedCoachStyle(route.timeControlId, route.coachStyle),
      });
      return `#/play?${query.toString()}`;
    }
    case 'review':
      return `#/review/${encodeURIComponent(route.gameId)}`;
    case 'puzzles': {
      const query = new URLSearchParams();
      const theme = normalizeTheme(route.theme);
      if (theme !== undefined) query.set('theme', theme);
      if (route.warmup === true) query.set('warmup', '1');
      const search = query.toString();
      return search === '' ? '#/puzzles' : `#/puzzles?${search}`;
    }
    case 'progress':
      return '#/progress';
    case 'path':
      return '#/path';
    case 'settings':
      return '#/settings';
    case 'playground':
      return route.tool === 'ui' ? '#/playground?tool=ui' : '#/playground';
  }
}

/** True when both routes show the same screen with the same parameters. */
export function sameRoute(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}
