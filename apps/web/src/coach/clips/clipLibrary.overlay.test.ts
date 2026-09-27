/**
 * «Дозапись голоса» in the browser library (docs/voice-clips/ONDEMAND.md): the recorded overlay the local server serves
 * next to the static library — one merged index as NEW objects on every (re)load (the planner memoises by identity),
 * each take fetched from its own origin, the overlay never able to break the static library, `reloadOverlay()`,
 * `hasTake` through the exact key and the text index with failed takes left out, `blocked[]`.
 * Fake fetch + fake decoder: silent, free, no ports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIP_VOICE_KEY, buildClipIndex, clipId } from '@gambit/core';
import type { ClipIndex, ClipIndexEntry } from '@gambit/core';
import { fixtureIndex } from '../../../../../packages/core/src/coach/clips/fixtures.ts';
import { DEFAULT_OVERLAY_URL, createClipLibrary } from './clipLibrary.ts';
import { FAKE_BASE, FAKE_OVERLAY, clipUrl, createFakeServer, decodeFakeClip, joinFakeServers, publishFakeLibrary } from './testAudio.ts';
import type { FakeServer } from './testAudio.ts';

const idle = (cb: () => void): void => cb();

/** a recorded lesson unit as the overlay publishes it (on-demand takes start at 101) */
function unit(key: string, text: string, take = 101, extra: Partial<ClipIndexEntry> = {}): ClipIndexEntry {
  const audible = [...text].length * 70;
  return { id: clipId(CLIP_VOICE_KEY, `${key}\n${text}`, 0, take), key, text, take, ms: audible + 100, on: 30, off: audible + 30, ...extra };
}

const LEAD = unit('line:v3.lead.subject@p#4', 'Давай пойдём пешкой');
const TAIL = unit('line:v3.tail.center#2', '— она займёт центр.');

function overlayIndex(entries: readonly ClipIndexEntry[] = [LEAD, TAIL]): ClipIndex {
  return buildClipIndex(entries);
}

interface Rig {
  staticServer: FakeServer;
  overlayServer: FakeServer;
  library: ReturnType<typeof createClipLibrary>;
}

function rig(o: { staticIndex?: ClipIndex | null; overlay?: ClipIndex | null; overlayOpts?: Parameters<typeof createFakeServer>[1] } = {}): Rig {
  const staticServer = createFakeServer(o.staticIndex === undefined ? fixtureIndex() : o.staticIndex);
  const overlayServer = createFakeServer(o.overlay === undefined ? overlayIndex() : o.overlay, { base: FAKE_OVERLAY, spaFallback: false, libraryVersion: 1, hash: '0000aa', ...o.overlayOpts });
  const library = createClipLibrary({
    baseUrl: FAKE_BASE,
    overlayUrl: FAKE_OVERLAY,
    fetch: joinFakeServers(staticServer, overlayServer),
    decode: (bytes) => Promise.resolve(decodeFakeClip(bytes)),
    idle,
  });
  return { staticServer, overlayServer, library };
}

describe('clipLibrary — the recorded overlay («Дозапись голоса»)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is served by the local server by default', () => {
    expect(DEFAULT_OVERLAY_URL).toBe('/api/voice/clips/overlay/');
    expect(FAKE_OVERLAY).toBe(DEFAULT_OVERLAY_URL);
  });

  it('merges the overlay into one index: both libraries\' takes, the static line unchanged, the overlay\'s count on the side', async () => {
    const r = rig();
    const info = await r.library.load();
    const statics = fixtureIndex();
    expect(info.units).toBe(Object.keys(statics.units).length + 2);
    expect(info.overlayUnits).toBe(2);
    expect(info.libraryVersion).toBe(3);
    expect(r.library.overlayVersion()).toBe(1);
    const index = r.library.index;
    expect(index?.keys['line:v3.lead.subject@p#4']).toEqual([LEAD.id]);
    expect(index?.pools['bark.cheer']).toEqual(statics.pools['bark.cheer']);
    expect(index?.textIndex['line:v3.lead.subject@p|Давай пойдём пешкой']).toEqual([LEAD.id]);
    expect(r.overlayServer.requests).toEqual([`${FAKE_OVERLAY}index.json`, `${FAKE_OVERLAY}${CLIP_VOICE_KEY}/manifest.0000aa.json`]);
  });

  it('each take is fetched from its own origin: overlay takes from the local server, static ones from the app', async () => {
    const r = rig();
    await r.library.load();
    const staticId = fixtureIndex().pools['bark.cheer']?.[0] as string;
    const loaded = await r.library.ensure([LEAD.id, staticId]);
    expect([...loaded.keys()].sort()).toEqual([LEAD.id, staticId].sort());
    expect(r.overlayServer.requests).toContain(clipUrl(LEAD.id, CLIP_VOICE_KEY, FAKE_OVERLAY));
    expect(r.staticServer.requests).toContain(clipUrl(staticId));
    expect(r.staticServer.requests).not.toContain(clipUrl(LEAD.id));
    expect(r.overlayServer.requests).not.toContain(clipUrl(staticId, CLIP_VOICE_KEY, FAKE_OVERLAY));
  });

  it('an overlay that fails in any way leaves the static library exactly as it was', async () => {
    const statics = fixtureIndex();
    // no overlay route (an old server, VOICE_OVERLAY_DIR=off): JSON 404
    const none = rig({ overlay: null });
    await expect(none.library.load()).resolves.toMatchObject({ units: Object.keys(statics.units).length, overlayUnits: 0 });
    expect(none.library.overlayVersion()).toBeNull();
    expect(none.library.index?.textIndex).toBeDefined();
    // offline / refused
    const offline = rig();
    offline.overlayServer.fail(`${FAKE_OVERLAY}index.json`, 'network');
    await expect(offline.library.load()).resolves.toMatchObject({ overlayUnits: 0 });
    // a broken manifest
    const broken = rig();
    broken.overlayServer.files.set(`${FAKE_OVERLAY}${CLIP_VOICE_KEY}/manifest.0000aa.json`, '{"v":2}');
    await expect(broken.library.load()).resolves.toMatchObject({ overlayUnits: 0 });
    expect(broken.library.index?.keys['line:v3.lead.subject@p#4']).toBeUndefined();
    // an overlay of another voice never joins (one sentence never mixes two voices)
    const other = rig({ overlayOpts: { voiceKey: 'other-voice', base: FAKE_OVERLAY, hash: '0000aa' } });
    await expect(other.library.load()).resolves.toMatchObject({ overlayUnits: 0 });
  });

  it('a slow overlay: the static library does not wait past 1.5 s, the overlay joins when it arrives (a new index object)', async () => {
    const r = rig();
    r.overlayServer.delay(`${FAKE_OVERLAY}index.json`, 5_000);
    let info: Awaited<ReturnType<typeof r.library.load>> | null = null;
    void r.library.load().then((value) => {
      info = value;
    });
    await vi.advanceTimersByTimeAsync(1_600);
    expect(info).toMatchObject({ overlayUnits: 0 });
    const before = r.library.index;
    expect(r.library.hasTake(LEAD.key, LEAD.text)).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(r.library.index).not.toBe(before);
    expect(r.library.hasTake(LEAD.key, LEAD.text)).toBe(true);
  });

  it('no static library but an overlay: the voice works from the overlay alone; neither → load() rejects', async () => {
    const alone = rig({ staticIndex: null });
    await expect(alone.library.load()).resolves.toMatchObject({ units: 2, overlayUnits: 2, libraryVersion: 0 });
    const loaded = await alone.library.ensure([TAIL.id]);
    expect(loaded.has(TAIL.id)).toBe(true);
    await expect(rig({ staticIndex: null, overlay: null }).library.load()).rejects.toThrow('not json');
  });

  it('reloadOverlay: a newly published manifest swaps in a NEW index; the same manifest changes nothing (false, same object)', async () => {
    const r = rig();
    await r.library.load();
    const first = r.library.index;
    await expect(r.library.reloadOverlay()).resolves.toBe(false);
    expect(r.library.index).toBe(first);
    expect(r.overlayServer.requests.filter((u) => u.endsWith('index.json'))).toHaveLength(2);

    const added = unit('line:v3.praise.good#7', 'Отличный ход!');
    publishFakeLibrary(r.overlayServer.files, overlayIndex([LEAD, TAIL, added]), { root: FAKE_OVERLAY, libraryVersion: 2, hash: '0000bb' });
    await expect(r.library.reloadOverlay()).resolves.toBe(true);
    const second = r.library.index;
    expect(second).not.toBe(first);
    expect(second?.units).not.toBe(first?.units);
    expect(second?.pools).not.toBe(first?.pools);
    expect(second?.keys).not.toBe(first?.keys);
    expect(r.library.overlayVersion()).toBe(2);
    expect(r.library.info()?.overlayUnits).toBe(3);
    expect(r.library.hasTake('line:v3.praise.good#7', 'Отличный ход!')).toBe(true);
    // the old index object was never mutated
    expect(first?.keys['line:v3.praise.good#7']).toBeUndefined();

    // a broken or missing overlay later keeps what plays now
    r.overlayServer.fail(`${FAKE_OVERLAY}index.json`, 404);
    await expect(r.library.reloadOverlay()).resolves.toBe(false);
    expect(r.library.index).toBe(second);
  });

  it('reloadOverlay while one is under way: read once more after it (it may have read the index before the newest publish)', async () => {
    const r = rig({ overlay: null });
    await r.library.load();
    expect(r.library.overlayVersion()).toBeNull();
    // the first publish: its manifest is slow to come
    publishFakeLibrary(r.overlayServer.files, overlayIndex([LEAD]), { root: FAKE_OVERLAY, libraryVersion: 1, hash: '0000c1' });
    r.overlayServer.delay(`${FAKE_OVERLAY}${CLIP_VOICE_KEY}/manifest.0000c1.json`, 1_000);
    const first = r.library.reloadOverlay();
    await vi.advanceTimersByTimeAsync(100);
    // the second publish lands while the first reload still waits: a caller now must get it, not the older one
    publishFakeLibrary(r.overlayServer.files, overlayIndex([LEAD, TAIL]), { root: FAKE_OVERLAY, libraryVersion: 2, hash: '0000c2' });
    const second = r.library.reloadOverlay();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(r.library.overlayVersion()).toBe(2);
    expect(r.library.hasTake(TAIL.key, TAIL.text)).toBe(true);
  });

  it('hasTake: the exact key with the exact words, else the text index (a shifted wording number) — never a take that failed', async () => {
    const r = rig();
    await r.library.load();
    expect(r.library.hasTake(LEAD.key, LEAD.text)).toBe(true);
    // a stale take: the key's wording now says other words
    expect(r.library.hasTake(LEAD.key, 'Давай пойдём конём')).toBe(false);
    // the writers inserted a wording: #4 became #5 — the same words are found by the text index
    expect(r.library.hasTake('line:v3.lead.subject@p#5', LEAD.text)).toBe(true);
    // another pool variant never borrows it
    expect(r.library.hasTake('line:v3.lead.subject@n#5', LEAD.text)).toBe(false);
    // the take's file is gone: after it failed the book must not count it as recorded
    r.overlayServer.fail(clipUrl(LEAD.id, CLIP_VOICE_KEY, FAKE_OVERLAY), 404);
    await r.library.ensure([LEAD.id]);
    expect(r.library.failed(LEAD.id)).toBe(true);
    expect(r.library.hasTake(LEAD.key, LEAD.text)).toBe(false);
    // a reload keeps a take that is still published failed; one that is gone is forgotten
    const other = unit('line:v3.praise.good#7', 'Отличный ход!');
    publishFakeLibrary(r.overlayServer.files, overlayIndex([LEAD, TAIL, other]), { root: FAKE_OVERLAY, libraryVersion: 2, hash: '0000bb' });
    await r.library.reloadOverlay();
    expect(r.library.failed(LEAD.id)).toBe(true);
    publishFakeLibrary(r.overlayServer.files, overlayIndex([TAIL, other]), { root: FAKE_OVERLAY, libraryVersion: 3, hash: '0000cc' });
    await r.library.reloadOverlay();
    expect(r.library.failed(LEAD.id)).toBe(false);
    expect(r.library.hasTake(LEAD.key, LEAD.text)).toBe(false);
  });

  it('blocked[]: the overlay\'s keys that will not be recorded; a manifest keeps `ctx: cont` on a lead take', async () => {
    const cont = unit('line:v3.lead.aim#3', 'Смотри', 101, { ctx: 'cont' });
    const r = rig({ overlay: overlayIndex([LEAD, cont]), overlayOpts: { base: FAKE_OVERLAY, spaFallback: false, hash: '0000aa', extra: { blocked: ['line:v3.lead.subject@n#9', 7, ''] } } });
    await r.library.load();
    expect(r.library.isBlocked('line:v3.lead.subject@n#9')).toBe(true);
    expect(r.library.isBlocked(LEAD.key)).toBe(false);
    expect(r.library.index?.blocked.size).toBe(1);
    expect(r.library.index?.units[cont.id]?.ctx).toBe('cont');
  });

  it('an overlay with no take yet but blocked[] (its first phrases were given up) still tells the book to avoid them', async () => {
    const blockedOnly = { base: FAKE_OVERLAY, spaFallback: false, libraryVersion: 1, hash: '0000aa', extra: { blocked: ['line:v3.whole.castle#1'] } };
    const r = rig({ overlay: buildClipIndex([]), overlayOpts: blockedOnly });
    const info = await r.library.load();
    expect(r.library.overlayVersion()).toBe(1);
    expect(r.library.isBlocked('line:v3.whole.castle#1')).toBe(true);
    expect(info.overlayUnits).toBe(0);
    expect(info.units).toBe(Object.keys(fixtureIndex().units).length);
    // …and when it is published later (a reload)
    const later = rig({ overlay: null });
    await later.library.load();
    expect(later.library.isBlocked('line:v3.whole.castle#1')).toBe(false);
    publishFakeLibrary(later.overlayServer.files, buildClipIndex([]), { root: FAKE_OVERLAY, libraryVersion: 2, hash: '0000bb', extra: { blocked: ['line:v3.whole.castle#1'] } });
    expect(await later.library.reloadOverlay()).toBe(true);
    expect(later.library.isBlocked('line:v3.whole.castle#1')).toBe(true);
    // with no static library, blocked[] alone is no library to play from
    const alone = rig({ staticIndex: null, overlay: buildClipIndex([]), overlayOpts: blockedOnly });
    await expect(alone.library.load()).rejects.toThrow();
  });
});
