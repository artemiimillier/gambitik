/**
 * «Дозапись голоса» — the browser's requester and poller (docs/voice-clips/ONDEMAND.md): never a request from an
 * automated browser (not one fetch), ids only, only while the server records, each sentence once while its answer
 * holds, ≤ 6 sentences per POST; the status poller every 4 s only while something is outstanding, ≤ 5 min, the overlay
 * reloaded when its version changes. Whole catalogue sentences of non-lesson events go the same way (`requestLines`); a
 * bubble on screen waiting for its voice makes the poller look every 1.5 s for a while (`hurry`).
 * Fake routes and fake timers: silent, free, no ports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipGenHealth, ClipGenLine, ClipGenOutcome, ClipGenRequest, ClipGenRequestResult, ClipGenStatus } from '@gambit/shared';
import { ApiError, requestClipGen } from '../../api/client.ts';
import { CLIP_GEN_POLL_FAST_MS, CLIP_GEN_POLL_FOR_MS, CLIP_GEN_POLL_MS, clipGenAccepts, clipGenGrows, createClipOnDemand } from './clipOnDemand.ts';
import type { ClipGenApi } from './clipOnDemand.ts';
import { LEAD, TAIL, WHOLE, lessonEvent } from './testLesson.ts';

const READY: ClipGenHealth = { state: 'ready', overlay: true };

function status(patch: Partial<ClipGenStatus> = {}): ClipGenStatus {
  return {
    health: READY,
    enabled: true,
    queue: 0,
    busy: false,
    overlay: { version: 1, units: 2 },
    spent: { today: '2026-09-24', todayMilli: 0, totalMilli: 0, prefetchMilli: 0 },
    caps: { dailyMilli: 3000, dailyMaxMilli: 15000, totalMilli: 60000 },
    givenUp: 0,
    ...patch,
  };
}

/** Fake routes: `answer` decides each sentence's outcome; every call is recorded. */
function fakeApi(answer: (index: number) => ClipGenOutcome = () => 'queued') {
  const requests: ClipGenRequest[] = [];
  let next: ClipGenStatus = status();
  let statusCalls = 0;
  let fail: unknown = null;
  const api: ClipGenApi = {
    request(body) {
      requests.push(body);
      if (fail) return Promise.reject(fail);
      const result: ClipGenRequestResult = { results: body.sentences.map((_, i) => ({ outcome: answer(i), keys: [] })), health: READY, queue: body.sentences.length };
      return Promise.resolve(result);
    },
    status() {
      statusCalls += 1;
      return Promise.resolve(next);
    },
  };
  return {
    api,
    requests,
    statusCalls: () => statusCalls,
    setStatus(s: ClipGenStatus) {
      next = s;
    },
    failWith(error: unknown) {
      fail = error;
    },
  };
}

function setup(o: { automated?: boolean; answer?: (index: number) => ClipGenOutcome; health?: ClipGenHealth | null } = {}) {
  const routes = fakeApi(o.answer);
  const reloads: number[] = [];
  const onDemand = createClipOnDemand({
    api: routes.api,
    isAutomated: () => o.automated ?? false,
    overlay: () => ({
      reload: () => {
        reloads.push(Date.now());
        return Promise.resolve(true);
      },
    }),
  });
  onDemand.setHealth(o.health === undefined ? READY : o.health);
  return { onDemand, routes, reloads };
}

const live: { dispose(): void }[] = [];

describe('clipOnDemand — the requester', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
  });
  afterEach(() => {
    for (const d of live.splice(0)) d.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('asks for exactly the missing sentences, as ids only, with the event kind as a hint; one outcome per index', async () => {
    const { onDemand, routes } = setup();
    live.push(onDemand);
    const event = lessonEvent();
    await expect(onDemand.request(event, [1])).resolves.toEqual(['queued']);
    expect(routes.requests).toEqual([{ sentences: [{ parts: [LEAD, TAIL] }], kind: 'teachTurn' }]);
    // no text anywhere in the body: the server renders the words itself
    expect(JSON.stringify(routes.requests)).not.toContain(event.text.slice(0, 10));
  });

  it('an automated browser never asks: not one fetch — the typed client refuses too, before fetch', async () => {
    const { onDemand, routes } = setup({ automated: true });
    live.push(onDemand);
    await expect(onDemand.request(lessonEvent(), [0, 1])).resolves.toBeNull();
    await expect(onDemand.check()).resolves.toBeNull();
    expect(routes.requests).toHaveLength(0);
    expect(routes.statusCalls()).toBe(0);

    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 202 })));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { webdriver: true });
    await expect(requestClipGen({ sentences: [{ parts: [WHOLE] }] })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only while the server records: off, a pause a person must lift, or no feature at all → nothing sent; a timed pause that is over → sent', async () => {
    for (const health of [null, { state: 'off', overlay: false }, { state: 'paused', reason: 'parent-off', until: null, overlay: true }, { state: 'paused', reason: 'day-cap', until: Date.now() + 60_000, overlay: true }] as const) {
      const { onDemand, routes } = setup({ health });
      live.push(onDemand);
      await expect(onDemand.request(lessonEvent(), [0])).resolves.toBeNull();
      expect(routes.requests, JSON.stringify(health)).toHaveLength(0);
    }
    const over = setup({ health: { state: 'paused', reason: 'rate', until: Date.now() - 1, overlay: true } });
    live.push(over.onDemand);
    await expect(over.onDemand.request(lessonEvent(), [0])).resolves.toEqual(['queued']);
    expect(clipGenAccepts(READY, 0)).toBe(true);
    expect(clipGenGrows(READY)).toBe(true);
    expect(clipGenGrows({ state: 'paused', reason: 'day-cap', until: 5, overlay: true })).toBe(true);
    expect(clipGenGrows({ state: 'paused', reason: 'parent-off', until: null, overlay: true })).toBe(false);
    expect(clipGenGrows({ state: 'off', overlay: true })).toBe(false);
    expect(clipGenGrows(null)).toBe(false);
  });

  it('a sentence that can never be recorded: the utterance is never requested (nothing paid for its other sentences)', async () => {
    const { onDemand, routes } = setup();
    live.push(onDemand);
    const event = lessonEvent();
    await expect(onDemand.request(event, [5])).resolves.toBeNull();
    await expect(onDemand.request({ ...event, saySentences: [{ text: event.text, parts: [] }] }, [0])).resolves.toBeNull();
    expect(routes.requests).toHaveLength(0);
  });

  it('dedup: a sentence asked for before repeats its answer while it holds; a «Повтори» of the phrase sends nothing', async () => {
    const { onDemand, routes } = setup();
    live.push(onDemand);
    const event = lessonEvent();
    await onDemand.request(event, [0, 1]);
    const again = lessonEvent();
    await expect(onDemand.request(again, [0, 1])).resolves.toEqual(['queued', 'queued']);
    expect(routes.requests).toHaveLength(1);
    // the same sentence twice in one utterance goes once
    const twice = lessonEvent([[WHOLE], [WHOLE]]);
    const fresh = setup();
    live.push(fresh.onDemand);
    await expect(fresh.onDemand.request(twice, [0, 1])).resolves.toEqual(['queued', 'queued']);
    expect(fresh.routes.requests[0]?.sentences).toHaveLength(1);
  });

  it('a short-lived answer (budget / paused) may be asked again later; given-up never again', async () => {
    let outcome: ClipGenOutcome = 'budget';
    const { onDemand, routes } = setup({ answer: () => outcome });
    live.push(onDemand);
    const event = lessonEvent();
    await expect(onDemand.request(event, [0])).resolves.toEqual(['budget']);
    await onDemand.request(event, [0]);
    expect(routes.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
    outcome = 'given-up';
    await expect(onDemand.request(event, [0])).resolves.toEqual(['given-up']);
    expect(routes.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await onDemand.request(event, [0]);
    expect(routes.requests).toHaveLength(2);
  });

  it('more than 6 sentences go in several requests of at most 6', async () => {
    const { onDemand, routes } = setup();
    live.push(onDemand);
    const many = lessonEvent([[WHOLE], [LEAD, TAIL], [LEAD], [{ pool: 'v3.whole.castleLong', n: 1 }], [{ pool: 'v3.q.develop', n: 1 }], [{ pool: 'v3.q.check', n: 1 }], [{ pool: 'v3.q.centerPawn', n: 1 }]]);
    const outcomes = await onDemand.request(many, [0, 1, 2, 3, 4, 5, 6]);
    expect(outcomes).toHaveLength(7);
    expect(routes.requests.map((r) => r.sentences.length)).toEqual([6, 1]);
  });

  it('the server says recording is off (503 clip-gen-off): nothing more is asked', async () => {
    const { onDemand, routes } = setup();
    live.push(onDemand);
    routes.failWith(new ApiError({ status: 503, code: 'clip-gen-off', method: 'POST', path: '/voice/clips/request' }));
    await expect(onDemand.request(lessonEvent(), [0])).resolves.toBeNull();
    expect(onDemand.health()?.state).toBe('off');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(onDemand.request(lessonEvent([[LEAD]]), [0])).resolves.toBeNull();
    expect(routes.requests).toHaveLength(1);
  });

  it('«already recorded» for a phrase this page could not play: the overlay is re-read once', async () => {
    const { onDemand, reloads } = setup({ answer: () => 'voiced' });
    live.push(onDemand);
    await onDemand.request(lessonEvent(), [0, 1]);
    expect(reloads).toHaveLength(1);
  });
});

describe('clipOnDemand — the poller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
  });
  afterEach(() => {
    for (const d of live.splice(0)) d.dispose();
    vi.useRealTimers();
  });

  it('starts with an accepted request, asks every 4 s, reloads the overlay only when its version changes, stops when the queue is empty', async () => {
    const { onDemand, routes, reloads } = setup();
    live.push(onDemand);
    expect(onDemand.polling).toBe(false);
    routes.setStatus(status({ queue: 1, busy: true, overlay: { version: 1, units: 2 } }));
    await onDemand.request(lessonEvent(), [1]);
    expect(onDemand.polling).toBe(true);
    expect(CLIP_GEN_POLL_MS).toBe(4_000);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(routes.statusCalls()).toBe(1);
    // the first look at the version re-reads the overlay (a no-op in the library when nothing changed)
    expect(reloads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(routes.statusCalls()).toBe(2);
    expect(reloads).toHaveLength(1);
    // published: a new version → one reload; the queue is empty → the poller stops
    routes.setStatus(status({ queue: 0, busy: false, overlay: { version: 2, units: 3 } }));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reloads).toHaveLength(2);
    expect(onDemand.polling).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(routes.statusCalls()).toBe(3);
  });

  it('a reload that failed (a server restart, a slow index) is tried again on the next look until the library has that version', async () => {
    const routes = fakeApi();
    let fail = false;
    let loaded = 1;
    const reloads: boolean[] = [];
    const onDemand = createClipOnDemand({
      api: routes.api,
      isAutomated: () => false,
      overlay: () => ({
        reload: () => {
          reloads.push(!fail);
          if (!fail) loaded = 2;
          return Promise.resolve(!fail);
        },
        version: () => loaded,
      }),
    });
    live.push(onDemand);
    onDemand.setHealth(READY);
    routes.setStatus(status({ queue: 1, busy: true, overlay: { version: 1, units: 2 } }));
    // the page's library is at version 1 already: nothing to re-read
    await onDemand.requestLines('greeting', [{ id: 'greet.hello.day', n: 1 }]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reloads).toEqual([]);
    const before = reloads.length;
    // the server publishes version 2 and its queue is empty — but this page's reload fails
    fail = true;
    routes.setStatus(status({ queue: 0, busy: false, overlay: { version: 2, units: 3 } }));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reloads.slice(before)).toEqual([false]);
    // the next look tries again (the poller keeps going while the library is behind), and then it has it
    fail = false;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reloads.slice(before)).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reloads.slice(before)).toEqual([false, true]);
    expect(onDemand.polling).toBe(false);
    // a check at a later game start: the library has that version, nothing is re-read
    await onDemand.check();
    expect(reloads.slice(before)).toEqual([false, true]);
  });

  it('never longer than 5 min after the last accepted request, even if the server stays busy', async () => {
    const { onDemand, routes } = setup();
    live.push(onDemand);
    routes.setStatus(status({ queue: 3, busy: true }));
    await onDemand.request(lessonEvent(), [0]);
    await vi.advanceTimersByTimeAsync(CLIP_GEN_POLL_FOR_MS + 10_000);
    expect(onDemand.polling).toBe(false);
    const calls = routes.statusCalls();
    expect(calls).toBeGreaterThanOrEqual(74);
    expect(calls).toBeLessThanOrEqual(76);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(routes.statusCalls()).toBe(calls);
  });

  it('nothing accepted, nothing polled: a refused request starts no poller', async () => {
    const { onDemand, routes } = setup({ answer: () => 'budget' });
    live.push(onDemand);
    await onDemand.request(lessonEvent(), [0]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onDemand.polling).toBe(false);
    expect(routes.statusCalls()).toBe(0);
  });

  it('one check at load / game start: health and overlay follow it; a busy server starts the poller, an idle one does not', async () => {
    const { onDemand, routes, reloads } = setup();
    live.push(onDemand);
    routes.setStatus(status({ health: { state: 'paused', reason: 'day-cap', until: null, overlay: true } }));
    await onDemand.check();
    expect(onDemand.health()).toMatchObject({ state: 'paused', reason: 'day-cap' });
    expect(reloads).toHaveLength(1);
    expect(onDemand.polling).toBe(false);
    routes.setStatus(status({ queue: 2 }));
    await onDemand.check();
    expect(onDemand.polling).toBe(true);
    // an old server without the feature: no status is asked at all
    const old = setup({ health: null });
    live.push(old.onDemand);
    await expect(old.onDemand.check()).resolves.toBeNull();
    expect(old.routes.statusCalls()).toBe(0);
  });

  it('dispose stops the poller', async () => {
    const { onDemand, routes } = setup();
    routes.setStatus(status({ queue: 1 }));
    await onDemand.request(lessonEvent(), [0]);
    onDemand.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(routes.statusCalls()).toBe(0);
  });
});

describe('clipOnDemand — whole catalogue sentences of non-lesson events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
  });
  afterEach(() => {
    for (const d of live.splice(0)) d.dispose();
    vi.useRealTimers();
  });

  const HELLO: ClipGenLine = { id: 'greet.hello.day', n: 1 };
  const FIRST: ClipGenLine = { id: 'greet.first', n: 2, g: 'f' };

  it('asks for the lines as ids only (id, wording, variant) with the event kind; never a stray field such as text', async () => {
    const { onDemand, routes } = setup();
    live.push(onDemand);
    const sneaky = { ...FIRST, text: 'Привет!' } as ClipGenLine;
    await expect(onDemand.requestLines('greeting', [HELLO, sneaky])).resolves.toEqual(['queued', 'queued']);
    expect(routes.requests).toEqual([{ sentences: [{ line: { id: 'greet.hello.day', n: 1 } }, { line: { id: 'greet.first', n: 2, g: 'f' } }], kind: 'greeting' }]);
    expect(JSON.stringify(routes.requests)).not.toContain('Привет');
  });

  it('the same rules as a lesson: dedup while an answer holds, never automated, never while the server does not record', async () => {
    const { onDemand, routes } = setup();
    live.push(onDemand);
    await onDemand.requestLines('greeting', [HELLO]);
    await expect(onDemand.requestLines('greeting', [HELLO])).resolves.toEqual(['queued']);
    expect(routes.requests).toHaveLength(1);
    await expect(onDemand.requestLines('greeting', [])).resolves.toBeNull();

    const auto = setup({ automated: true });
    live.push(auto.onDemand);
    await expect(auto.onDemand.requestLines('greeting', [HELLO])).resolves.toBeNull();
    expect(auto.routes.requests).toHaveLength(0);
    const off = setup({ health: { state: 'off', overlay: true } });
    live.push(off.onDemand);
    await expect(off.onDemand.requestLines('greeting', [HELLO])).resolves.toBeNull();
    expect(off.routes.requests).toHaveLength(0);
  });

  it('refusal() names why nothing would be sent (Latin codes for the black box)', async () => {
    expect(setup().onDemand.refusal()).toBeNull();
    expect(setup({ automated: true }).onDemand.refusal()).toBe('automation');
    expect(setup({ health: null }).onDemand.refusal()).toBe('no-health');
    expect(setup({ health: { state: 'off', overlay: false } }).onDemand.refusal()).toBe('off');
    expect(setup({ health: { state: 'paused', reason: 'parent-off', until: null, overlay: true } }).onDemand.refusal()).toBe('paused');
    const failed = setup();
    failed.routes.failWith(new Error('network'));
    await failed.onDemand.requestLines('greeting', [HELLO]);
    expect(failed.onDemand.refusal()).toBe('quiet');
    failed.onDemand.dispose();
    expect(failed.onDemand.refusal()).toBe('disposed');
  });
});

describe('clipOnDemand — hurry: a bubble on screen waits for its voice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
  });
  afterEach(() => {
    for (const d of live.splice(0)) d.dispose();
    vi.useRealTimers();
  });

  it('every 1.5 s while something is outstanding, for the given time only — then every 4 s again', async () => {
    const { onDemand, routes } = setup();
    live.push(onDemand);
    routes.setStatus(status({ queue: 1, busy: true }));
    await onDemand.requestLines('greeting', [{ id: 'greet.hello.day', n: 1 }]);
    expect(CLIP_GEN_POLL_FAST_MS).toBe(1_500);
    // the request scheduled the ordinary 4 s look: the hurry brings it forward
    onDemand.hurry(30_000);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(routes.statusCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(28_500);
    expect(routes.statusCalls()).toBe(20);
    // the window is over: the ordinary cadence
    await vi.advanceTimersByTimeAsync(1_500);
    const after = routes.statusCalls();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(routes.statusCalls()).toBe(after + 1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(routes.statusCalls()).toBe(after + 2);
  });

  it('stops as soon as nothing is outstanding (the recording was published), even inside the window', async () => {
    const { onDemand, routes, reloads } = setup();
    live.push(onDemand);
    routes.setStatus(status({ queue: 1, busy: true }));
    await onDemand.requestLines('greeting', [{ id: 'greet.hello.day', n: 1 }]);
    onDemand.hurry(30_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(routes.statusCalls()).toBe(2);
    routes.setStatus(status({ queue: 0, busy: false, overlay: { version: 2, units: 3 } }));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(routes.statusCalls()).toBe(3);
    expect(reloads).toHaveLength(2);
    expect(onDemand.polling).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(routes.statusCalls()).toBe(3);
  });

  it('follows the server for that long even when no POST went out (the answer was still in hand); never automated', async () => {
    const { onDemand, routes } = setup();
    live.push(onDemand);
    routes.setStatus(status({ queue: 1, busy: true }));
    onDemand.hurry(6_000);
    await vi.advanceTimersByTimeAsync(20_000);
    // 1.5, 3, 4.5, 6: the poller keeps going only while it is inside the window after the last accepted request
    expect(routes.statusCalls()).toBe(4);
    expect(onDemand.polling).toBe(false);

    const auto = setup({ automated: true });
    live.push(auto.onDemand);
    auto.routes.setStatus(status({ queue: 1, busy: true }));
    auto.onDemand.hurry(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(auto.routes.statusCalls()).toBe(0);
    expect(auto.onDemand.polling).toBe(false);
  });
});
