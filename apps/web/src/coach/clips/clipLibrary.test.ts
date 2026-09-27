/**
 * The «Записи» library in the browser (docs/voice-clips/SPEC.md §4.1, §5.4, §11): manifest loading (an absent library
 * rejects, so the chain falls to silent), deduplicated fetch + decode of a COPY, the sample-scan trim of MP3 padding,
 * the decoded LRU by seconds, failures remembered for the planner. Fake fetch + fake decoder: silent, free, no ports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIP_VOICE_KEY } from '@gambit/core';
import { fixtureIndex } from '../../../../../packages/core/src/coach/clips/fixtures.ts';
import { createClipLibrary, mouthEnvelope, parseManifest, playWindow, scanAudible } from './clipLibrary.ts';
import type { ClipLibraryOptions } from './clipLibrary.ts';
import { FAKE_BASE, FakeBuffer, FAKE_RATE, clipUrl, createFakeServer, decodeFakeClip, fakeClipBytes } from './testAudio.ts';

const idle = (cb: () => void): void => cb();

function lib(server = createFakeServer(fixtureIndex()), extra: Partial<ClipLibraryOptions> = {}) {
  const decode = vi.fn((bytes: ArrayBuffer) => Promise.resolve(decodeFakeClip(bytes)));
  // the static library alone (the recorded overlay has its own tests: clipLibrary.overlay.test.ts)
  const library = createClipLibrary({ baseUrl: FAKE_BASE, fetch: server.fetch, decode, idle, overlayUrl: null, ...extra });
  return { library, server, decode };
}

function idsOf(index: ReturnType<typeof fixtureIndex>, unitKey: string): string[] {
  return index.keys[unitKey] ?? [];
}

describe('clipLibrary — the manifest', () => {
  it('loads index.json → the voice\'s manifest; the planner index is a new object per load', async () => {
    const { library, server } = lib();
    const info = await library.load();
    expect(info.voiceKey).toBe(CLIP_VOICE_KEY);
    expect(info.libraryVersion).toBe(3);
    expect(info.units).toBe(Object.keys(fixtureIndex().units).length);
    expect(info.phrases).toBe(Object.keys(fixtureIndex().keys).length);
    expect(server.requests).toEqual([`${FAKE_BASE}index.json`, `${FAKE_BASE}${CLIP_VOICE_KEY}/manifest.abcdef123456.json`]);
    expect(library.index?.pools['bark.cheer']?.length).toBe(2);
    expect(library.index?.fallbacks?.['teach.head.advice']).toBe('teach.head.arrow');
    // memoised
    await library.load();
    expect(server.requests).toHaveLength(2);
  });

  it('an absent library rejects: the SPA answers index.html for the missing JSON (dev / e2e builds)', async () => {
    await expect(lib(createFakeServer(null)).library.load()).rejects.toThrow('not json');
    await expect(lib(createFakeServer(null, { spaFallback: false })).library.load()).rejects.toThrow('http 404');
    const broken = createFakeServer(fixtureIndex());
    broken.files.set(`${FAKE_BASE}${CLIP_VOICE_KEY}/manifest.abcdef123456.json`, JSON.stringify({ v: 2, units: {} }));
    await expect(lib(broken).library.load()).rejects.toThrow('bad manifest');
    // a voice the index does not have
    await expect(lib(createFakeServer(fixtureIndex()), { voiceKey: 'other-voice' }).library.load()).rejects.toThrow('no voice');
    // a failed load may be retried later
    const later = createFakeServer(null);
    const { library } = lib(later);
    await expect(library.load()).rejects.toThrow();
    const index = fixtureIndex();
    const good = createFakeServer(index);
    for (const [url, body] of good.files) later.files.set(url, body);
    await expect(library.load()).resolves.toMatchObject({ voiceKey: CLIP_VOICE_KEY });
  });

  it('parseManifest keeps only hex ids, safe file paths and references to known units', () => {
    const parsed = parseManifest({
      v: 1,
      voiceKey: 'giselle-mm1',
      libraryVersion: 2,
      units: {
        c0123456789abc: { text: 'Ого!', ms: 500, on: 30, off: 470, file: '01/c0123456789abc.mp3', interj: true },
        'c0123456789ab/../x': { text: 'bad', ms: 1 },
        c1111111111111: { text: 'bad file', ms: 400, file: '../../etc/passwd' },
        c2222222222222: { text: 'no ms' },
      },
      pools: { 'bark.cheer': ['c0123456789abc', 'cffffffffffff0', 7] },
      keys: { 'line:bark.cheer#1': ['c0123456789abc'], 'slot:x': ['nope'] },
      fallbacks: { a: 'b', c: 3 },
    });
    expect(Object.keys(parsed?.units ?? {})).toEqual(['c0123456789abc', 'c1111111111111']);
    expect(parsed?.units.c1111111111111?.file).toBeUndefined();
    expect(parsed?.units.c0123456789abc?.interj).toBe(true);
    expect(parsed?.pools).toEqual({ 'bark.cheer': ['c0123456789abc'] });
    expect(parsed?.keys).toEqual({ 'line:bark.cheer#1': ['c0123456789abc'] });
    expect(parsed?.fallbacks).toEqual({ a: 'b' });
    expect(parseManifest({ v: 1 })).toBeNull();
    expect(parseManifest('<html>')).toBeNull();
  });
});

describe('clipLibrary — the audible window (sample scan, never the container metadata)', () => {
  it('finds the first / last sample above −55 dBFS and keeps a few ms around them', () => {
    const buffer = decodeFakeClip(fakeClipBytes({ ms: 500, leadMs: 34.5, tailMs: 80 }));
    const edges = scanAudible(buffer);
    expect(edges?.onsetSec).toBeCloseTo(0.0345, 3);
    expect(edges?.offsetSec).toBeCloseTo(0.5345, 3);
    const w = playWindow(buffer, { on: 0, off: 10 });
    expect(w.offsetSec).toBeCloseTo(0.0345 - 0.006, 3);
    expect(w.durSec).toBeCloseTo(0.5 + 0.006 + 0.012, 3);
  });

  it('keeps quiet word-final consonants (−50 dBFS) and drops the −66 dBFS floor', () => {
    const data = new Float32Array(FAKE_RATE);
    for (let i = 0; i < data.length; i++) data[i] = 10 ** (-66 / 20) * (i % 2 ? 1 : -1);
    for (let i = 3200; i < 16000; i++) data[i] = 0.3;
    for (let i = 16000; i < 19200; i++) data[i] = 10 ** (-50 / 20); // «ть» at −50 dBFS for 100 ms
    const edges = scanAudible(new FakeBuffer(data.length, FAKE_RATE, data));
    expect(edges?.onsetSec).toBeCloseTo(0.1, 3);
    expect(edges?.offsetSec).toBeCloseTo(0.6, 3);
  });

  it('pure silence falls back to the manifest on / off, then to the whole buffer', () => {
    const silence = new FakeBuffer(FAKE_RATE / 2);
    expect(scanAudible(silence)).toBeNull();
    const w = playWindow(silence, { on: 30, off: 300 });
    expect(w.offsetSec).toBeCloseTo(0.03, 6);
    expect(w.durSec).toBeCloseTo(0.27, 6);
    expect(playWindow(silence, undefined)).toEqual({ offsetSec: 0, durSec: 0.5 });
  });

  it('the mouth envelope opens on the tone and stays shut on silence', () => {
    const buffer = decodeFakeClip(fakeClipBytes({ ms: 400, leadMs: 100, tailMs: 100 }));
    const env = mouthEnvelope(buffer, 0, buffer.duration);
    expect(env[0]).toBe(0);
    expect(env[10]).toBeGreaterThan(0.5);
    expect(env.at(-1)).toBe(0);
  });
});

describe('clipLibrary — fetch, decode, caches', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dedupes concurrent loads and decodes a COPY (decodeAudioData detaches its argument)', async () => {
    const index = fixtureIndex();
    const detaching = vi.fn((bytes: ArrayBuffer) => {
      const clip = decodeFakeClip(bytes);
      structuredClone(bytes, { transfer: [bytes] }); // what a real decoder does to its input
      return Promise.resolve(clip);
    });
    const { library, server } = lib(createFakeServer(index), { decode: detaching, maxDecodedSec: 0.001 });
    await library.load();
    const [id] = idsOf(index, 'slot:ins:n:f3');
    const [a, b] = await Promise.all([library.ensure([id as string]), library.ensure([id as string])]);
    expect(a.get(id as string)?.durSec).toBeGreaterThan(0.5);
    expect(b.get(id as string)).toBe(a.get(id as string));
    expect(server.requests.filter((u) => u === clipUrl(id as string))).toHaveLength(1);
    // evicted from the decoded LRU (tiny budget) but the compressed bytes are intact: decoded again, not fetched again
    const [other] = idsOf(index, 'slot:nom:n:f3');
    await library.ensure([other as string]);
    expect(library.cached(id as string)).toBeNull();
    const again = await library.ensure([id as string]);
    expect(again.get(id as string)).toBeDefined();
    expect(detaching).toHaveBeenCalledTimes(3); // id, other, id again
    expect(server.requests.filter((u) => u === clipUrl(id as string))).toHaveLength(1);
  });

  it('the decoded cache is an LRU by seconds of audio', async () => {
    const index = fixtureIndex();
    const { library } = lib(createFakeServer(index), { maxDecodedSec: 2.5 });
    await library.load();
    const ids = ['slot:ins:n:f3', 'slot:nom:n:f3', 'slot:ins:p:e4'].map((k) => idsOf(index, k)[0] as string);
    for (const id of ids) await library.ensure([id]);
    // each ≈ 1.1–1.3 s of file: only the two most recent fit in 2.5 s
    expect(library.cached(ids[0] as string)).toBeNull();
    expect(library.cached(ids[1] as string)).not.toBeNull();
    expect(library.cached(ids[2] as string)).not.toBeNull();
  });

  it('a missing file / a broken take is remembered as failed; a network error is not', async () => {
    const index = fixtureIndex();
    const server = createFakeServer(index);
    const { library } = lib(server);
    await library.load();
    const [gone] = idsOf(index, 'slot:ins:n:f3');
    const [flaky] = idsOf(index, 'slot:nom:n:f3');
    const [broken] = idsOf(index, 'slot:ins:p:e4');
    server.fail(clipUrl(gone as string), 404);
    server.fail(clipUrl(flaky as string), 'network');
    server.files.set(clipUrl(broken as string), new ArrayBuffer(7));
    const out = await library.ensure([gone as string, flaky as string, broken as string]);
    expect(out.size).toBe(0);
    expect(library.failed(gone as string)).toBe(true);
    expect(library.failed(flaky as string)).toBe(false);
    expect(library.failed(broken as string)).toBe(true);
  });

  it('a clip slower than the timeout is left out of this plan and still lands in the cache', async () => {
    const index = fixtureIndex();
    const server = createFakeServer(index);
    const { library } = lib(server, { loadTimeoutMs: 100 });
    await library.load();
    const [slow] = idsOf(index, 'slot:ins:n:f3');
    server.delay(clipUrl(slow as string), 500);
    const pending = library.ensure([slow as string]);
    await vi.advanceTimersByTimeAsync(150);
    expect((await pending).size).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(library.cached(slow as string)).not.toBeNull();
  });

  it('the hot set: barks, generic lines and the split set; prefetch fetches bytes, prewarm decodes', async () => {
    const index = fixtureIndex();
    const { library, server, decode } = lib(createFakeServer(index));
    await library.load();
    const hot = new Set(library.hotIds());
    for (const pool of ['bark.cheer', 'bark.think', 'generic', 'generic.teachTurn', 'generic.teachTurn.turn']) for (const id of index.pools[pool] ?? []) expect(hot.has(id)).toBe(true);
    for (const key of ['slot:sq:f6', 'slot:head:ins:n', 'slot:xsq:d5']) for (const id of index.keys[key] ?? []) expect(hot.has(id)).toBe(true);
    for (const id of index.keys['slot:ins:n:f3'] ?? []) expect(hot.has(id)).toBe(false);
    library.prefetch([...hot]);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.requests.length).toBe(2 + hot.size);
    expect(decode).not.toHaveBeenCalled();
    const warm = index.pools['bark.cheer'] ?? [];
    library.prewarm(warm);
    await vi.advanceTimersByTimeAsync(0);
    for (const id of warm) expect(library.cached(id)).not.toBeNull();
    expect(server.requests.length).toBe(2 + hot.size);
  });
});
