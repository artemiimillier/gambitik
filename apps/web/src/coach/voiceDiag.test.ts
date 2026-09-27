import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIAG_RING_SIZE,
  configureVoiceDiagForTests,
  diag,
  diagString,
  errorName,
  flushVoiceDiag,
  resetVoiceDiagForTests,
  voiceDiagEnabled,
  voiceDiagRecent,
} from './voiceDiag.ts';
import type { VoiceDiagBatch } from './voiceDiag.ts';

function harness(opts: { postOk?: boolean } = {}) {
  const posts: VoiceDiagBatch[] = [];
  const beacons: VoiceDiagBatch[] = [];
  let leave: (() => void) | null = null;
  configureVoiceDiagForTests({
    enabled: true,
    now: () => Date.now(),
    post: (json) => {
      posts.push(JSON.parse(json) as VoiceDiagBatch);
      return Promise.resolve(opts.postOk ?? true);
    },
    beacon: (json) => {
      beacons.push(JSON.parse(json) as VoiceDiagBatch);
      return true;
    },
    listenPage: (onLeave) => {
      leave = onLeave;
      return () => {
        leave = null;
      };
    },
  });
  return { posts, beacons, leave: () => leave?.() };
}

describe('voiceDiag — the black box', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
  });

  it('is off outside a browser / under automation by default (unit tests never write anything)', () => {
    resetVoiceDiagForTests();
    expect(voiceDiagEnabled()).toBe(false);
    diag('out.play', { ok: true });
    expect(voiceDiagRecent()).toEqual([]);
  });

  it('records compact events with a page-relative time and opens with the browser facts', () => {
    harness();
    vi.advanceTimersByTime(250);
    diag('out.play', { ok: false, err: 'NotAllowedError', kind: 'openai-live' });
    const recent = voiceDiagRecent();
    expect(recent.map((entry) => entry.e)).toEqual(['page.open', 'out.play']);
    expect(recent[1]).toMatchObject({ t: 250, e: 'out.play', ok: false, err: 'NotAllowedError', kind: 'openai-live' });
  });

  it('never lets words or long text through: Cyrillic / odd / long strings become «?», bad keys and extra fields are dropped', () => {
    harness();
    diag('say.end', {
      text: 'Осторожно, соперник может пойти слоном',
      reason: 'the SDP exchange timed out',
      long: 'x'.repeat(80),
      sdp: 'v=0\r\no=- 1',
      'bad key': 1,
      t: 999,
      n: 1 / 3,
      inf: Number.POSITIVE_INFINITY,
    });
    const entry = voiceDiagRecent().at(-1);
    expect(entry).toMatchObject({ e: 'say.end', text: '?', reason: 'the SDP exchange timed out', long: '?', sdp: '?', n: 0.333, inf: null });
    expect(entry).not.toHaveProperty('bad key');
    expect(entry?.t).not.toBe(999);
    expect(diagString('Привет')).toBe('?');
    expect(errorName(new DOMException('x', 'NotAllowedError'))).toBe('NotAllowedError');
    expect(errorName('boom')).toBe('Error');
    // invalid event names are ignored
    diag('Bad Event', {});
    expect(voiceDiagRecent().at(-1)?.e).toBe('say.end');
  });

  it('flushes a batch every 5 s (one POST per batch), and keeps the events when the server is away', async () => {
    const failing = harness({ postOk: false });
    diag('sess.open', { kind: 'openai-live' });
    await vi.advanceTimersByTimeAsync(4900);
    expect(failing.posts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(failing.posts).toHaveLength(1);
    expect(failing.posts[0]?.events.map((event) => event.e)).toEqual(['page.open', 'sess.open']);
    expect(failing.posts[0]?.page).toMatch(/^[a-z0-9-]{4,40}$/);
    // the server did not take them: tried again with the next batch
    diag('sess.up', { kind: 'openai-live' });
    await vi.advanceTimersByTimeAsync(5100);
    expect(failing.posts[1]?.events.map((event) => event.e)).toEqual(['page.open', 'sess.open', 'sess.up']);
  });

  it('on pagehide the rest goes out with a beacon at once', async () => {
    const h = harness();
    diag('sess.close', { why: 'pagehide' });
    h.leave();
    expect(h.beacons).toHaveLength(1);
    expect(h.beacons[0]?.events.map((event) => event.e)).toEqual(['page.open', 'sess.close']);
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.posts).toHaveLength(0);
    await flushVoiceDiag();
    expect(h.posts).toHaveLength(0);
  });

  it('local-only: records in the ring, never posts and never beacons', async () => {
    const posts: string[] = [];
    const beacons: string[] = [];
    let leave: (() => void) | null = null;
    configureVoiceDiagForTests({
      localOnly: true,
      post: (json) => {
        posts.push(json);
        return Promise.resolve(true);
      },
      beacon: (json) => {
        beacons.push(json);
        return true;
      },
      listenPage: (onLeave) => {
        leave = onLeave;
        return () => undefined;
      },
    });
    expect(voiceDiagEnabled()).toBe(true);
    diag('clip.plan', { kind: 'teachTurn', level: 1 });
    expect(voiceDiagRecent().map((entry) => entry.e)).toEqual(['page.open', 'clip.plan']);
    await vi.advanceTimersByTimeAsync(20_000);
    await flushVoiceDiag();
    (leave as (() => void) | null)?.();
    expect(posts).toEqual([]);
    expect(beacons).toEqual([]);
  });

  describe('an automated browser (navigator.webdriver)', () => {
    function automatedBrowser(storage: Record<string, string>) {
      const fetchSpy = vi.fn(() => Promise.resolve({ ok: true }));
      const sendBeacon = vi.fn(() => true);
      const listeners = { addEventListener: () => undefined, removeEventListener: () => undefined };
      vi.stubGlobal('window', { ...listeners, localStorage: { getItem: (key: string) => storage[key] ?? null }, location: { search: '', hash: '#/settings' } });
      vi.stubGlobal('document', { ...listeners, visibilityState: 'visible' });
      vi.stubGlobal('navigator', { webdriver: true, userAgent: 'HeadlessChrome/140', sendBeacon });
      vi.stubGlobal('fetch', fetchSpy);
      resetVoiceDiagForTests();
      return { fetchSpy, sendBeacon };
    }
    afterEach(() => {
      resetVoiceDiagForTests(); // uninstalls the page listeners while the stubbed window still exists
      vi.unstubAllGlobals();
    });

    it('stays off without the clips opt-in', () => {
      automatedBrowser({});
      expect(voiceDiagEnabled()).toBe(false);
      diag('clip.plan', { level: 1 });
      expect(voiceDiagRecent()).toEqual([]);
    });

    it('with `gambit.e2eClips` = on keeps the black box in memory only (the run reads clip.plan; nothing leaves the page)', async () => {
      const { fetchSpy, sendBeacon } = automatedBrowser({ 'gambit.e2eClips': 'on' });
      expect(voiceDiagEnabled()).toBe(true);
      diag('clip.plan', { kind: 'praise', level: 2 });
      expect(voiceDiagRecent().at(-1)).toMatchObject({ e: 'clip.plan', kind: 'praise', level: 2 });
      await vi.advanceTimersByTimeAsync(20_000);
      await flushVoiceDiag();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sendBeacon).not.toHaveBeenCalled();
    });
  });

  it('the ring is bounded', () => {
    harness();
    for (let i = 0; i < DIAG_RING_SIZE + 50; i++) diag('utt', { i });
    expect(voiceDiagRecent()).toHaveLength(DIAG_RING_SIZE);
    expect(voiceDiagRecent().at(-1)).toMatchObject({ i: DIAG_RING_SIZE + 49 });
  });
});
