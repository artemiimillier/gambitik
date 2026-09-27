/** Signal analysis on synthetic PCM (no ffmpeg): silences, splitting, breaths, pause clamps, F0, text measures. */
import { describe, expect, it } from 'vitest';
import {
  applyFades,
  articulationMs,
  clampInnerPauses,
  frameLevels,
  hfRatio,
  innerSilences,
  pitchStats,
  soundSpan,
  speechChars,
  splitAtSilences,
  stripEdgeBreaths,
  syllables,
  withMargins,
} from './dsp.ts';
import { tempoDecision, unitEnd } from './process.ts';
import { RATE, concat, ms, noise, silence, tone } from './testkit.ts';

describe('levels and silences at −55 dBFS', () => {
  it('finds the sound span and inner silences', () => {
    const pcm = concat(silence(200), tone(220, 500), silence(300), tone(220, 400), silence(100));
    const span = soundSpan(pcm, RATE)!;
    expect(ms(span.start)).toBeCloseTo(200, -1);
    expect(ms(span.end)).toBeCloseTo(1400, -1);
    const inner = innerSilences(pcm, RATE);
    expect(inner).toHaveLength(1);
    expect(ms(inner[0]!.end - inner[0]!.start)).toBeGreaterThan(280);
    expect(soundSpan(silence(300), RATE)).toBeNull();
  });

  it('a −50 dBFS consonant tail is sound, the −66 dBFS floor is silence', () => {
    const { levels } = frameLevels(concat(noise(100, -50), noise(100, -66)), RATE);
    expect(levels[3]).toBeGreaterThan(-55);
    expect(levels[15]).toBeLessThan(-55);
  });
});

describe('splitting a take', () => {
  const take = concat(silence(100), tone(220, 600), silence(750), tone(200, 500), silence(150), tone(200, 400), silence(750), tone(180, 700), silence(100));

  it('tags: every gap ≥ 550 ms is a boundary, cut in the middle of the gap', () => {
    const split = splitAtSilences(take, RATE, 3, 'tags', 550);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.segments).toHaveLength(3);
    expect(ms(split.segments[0]!.end)).toBeCloseTo(100 + 600 + 375, -1);
    expect(split.segments[2]!.end).toBe(take.length);
  });

  it('tags: a count that does not match the pieces is a mismatch (the job is re-queued)', () => {
    expect(splitAtSilences(take, RATE, 2, 'tags', 550)).toEqual({ ok: false, found: 3, expected: 2 });
    expect(splitAtSilences(take, RATE, 5, 'tags', 550)).toEqual({ ok: false, found: 3, expected: 5 });
  });

  it('a click after the last unit is not a piece (take M ends in a 20 ms blip at −44 dBFS after 560 ms of silence)', () => {
    const clicked = concat(take, silence(460), noise(20, -44, 3), silence(40));
    const split = splitAtSilences(clicked, RATE, 3, 'tags', 550);
    expect(split.ok).toBe(true);
    const leading = concat(silence(40), noise(20, -44, 4), silence(600), take);
    expect(splitAtSilences(leading, RATE, 3, 'tags', 550).ok).toBe(true);
  });

  it('longest: a head recipe is cut at its longest natural pause', () => {
    const head = concat(silence(50), tone(250, 700), silence(280), tone(200, 900), silence(50));
    const split = splitAtSilences(head, RATE, 2, 'longest', 150);
    expect(split.ok).toBe(true);
    if (split.ok) expect(ms(split.segments[0]!.end)).toBeCloseTo(50 + 700 + 140, -1);
  });
});

describe('breaths at unit edges', () => {
  it('a separate, quiet, noisy island at the edge is dropped', () => {
    const pcm = concat(silence(50), noise(160, -46, 7), silence(150), tone(220, 800), silence(50));
    const span = soundSpan(pcm, RATE)!;
    const kept = stripEdgeBreaths(pcm, RATE, span);
    expect(ms(kept.start)).toBeGreaterThan(350);
    expect(ms(kept.end)).toBeCloseTo(1160, -1);
  });

  it('a trailing breath after the speech is dropped as well', () => {
    const pcm = concat(silence(50), tone(220, 800), silence(120), noise(150, -47, 3), silence(50));
    const kept = stripEdgeBreaths(pcm, RATE, soundSpan(pcm, RATE)!);
    expect(ms(kept.end)).toBeLessThan(870);
  });

  it('a quiet click well after the speech is dropped; a loud or close one is kept', () => {
    const click = concat(silence(50), tone(220, 800), silence(560), noise(20, -44, 3), silence(40));
    expect(ms(stripEdgeBreaths(click, RATE, soundSpan(click, RATE)!).end)).toBeCloseTo(850, -1);
    const loud = concat(silence(50), tone(220, 800), silence(560), noise(20, -25, 3), silence(40));
    expect(stripEdgeBreaths(loud, RATE, soundSpan(loud, RATE)!)).toEqual(soundSpan(loud, RATE));
    const close = concat(silence(50), tone(220, 800), silence(90), noise(20, -44, 3), silence(40));
    expect(stripEdgeBreaths(close, RATE, soundSpan(close, RATE)!)).toEqual(soundSpan(close, RATE));
  });

  it('a word-final consonant attached to the word, a loud island or a voiced one are kept', () => {
    const attached = concat(silence(50), tone(220, 800), noise(120, -45, 5), silence(50));
    expect(stripEdgeBreaths(attached, RATE, soundSpan(attached, RATE)!)).toEqual(soundSpan(attached, RATE));
    const loud = concat(silence(50), noise(160, -30, 9), silence(150), tone(220, 800), silence(50));
    expect(stripEdgeBreaths(loud, RATE, soundSpan(loud, RATE)!)).toEqual(soundSpan(loud, RATE));
    const voiced = concat(silence(50), tone(200, 160, 0.004), silence(150), tone(220, 800), silence(50));
    expect(stripEdgeBreaths(voiced, RATE, soundSpan(voiced, RATE)!)).toEqual(soundSpan(voiced, RATE));
  });

  it('white noise is high-frequency, a low tone is not', () => {
    expect(hfRatio(noise(200, -40), { start: 0, end: 6400 })).toBeGreaterThan(1.5);
    expect(hfRatio(tone(200, 200), { start: 0, end: 6400 })).toBeLessThan(0.05);
  });
});

describe('editing', () => {
  it('margins keep 30 / 60 ms and pad with silence where the source has none', () => {
    const pcm = concat(tone(220, 300));
    const out = withMargins(pcm, { start: 0, end: pcm.length }, 960, 1920);
    expect(out.length).toBe(pcm.length + 960 + 1920);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(0);
  });

  it('clamps an inner pause of 230 ms to 60 ms, leaves a 90 ms closure alone', () => {
    const pcm = concat(silence(30), tone(200, 400), silence(230), tone(200, 300), silence(90), tone(200, 200), silence(60));
    const { pcm: out, clamped } = clampInnerPauses(pcm, RATE, 120, 60);
    expect(clamped).toBe(1);
    expect(ms(pcm.length - out.length)).toBeGreaterThan(150);
    expect(ms(pcm.length - out.length)).toBeLessThan(180);
    const gaps = innerSilences(out, RATE).map((g) => ms(g.end - g.start));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(100);
  });

  it('fades start and end at zero', () => {
    const pcm = applyFades(new Float32Array(3200).fill(0.5), RATE);
    expect(pcm[0]).toBe(0);
    expect(pcm[3199]).toBe(0);
    expect(pcm[1600]).toBe(0.5);
  });
});

describe('F0', () => {
  it('tracks steady tones across the voice range without octave errors', () => {
    for (const hz of [150, 184, 242, 302, 400]) {
      const stats = pitchStats(concat(silence(50), tone(hz, 600), silence(50)), RATE);
      expect(Math.abs(stats.medianF0 - hz), `${hz} Hz`).toBeLessThan(hz * 0.02);
      expect(stats.voicedFraction).toBeGreaterThan(0.8);
    }
  });

  it('edge F0 is the end of the unit (a fall to 170 Hz)', () => {
    const stats = pitchStats(concat(tone(300, 500), tone(170, 300), silence(40)), RATE);
    expect(stats.edgeF0).toBeLessThan(180);
    expect(stats.medianF0).toBeGreaterThan(250);
  });

  it('noise is unvoiced', () => {
    expect(pitchStats(noise(400, -30), RATE).voicedFraction).toBeLessThan(0.2);
  });
});

describe('text measures and the tempo gate', () => {
  it('syllables are vowel letters, speech characters skip punctuation and tags', () => {
    expect(syllables('Смотри, тут подарок!')).toBe(6);
    expect(syllables('конём на эф шесть')).toBe(5);
    expect(syllables('Хм…')).toBe(0);
    expect(speechChars('Ходи конём на эф шесть — так мы давим на центр.')).toBe(44);
    expect(speechChars('Ого!<#0.6#>Ух ты!')).toBe(9);
  });

  it('articulation time leaves out pauses ≥ 100 ms', () => {
    const pcm = concat(silence(30), tone(200, 500), silence(300), tone(200, 500), silence(60));
    expect(articulationMs(pcm, RATE, 100)).toBeCloseTo(1000, -1);
  });

  it('inside 4.0 ± 0.6 syl/s nothing changes; outside, the take is pulled just inside within 0.8–1.3', () => {
    expect(tempoDecision(4.0)).toEqual({ factor: 1, inRange: true });
    expect(tempoDecision(3.4)).toEqual({ factor: 1, inRange: true });
    expect(tempoDecision(4.6)).toEqual({ factor: 1, inRange: true });
    const slow = tempoDecision(2.9); // K1 carrier: 2.9 syl/s
    expect(slow.inRange).toBe(true);
    expect(slow.factor).toBeCloseTo(3.5 / 2.9, 5);
    const fast = tempoDecision(5.5); // W_A whole sentence: 5.5 syl/s
    expect(fast.factor).toBeCloseTo(4.5 / 5.5, 5);
    expect(tempoDecision(1.7)).toEqual({ factor: 1.3, inRange: false }); // NB: needs a re-render
    expect(tempoDecision(7)).toEqual({ factor: 0.8, inRange: false });
    expect(tempoDecision(0)).toEqual({ factor: 1, inRange: true });
  });

  it('falling edge: slot units, lines ending in «.» or «—»; questions and exclamations are free', () => {
    expect(unitEnd({ key: 'slot:ins:n:f6', text: 'конём на эф шесть', kind: 'slot' })).toBe('fall');
    expect(unitEnd({ key: 'line:a#1', text: 'Мой совет —' })).toBe('fall');
    expect(unitEnd({ key: 'line:b#1', text: 'Соперник вывел коня.' })).toBe('fall');
    expect(unitEnd({ key: 'line:c#1', text: 'Найдёшь ход сам?' })).toBe('any');
    expect(unitEnd({ key: 'line:d#1', text: 'Ого!' })).toBe('any');
    expect(unitEnd({ key: 'line:e#1', text: 'Ого!', end: 'fall' })).toBe('fall');
  });
});
