import { describe, expect, it } from 'vitest';
import type { Puzzle } from '@gambit/shared';
import { openAppDb } from '../storage/db.ts';
import { Repo } from '../storage/repo.ts';
import { createTestServer } from '../testing/fixtures.ts';
import { GRADUATE_AFTER_DAYS, MistakeRepetition } from './repetition.ts';

const DAY = 86_400_000;

describe('MistakeRepetition (FSRS)', () => {
  it('schedules a failed puzzle for the next day and spaces it out while it keeps being solved', () => {
    const repetition = new MistakeRepetition(new Repo(openAppDb(':memory:')));
    const t0 = new Date('2026-09-21T10:00:00.000Z');
    repetition.recordAttempt('p1', { solved: false, hintsUsed: 0 }, t0);
    expect(repetition.due(t0, 5)).toEqual([]);
    expect(repetition.due(new Date(t0.getTime() + DAY), 5)).toEqual(['p1']);

    // solved on the next day: comes back a few days later, not tomorrow
    const t1 = new Date(t0.getTime() + DAY);
    repetition.recordAttempt('p1', { solved: true, hintsUsed: 0 }, t1);
    expect(repetition.due(new Date(t1.getTime() + DAY), 5)).toEqual([]);
    expect(repetition.due(new Date(t1.getTime() + 4 * DAY), 5)).toEqual(['p1']);

    // failing again brings it back quickly
    const t2 = new Date(t1.getTime() + 4 * DAY);
    repetition.recordAttempt('p1', { solved: false, hintsUsed: 0 }, t2);
    expect(repetition.due(new Date(t2.getTime() + DAY), 5)).toEqual(['p1']);
  });

  it('ignores clean first solves, keeps hinted ones, retires a card once the interval is long', () => {
    const repetition = new MistakeRepetition(new Repo(openAppDb(':memory:')));
    let now = new Date('2026-09-21T10:00:00.000Z');
    repetition.recordAttempt('clean', { solved: true, hintsUsed: 0 }, now);
    expect(repetition.count()).toBe(0);
    repetition.recordAttempt('hinted', { solved: true, hintsUsed: 2 }, now);
    expect(repetition.count()).toBe(1);

    for (let i = 0; i < 12 && repetition.count() > 0; i += 1) {
      now = new Date(now.getTime() + (GRADUATE_AFTER_DAYS + 40) * DAY);
      expect(repetition.due(now, 5)).toEqual(['hinted']);
      repetition.recordAttempt('hinted', { solved: true, hintsUsed: 0 }, now);
    }
    expect(repetition.count()).toBe(0);
  });

  it('orders by how overdue a card is and survives a malformed stored value', () => {
    const repo = new Repo(openAppDb(':memory:'));
    const repetition = new MistakeRepetition(repo);
    const t0 = new Date('2026-09-01T10:00:00.000Z');
    repetition.recordAttempt('older', { solved: false, hintsUsed: 0 }, t0);
    repetition.recordAttempt('newer', { solved: false, hintsUsed: 0 }, new Date(t0.getTime() + 2 * DAY));
    const later = new Date(t0.getTime() + 10 * DAY);
    expect(repetition.due(later, 5)).toEqual(['older', 'newer']);
    expect(repetition.due(later, 1)).toEqual(['older']);

    repo.savePuzzleRepetition({ cards: { broken: { due: 'not a date' }, alsoBroken: 7 } });
    expect(repetition.due(later, 5)).toEqual([]);
    repo.savePuzzleRepetition('garbage');
    expect(repetition.count()).toBe(0);
  });
});

describe('GET /api/puzzles/next with due repetitions', () => {
  it('re-serves a failed puzzle once it is due — as part of a normal batch', async () => {
    const server = await createTestServer();
    try {
      const first = ((await (await server.request('/api/puzzles/next?count=3')).json()) as Puzzle[])[0];
      if (first === undefined) throw new Error('no puzzles');
      const attempt = { puzzleId: first.id, solved: false, msSpent: 9_000, hintsUsed: 0, themes: first.themes, puzzleRating: first.rating };
      expect((await server.request('/api/puzzles/attempt', { method: 'POST', json: attempt })).status).toBe(200);
      expect(server.ctx.repetition.count()).toBe(1);

      // not due today: the puzzle was just seen, so it stays out of the next batch
      const today = (await (await server.request('/api/puzzles/next?count=6')).json()) as Puzzle[];
      expect(today.map((p) => p.id)).not.toContain(first.id);

      // make the card due (as if a day had passed) and ask again
      const raw = server.ctx.repo.loadPuzzleRepetitionRaw() as { cards: Record<string, { due: string }> };
      const card = raw.cards[first.id];
      if (card === undefined) throw new Error('no card');
      card.due = new Date(Date.now() - 1_000).toISOString();
      server.ctx.repo.savePuzzleRepetition(raw);

      const batch = (await (await server.request('/api/puzzles/next?count=6')).json()) as Puzzle[];
      expect(batch).toHaveLength(6);
      expect(batch.filter((p) => p.id === first.id)).toHaveLength(1);
      expect(new Set(batch.map((p) => p.id)).size).toBe(6);
      // a themed session only repeats puzzles of that theme
      const themed = (await (await server.request('/api/puzzles/next?theme=fork&count=6')).json()) as Puzzle[];
      if (!first.themes.includes('fork')) expect(themed.map((p) => p.id)).not.toContain(first.id);
    } finally {
      await server.cleanup();
    }
  });
});
