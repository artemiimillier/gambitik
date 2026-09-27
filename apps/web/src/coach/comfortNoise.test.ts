import { describe, expect, it } from 'vitest';
import { COMFORT_NOISE_GAIN, startComfortNoise } from './rtcSession.ts';

/** Minimal stand-in for the WebAudio graph: records what gets built and connected. */
function fakeContext() {
  const log: string[] = [];
  const channel = new Float32Array(48_000 * 2);
  const source = {
    buffer: null as unknown,
    loop: false,
    connect: (node: unknown) => log.push(`source→${(node as { name: string }).name}`),
    start: () => log.push('start'),
    stop: () => log.push('stop'),
  };
  const gainNode = {
    name: 'gain',
    gain: { value: 1 },
    connect: (node: unknown) => log.push(`gain→${(node as { name: string }).name}`),
  };
  const ctx = {
    sampleRate: 48_000,
    createBuffer: (_channels: number, length: number) => ({ length, getChannelData: () => channel }),
    createBufferSource: () => source,
    createGain: () => gainNode,
  };
  return { ctx, log, channel, source, gainNode };
}

describe('startComfortNoise — the Live model must never get pure digital silence', () => {
  it('feeds a looping, very quiet noise into the outgoing destination', () => {
    const { ctx, log, channel, source, gainNode } = fakeContext();
    const destination = { name: 'destination' };
    const started = startComfortNoise(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    expect(started).toBe(source);
    expect(source.loop).toBe(true);
    expect(gainNode.gain.value).toBe(COMFORT_NOISE_GAIN);
    expect(COMFORT_NOISE_GAIN).toBeLessThan(0.01);
    expect(log).toEqual(['source→gain', 'gain→destination', 'start']);
    // real noise, not zeros
    expect(channel.some((v) => v !== 0)).toBe(true);
    expect(channel.every((v) => v >= -1 && v <= 1)).toBe(true);
  });

  it('returns null instead of throwing when the browser cannot build it', () => {
    const broken = { sampleRate: 48_000, createBuffer: () => { throw new Error('nope'); } };
    expect(startComfortNoise(broken as unknown as BaseAudioContext, {} as AudioNode)).toBeNull();
  });
});
