/**
 * The «Записи» player (docs/voice-clips/SPEC.md §5.3, §5.5, §11): planned gaps and 5 ms raised-cosine fades, the audible
 * start and end (output latency included), an immediate stop, the gentle end after the sentence being heard, the
 * watchdog of a suspended context. A fake AudioContext on vi fake timers — nothing is ever audible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClipAudio } from './clipAudio.ts';
import type { ClipAudio } from './clipAudio.ts';
import { mouthEnvelope, playWindow } from './clipLibrary.ts';
import type { LoadedClip } from './clipLibrary.ts';
import { CLIP_WATCHDOG_EXTRA_MS, createClipPlayer } from './clipPlayer.ts';
import type { ClipPlayItem } from './clipPlayer.ts';
import { FakeAudioContext, decodeFakeClip, fakeClipBytes } from './testAudio.ts';
import type { FakeGain } from './testAudio.ts';

function loaded(id: string, ms: number): LoadedClip {
  const buffer = decodeFakeClip(fakeClipBytes({ ms, leadMs: 35, tailMs: 60 }));
  const w = playWindow(buffer, undefined);
  return { id, buffer, offsetSec: w.offsetSec, durSec: w.durSec, env: mouthEnvelope(buffer, w.offsetSec, w.durSec) };
}

interface Rig {
  ctx: FakeAudioContext;
  audio: ClipAudio;
  speaking: boolean[];
  levels: number[];
  frame: () => void;
}

function rig(opts: { latency?: number; state?: 'running' | 'suspended' } = {}): Rig & { player: ReturnType<typeof createClipPlayer> } {
  const ctx = new FakeAudioContext({ outputLatency: opts.latency ?? 0, state: opts.state ?? 'running' });
  const audio = createClipAudio({ createContext: () => ctx });
  const speaking: boolean[] = [];
  const levels: number[] = [];
  let onFrame: (now: number) => void = () => undefined;
  const player = createClipPlayer({
    audio,
    onSpeaking: (v) => speaking.push(v),
    onLevel: (v) => levels.push(v),
    createLoop: (cb) => {
      onFrame = cb;
      let running = false;
      return {
        start: () => {
          running = true;
        },
        stop: () => {
          running = false;
        },
        get running() {
          return running;
        },
      };
    },
  });
  return { ctx, audio, speaking, levels, frame: () => onFrame(0), player };
}

const items = (list: [string, number, number, number][]): ClipPlayItem[] => list.map(([id, ms, gapBeforeMs, sentence]) => ({ clip: loaded(id, ms), gapBeforeMs, sentence }));

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('clipPlayer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules clips back to back with the planned gaps, their audible windows and 5 ms raised-cosine fades', () => {
    const { ctx, player } = rig();
    const plan = items([
      ['c00000000000a1', 700, 0, 0],
      ['c00000000000a2', 1000, 280, 0],
      ['c00000000000a3', 1400, 280, 0],
    ]);
    const playback = player.play(plan);
    expect(playback).not.toBeNull();
    const [a, b, c] = ctx.played;
    expect(ctx.played).toHaveLength(3);
    const t0 = 0.03;
    const dur = (i: number): number => (plan[i] as ClipPlayItem).clip.durSec;
    expect(a?.started?.when).toBeCloseTo(t0, 6);
    expect(b?.started?.when).toBeCloseTo(t0 + dur(0) + 0.28, 6);
    expect(c?.started?.when).toBeCloseTo(t0 + dur(0) + 0.28 + dur(1) + 0.28, 6);
    // the audible window of the decoded take (lead silence skipped by the sample scan), never the whole file
    expect(a?.started?.offset).toBeGreaterThan(0.025);
    expect(a?.started?.offset).toBeLessThan(0.035);
    expect(a?.started?.duration).toBeCloseTo(dur(0), 6);
    // fades: a rising and a falling raised-cosine curve of 5 ms at the edges; the gain starts at 0
    const gain = ctx.gains.find((g) => g.gain.events.length > 0) as FakeGain;
    const curves = gain.gain.events.filter((e) => e.type === 'curve');
    expect(curves).toHaveLength(2);
    expect(curves[0]?.time).toBeCloseTo(t0, 6);
    expect(curves[0]?.duration).toBeCloseTo(0.005, 6);
    expect(curves[0]?.curve?.[0]).toBeCloseTo(0, 6);
    expect(curves[0]?.curve?.at(-1)).toBeCloseTo(1, 6);
    expect(curves[1]?.time).toBeCloseTo(t0 + dur(0) - 0.005, 6);
    expect(curves[1]?.curve?.at(-1)).toBeCloseTo(0, 6);
    expect(playback?.ms).toBe(Math.round((dur(0) + dur(1) + dur(2) + 0.56) * 1000));
  });

  it('speaking starts when the first sample is audible and ends at the last one + the output latency', async () => {
    const { speaking, player } = rig({ latency: 0.1 });
    const playback = player.play(items([['c00000000000b1', 500, 0, 0]]));
    let how: string | null = null;
    void playback?.ended.then((h) => {
      how = h;
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(speaking).toEqual([]);
    await vi.advanceTimersByTimeAsync(20); // 30 ms lead + 100 ms latency
    expect(speaking).toEqual([true]);
    const total = 30 + (playback?.ms ?? 0);
    await vi.advanceTimersByTimeAsync(total - 140 + 50);
    expect(how).toBeNull(); // the last sample left the context, the child still hears it (latency)
    await vi.advanceTimersByTimeAsync(80);
    expect(how).toBe('end');
    expect(speaking).toEqual([true, false]);
    expect(playback?.heardIds()).toEqual(['c00000000000b1']);
  });

  it('stop(): resolves at once, fades a playing clip out in 25 ms and cancels the ones not started yet', async () => {
    const { ctx, speaking, player } = rig();
    const playback = player.play(
      items([
        ['c00000000000c1', 800, 0, 0],
        ['c00000000000c2', 800, 450, 1],
      ]),
    );
    await vi.advanceTimersByTimeAsync(300);
    expect(speaking).toEqual([true]);
    playback?.stop();
    expect(speaking).toEqual([true, false]);
    await expect(playback?.ended).resolves.toBe('stop');
    const [first, second] = ctx.played;
    // playing: held and ramped to zero, stopped 25 ms later; waiting: stopped before it ever starts
    expect(first?.stoppedAt).toBeCloseTo(0.3 + 0.025, 3);
    const firstGain = ctx.gains.find((g) => g.gain.events.some((e) => e.type === 'hold')) as FakeGain;
    expect(firstGain.gain.events.at(-1)).toMatchObject({ type: 'ramp', value: 0 });
    expect(second?.stoppedAt).toBeCloseTo(0.3, 3);
    expect(playback?.heardIds()).toEqual(['c00000000000c1']);
    expect(playback?.msToSentenceEnd()).toBeNull();
  });

  it('endAfterSentence(): the sentence being heard finishes, later ones never sound; msToSentenceEnd is exact', async () => {
    const { ctx, player } = rig({ latency: 0.05 });
    const plan = items([
      ['c00000000000d1', 600, 0, 0],
      ['c00000000000d2', 700, 280, 0],
      ['c00000000000d3', 900, 450, 1],
    ]);
    const playback = player.play(plan);
    // nothing audible yet: no sentence to end, the caller cuts instead
    expect(playback?.msToSentenceEnd()).toBeNull();
    expect(playback?.endAfterSentence()).toBe(false);
    await vi.advanceTimersByTimeAsync(700);
    const d = (i: number): number => (plan[i] as ClipPlayItem).clip.durSec;
    const sentence0End = 0.03 + d(0) + 0.28 + d(1);
    const heard = 0.7 - 0.05;
    expect(playback?.msToSentenceEnd()).toBe(Math.round((sentence0End - heard) * 1000));
    let how: string | null = null;
    void playback?.ended.then((h) => {
      how = h;
    });
    expect(playback?.endAfterSentence()).toBe(true);
    const third = ctx.played[2];
    expect(third?.stoppedAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(Math.ceil((sentence0End - 0.7) * 1000) - 5);
    expect(how).toBeNull();
    await vi.advanceTimersByTimeAsync(60);
    expect(how).toBe('grace');
    expect(playback?.heardIds()).toEqual(['c00000000000d1', 'c00000000000d2']);
  });

  it('in the gap after a sentence, endAfterSentence ends right away', async () => {
    const { player } = rig();
    const plan = items([
      ['c00000000000e1', 300, 0, 0],
      ['c00000000000e2', 300, 450, 1],
    ]);
    const playback = player.play(plan);
    await vi.advanceTimersByTimeAsync(Math.round((0.03 + (plan[0] as ClipPlayItem).clip.durSec) * 1000) + 100);
    expect(playback?.msToSentenceEnd()).toBe(0);
    expect(playback?.endAfterSentence()).toBe(true);
    await settle();
    await expect(playback?.ended).resolves.toBe('grace');
  });

  it('a context suspended mid-phrase never hangs: the watchdog ends it at ms + 1.5 s', async () => {
    const { ctx, speaking, player } = rig();
    const playback = player.play(items([['c00000000000f1', 1000, 0, 0]]));
    let how: string | null = null;
    void playback?.ended.then((h) => {
      how = h;
    });
    await vi.advanceTimersByTimeAsync(200);
    ctx.setState('interrupted');
    await vi.advanceTimersByTimeAsync((playback?.ms ?? 0) + 30 - 200 + CLIP_WATCHDOG_EXTRA_MS - 10);
    expect(how).toBeNull();
    await vi.advanceTimersByTimeAsync(20);
    expect(how).toBe('watchdog');
    expect(speaking.at(-1)).toBe(false);
  });

  it('never plays into a suspended context (the voice keeps silent timing)', () => {
    const { ctx, player } = rig({ state: 'suspended' });
    expect(player.play(items([['c00000000000g1', 500, 0, 0]]))).toBeNull();
    expect(ctx.played).toHaveLength(0);
  });

  it('the mouth follows the clip envelope while it is heard, and closes at the end', async () => {
    const r = rig();
    const playback = r.player.play(items([['c00000000000h1', 600, 0, 0]]));
    await vi.advanceTimersByTimeAsync(300);
    r.frame();
    r.frame();
    expect(Math.max(...r.levels)).toBeGreaterThan(0.3);
    playback?.stop();
    expect(r.levels.at(-1)).toBe(0);
  });

  it('a new utterance stops the one still playing', async () => {
    const { player } = rig();
    const first = player.play(items([['c00000000000i1', 2000, 0, 0]]));
    await vi.advanceTimersByTimeAsync(100);
    player.play(items([['c00000000000i2', 300, 0, 0]]));
    await expect(first?.ended).resolves.toBe('stop');
  });
});
