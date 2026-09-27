import { describe, expect, it, vi } from 'vitest';
import type { CoachToolHost, HintLevel } from '@gambit/shared';
import { clampHintLevel, createHintLadder } from './hintLadder.ts';
import { makeEvent } from './testUtils.ts';

function makeHost(position: { current: string }, hostClamp?: HintLevel): CoachToolHost {
  return {
    getPositionSummary: vi.fn(() => Promise.resolve(position.current)),
    getHint: vi.fn((level: HintLevel) => Promise.resolve(makeEvent({ kind: 'hint', hintLevel: hostClamp ?? level }))),
    explainLastMove: vi.fn(() => Promise.resolve(null)),
    showOnBoard: vi.fn(),
    takeBackMove: vi.fn(() => false),
  };
}

describe('hint ladder (enforced in code, not by the prompt)', () => {
  it('clampHintLevel never allows more than one step above the last hint given', () => {
    expect(clampHintLevel(4, 0)).toBe(1);
    expect(clampHintLevel(4, 1)).toBe(2);
    expect(clampHintLevel(4, 3)).toBe(4);
    expect(clampHintLevel(4, 4)).toBe(4);
    expect(clampHintLevel(1, 3)).toBe(1);
    expect(clampHintLevel(2, 3)).toBe(2);
    expect(clampHintLevel(null, 0)).toBe(1);
    expect(clampHintLevel(null, 2)).toBe(3);
    expect(clampHintLevel(null, 4)).toBe(4);
  });

  it('walks 1 → 2 → 3 → 4 however greedy the request is, and starts over on a new position', async () => {
    const position = { current: 'Позиция один.' };
    const host = makeHost(position);
    const ladder = createHintLadder();
    const levels: number[] = [];
    for (let i = 0; i < 5; i++) levels.push((await ladder.give(host, 4)).level);
    expect(levels).toEqual([1, 2, 3, 4, 4]);

    position.current = 'Позиция два.';
    expect((await ladder.give(host, 4)).level).toBe(1);
    expect(ladder.lastLevel).toBe(1);
  });

  it('trusts the level the host really gave (exam mode keeps everything on step 1)', async () => {
    const host = makeHost({ current: 'Экзамен.' }, 1);
    const ladder = createHintLadder();
    await ladder.give(host, null);
    await ladder.give(host, null);
    const third = await ladder.give(host, 4);
    expect(third.level).toBe(1);
    expect(vi.mocked(host.getHint).mock.calls.map(([level]) => level)).toEqual([1, 2, 2]);
  });

  it('a failing position summary does not break hints; reset() starts over', async () => {
    const host = makeHost({ current: 'x' });
    host.getPositionSummary = () => Promise.reject(new Error('engine down'));
    const ladder = createHintLadder();
    expect((await ladder.give(host, 4)).level).toBe(1);
    expect((await ladder.give(host, 4)).level).toBe(2);
    ladder.reset();
    expect((await ladder.give(host, 4)).level).toBe(1);
  });
});
