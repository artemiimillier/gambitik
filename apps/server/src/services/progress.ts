/**
 * ProgressSnapshot for the parent dashboard (`GET /progress`) and its file twin
 * `data/student/progress.json` (versioned schema, machine-readable).
 */
import type { CurriculumStage, ProgressSnapshot, StudentProfile } from '@gambit/shared';
import { stageFor } from '../content.ts';
import type { ContentBundle } from '../content.ts';
import type { Repo } from '../storage/repo.ts';

export const PROGRESS_GAMES_LIMIT = 300;
export const PROGRESS_RATING_POINTS_LIMIT = 500;

/** Kid-friendly Russian title of a lichess theme key; falls back to the raw key. */
export function themeTitle(themeTitlesRu: Record<string, string>, theme: string): string {
  const title = themeTitlesRu[theme];
  return title !== undefined && title.trim() !== '' ? title : theme;
}

export function currentStages(curriculum: CurriculumStage[], stageNumber: number): { stage: CurriculumStage; nextStage: CurriculumStage | null } {
  const stage = stageFor(curriculum, stageNumber);
  const nextStage = curriculum.find((s) => s.stage === stage.stage + 1) ?? null;
  return { stage, nextStage };
}

export function buildProgressSnapshot(repo: Repo, profile: StudentProfile, content: Pick<ContentBundle, 'curriculum' | 'themeTitlesRu'>): ProgressSnapshot {
  const { stage, nextStage } = currentStages(content.curriculum, profile.stage);
  const themeTable = Object.entries(profile.themeSkills)
    .map(([theme, skill]) => ({
      theme,
      title: themeTitle(content.themeTitlesRu, theme),
      rating: Math.round(skill.rating),
      attempts: skill.attempts,
      solved: skill.solved,
    }))
    .sort((a, b) => b.attempts - a.attempts || a.theme.localeCompare(b.theme));
  return {
    profile,
    games: repo.progressPoints(PROGRESS_GAMES_LIMIT),
    puzzleRatingHistory: repo
      .loadRatingHistory()
      .slice(-PROGRESS_RATING_POINTS_LIMIT)
      .map((point) => ({ date: point.date, rating: Math.round(point.rating) })),
    themeTable,
    stage,
    nextStage,
  };
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
}

/** `progress.json`: the snapshot plus a few ready-made aggregates for scripts and LLMs. */
export function renderProgressJson(snapshot: ProgressSnapshot, now: Date = new Date()): string {
  const last10 = snapshot.games.slice(-10);
  const gamesByOpponent: Record<string, number> = {};
  for (const game of snapshot.games) gamesByOpponent[game.personaId] = (gamesByOpponent[game.personaId] ?? 0) + 1;
  const file = {
    schema: 'progress/1',
    generatedAt: now.toISOString(),
    student: snapshot.profile.nickname,
    stage: { number: snapshot.stage.stage, title: snapshot.stage.title, next: snapshot.nextStage?.title ?? null },
    ratings: {
      'puzzle:all': snapshot.profile.puzzleRating,
      ...Object.fromEntries(Object.entries(snapshot.profile.themeSkills).map(([theme, skill]) => [`puzzle:${theme}`, skill])),
    },
    games: {
      total: snapshot.profile.totals.games,
      wins: snapshot.profile.totals.wins,
      losses: snapshot.profile.totals.losses,
      draws: snapshot.profile.totals.draws,
      minutesPlayed: snapshot.profile.totals.minutesPlayed,
      last10: { accuracy: mean(last10.map((g) => g.accuracy)), blundersPerGame: mean(last10.map((g) => g.blunders)) },
      gamesByOpponent,
    },
    focus: snapshot.profile.weaknesses,
    strengths: snapshot.profile.strengths,
    snapshot,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}
