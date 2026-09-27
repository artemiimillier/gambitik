/**
 * The child's thoughts after a game's record went out (./thoughts.ts): the server's shape and limits, parking in
 * localStorage, the delivery order and what a refusal means. The game's own wiring is tested in
 * gameStore.hardening.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { GameThought } from '@gambit/shared';
import { MemoryStorage } from './testing/fakes.ts';
import {
  MAX_PARKED_THOUGHT_GAMES,
  THOUGHTS_PER_GAME,
  THOUGHTS_PER_REQUEST,
  UNSENT_THOUGHTS_KEY,
  createThoughtsOutbox,
  flushParkedThoughts,
  makeThought,
  parkThoughts,
  readParkedThoughts,
} from './thoughts.ts';

const AT = new Date('2026-09-23T18:00:00Z');

function thought(id: string, text = `мысль ${id}`): GameThought {
  return makeThought({ id, source: 'voice', text, at: AT }) as GameThought;
}

const refused = (status: number): Error => Object.assign(new Error(`http ${status}`), { status });

describe('makeThought — the server\'s shape and limits', () => {
  it('tidies the text, cuts it to 600 and the question to 300, leaves out an empty question', () => {
    expect(makeThought({ id: 'g-1-t1', source: 'typed', text: '  Трудно   было ', question: '  ', at: AT })).toEqual({ id: 'g-1-t1', source: 'typed', text: 'Трудно было', at: AT.toISOString() });
    const long = makeThought({ id: 'g-1-t2', source: 'voice', text: 'я'.repeat(700), question: `${'в'.repeat(400)}?`, at: AT });
    expect(long?.text).toHaveLength(600);
    expect(long?.question).toHaveLength(300);
    expect(makeThought({ id: 'g-1-t3', source: 'voice', text: '   ', at: AT })).toBeNull();
    expect(makeThought({ id: 'bad id!', source: 'voice', text: 'да', at: AT })).toBeNull();
  });
});

describe('parking and the delivery at the next game start', () => {
  it('parks by game, merges by id, keeps ≤ 60 a game and the newest five games', () => {
    const storage = new MemoryStorage();
    expect(parkThoughts(storage, 'g-a', [thought('g-a-t1'), thought('g-a-t2')])).toBe(true);
    parkThoughts(storage, 'g-a', [thought('g-a-t2'), thought('g-a-t3')]);
    expect(readParkedThoughts(storage).map((g) => [g.gameId, g.thoughts.map((t) => t.id)])).toEqual([['g-a', ['g-a-t1', 'g-a-t2', 'g-a-t3']]]);
    parkThoughts(storage, 'g-b', Array.from({ length: 70 }, (_, i) => thought(`g-b-t${i}`)));
    expect(readParkedThoughts(storage).find((g) => g.gameId === 'g-b')?.thoughts).toHaveLength(THOUGHTS_PER_GAME);
    for (const id of ['g-c', 'g-d', 'g-e', 'g-f']) parkThoughts(storage, id, [thought(`${id}-t1`)]);
    const games = readParkedThoughts(storage).map((g) => g.gameId);
    expect(games).toHaveLength(MAX_PARKED_THOUGHT_GAMES);
    expect(games).not.toContain('g-a');
    // a broken entry is ignored, a blocked localStorage says so
    storage.setItem(UNSENT_THOUGHTS_KEY, '{"oops":1}');
    expect(readParkedThoughts(storage)).toEqual([]);
    storage.failWrites = true;
    expect(parkThoughts(storage, 'g-x', [thought('g-x-t1')])).toBe(false);
  });

  it('sends ≤ 20 at a time and removes what went out; a network failure stops the pass, a 4xx drops that game', async () => {
    const storage = new MemoryStorage();
    parkThoughts(storage, 'g-old', [thought('g-old-t1')]);
    parkThoughts(storage, 'g-new', Array.from({ length: 25 }, (_, i) => thought(`g-new-t${i}`)));
    const calls: [string, number][] = [];
    const sent = await flushParkedThoughts(storage, (gameId, list) => {
      calls.push([gameId, list.length]);
      return gameId === 'g-old' ? Promise.reject(refused(409)) : Promise.resolve();
    });
    expect(calls).toEqual([['g-old', 1], ['g-new', THOUGHTS_PER_REQUEST], ['g-new', 5]]);
    expect(sent).toBe(25);
    expect(storage.getItem(UNSENT_THOUGHTS_KEY)).toBeNull();

    parkThoughts(storage, 'g-down', [thought('g-down-t1'), thought('g-down-t2')]);
    expect(await flushParkedThoughts(storage, () => Promise.reject(new Error('network')))).toBe(0);
    expect(readParkedThoughts(storage)[0]?.thoughts).toHaveLength(2);
  });
});

describe('the outbox of one finished game', () => {
  it('waits for the record; sends after «saved», parks after «local» and on close', async () => {
    const storage = new MemoryStorage();
    const calls: string[][] = [];
    const send = (_gameId: string, list: GameThought[]): Promise<void> => {
      calls.push(list.map((t) => t.id));
      return Promise.resolve();
    };
    const box = createThoughtsOutbox({ gameId: 'g-1', send, storage, delayMs: 60_000 });
    box.add(thought('g-1-t1'));
    await box.flush();
    expect(calls).toEqual([]); // the game is not on the server yet
    box.recordDelivered('saved');
    box.add(thought('g-1-t2'));
    await box.flush();
    expect(calls).toEqual([['g-1-t1', 'g-1-t2']]);

    const parked = createThoughtsOutbox({ gameId: 'g-2', send, storage });
    parked.add(thought('g-2-t1'));
    parked.recordDelivered('local'); // the record itself is parked: its thoughts wait with it
    parked.add(thought('g-2-t2'));
    expect(readParkedThoughts(storage).find((g) => g.gameId === 'g-2')?.thoughts.map((t) => t.id)).toEqual(['g-2-t1', 'g-2-t2']);

    const closed = createThoughtsOutbox({ gameId: 'g-3', send, storage, delayMs: 60_000 });
    closed.recordDelivered('saved');
    closed.add(thought('g-3-t1'));
    closed.close();
    expect(readParkedThoughts(storage).find((g) => g.gameId === 'g-3')?.thoughts.map((t) => t.id)).toEqual(['g-3-t1']);
  });

  it('a network failure parks them; a refusal drops them and everything after', async () => {
    const storage = new MemoryStorage();
    let fail: Error | null = new Error('network');
    const box = createThoughtsOutbox({ gameId: 'g-4', send: () => (fail ? Promise.reject(fail) : Promise.resolve()), storage, delayMs: 60_000 });
    box.recordDelivered('saved');
    box.add(thought('g-4-t1'));
    await box.flush();
    expect(readParkedThoughts(storage)[0]?.thoughts.map((t) => t.id)).toEqual(['g-4-t1']);

    storage.removeItem(UNSENT_THOUGHTS_KEY);
    fail = refused(404);
    box.add(thought('g-4-t2'));
    await box.flush();
    box.add(thought('g-4-t3'));
    await box.flush();
    box.close();
    expect(storage.getItem(UNSENT_THOUGHTS_KEY)).toBeNull();
  });
});
