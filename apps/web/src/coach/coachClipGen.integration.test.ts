/**
 * «Дозапись голоса» through the real web stack: the coach controller,
 * the real «Записи» layer (planner, player), the real clip library (the static library + the server's recorded overlay,
 * merged by core `mergeClipIndexes`, re-read on a new overlay version) and the real requester / status poller — only
 * the server's two routes, the files and the AudioContext are fakes. A phrase shown without its voice is requested as
 * ids; its recording is published while its bubble is still up; the poller notices, the library merges it, and the
 * phrase is heard in the same turn — outside the queue (the game holds the child's clock itself, `onLateSpeech`).
 * Silent, free, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIP_VOICE_KEY } from '@gambit/core';
import type { ClipIndex } from '@gambit/core';
import type { ClipGenHealth, ClipGenRequest, ClipGenRequestResult, ClipGenStatus, HealthInfo } from '@gambit/shared';
import { fixtureIndex } from '../../../../packages/core/src/coach/clips/fixtures.ts';
import { createCoachController } from './coachController.ts';
import type { CoachPageLifecycle } from './coachController.ts';
import { createCoachStore } from './coachStore.ts';
import { createClipAudio } from './clips/clipAudio.ts';
import { createClipLibrary } from './clips/clipLibrary.ts';
import type { ClipGenApi } from './clips/clipOnDemand.ts';
import { createClipVoice } from './clips/clipVoice.ts';
import type { ClipVoice } from './clips/clipVoice.ts';
import { HELLO_DAY, LEAD, TAIL, WHOLE, greetingEvent, lessonEvent, recordedLine, recordedLines, recordedOverlay, recordedUnit } from './clips/testLesson.ts';
import { FAKE_BASE, FAKE_OVERLAY, FakeAudioContext, clipUrl, createFakeServer, joinFakeServers, publishFakeLibrary } from './clips/testAudio.ts';
import { SETTINGS_STORAGE_KEY } from './settings.ts';
import { createSilentVoice } from './silentVoice.ts';
import { createMemoryStorage, makeHealth } from './testUtils.ts';
import { configureVoiceDiagForTests, resetVoiceDiagForTests, voiceDiagRecent } from './voiceDiag.ts';

const READY: ClipGenHealth = { state: 'ready', overlay: true };

function statusOf(version: number, busy: boolean): ClipGenStatus {
  return {
    health: READY,
    enabled: true,
    queue: busy ? 1 : 0,
    busy,
    overlay: { version, units: version },
    spent: { today: '2026-09-25', todayMilli: 0, totalMilli: 0, prefetchMilli: 0 },
    caps: { dailyMilli: 3000, dailyMaxMilli: 15000, totalMilli: 60000 },
    givenUp: 0,
  };
}

/**
 * The web stack on fakes. The static library has no greeting, no lesson take and no generic line (the gaps of the `pilot` tier);
 * the overlay starts with `overlay` (null = none recorded yet). `publish(index)` = the server finished a recording:
 * a new overlay manifest is served and the status names its version.
 */
function stack(overlay: ClipIndex | null = null) {
  const staticServer = createFakeServer(fixtureIndex({ omit: ['generic'] }));
  const overlayServer = createFakeServer(overlay, { base: FAKE_OVERLAY, spaFallback: false, hash: '000001', libraryVersion: 1 });
  const ctx = new FakeAudioContext({ state: 'running' });
  const audio = createClipAudio({ createContext: () => ctx });
  const library = createClipLibrary({ baseUrl: FAKE_BASE, overlayUrl: FAKE_OVERLAY, fetch: joinFakeServers(staticServer, overlayServer), audio, idle: (cb) => cb() });
  const voice: ClipVoice = createClipVoice({ audio, library, storage: null, rng: () => 0.5, hasUserActivation: () => true, gestureTarget: null, childName: () => undefined });

  const requests: ClipGenRequest[] = [];
  let version = 1;
  let status = statusOf(version, false);
  const api: ClipGenApi = {
    request(body) {
      requests.push(body);
      status = statusOf(version, true);
      const result: ClipGenRequestResult = { results: body.sentences.map(() => ({ outcome: 'queued' as const, keys: [] })), health: READY, queue: body.sentences.length };
      return Promise.resolve(result);
    },
    status: () => Promise.resolve(status),
  };
  const page: CoachPageLifecycle = { isHidden: () => false, onVisibilityChange: () => () => undefined, onPageHide: () => () => undefined };
  const store = createCoachStore();
  const health: HealthInfo = { ...makeHealth(false, undefined, { runtimeAi: false }), clipGen: READY };
  const coach = createCoachController({
    store,
    getStorage: () => createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voice: 'clips' }) }),
    getHealth: () => Promise.resolve(health),
    isAutomated: () => false,
    clipGen: api,
    page,
    createVoice: (kind) => (kind === 'clips' ? voice : createSilentVoice()),
  });
  return {
    coach,
    store,
    voice,
    ctx,
    overlayServer,
    requests,
    /** the page loads, the child taps once (the audio runs from then on) */
    async start(): Promise<void> {
      await coach.init();
      await vi.advanceTimersByTimeAsync(0);
      voice.unlock();
    },
    publish(index: ClipIndex): void {
      version += 1;
      publishFakeLibrary(overlayServer.files, index, { root: FAKE_OVERLAY, hash: `0000${version.toString(16).padStart(2, '0')}`, libraryVersion: version });
      status = statusOf(version, false);
    },
  };
}

const at = (ms: number): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);

function diags(e: string): Record<string, unknown>[] {
  return voiceDiagRecent().filter((d) => d.e === e) as Record<string, unknown>[];
}

describe('«Дозапись голоса» through the real web stack: recorded while its bubble is up → heard in the same turn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T10:00:00Z'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a teacher\'s lesson phrase in a live game: requested by its parts, merged into the library, played late — whole, as its bubble reads', async () => {
    // the overlay already has the whole sentence; the lead and its tail are new
    const s = stack(recordedOverlay([WHOLE]));
    await s.start();
    s.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    const event = lessonEvent();
    let said = false;
    void s.coach.say(event).then(() => {
      said = true;
    });
    await at(0);
    // shown at once without a voice; only the sentence that has no recording is asked for, as ids
    expect(s.store.getState()).toMatchObject({ bubbleText: event.bubbleText, unvoiced: true });
    expect(s.requests).toEqual([{ sentences: [{ parts: [LEAD, TAIL] }], kind: 'teachTurn' }]);
    expect(s.store.getState().unvoicedMark).toBe('recording');
    // its silent timing ends: the game's clock is released, the bubble stays up waiting for its voice
    await at(10_000);
    expect(said).toBe(true);
    expect(s.ctx.played).toHaveLength(0);
    expect(s.store.getState()).toMatchObject({ bubbleText: event.bubbleText, unvoiced: true, unvoicedMark: 'recording' });

    // the server publishes the lead and the tail ≈ 12 s after the request
    const before = s.voice.libraryStatus()?.units ?? 0;
    expect(before).toBeGreaterThan(1);
    s.publish(recordedOverlay([WHOLE, LEAD, TAIL]));
    // the poller looks every 1.5 s while the bubble waits: the new version is merged, and it starts
    await at(1_600);
    // one library: the static takes, the whole sentence recorded earlier, and the lead and the tail just published
    expect(s.voice.libraryStatus()?.units).toBe(before + 2);
    for (const say of [WHOLE, LEAD, TAIL]) expect(s.overlayServer.requests).toContain(clipUrl(recordedUnit(say).id, CLIP_VOICE_KEY, FAKE_OVERLAY));
    expect(s.ctx.played.length).toBeGreaterThan(0);
    // the mark goes when it starts, the bubble is unchanged — and it is no queued phrase (the game holds the clock itself)
    expect(s.store.getState()).toMatchObject({ bubbleText: event.bubbleText, unvoiced: false, unvoicedMark: null, speaking: true });
    expect(s.coach.speaksAloud()).toBe(false);
    await at(15_000);
    // heard whole: all three parts
    expect(s.ctx.played).toHaveLength(3);
    expect(s.store.getState().speaking).toBe(false);
    expect(diags('clip.late').at(-1)).toMatchObject({ kind: 'teachTurn', ok: true, why: 'played' });
    expect(diags('clip.end').at(-1)).toMatchObject({ late: true });
    // nothing is requested twice, and it is played once
    await at(30_000);
    expect(s.requests).toHaveLength(1);
    expect(s.ctx.played).toHaveLength(3);
    s.coach.dispose();
  });

  it('the child moved before it landed: never played late — and the next time the same phrase is voiced from the library at once', async () => {
    const s = stack();
    await s.start();
    s.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    const event = lessonEvent();
    void s.coach.say(event);
    await at(0);
    expect(s.requests[0]?.sentences).toEqual([{ parts: [WHOLE] }, { parts: [LEAD, TAIL] }]);
    await at(10_000);
    s.coach.noteBoardChange();
    s.publish(recordedOverlay([WHOLE, LEAD, TAIL]));
    await at(5_000);
    expect(s.ctx.played).toHaveLength(0);
    expect(diags('clip.late').at(-1)).toMatchObject({ ok: false, why: 'board' });

    const again = lessonEvent(undefined, { id: 'lesson-again' });
    void s.coach.say(again);
    await at(15_000);
    expect(s.ctx.played).toHaveLength(3);
    expect(s.requests).toHaveLength(1);
    s.coach.dispose();
  });

  it('the home screen\'s greeting (an older event, a clip twin): its bubble\'s wording requested as a whole line, played late', async () => {
    const s = stack();
    await s.start();
    s.coach.setRecordingScope(true);
    const event = greetingEvent(1);
    void s.coach.say(event);
    await at(0);
    expect(s.requests).toEqual([{ sentences: [{ line: HELLO_DAY }], kind: 'greeting' }]);
    expect(s.store.getState()).toMatchObject({ bubbleText: event.bubbleText, unvoiced: true, unvoicedMark: 'recording' });
    await at(8_000);
    expect(s.ctx.played).toHaveLength(0);

    s.publish(recordedLines([HELLO_DAY]));
    await at(1_600);
    expect(s.overlayServer.requests).toContain(clipUrl(recordedLine(HELLO_DAY).id, CLIP_VOICE_KEY, FAKE_OVERLAY));
    expect(s.ctx.played).toHaveLength(1);
    expect(s.store.getState()).toMatchObject({ bubbleText: 'Добрый день!', unvoiced: false, speaking: true });
    await at(5_000);
    expect(diags('clip.late').at(-1)).toMatchObject({ kind: 'greeting', ok: true, why: 'played' });
    s.coach.dispose();
  });
});
