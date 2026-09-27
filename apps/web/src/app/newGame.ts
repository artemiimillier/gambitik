/**
 * New-game wizard — pure logic and copy (the view is NewGame.tsx).
 * Three taps: time control → opponent → colour, then #/play. Step 3 also shows «Как помогает Гамбитик?»
 * (Учитель / Подсказчик / Экзамен, docs/TEACHER-MODE.md §1.3) with the right style already picked.
 */
import { PERSONA_ORDER, getCurriculumStage } from '@gambit/content';
import { coachStylesFor, defaultCoachStyle } from '@gambit/core';
import { TIME_CONTROLS, TIME_CONTROL_IDS } from '@gambit/shared';
import type { CoachStyle, Color, PersonaId, TimeControl, TimeControlId } from '@gambit/shared';
import type { ShellLine } from '../coach/clips/shellTwin.ts';
import { isCoachStyle, playRoute } from './router.ts';
import type { PlayRoute } from './router.ts';
import { readJsonObject, writeJson } from './shellSettings.ts';
import type { KeyValueStorage } from './shellSettings.ts';

export type WizardStep = 'time' | 'opponent' | 'color';
export type ColorChoice = Color | 'random';

export interface TimeControlCard {
  control: TimeControl;
  title: string;
  /** kid-friendly line: what the game feels like and how much Гамбитик helps */
  subtitle: string;
  icon: string;
  accent: 'coral' | 'sunny' | 'green' | 'blue';
  /** small corner label */
  badge?: { text: string; tone: 'coral' | 'teal' };
}

const TIME_CONTROL_COPY: Record<TimeControlId, Omit<TimeControlCard, 'control'>> = {
  bullet1: {
    title: '1 минута',
    // say plainly what he does in a 1-minute game — hello, then the talk after it
    subtitle: 'Молния! Гамбитик поздоровается, а поговорим после',
    icon: '🚀',
    accent: 'coral',
    badge: { text: 'без подсказок', tone: 'coral' },
  },
  // «Учитель» works here too: the child's clock stands while Гамбитик speaks
  blitz5: { title: '5 минут', subtitle: 'Быстрая игра. Пока Гамбитик учит, часы стоят', icon: '⚡', accent: 'sunny' },
  rapid10: {
    title: '10 минут',
    subtitle: 'Спокойная игра. Гамбитик может быть учителем',
    icon: '🐢',
    accent: 'green',
    badge: { text: 'Гамбитик советует', tone: 'teal' },
  },
  training: { title: 'Без часов', subtitle: 'Думай сколько хочешь — Гамбитик научит', icon: '🌱', accent: 'blue' },
};

/** The four tiles in the order of contracts.ts (fastest → calmest). */
export const TIME_CONTROL_CARDS: readonly TimeControlCard[] = TIME_CONTROL_IDS.map((id) => ({ control: TIME_CONTROLS[id], ...TIME_CONTROL_COPY[id] }));

// ───────────────────────── «Как помогает Гамбитик?» (TEACHER-MODE §1.2–§1.3) ─────────────────────────

export interface CoachStyleTile {
  style: CoachStyle;
  icon: string;
  title: string;
  /** what the child gets, in a few words */
  subtitle: string;
  /** one longer line under the tiles for the chosen style (parents and readers) */
  hint: string;
  accent: 'green' | 'sunny' | 'coral';
}

const COACH_STYLE_COPY: Record<CoachStyle, Omit<CoachStyleTile, 'style'>> = {
  teacher: {
    icon: '🎓',
    title: 'Учитель',
    subtitle: 'Объясняет каждый ход и показывает хорошие ходы',
    hint: 'Гамбитик покажет стрелками хорошие ходы и скажет почему. Выбираешь ты.',
    accent: 'green',
  },
  helper: {
    icon: '💡',
    title: 'Подсказчик',
    subtitle: 'Помогает, когда попросишь',
    hint: 'Думаешь сам, а Гамбитик поможет, если нажмёшь «Подсказку» или спросишь.',
    accent: 'sunny',
  },
  exam: {
    icon: '🏆',
    title: 'Экзамен',
    // a no-break space keeps the dash at the end of the first line when the tile wraps (never «— играешь сам» alone)
    subtitle: 'Без подсказок — играешь сам',
    hint: 'Гамбитик молчит всю партию, а потом разберём её вместе.',
    accent: 'coral',
  },
};

/** The style tiles a time control offers, in wizard order; none for bullet (Гамбитик only greets there). */
export function coachStyleTiles(timeControlId: TimeControlId): CoachStyleTile[] {
  return coachStylesFor(timeControlId).map((style) => ({ style, ...COACH_STYLE_COPY[style] }));
}

export function coachStyleTile(style: CoachStyle): CoachStyleTile {
  return { style, ...COACH_STYLE_COPY[style] };
}

/** Is there anything to choose on step 3? (Bullet: no — `BULLET_COACH_NOTE` instead.) */
export function coachStyleChoiceAvailable(timeControlId: TimeControlId): boolean {
  return coachStylesFor(timeControlId).length > 0;
}

/**
 * Step 3 of a 1-minute game, instead of the style tiles: what Гамбитик does there, and where the teacher is, said
 * plainly.
 */
export const BULLET_COACH_NOTE = 'В молнии Гамбитик только поздоровается, а поговорим после партии. «Учитель» есть в играх на 5 и 10 минут и «Без часов».';

/** localStorage: `{ [timeControlId]: { style, at } }` — the last choice per time control (`at` = ISO time). */
export const COACH_STYLE_STORAGE_KEY = 'gambit.coachStyle';
/** A remembered choice older than this is forgotten: the child has grown, the stage default knows better. */
export const COACH_STYLE_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;
/** A timestamp this far in the future is a broken clock, not a choice. */
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

function timestampOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The remembered style for this time control: only when it is fresh (< 30 days) and still offered there. */
export function rememberedCoachStyle(storage: KeyValueStorage | null, timeControlId: TimeControlId, now: number): CoachStyle | null {
  const entry = readJsonObject(storage, COACH_STYLE_STORAGE_KEY)[timeControlId];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const { style, at } = entry as Record<string, unknown>;
  if (!isCoachStyle(style) || !coachStylesFor(timeControlId).includes(style)) return null;
  const savedAt = timestampOf(at);
  if (savedAt === null) return null;
  const age = now - savedAt;
  return age < COACH_STYLE_MEMORY_MS && age > -CLOCK_SKEW_MS ? style : null;
}

/**
 * Remembers the choice for this time control (read-modify-write: the other time controls keep theirs).
 *
 * With `stage`, a choice equal to the stage default is stored as «follow the default» (the entry is removed): the
 * next wizard preselects the same tile either way, but when the stage grows past 4 the §1.2 default («Подсказчик»)
 * can take over — a stored copy of the earlier stage's default, refreshed by every game, would keep «Учитель» for good.
 */
export function rememberCoachStyle(storage: KeyValueStorage | null, timeControlId: TimeControlId, style: CoachStyle, now: number, stage?: number): boolean {
  if (!coachStylesFor(timeControlId).includes(style)) return false;
  const all = readJsonObject(storage, COACH_STYLE_STORAGE_KEY);
  if (stage !== undefined && style === defaultCoachStyle(timeControlId, stage)) {
    if (!(timeControlId in all)) return true;
    delete all[timeControlId];
  } else {
    all[timeControlId] = { style, at: new Date(now).toISOString() };
  }
  return writeJson(storage, COACH_STYLE_STORAGE_KEY, all);
}

/**
 * The preselected tile: the remembered choice for this time control, otherwise the stage default of §1.2
 * («Учитель» in training, 10 and 5 minutes up to stage 4, «Подсказчик» from stage 5).
 */
export function initialCoachStyle(timeControlId: TimeControlId, stage: number, storage: KeyValueStorage | null, now: number): CoachStyle {
  return rememberedCoachStyle(storage, timeControlId, now) ?? defaultCoachStyle(timeControlId, stage);
}

/** Personas recommended for the child's current curriculum stage («в самый раз»). */
export function recommendedPersonaIds(stage: number): PersonaId[] {
  return [...getCurriculumStage(stage).recommendedPersonas];
}

/** 1-based rung on the ladder of eight bots (strength dots). */
export function personaRung(personaId: PersonaId): number {
  return PERSONA_ORDER.indexOf(personaId) + 1;
}

/** A bot three or more rungs above the strongest recommended one: allowed, but Гамбитик sets a gentler goal. */
export function isStretchOpponent(personaId: PersonaId, stage: number): boolean {
  const recommended = recommendedPersonaIds(stage);
  if (recommended.length === 0) return false;
  const top = Math.max(...recommended.map(personaRung));
  return personaRung(personaId) - top >= 3;
}

export function resolveColor(choice: ColorChoice, rng: () => number = Math.random): Color {
  if (choice === 'random') return rng() < 0.5 ? 'w' : 'b';
  return choice;
}

export interface WizardSelection {
  timeControlId: TimeControlId;
  personaId: PersonaId;
  color: ColorChoice;
  coachStyle: CoachStyle;
  /** the child's curriculum stage: picks the default when `coachStyle` is not offered for this time control */
  stage?: number;
}

/**
 * The colour is resolved HERE, so a reload of #/play never re-rolls «сюрприз». A style the time control does not
 * offer (anything in bullet) becomes `defaultCoachStyle(tc, stage)`; `examMode` is derived.
 */
export function playRouteFor(selection: WizardSelection, rng: () => number = Math.random): PlayRoute {
  return playRoute({
    personaId: selection.personaId,
    timeControlId: selection.timeControlId,
    childColor: resolveColor(selection.color, rng),
    coachStyle: selection.coachStyle,
    stage: selection.stage ?? 1,
  });
}

export function previousStep(step: WizardStep): WizardStep | null {
  if (step === 'color') return 'opponent';
  if (step === 'opponent') return 'time';
  return null;
}

export const WIZARD_TITLES: Record<WizardStep, { title: string; subtitle: string }> = {
  time: { title: 'Сколько играем?', subtitle: 'Шаг 1 из 3' },
  opponent: { title: 'С кем играем?', subtitle: 'Шаг 2 из 3' },
  color: { title: 'Каким цветом?', subtitle: 'Шаг 3 из 3' },
};

// ───────────────────────── spoken guidance ─────────────────────────

/**
 * For a child who does not read yet the spoken explanation IS the interface, so the wizard's guidance is a
 * normal phrase (priority 1: queued behind the home greeting, never silently dropped like priority-0 chatter)
 * — and at most ONE phrase per wizard step, so nothing piles up when the child taps quickly.
 */
export interface WizardPhrase {
  kind: 'encourage';
  priority: 1;
  pose: 'talk' | 'think';
  text: string;
  /**
   * «Дозапись голоса»: the catalogue's `shell.*` lines that say exactly `text`, one per sentence (its clip twin — «Записи»
   * says it and records it on first use). Absent: a phrase with a name in it (the opponent's) is never recorded.
   */
  lines?: ShellLine[];
}

/** Step 1: two sentences, one catalogue line each — the second is shared with the 1-minute step 3. */
export function timeStepPhrase(): WizardPhrase {
  return {
    kind: 'encourage',
    priority: 1,
    pose: 'talk',
    text: 'Сколько будем играть? В молнии я только поздороваюсь. Учить могу на пяти, десяти минутах и без часов.',
    lines: [{ line: 'shell.wizard.time' }, { line: 'shell.wizard.teachTimes' }],
  };
}

export function stretchOpponentPhrase(personaName: string): WizardPhrase {
  return { kind: 'encourage', priority: 1, pose: 'think', text: `${personaName} играет очень сильно. Попробуем продержаться двадцать ходов?` };
}

/** Step 3 of a 1-minute game, said aloud (a non-reader does not read `BULLET_COACH_NOTE`). */
export const BULLET_COACH_PHRASE = 'В молнии я только поздороваюсь, а поговорим после партии. Учить могу на пяти, десяти минутах и без часов.';

/**
 * Step 3, «Как помогает Гамбитик?» — the one place of the wizard where he offers to be the teacher (§1.3): in training,
 * 10 and 5 minutes. A time control without the teacher would get help on request or an exam instead.
 * Bullet: nothing to choose — he says plainly what he does there and where the teacher is.
 * `address`: the child's gender («подумаешь сам / сама»; unknown = «сам»).
 */
export function coachStylePhrase(timeControlId: TimeControlId, address: 'm' | 'f' = 'm'): WizardPhrase {
  const styles = coachStylesFor(timeControlId);
  const self = address === 'f' ? 'сама' : 'сам';
  if (styles.includes('teacher')) {
    return {
      kind: 'encourage',
      priority: 1,
      pose: 'talk',
      text: `Хочешь, я буду твоим учителем — показывать хорошие ходы и объяснять? Или подумаешь ${self}, а я помогу, когда попросишь?`,
      lines: [{ line: 'shell.wizard.teacher' }, { line: 'shell.wizard.self', g: address }],
    };
  }
  if (styles.length > 0) return helpOnlyPhrase(address);
  return { kind: 'encourage', priority: 1, pose: 'talk', text: BULLET_COACH_PHRASE, lines: [{ line: 'shell.wizard.bullet' }, { line: 'shell.wizard.teachTimes' }] };
}

/** Step 3 of a time control that offers help on request or an exam, but not the teacher (none does today). */
export function helpOnlyPhrase(address: 'm' | 'f' = 'm'): WizardPhrase {
  const self = address === 'f' ? 'сама' : 'сам';
  return { kind: 'encourage', priority: 1, pose: 'talk', text: `Я помогу, когда попросишь. А хочешь — сыграешь экзамен совсем ${self}.`, lines: [{ line: 'shell.wizard.help', g: address }] };
}

/** `claim(step)` answers true exactly once per step — also under React StrictMode, where effects run twice. */
export function createStepGuard(): { claim(step: WizardStep): boolean } {
  const said = new Set<WizardStep>();
  return {
    claim(step) {
      if (said.has(step)) return false;
      said.add(step);
      return true;
    },
  };
}
