import { describe, expect, it, vi } from 'vitest';
import { SOUND_NAMES, SOUND_RECIPES, createSoundPlayer, recipeDuration } from './sounds.ts';

class FakeParam {
  value = 0;
  events: { kind: string; value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number) {
    this.events.push({ kind: 'set', value, time });
    this.value = value;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ kind: 'linear', value, time });
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.events.push({ kind: 'exp', value, time });
  }
  setTargetAtTime(value: number, time: number) {
    this.events.push({ kind: 'target', value, time });
    this.value = value;
  }
}

class FakeNode {
  connections: unknown[] = [];
  connect(target: unknown) {
    this.connections.push(target);
  }
  disconnect() {
    this.connections = [];
  }
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  frequency = new FakeParam();
  onended: (() => void) | null = null;
  started: number | null = null;
  stopped: number | null = null;
  start(t: number) {
    this.started = t;
  }
  stop(t: number) {
    this.stopped = t;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeBufferSource extends FakeOscillator {
  buffer: unknown = null;
}

class FakeContext {
  state: 'suspended' | 'running' | 'closed';
  currentTime = 10;
  sampleRate = 8000;
  destination = new FakeNode();
  oscillators: FakeOscillator[] = [];
  gains: FakeGain[] = [];
  sources: FakeBufferSource[] = [];
  resumeCalls = 0;
  resumeImpl: () => Promise<void> = async () => {
    this.state = 'running';
  };
  constructor(state: 'suspended' | 'running' = 'running') {
    this.state = state;
  }
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createOscillator() {
    const o = new FakeOscillator();
    this.oscillators.push(o);
    return o;
  }
  createBufferSource() {
    const s = new FakeBufferSource();
    this.sources.push(s);
    return s;
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: 'lowpass', frequency: new FakeParam(), Q: new FakeParam() });
  }
  createDynamicsCompressor() {
    return Object.assign(new FakeNode(), { threshold: new FakeParam(), knee: new FakeParam(), ratio: new FakeParam(), attack: new FakeParam(), release: new FakeParam() });
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  resume() {
    this.resumeCalls++;
    return this.resumeImpl();
  }
  async close() {
    this.state = 'closed';
  }
}

function setup(state: 'suspended' | 'running' = 'running', options: { muted?: boolean } = {}) {
  const ctx = new FakeContext(state);
  const createContext = vi.fn(() => ctx as unknown as AudioContext);
  const player = createSoundPlayer({ createContext, random: () => 0.5, ...options });
  return { ctx, createContext, player };
}

describe('sound recipes', () => {
  it('defines every sound named in the architecture (+ star)', () => {
    expect([...SOUND_NAMES].sort()).toEqual(['capture', 'check', 'click', 'lose', 'move', 'oops', 'star', 'win']);
    for (const name of SOUND_NAMES) expect(SOUND_RECIPES[name].tones.length).toBeGreaterThan(0);
  });

  it('keeps board sounds short and the jingle under two seconds', () => {
    expect(recipeDuration(SOUND_RECIPES.move)).toBeLessThan(0.3);
    expect(recipeDuration(SOUND_RECIPES.capture)).toBeLessThan(0.3);
    expect(recipeDuration(SOUND_RECIPES.check)).toBeLessThan(0.3);
    expect(recipeDuration(SOUND_RECIPES.click)).toBeLessThan(0.1);
    expect(recipeDuration(SOUND_RECIPES.win)).toBeLessThanOrEqual(2);
    expect(recipeDuration(SOUND_RECIPES.lose)).toBeLessThan(1);
  });

  it('never uses harsh waveforms or loud gains', () => {
    for (const name of SOUND_NAMES) {
      for (const tone of SOUND_RECIPES[name].tones) {
        expect(['sine', 'triangle']).toContain(tone.type);
        expect(tone.gain).toBeLessThanOrEqual(1);
        expect(tone.decay).toBeGreaterThan(0);
      }
    }
  });
});

describe('createSoundPlayer', () => {
  it('creates the AudioContext lazily, on the first play', () => {
    const { createContext, player } = setup();
    expect(createContext).not.toHaveBeenCalled();
    expect(player.play('move')).toBe(true);
    expect(player.play('capture')).toBe(true);
    expect(createContext).toHaveBeenCalledTimes(1);
  });

  it('schedules one oscillator per tone and one buffer source per noise burst, in the future', () => {
    const { ctx, player } = setup();
    player.play('capture');
    const recipe = SOUND_RECIPES.capture;
    expect(ctx.oscillators).toHaveLength(recipe.tones.length);
    expect(ctx.sources).toHaveLength(recipe.noises?.length ?? 0);
    for (const osc of ctx.oscillators) {
      expect(osc.started).toBeGreaterThan(ctx.currentTime);
      expect(osc.stopped).toBeGreaterThan(osc.started as number);
    }
  });

  it('does nothing while muted and resumes normally after unmuting', () => {
    const { ctx, createContext, player } = setup('running', { muted: true });
    expect(player.isMuted()).toBe(true);
    expect(player.play('win')).toBe(false);
    expect(createContext).not.toHaveBeenCalled();
    player.setMuted(false);
    expect(player.play('win')).toBe(true);
    expect(ctx.oscillators.length).toBeGreaterThan(0);
  });

  it('routes everything through a master gain that follows volume, ducking and mute', () => {
    const { ctx, player } = setup();
    player.setVolume(0.5);
    player.play('click');
    const master = ctx.gains[0] as FakeGain;
    expect(master.gain.value).toBeCloseTo(0.5);
    player.setDucked(true);
    expect(master.gain.value).toBeCloseTo(0.15);
    player.setDucked(false);
    expect(master.gain.value).toBeCloseTo(0.5);
    player.setMuted(true);
    expect(master.gain.value).toBe(0);
    player.setVolume(7);
    expect(player.getVolume()).toBe(1);
  });

  it('on a locked context asks to resume and plays only if that happens right away', async () => {
    const { ctx, player } = setup('suspended');
    expect(player.play('move')).toBe(false);
    expect(ctx.resumeCalls).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.oscillators).toHaveLength(SOUND_RECIPES.move.tones.length);
  });

  it('drops a sound that became stale while the context was locked', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, player } = setup('suspended');
      let release: () => void = () => undefined;
      ctx.resumeImpl = () =>
        new Promise<void>((resolve) => {
          release = () => {
            ctx.state = 'running';
            resolve();
          };
        });
      expect(player.play('check')).toBe(false);
      vi.setSystemTime(Date.now() + 5_000);
      release();
      await Promise.resolve();
      await Promise.resolve();
      expect(ctx.oscillators).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unlock() resumes the context and reports whether audio runs', async () => {
    const { ctx, player } = setup('suspended');
    await expect(player.unlock()).resolves.toBe(true);
    expect(ctx.state).toBe('running');
  });

  it('is a silent no-op when WebAudio is unavailable', async () => {
    const player = createSoundPlayer({ createContext: () => null });
    expect(player.play('move')).toBe(false);
    await expect(player.unlock()).resolves.toBe(false);
    expect(() => player.setDucked(true)).not.toThrow();
    expect(() => player.dispose()).not.toThrow();
  });

  it('applies a small pitch jitter to wooden sounds only', () => {
    const ctx = new FakeContext();
    const player = createSoundPlayer({ createContext: () => ctx as unknown as AudioContext, random: () => 1 });
    player.play('move');
    const thump = ctx.oscillators[0] as FakeOscillator;
    expect(thump.frequency.events[0]?.value).toBeCloseTo(220 * 1.05);
    player.play('check');
    const bell = ctx.oscillators[SOUND_RECIPES.move.tones.length] as FakeOscillator;
    expect(bell.frequency.events[0]?.value).toBeCloseTo(880);
  });
});
