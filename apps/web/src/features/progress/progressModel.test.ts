import { describe, expect, it } from 'vitest';
import type { ProgressSnapshot } from '@gambit/shared';
import {
  MAX_RATING_POINTS,
  average,
  formatMinutesRu,
  isGameChartPoint,
  isRatingChartPoint,
  niceDomain,
  outcomeFor,
  rankThemes,
  toGameChartData,
  toRatingChartData,
  trendOf,
} from './progressModel.ts';

function game(i: number, accuracy: number, blunders: number): ProgressSnapshot['games'][number] {
  return { date: `2026-09-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`, gameId: `g${i}`, accuracy, blunders, personaId: 'petya', result: '1-0' };
}

describe('toGameChartData', () => {
  it('keeps the newest games, oldest first, numbered by their real position', () => {
    const games = Array.from({ length: 35 }, (_, i) => game(i % 28, 60 + (i % 10), i % 3)).map((g, i) => ({ ...g, gameId: `g${i}`, date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }));
    const data = toGameChartData(games, 30);
    expect(data).toHaveLength(30);
    expect(data[0]?.n).toBe(6);
    expect(data[29]?.n).toBe(35);
    expect(data[29]?.gameId).toBe('g34');
  });

  it('sorts unsorted input, rounds and clamps', () => {
    const data = toGameChartData([game(5, 120.4, 2.6), game(1, -3, -1)]);
    expect(data.map((d) => d.gameId)).toEqual(['g1', 'g5']);
    expect(data[0]).toMatchObject({ accuracy: 0, blunders: 0, n: 1 });
    expect(data[1]).toMatchObject({ accuracy: 100, blunders: 3, n: 2 });
    expect(data[1]?.dateLabel).toMatch(/^\d{2}\.09$/);
  });

  it('has working payload guards for the tooltips', () => {
    const [point] = toGameChartData([game(1, 80, 1)]);
    expect(isGameChartPoint(point)).toBe(true);
    expect(isGameChartPoint({ rating: 1 })).toBe(false);
    expect(isGameChartPoint(null)).toBe(false);
    expect(isRatingChartPoint({ n: 1, dateLabel: '01.09', rating: 640 })).toBe(true);
    expect(isRatingChartPoint('x')).toBe(false);
  });
});

describe('toRatingChartData', () => {
  it('thins a long history but keeps both ends', () => {
    const history = Array.from({ length: 500 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), rating: 600 + i }));
    const data = toRatingChartData(history);
    expect(data).toHaveLength(MAX_RATING_POINTS);
    expect(data[0]?.rating).toBe(600);
    expect(data[data.length - 1]?.rating).toBe(1099);
    expect(data.every((p, i) => i === 0 || p.rating > (data[i - 1]?.rating ?? 0))).toBe(true);
  });

  it('passes short histories through and drops broken points', () => {
    const data = toRatingChartData([
      { date: '2026-09-02T00:00:00Z', rating: 612.6 },
      { date: '2026-09-01T00:00:00Z', rating: 600 },
      { date: '2026-09-03T00:00:00Z', rating: Number.NaN },
    ]);
    expect(data.map((p) => p.rating)).toEqual([600, 613]);
  });
});

describe('niceDomain / trend / average', () => {
  it('snaps the axis to clean numbers', () => {
    expect(niceDomain([612, 655, 701])).toEqual([550, 750]);
    expect(niceDomain([600])).toEqual([550, 650]);
    expect(niceDomain([])).toEqual([0, 50]);
    expect(niceDomain([10])[0]).toBe(0);
  });

  it('compares the recent games with the ones before', () => {
    expect(trendOf([50, 52, 51, 49, 50, 70, 72, 71, 69, 73])).toBe('up');
    expect(trendOf([80, 82, 81, 60, 58, 61])).toBe('down');
    expect(trendOf([70, 71, 69, 70, 71, 70])).toBe('flat');
    expect(trendOf([70, 90])).toBe('none');
  });

  it('averages', () => {
    expect(average([])).toBeNull();
    expect(average([1, 2, 3])).toBe(2);
  });
});

describe('rankThemes', () => {
  const table: ProgressSnapshot['themeTable'] = [
    { theme: 'fork', title: 'Вилка', rating: 820, attempts: 20, solved: 16 },
    { theme: 'pin', title: 'Связка', rating: 590, attempts: 12, solved: 5 },
    { theme: 'mateIn1', title: 'Мат в 1 ход', rating: 700, attempts: 30, solved: 22 },
    { theme: 'skewer', title: 'Сквозной удар', rating: 900, attempts: 2, solved: 2 },
    { theme: 'promotion', title: 'Превращение пешки', rating: 600, attempts: 0, solved: 0 },
  ];

  it("compares each theme with the child's own overall rating", () => {
    const rows = rankThemes(table, 700);
    expect(rows.map((r) => `${r.theme}:${r.level}`)).toEqual(['skewer:new', 'fork:strong', 'mateIn1:steady', 'pin:weak']);
    expect(rows.find((r) => r.theme === 'fork')?.solvedPct).toBe(80);
  });

  it('puts every bar on one 4..100 scale', () => {
    const rows = rankThemes(table, 700);
    for (const row of rows) {
      expect(row.bar).toBeGreaterThanOrEqual(4);
      expect(row.bar).toBeLessThanOrEqual(100);
    }
    const fork = rows.find((r) => r.theme === 'fork');
    const pin = rows.find((r) => r.theme === 'pin');
    expect((fork?.bar ?? 0) > (pin?.bar ?? 0)).toBe(true);
  });

  it('returns nothing when no theme was tried yet', () => {
    expect(rankThemes([], 600)).toEqual([]);
    expect(rankThemes([{ theme: 'fork', title: 'Вилка', rating: 600, attempts: 0, solved: 0 }], 600)).toEqual([]);
  });
});

describe('formatting', () => {
  it('formats minutes in Russian', () => {
    expect(formatMinutesRu(0)).toBe('меньше минуты');
    expect(formatMinutesRu(40)).toBe('40 мин');
    expect(formatMinutesRu(60)).toBe('1 ч');
    expect(formatMinutesRu(135.4)).toBe('2 ч 15 мин');
    expect(formatMinutesRu(Number.NaN)).toBe('меньше минуты');
  });

  it("reads a result from the child's side", () => {
    expect(outcomeFor('1-0', 'w')).toBe('win');
    expect(outcomeFor('1-0', 'b')).toBe('loss');
    expect(outcomeFor('0-1', 'b')).toBe('win');
    expect(outcomeFor('1/2-1/2', 'w')).toBe('draw');
    expect(outcomeFor('*', 'b')).toBe('unfinished');
  });
});
