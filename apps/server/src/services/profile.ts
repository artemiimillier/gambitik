/**
 * Pure student-profile logic: defaults, applying a finished game, weaknesses / strengths,
 * stage suggestion. No I/O here — persistence lives in `student.ts`.
 */
import type { CurriculumStage, GameRecord, MotifId, PersonaId, StudentProfile, ThemeSkill } from '@gambit/shared';
import { childOutcome } from '../storage/notation.ts';

export const INITIAL_PUZZLE_RATING = 600;
export const INITIAL_RD = 300;
export const INITIAL_VOL = 0.06;
export const RECENT_ACCURACY_LIMIT = 20;
export const RECENT_GAMES_WINDOW = 10;
/** a game with fewer judged child moves says little about accuracy */
export const MIN_JUDGED_MOVES = 4;
/** games that must be played on a stage before the server suggests the next one */
export const MIN_GAMES_PER_STAGE = 5;

export function initialThemeSkill(rating = INITIAL_PUZZLE_RATING): ThemeSkill {
  return { rating, rd: INITIAL_RD, vol: INITIAL_VOL, attempts: 0, solved: 0, lastSeen: null };
}

export function defaultProfile(now: Date = new Date()): StudentProfile {
  return {
    nickname: 'Шахматист',
    address: 'm',
    stage: 1,
    totals: { games: 0, wins: 0, losses: 0, draws: 0, puzzlesAttempted: 0, puzzlesSolved: 0, minutesPlayed: 0 },
    puzzleRating: initialThemeSkill(),
    themeSkills: {},
    recentAccuracy: [],
    weaknesses: [],
    strengths: [],
    bestWin: null,
    updatedAt: now.toISOString(),
  };
}

export interface ProfileContext {
  /** weakest → strongest */
  personaOrder: readonly PersonaId[];
  curriculum: readonly CurriculumStage[];
  motifTitleRu: (motif: MotifId) => string;
  themeTitleRu: (theme: string) => string;
  /** total games recorded when the current stage began (see `StageMeta`) */
  gamesAtStageStart: number;
  now?: Date;
}

function countMotifs(lists: readonly (readonly MotifId[])[]): Map<MotifId, number> {
  const counts = new Map<MotifId, number>();
  for (const list of lists) for (const motif of list) counts.set(motif, (counts.get(motif) ?? 0) + 1);
  return counts;
}

function topMotifs(counts: Map<MotifId, number>, minCount: number, limit: number, exclude: ReadonlySet<MotifId> = new Set()): MotifId[] {
  return [...counts.entries()]
    .filter(([motif, n]) => n >= minCount && !exclude.has(motif))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([motif]) => motif);
}

/** Motifs the child found himself: a best / excellent move whose idea was a recognised motif. */
function motifsFound(record: GameRecord): MotifId[] {
  const found: MotifId[] = [];
  for (const j of record.judgements) {
    if ((j.classification === 'best' || j.classification === 'excellent') && j.missedMotif !== undefined) found.push(j.missedMotif);
  }
  return found;
}

export interface WeaknessAnalysis {
  weaknessMotifs: MotifId[];
  strengthMotifs: MotifId[];
}

/**
 * Weaknesses: motifs the child allowed or missed at least twice over the recent games.
 * Strengths: motifs he found at least twice and that are not among the weaknesses.
 */
export function analyseMotifs(recentGames: readonly GameRecord[]): WeaknessAnalysis {
  const window = recentGames.slice(0, RECENT_GAMES_WINDOW);
  const problems = countMotifs(window.flatMap((g) => [g.summary.motifsAllowed, g.summary.motifsMissed]));
  const weaknessMotifs = topMotifs(problems, 2, 3);
  const found = countMotifs(window.map(motifsFound));
  const strengthMotifs = topMotifs(found, 2, 3, new Set(weaknessMotifs));
  return { weaknessMotifs, strengthMotifs };
}

function strongPuzzleThemes(profile: StudentProfile, limit: number): string[] {
  return Object.entries(profile.themeSkills)
    .filter(([, skill]) => skill.attempts >= 8 && skill.solved / skill.attempts >= 0.75)
    .sort((a, b) => b[1].rating - a[1].rating)
    .slice(0, limit)
    .map(([theme]) => theme);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Stage suggestion. NEVER lower than the current stage (no auto-demotion — a parent can change
 * the stage by hand through PUT /student). Moves up by at most one stage, and only when every
 * numeric mastery criterion of the current stage is met over the last games played on it.
 */
export function suggestStage(profile: StudentProfile, recentGames: readonly GameRecord[], ctx: Pick<ProfileContext, 'curriculum' | 'gamesAtStageStart'>): number {
  const current = profile.stage;
  const stage = ctx.curriculum.find((s) => s.stage === current);
  const hasNext = ctx.curriculum.some((s) => s.stage === current + 1);
  if (stage === undefined || !hasNext) return current;

  const { minPuzzleRating, maxBlundersPerGame, minAccuracy } = stage.mastery;
  if (minPuzzleRating === undefined && maxBlundersPerGame === undefined && minAccuracy === undefined) return current;

  const gamesOnStage = profile.totals.games - ctx.gamesAtStageStart;
  if (gamesOnStage < MIN_GAMES_PER_STAGE) return current;
  // only games played on the current stage count, newest first, and only meaningful ones
  const sample = recentGames
    .slice(0, gamesOnStage)
    .filter((g) => g.judgements.length >= MIN_JUDGED_MOVES)
    .slice(0, MIN_GAMES_PER_STAGE);
  if (sample.length < MIN_GAMES_PER_STAGE) return current;

  if (minPuzzleRating !== undefined && (profile.puzzleRating.attempts < 10 || profile.puzzleRating.rating < minPuzzleRating)) return current;
  if (maxBlundersPerGame !== undefined && mean(sample.map((g) => g.summary.counts.blunder)) > maxBlundersPerGame) return current;
  if (minAccuracy !== undefined && mean(sample.map((g) => g.summary.accuracy)) < minAccuracy) return current;
  return current + 1;
}

function gameMinutes(record: GameRecord): number {
  const ms = Date.parse(record.endedAt) - Date.parse(record.startedAt);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(180, Math.round(ms / 6_000) / 10);
}

/** The concept list is bounded (the library has a few dozen cards; the schema allows 500). */
export const MAX_CONCEPTS_INTRODUCED = 500;

/** The concept cards «Учитель» explained in a game: `teach.conceptId` of its `coachSaid` events (TEACHER-MODE §7.5). */
export function conceptsOfGame(record: GameRecord): string[] {
  const ids: string[] = [];
  for (const event of record.events) {
    if (event.type !== 'coachSaid') continue;
    const teach = event.data.teach;
    const id = typeof teach === 'object' && teach !== null && 'conceptId' in teach ? teach.conceptId : undefined;
    if (typeof id === 'string' && id !== '' && id.length <= 80 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** `known` plus the cards of `games` (oldest first), each once, the newest MAX_CONCEPTS_INTRODUCED kept. */
export function withConceptsOf(known: readonly string[], games: readonly GameRecord[]): string[] {
  const out = [...known];
  for (const record of games) for (const id of conceptsOfGame(record)) if (!out.includes(id)) out.push(id);
  return out.slice(-MAX_CONCEPTS_INTRODUCED);
}

/** Adds one finished game to the totals, the recent accuracy and the best win. Nothing else changes. */
export function countGame(profile: StudentProfile, record: GameRecord, personaOrder: readonly PersonaId[]): StudentProfile {
  const outcome = childOutcome(record.result, record.childColor);
  const totals = { ...profile.totals };
  totals.games += 1;
  if (outcome === 'win') totals.wins += 1;
  else if (outcome === 'loss') totals.losses += 1;
  else if (outcome === 'draw') totals.draws += 1;
  totals.minutesPlayed = Math.round((totals.minutesPlayed + gameMinutes(record)) * 10) / 10;

  const recentAccuracy = [...profile.recentAccuracy];
  if (record.judgements.length >= MIN_JUDGED_MOVES) {
    recentAccuracy.push(Math.round(record.summary.accuracy * 10) / 10);
  }

  let bestWin = profile.bestWin;
  if (outcome === 'win') {
    const rank = (id: PersonaId | null) => (id === null ? -1 : personaOrder.indexOf(id));
    if (rank(record.personaId) > rank(bestWin)) bestWin = record.personaId;
  }
  return { ...profile, totals, recentAccuracy: recentAccuracy.slice(-RECENT_ACCURACY_LIMIT), bestWin };
}

/**
 * Applies one finished game. `recentGames` are the most recent games, newest first, INCLUDING
 * `record` itself.
 */
export function applyGameToProfile(profile: StudentProfile, record: GameRecord, recentGames: readonly GameRecord[], ctx: ProfileContext): StudentProfile {
  const next: StudentProfile = {
    ...countGame(profile, record, ctx.personaOrder),
    conceptsIntroduced: withConceptsOf(profile.conceptsIntroduced ?? [], [record]),
    updatedAt: (ctx.now ?? new Date()).toISOString(),
  };
  const withInsights = refreshInsights(next, recentGames, ctx);
  return { ...withInsights, stage: Math.max(profile.stage, suggestStage(withInsights, recentGames, ctx)) };
}

/**
 * The profile recounted from the games that count (a game was marked «играл взрослый», or the progress was started
 * anew): totals, recent accuracy, best win, weaknesses, strengths and the concept cards explained come from
 * `gamesOldestFirst` only. Everything that is not about games stays — the pseudonym, the puzzles and their ratings, and
 * the stage: a stage is never lowered automatically (a parent changes it in the settings).
 */
export function recountProfile(profile: StudentProfile, gamesOldestFirst: readonly GameRecord[], ctx: Omit<ProfileContext, 'curriculum' | 'gamesAtStageStart'>): StudentProfile {
  let next: StudentProfile = {
    ...profile,
    totals: { ...profile.totals, games: 0, wins: 0, losses: 0, draws: 0, minutesPlayed: 0 },
    recentAccuracy: [],
    bestWin: null,
    // an adult's 5-minute games do not use up the child's cards (a parent may play «Учитель» games too)
    conceptsIntroduced: withConceptsOf([], gamesOldestFirst),
  };
  for (const record of gamesOldestFirst) next = countGame(next, record, ctx.personaOrder);
  const newestFirst = [...gamesOldestFirst].reverse().slice(0, RECENT_GAMES_WINDOW);
  return { ...refreshInsights(next, newestFirst, ctx), stage: profile.stage, updatedAt: (ctx.now ?? new Date()).toISOString() };
}

/** Recomputes the weaknesses / strengths lists (Russian, human- and LLM-readable). */
export function refreshInsights(profile: StudentProfile, recentGames: readonly GameRecord[], ctx: Pick<ProfileContext, 'motifTitleRu' | 'themeTitleRu'>): StudentProfile {
  const { weaknessMotifs, strengthMotifs } = analyseMotifs(recentGames);
  const weaknesses = weaknessMotifs.map(ctx.motifTitleRu);
  const strengths = strengthMotifs.map(ctx.motifTitleRu);
  for (const theme of strongPuzzleThemes(profile, 3)) {
    const title = `Задачи: ${ctx.themeTitleRu(theme)}`;
    if (strengths.length < 3 && !strengths.includes(title)) strengths.push(title);
  }
  const window = recentGames.slice(0, RECENT_GAMES_WINDOW).filter((g) => g.judgements.length >= MIN_JUDGED_MOVES);
  if (strengths.length < 3 && window.length >= 5 && mean(window.map((g) => g.summary.counts.blunder)) <= 0.5) {
    strengths.push('Внимательно следит за своими фигурами');
  }
  return { ...profile, weaknesses, strengths };
}
