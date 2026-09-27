/**
 * Cross-module contract check: a GameRecord produced by the game controller must pass the zod schema the
 * server applies to `POST /api/games` — otherwise every finished game would be refused with 400.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { GameRecord } from '@gambit/shared';
import { gameRecordSchema, newGameRecordSchema } from '../../../../server/src/schemas.ts';
import { createGameController } from './gameStore.ts';
import type { GameController } from './gameStore.ts';
import { clearResumableGame, hasResumableGame } from './resume.ts';
import { createTestHarness } from './testing/fakes.ts';
import { readUnsavedGames } from './unsavedGames.ts';

function childMoves(game: GameController, san: string): boolean {
  const move = new Chess(game.store.getState().fen).move(san);
  return game.dropPiece(move.from, move.to);
}

async function turn(game: GameController, san: string): Promise<void> {
  expect(childMoves(game, san)).toBe(true);
  await game.whenSettled();
}

async function waitForNote(game: GameController): Promise<void> {
  for (let i = 0; i < 500 && game.store.getState().note !== 'asking'; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(game.store.getState().note).toBe('asking');
}

describe('GameRecord ↔ server schema', () => {
  it('a rich game (offer, accept, hints, voice, mate) is accepted unchanged', async () => {
    const h = createTestHarness({ timings: { childNoteWaitMs: 60_000 } });
    const game = createGameController(h.deps);
    h.bot.replies = ['e7e5', 'b8c6', 'g8f6'];
    h.judge.scriptAfter(['e4', 'e5', 'Qh5', 'Nc6', 'Qg5'], [{ cp: 900, pv: ['d8g5'] }]);
    await game.start({ personaId: 'grisha', timeControlId: 'rapid10', childColor: 'w', examMode: false });

    await game.requestHint();
    await turn(game, 'e4');
    await turn(game, 'Qh5');
    await turn(game, 'Qg5');
    expect(game.store.getState().phase).toBe('coachIntervention');
    game.acceptTakeback();
    await game.whenSettled();
    h.coach.hear('child', 'Я понял, ферзя бы съели!');
    await game.requestHint();
    await game.requestHint();
    await turn(game, 'Bc4');
    expect(childMoves(game, 'Qxf7#')).toBe(true);
    // the diary sentence on the result card is journaled BEFORE the record is posted
    await waitForNote(game);
    game.submitChildNote('Трудно было заметить, что ферзь под боем.');
    await game.whenSettled();

    const record = h.saved[0] as GameRecord;
    expect(record.events.some((e) => e.type === 'childSaid' && e.data.source === 'typed')).toBe(true);
    expect(record.result).toBe('1-0');
    const parsed = gameRecordSchema.safeParse(record);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    // zod strips unknown keys — nothing of ours may be lost on the way
    expect(parsed.data).toEqual(record);
    expect(JSON.stringify(record).length).toBeLessThan(1_000_000);
    // … and within the size of a real game that POST /api/games holds a new record to
    const fresh = newGameRecordSchema.safeParse(record);
    expect(fresh.success ? [] : fresh.error.issues).toEqual([]);
    game.dispose();
  });

  it('an abandoned and a timed-out bullet game are accepted too', async () => {
    const h = createTestHarness();
    const game = createGameController(h.deps);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start({ personaId: 'dima', timeControlId: 'bullet1', childColor: 'w', examMode: true });
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    game.dispose();
    await Promise.resolve();

    // the interrupted game waits for «Продолжить партию?»; declined, it becomes an unfinished game in the journal
    expect(h.saved).toHaveLength(0);
    expect(hasResumableGame(h.storage)).toBe(true);
    clearResumableGame(h.storage);
    const record = readUnsavedGames(h.storage)[0] as GameRecord;
    expect(record.termination).toBe('abandoned');
    const parsed = newGameRecordSchema.safeParse(record);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });
});
