/**
 * The «Записи» demo replay (docs/voice-clips/demo-format.md): the file format is checked move by move; the replay says
 * the harvested events in order, holds the child's clock exactly while a phrase is being said (5 / 10 minutes: any
 * phrase), and a child move that comes while Гамбитик speaks is a gentle stop — as in the real game.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoachEvent } from '@gambit/shared';
import { createDemoReplay, parseClipsDemo, sampleClipsDemo } from './clipsDemo.ts';
import type { DemoState } from './clipsDemo.ts';

describe('the demo file', () => {
  it('the built-in sample is a valid, legal game', () => {
    const { demo, problems } = parseClipsDemo(JSON.parse(JSON.stringify(sampleClipsDemo())));
    expect(problems).toEqual([]);
    expect(demo?.plies.map((p) => p.uci)).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
    expect(demo?.intro?.map((s) => s.event.kind)).toEqual(['greeting', 'teachTurn']);
  });

  it('an illegal move, a move out of turn or a broken event is reported; the rest stays replayable', () => {
    const raw = JSON.parse(JSON.stringify(sampleClipsDemo())) as Record<string, unknown> & { plies: Record<string, unknown>[] };
    raw.plies[2] = { by: 'child', uci: 'e1e5' };
    const { demo, problems } = parseClipsDemo(raw);
    expect(problems).toEqual(['plies[2]: illegal e1e5']);
    expect(demo?.plies).toHaveLength(2);
    const outOfTurn = JSON.parse(JSON.stringify(sampleClipsDemo())) as { plies: Record<string, unknown>[] };
    outOfTurn.plies[0] = { by: 'bot', uci: 'e2e4' };
    expect(parseClipsDemo(outOfTurn).problems[0]).toMatch(/bot moves on child's turn/);
    expect(parseClipsDemo({ v: 2 }).demo).toBeNull();
    expect(parseClipsDemo({ v: 1, seed: '../x', timeControlId: 'blitz5', childColor: 'w', plies: [] }).problems).toContain('seed');
  });
});

describe('the replay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function run(opts: { sayMs: number }) {
    const said: CoachEvent[] = [];
    const states: DemoState[] = [];
    let audible = 0;
    const graceStops: number[] = [];
    const replay = createDemoReplay({
      demo: sampleClipsDemo(),
      say(event) {
        said.push(event);
        audible += 1;
        return new Promise((resolve) =>
          setTimeout(() => {
            audible -= 1;
            resolve();
          }, opts.sayMs),
        );
      },
      stopSpeaking: () => graceStops.push(Date.now()),
      speaking: () => audible > 0,
      onState: (s) => states.push(s),
    });
    return { replay, said, states, graceStops, last: () => states.at(-1) as DemoState };
  }

  it('says the harvested events in order and plays every move', async () => {
    const r = run({ sayMs: 500 });
    r.replay.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.said.map((e) => e.id)).toEqual(['sample-hello', 'sample-t1', 'sample-t2', 'sample-praise']);
    expect(r.last().status).toBe('done');
    expect(r.last().ply).toBe(4);
    expect(r.last().fen).toBe('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
    expect(r.graceStops).toEqual([]);
  });

  it('the child\'s clock stands exactly while a phrase is being said (5 minutes: any phrase)', async () => {
    const r = run({ sayMs: 3000 });
    r.replay.start();
    // greeting + teach turn are said in the child's first turn: at 0.15 s and 0.3 s, 3 s each
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.last().held).toBe(true);
    await vi.advanceTimersByTimeAsync(1900);
    // the child moved at 2.8 s (0.3 s + 2.5 s of thinking) while the teach turn was still audible
    expect(r.graceStops).toHaveLength(1);
    const afterMove = r.states.find((s) => s.ply === 1) as DemoState;
    // it ran only from 0 to 0.15 s (before the first phrase) — nothing while he spoke
    expect(afterMove.childMs).toBe(5 * 60_000 - 150);
  });

  it('pause stops everything (the clock too); resume goes on where it was', async () => {
    const r = run({ sayMs: 100 });
    r.replay.start();
    await vi.advanceTimersByTimeAsync(1000);
    r.replay.pause();
    const paused = r.last();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.last().ply).toBe(paused.ply);
    expect(r.last().childMs).toBe(paused.childMs);
    r.replay.resume();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.last().status).toBe('done');
    r.replay.stop();
    expect(r.last().status).toBe('stopped');
  });
});
