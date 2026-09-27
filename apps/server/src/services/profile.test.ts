import { describe, expect, it } from 'vitest';
import { PERSONA_IDS } from '@gambit/shared';
import type { GameRecord, MotifId, StudentProfile } from '@gambit/shared';
import { fallbackCurriculum } from '../content.ts';
import { sampleGameRecord } from '../testing/fixtures.ts';
import { analyseMotifs, applyGameToProfile, defaultProfile, recountProfile, refreshInsights, suggestStage } from './profile.ts';
import type { ProfileContext } from './profile.ts';

const ctx: ProfileContext = {
  personaOrder: PERSONA_IDS,
  curriculum: fallbackCurriculum(),
  motifTitleRu: (motif) => `motif:${motif}`,
  themeTitleRu: (theme) => `theme:${theme}`,
  gamesAtStageStart: 0,
  now: new Date('2026-09-21T15:00:00Z'),
};

function game(overrides: Partial<GameRecord> = {}, summary: Partial<GameRecord['summary']> = {}): GameRecord {
  const base = sampleGameRecord(overrides);
  return { ...base, summary: { ...base.summary, ...summary } };
}

function play(profile: StudentProfile, records: GameRecord[], context: ProfileContext = ctx): StudentProfile {
  const history: GameRecord[] = [];
  let current = profile;
  for (const record of records) {
    history.unshift(record);
    current = applyGameToProfile(current, record, history.slice(0, 10), context);
  }
  return current;
}

describe('applyGameToProfile', () => {
  it('updates totals, minutes, recent accuracy and the best win', () => {
    const profile = applyGameToProfile(defaultProfile(), game(), [game()], ctx);
    expect(profile.totals).toMatchObject({ games: 1, wins: 1, losses: 0, draws: 0, minutesPlayed: 7.5 });
    expect(profile.recentAccuracy).toEqual([81.4]);
    expect(profile.bestWin).toBe('petya');
    expect(profile.updatedAt).toBe('2026-09-21T15:00:00.000Z');
  });

  it('counts losses, draws and unfinished games from the child\'s point of view', () => {
    const profile = play(defaultProfile(), [
      game({ id: 'a', result: '0-1' }),
      game({ id: 'b', result: '1/2-1/2', termination: 'draw' }),
      game({ id: 'c', result: '*', termination: 'abandoned' }),
      game({ id: 'd', childColor: 'b', result: '0-1' }),
    ]);
    expect(profile.totals).toMatchObject({ games: 4, wins: 1, losses: 1, draws: 1 });
  });

  it('keeps only the last 20 accuracies and ignores games with too few judged moves', () => {
    const records = Array.from({ length: 23 }, (_, i) => game({ id: `g${i}` }, { accuracy: i }));
    const tiny = { ...game({ id: 'tiny' }, { accuracy: 99 }), judgements: [] };
    const profile = play(defaultProfile(), [...records, tiny]);
    expect(profile.recentAccuracy).toHaveLength(20);
    expect(profile.recentAccuracy[0]).toBe(3);
    expect(profile.recentAccuracy.at(-1)).toBe(22);
    expect(profile.totals.games).toBe(24);
  });

  it('only ever raises the best win', () => {
    const profile = play(defaultProfile(), [
      game({ id: 'a', personaId: 'grisha' }),
      game({ id: 'b', personaId: 'petya' }),
      game({ id: 'c', personaId: 'dima', result: '0-1' }),
    ]);
    expect(profile.bestWin).toBe('grisha');
  });
});

describe('weaknesses and strengths', () => {
  it('derives weaknesses from motifs allowed / missed at least twice over the last 10 games', () => {
    const allowed = (motifs: MotifId[], missed: MotifId[] = []) => game({}, { motifsAllowed: motifs, motifsMissed: missed });
    const games = [allowed(['fork']), allowed(['hangingPiece'], ['fork']), allowed(['hangingPiece', 'pin']), allowed([], ['hangingPiece'])];
    expect(analyseMotifs(games).weaknessMotifs).toEqual(['hangingPiece', 'fork']);
    // older than the window → ignored
    const old = Array.from({ length: 10 }, () => allowed([]));
    expect(analyseMotifs([...old, ...games]).weaknessMotifs).toEqual([]);
  });

  it('derives strengths from motifs the child found himself, never duplicating a weakness', () => {
    const found = game(); // Qxf7# is a best move with the mateIn1 motif
    const profile = refreshInsights(defaultProfile(), [found, found, game({}, { motifsAllowed: ['hangingPiece'] })], ctx);
    expect(profile.weaknesses).toEqual(['motif:hangingPiece']);
    expect(profile.strengths).toContain('motif:mateIn1');
  });

  it('adds strong puzzle themes and clean play as strengths', () => {
    const base = defaultProfile();
    const skilled: StudentProfile = { ...base, themeSkills: { fork: { rating: 1100, rd: 80, vol: 0.06, attempts: 10, solved: 9, lastSeen: null } } };
    const clean = Array.from({ length: 5 }, (_, i) => ({ ...game({ id: `c${i}` }, { motifsAllowed: [], counts: { best: 5, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, missedWin: 0 } }), judgements: game().judgements.filter((j) => j.classification !== 'best' || j.missedMotif === undefined) }));
    const profile = refreshInsights(skilled, clean, ctx);
    expect(profile.strengths).toEqual(['Задачи: theme:fork', 'Внимательно следит за своими фигурами']);
  });
});

describe('suggestStage', () => {
  const strong = (id: string) => game({ id }, { accuracy: 90, counts: { best: 9, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, missedWin: 0 } });
  const weak = (id: string) => game({ id }, { accuracy: 30, counts: { best: 1, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 9, missedWin: 0 } });
  const ready: StudentProfile = { ...defaultProfile(), totals: { ...defaultProfile().totals, games: 5 }, puzzleRating: { rating: 900, rd: 80, vol: 0.06, attempts: 40, solved: 30, lastSeen: null } };

  it('promotes by one stage when every mastery criterion is met over five games', () => {
    const games = ['a', 'b', 'c', 'd', 'e'].map(strong);
    expect(suggestStage(ready, games, ctx)).toBe(2);
  });

  it('needs five games on the current stage', () => {
    const games = ['a', 'b', 'c', 'd', 'e'].map(strong);
    expect(suggestStage(ready, games, { ...ctx, gamesAtStageStart: 2 })).toBe(1);
    expect(suggestStage({ ...ready, totals: { ...ready.totals, games: 4 } }, games.slice(0, 4), ctx)).toBe(1);
  });

  it('holds the stage when the puzzle rating or the blunder rate is not there yet', () => {
    const games = ['a', 'b', 'c', 'd', 'e'].map(strong);
    expect(suggestStage({ ...ready, puzzleRating: { ...ready.puzzleRating, rating: 650 } }, games, ctx)).toBe(1);
    expect(suggestStage(ready, ['a', 'b', 'c', 'd', 'e'].map(weak), ctx)).toBe(1);
  });

  it('NEVER demotes, however badly things go', () => {
    const start: StudentProfile = { ...defaultProfile(), stage: 4 };
    const profile = play(start, Array.from({ length: 12 }, (_, i) => weak(`w${i}`)));
    expect(profile.stage).toBe(4);
  });

  it('stays on the last stage and ignores stages without numeric criteria', () => {
    const last = fallbackCurriculum().length;
    expect(suggestStage({ ...ready, stage: last }, ['a', 'b', 'c', 'd', 'e'].map(strong), ctx)).toBe(last);
  });

  it('promotes through applyGameToProfile', () => {
    const profile = play(ready, ['a', 'b', 'c', 'd', 'e'].map(strong), { ...ctx, gamesAtStageStart: 5 });
    expect(profile.stage).toBe(2);
  });
});

describe('recountProfile («играл взрослый», «Начать прогресс заново»)', () => {
  const adultGame = (id: string) => game({ id, personaId: 'dima', startedAt: '2026-09-20T10:00:00.000Z' }, { motifsAllowed: ['fork', 'pin'], motifsMissed: ['fork'] });

  it('counts only the given games: totals, accuracy, best win and insights come from them alone', () => {
    const childGames = [game({ id: 'c1' }, { accuracy: 60 }), game({ id: 'c2', result: '0-1' }, { accuracy: 70, motifsAllowed: ['hangingPiece'] }), game({ id: 'c3' }, { accuracy: 80, motifsAllowed: ['hangingPiece'] })];
    const mixed = play(defaultProfile(), [adultGame('a1'), ...childGames.slice(0, 2), adultGame('a2'), childGames[2] ?? game()]);
    expect(mixed.totals.games).toBe(5);
    expect(mixed.bestWin).toBe('dima');
    expect(mixed.weaknesses).toContain('motif:fork');

    const withPuzzles: StudentProfile = { ...mixed, nickname: 'Миша', stage: 3, totals: { ...mixed.totals, puzzlesAttempted: 12, puzzlesSolved: 9 }, puzzleRating: { ...mixed.puzzleRating, rating: 777, attempts: 12 } };
    const recounted = recountProfile(withPuzzles, childGames, ctx);
    expect(recounted.totals).toMatchObject({ games: 3, wins: 2, losses: 1, draws: 0, minutesPlayed: 22.5, puzzlesAttempted: 12, puzzlesSolved: 9 });
    expect(recounted.recentAccuracy).toEqual([60, 70, 80]);
    expect(recounted.bestWin).toBe('petya');
    expect(recounted.weaknesses).toEqual(['motif:hangingPiece']);
    // not about games: kept as they are — the stage is never lowered automatically
    expect(recounted).toMatchObject({ nickname: 'Миша', stage: 3, puzzleRating: { rating: 777, attempts: 12 } });
    expect(recounted.updatedAt).toBe('2026-09-21T15:00:00.000Z');
  });

  it('starts from zero games when every game is left out', () => {
    const recounted = recountProfile(play(defaultProfile(), [adultGame('a1'), adultGame('a2')]), [], ctx);
    expect(recounted.totals).toMatchObject({ games: 0, wins: 0, losses: 0, draws: 0, minutesPlayed: 0 });
    expect(recounted).toMatchObject({ recentAccuracy: [], bestWin: null, weaknesses: [], strengths: [] });
  });
});
