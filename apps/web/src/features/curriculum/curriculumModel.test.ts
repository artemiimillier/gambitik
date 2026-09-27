import { describe, expect, it } from 'vitest';
import { CONCEPT_CARDS, CURRICULUM, OPENING_REPERTOIRE, THEMES_NOT_FOR_DRILL, THEME_TITLES_RU } from '@gambit/content';
import type { ProgressSnapshot, StudentProfile } from '@gambit/shared';
import { START_FEN, drillThemes, exampleLine, masteryCriteria, repertoireForStage, sideOf, stageProgressPct, stageState } from './curriculumModel.ts';

function profile(rating: number, attempts: number, themeSkills: StudentProfile['themeSkills'] = {}): StudentProfile {
  return {
    nickname: 'Тёма',
    address: 'm',
    stage: 1,
    totals: { games: 0, wins: 0, losses: 0, draws: 0, puzzlesAttempted: attempts, puzzlesSolved: 0, minutesPlayed: 0 },
    puzzleRating: { rating, rd: 120, vol: 0.06, attempts, solved: 0, lastSeen: null },
    themeSkills,
    recentAccuracy: [],
    weaknesses: [],
    strengths: [],
    bestWin: null,
    updatedAt: '',
  };
}

function games(rows: [accuracy: number, blunders: number][]): ProgressSnapshot['games'] {
  return rows.map(([accuracy, blunders], i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}T10:00:00Z`, gameId: `g${i}`, accuracy, blunders, personaId: 'petya', result: '1-0' }));
}

describe('stageState', () => {
  it('splits the path around the current stage', () => {
    expect([1, 2, 3, 4].map((s) => stageState(s, 3))).toEqual(['done', 'done', 'current', 'ahead']);
  });

  it('alternates the sides of the zig-zag', () => {
    expect([0, 1, 2, 3].map(sideOf)).toEqual(['left', 'right', 'left', 'right']);
  });
});

describe('masteryCriteria', () => {
  const stage = { mastery: { description: '', minPuzzleRating: 900, maxBlundersPerGame: 3, minAccuracy: 65 } };

  it('reports nothing measurable for a brand-new student', () => {
    const criteria = masteryCriteria(stage, { profile: profile(600, 0), games: [] });
    expect(criteria.map((c) => c.id)).toEqual(['puzzleRating', 'blunders', 'accuracy']);
    expect(criteria.every((c) => !c.met && c.pct === 0 && c.current === null)).toBe(true);
    expect(stageProgressPct(criteria)).toBe(0);
  });

  it('shows partial progress from the last five games and the puzzle rating', () => {
    const criteria = masteryCriteria(stage, { profile: profile(650, 40), games: games([[10, 9], [50, 6], [52, 6], [54, 6], [56, 6], [48, 6]]) });
    const [rating, blunders, accuracy] = criteria;
    expect(rating).toMatchObject({ target: '900 и выше', current: 'сейчас 650', pct: 50, met: false });
    // the oldest game (10 %, 9 blunders) is outside the window of five
    expect(blunders).toMatchObject({ target: 'не больше 3', current: 'сейчас 6', pct: 50, met: false });
    expect(accuracy).toMatchObject({ target: '65% и выше', current: 'сейчас 52%', pct: 80, met: false });
    expect(stageProgressPct(criteria)).toBe(60);
  });

  it('marks criteria as met only with enough data, like the server does', () => {
    const good = games([[80, 1], [82, 0], [78, 2], [85, 1], [90, 0]]);
    const met = masteryCriteria(stage, { profile: profile(950, 25), games: good });
    expect(met.every((c) => c.met)).toBe(true);
    expect(stageProgressPct(met)).toBe(100);

    const fewPuzzles = masteryCriteria(stage, { profile: profile(950, 4), games: good });
    expect(fewPuzzles[0]?.met).toBe(false);
    const fewGames = masteryCriteria(stage, { profile: profile(950, 25), games: good.slice(0, 3) });
    expect(fewGames[1]?.met).toBe(false);
    expect(fewGames[2]?.met).toBe(false);
    expect(fewGames[1]?.pct).toBe(100);
  });

  it('handles zero blunders, fractional targets and stages without numbers', () => {
    const zero = masteryCriteria({ mastery: { description: '', maxBlundersPerGame: 0.5 } }, { profile: profile(600, 0), games: games([[70, 0], [70, 0], [70, 0], [70, 0], [70, 0]]) });
    expect(zero).toHaveLength(1);
    expect(zero[0]).toMatchObject({ target: 'не больше 0,5', current: 'сейчас 0', pct: 100, met: true });
    expect(masteryCriteria({ mastery: { description: 'слова' } }, { profile: profile(600, 0), games: [] })).toEqual([]);
  });

  it('works for every stage of the real curriculum', () => {
    for (const real of CURRICULUM) {
      const criteria = masteryCriteria(real, { profile: profile(1200, 50), games: games([[70, 2], [71, 1], [69, 2], [75, 1], [72, 2]]) });
      for (const c of criteria) {
        expect(c.pct).toBeGreaterThanOrEqual(0);
        expect(c.pct).toBeLessThanOrEqual(100);
        expect(c.label.length).toBeGreaterThan(3);
      }
    }
  });
});

describe('drillThemes', () => {
  it('keeps real, titled themes once and adds the theme rating when there is one', () => {
    const themes = drillThemes(
      { puzzleThemes: ['fork', 'mix', 'fork', 'pin', 'oneMove', 'bad theme!', 'unknownTag'] },
      THEME_TITLES_RU,
      THEMES_NOT_FOR_DRILL,
      { fork: { rating: 812.4, rd: 90, vol: 0.06, attempts: 12, solved: 9, lastSeen: null }, pin: { rating: 600, rd: 300, vol: 0.06, attempts: 0, solved: 0, lastSeen: null } },
    );
    expect(themes).toEqual([
      { theme: 'fork', title: 'Вилка', rating: 812 },
      { theme: 'pin', title: 'Связка', rating: null },
      { theme: 'unknownTag', title: 'unknownTag', rating: null },
    ]);
  });

  it('every stage of the real curriculum offers at least one drill with a Russian title', () => {
    for (const stage of CURRICULUM) {
      const themes = drillThemes(stage, THEME_TITLES_RU, THEMES_NOT_FOR_DRILL, undefined);
      expect(themes.length, `stage ${stage.stage}`).toBeGreaterThan(0);
      for (const t of themes) expect(t.title, t.theme).toMatch(/[А-Яа-яЁё]/);
    }
  });
});

describe('exampleLine', () => {
  it('applies every example of every real concept card completely', () => {
    for (const card of CONCEPT_CARDS) {
      for (const example of card.examples) {
        const line = exampleLine(example.fen, example.solutionSan);
        expect(line.map((m) => m.san), card.id).toEqual(example.solutionSan);
        expect(line[0]?.fenBefore).toBe(example.fen);
      }
    }
  });

  it('stops quietly at a move that does not fit', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(exampleLine(start, ['e4', 'Qh5', 'Nf3']).map((m) => m.san)).toEqual(['e4']);
    expect(exampleLine('broken', ['e4'])).toEqual([]);
  });
});

describe('opening repertoire on the path', () => {
  it('is hidden before the stage it is taught from and shown from then on', () => {
    expect(repertoireForStage(4, OPENING_REPERTOIRE)).toEqual([]);
    const atFive = repertoireForStage(5, OPENING_REPERTOIRE);
    expect(atFive.map((entry) => entry.id)).toEqual(['italian-white', 'e5-black', 'd5-black']);
    expect(repertoireForStage(10, OPENING_REPERTOIRE).length).toBe(atFive.length);
  });

  it('turns every real model line into playable moves from the initial position', () => {
    for (const entry of repertoireForStage(10, OPENING_REPERTOIRE)) {
      const source = OPENING_REPERTOIRE.find((raw) => raw.id === entry.id);
      expect(entry.lines.length, entry.id).toBe(source?.lines.length);
      expect(entry.side).toBe(source?.side);
      for (const line of entry.lines) {
        const sourceLine = source?.lines.find((raw) => raw.id === line.id);
        expect(line.moves.length, line.id).toBe(sourceLine?.movesSan.length);
        expect(line.moves[0]?.fenBefore).toBe(START_FEN);
        expect(line.idea).not.toMatch(/[A-Za-z]/); // Гамбитик reads it aloud
      }
      expect(entry.keyIdeas.length).toBeGreaterThan(0);
    }
  });

  it('survives whatever the content package exports (missing, reshaped or broken data)', () => {
    for (const junk of [undefined, null, 'repertoire', 42, {}, [null, 7, 'x', {}, { id: 'a' }, { id: 'a', title: 'Б', fromStage: 1 }]]) expect(repertoireForStage(10, junk)).toEqual([]);
    const partly = repertoireForStage(10, [
      { id: 'x', title: 'Дебют', fromStage: 5, side: 'b', lines: [{ id: 'bad', title: 'Сломанный', movesSan: ['Zz9'] }, { title: 'Рабочий', movesSan: ['e4', 'e5', 'Ke3'], nextIdea: 'Дальше — рокировка.', warning: true }, 'junk'] },
      { id: 'y', title: 'Только сломанные', fromStage: 5, lines: [{ id: 'bad', title: 'Сломанный', movesSan: [] }] },
    ]);
    expect(partly).toHaveLength(1);
    expect(partly[0]).toMatchObject({ id: 'x', side: 'b', summary: '', keyIdeas: [], watchOut: [] });
    // the illegal third move cuts the line, the legal part stays
    expect(partly[0]?.lines).toEqual([expect.objectContaining({ id: 'x-0', title: 'Рабочий', nextIdea: 'Дальше — рокировка.', warning: true, moves: [expect.objectContaining({ san: 'e4' }), expect.objectContaining({ san: 'e5' })] })]);
  });
});
