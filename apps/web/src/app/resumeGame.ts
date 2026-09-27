/**
 * «Продолжить партию» on the home screen: is there an interrupted game the child can go on with?
 *
 * The snapshot itself belongs to the game module (features/game/resume.ts — «STABLE PATH for the shell»:
 * `resumableGameInfo()`). The shell loads it lazily and defensively: a missing module, a changed export or a
 * broken snapshot only means «no tile» — home must open no matter what.
 */
import { PERSONA_IDS, TIME_CONTROL_IDS } from '@gambit/shared';
import type { CoachStyle, PersonaId, TimeControlId } from '@gambit/shared';
import { isCoachStyle, playRoute } from './router.ts';
import type { PlayRoute } from './router.ts';

export interface ResumeTile {
  /** where a tap leads: the same #/play link the game was started with — the game screen then offers to continue */
  route: PlayRoute;
  personaId: PersonaId;
  /** full moves already played (at least 1) */
  movesPlayed: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPersonaId(value: unknown): value is PersonaId {
  return PERSONA_IDS.some((id) => id === value);
}

function isTimeControlId(value: unknown): value is TimeControlId {
  return TIME_CONTROL_IDS.some((id) => id === value);
}

/**
 * The style the interrupted game was played with: the snapshot's own `coachStyle` (teacher mode, §7.5), else — a
 * snapshot from before teacher mode — derived from `examMode` (true → «Экзамен», otherwise «Подсказчик», which is
 * what those games were). `playRoute` then keeps it only if the time control offers it.
 */
function resumedCoachStyle(config: Record<string, unknown>): CoachStyle {
  if (isCoachStyle(config.coachStyle)) return config.coachStyle;
  return config.examMode === true ? 'exam' : 'helper';
}

/** Pure: whatever the game module reported → a validated tile, or null. */
export function resumeTileFrom(info: unknown): ResumeTile | null {
  if (!isObject(info)) return null;
  const config = isObject(info.config) ? info.config : info;
  if (!isPersonaId(config.personaId) || !isTimeControlId(config.timeControlId)) return null;
  const plies = typeof info.moveCount === 'number' && Number.isFinite(info.moveCount) ? info.moveCount : 0;
  if (plies < 1) return null; // nothing was played yet: a fresh game is the same thing
  return {
    route: playRoute({
      personaId: config.personaId,
      timeControlId: config.timeControlId,
      childColor: config.childColor === 'b' ? 'b' : 'w',
      coachStyle: resumedCoachStyle(config),
    }),
    personaId: config.personaId,
    movesPlayed: Math.max(1, Math.ceil(plies / 2)),
  };
}

type ResumeModule = Record<string, unknown>;

/** Never rejects. `load` is injectable for tests; the app imports the game module's resume file. */
export async function loadResumeTile(load: () => Promise<ResumeModule> = () => import('../features/game/resume.ts') as Promise<ResumeModule>): Promise<ResumeTile | null> {
  try {
    const module = await load();
    const report = module.resumableGameInfo;
    if (typeof report !== 'function') return null;
    return resumeTileFrom((report as () => unknown)());
  } catch {
    return null;
  }
}
