import { describe, expect, it, vi } from 'vitest';
import {
  clamp01,
  computeRms,
  createEmitter,
  createMouthEnvelope,
  estimateSpeechMs,
  paginateBubble,
  rmsToMouthTarget,
  smoothLevel,
  splitIntoSentences,
} from './voiceUtils.ts';

describe('createEmitter', () => {
  it('delivers values, unsubscribes and survives a throwing listener', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const emitter = createEmitter<number>();
    const seen: number[] = [];
    emitter.on(() => {
      throw new Error('boom');
    });
    const off = emitter.on((v) => seen.push(v));
    emitter.emit(1);
    off();
    emitter.emit(2);
    expect(seen).toEqual([1]);
    expect(emitter.size).toBe(1);
    expect(errors).toHaveBeenCalled();
    emitter.clear();
    expect(emitter.size).toBe(0);
  });
});

describe('splitIntoSentences', () => {
  it('splits Russian text by sentence and keeps the punctuation', () => {
    expect(splitIntoSentences('Стоп-стоп! Подожди. Давай вернём ход и подумаем ещё разок? Хорошо…')).toEqual([
      'Стоп-стоп!',
      'Подожди.',
      'Давай вернём ход и подумаем ещё разок?',
      'Хорошо…',
    ]);
  });

  it('normalises whitespace and ignores empty / punctuation-only input', () => {
    expect(splitIntoSentences('  Привет,\n\n  друг!  ')).toEqual(['Привет, друг!']);
    expect(splitIntoSentences('')).toEqual([]);
    expect(splitIntoSentences(' … !!! ')).toEqual([]);
  });

  it('keeps closing quotes with their sentence', () => {
    expect(splitIntoSentences('Он сказал: «Ход конём!» И прыгнул.')).toEqual(['Он сказал: «Ход конём!»', 'И прыгнул.']);
  });

  it('never produces a chunk longer than the limit (Chrome cuts long utterances)', () => {
    const long = `${'очень длинное предложение без единой точки, зато с запятыми, '.repeat(8)}и наконец конец.`;
    const chunks = splitIntoSentences(long, 120);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(120);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long);
  });

  it('wraps even a comma-less monster on word boundaries', () => {
    const chunks = splitIntoSentences('слово '.repeat(60).trim(), 50);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(50);
    expect(chunks.join(' ')).toBe('слово '.repeat(60).trim());
  });
});

describe('paginateBubble', () => {
  it('keeps a short phrase on one page', () => {
    expect(paginateBubble('Ход конём! Отлично!')).toEqual(['Ход конём! Отлично!']);
  });

  it('groups sentences into pages that fit the bubble', () => {
    const text = 'Так-так-так… А что хочет соперник? Посмотри на своего коня. Он защищён? Какие есть шахи, взятия и угрозы? Не спеши, у нас полно времени.';
    const pages = paginateBubble(text, 60);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(60);
    expect(pages.join(' ')).toBe(text);
  });

  it('returns no pages for an empty bubble', () => {
    expect(paginateBubble('')).toEqual([]);
  });
});

describe('level maths', () => {
  it('clamp01', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(3)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });

  it('computeRms', () => {
    expect(computeRms(new Float32Array(0))).toBe(0);
    expect(computeRms(new Float32Array([0, 0, 0]))).toBe(0);
    expect(computeRms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5, 6);
  });

  it('rmsToMouthTarget gates noise and saturates', () => {
    expect(rmsToMouthTarget(0.005)).toBe(0);
    expect(rmsToMouthTarget(0.1)).toBeGreaterThan(0.4);
    expect(rmsToMouthTarget(0.9)).toBe(1);
  });

  it('smoothLevel attacks fast and releases slowly', () => {
    const up = smoothLevel(0, 1);
    const down = smoothLevel(1, 0);
    expect(up).toBeGreaterThan(0.5);
    expect(1 - down).toBeLessThan(0.3);
  });

  it('estimateSpeechMs grows with the text', () => {
    expect(estimateSpeechMs('Привет!')).toBeLessThan(estimateSpeechMs('Привет! Давай сыграем в шахматы прямо сейчас.'));
  });
});

describe('createMouthEnvelope', () => {
  it('stays inside 0..1, actually moves, and reacts to kicks', () => {
    const envelope = createMouthEnvelope(() => 0.25);
    const samples = Array.from({ length: 120 }, (_, i) => envelope.sample(i * 16));
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1);
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.3);

    const calm = createMouthEnvelope(() => 0.25);
    const kicked = createMouthEnvelope(() => 0.25);
    kicked.kick(1000);
    expect(kicked.sample(1010)).toBeGreaterThanOrEqual(calm.sample(1010));
    expect(kicked.sample(2000)).toBeCloseTo(calm.sample(2000), 6);
  });
});
