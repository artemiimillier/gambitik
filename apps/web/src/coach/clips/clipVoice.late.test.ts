/**
 * «Дозапись голоса» for every phrase, through the real clip layer: a non-lesson event's twin is planned with the wording
 * its bubble reads and names the whole sentences it misses (`lineMissing`); `playLate` plays a phrase that was
 * silent a moment ago once its recording arrived — whole and exactly as its bubble reads, only into a running
 * context, only while the layer says nothing else, never reported as a plan, cut by a stop or a newer phrase.
 * Fake fetch, fake AudioContext: silent, free.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIP_VOICE_KEY } from '@gambit/core';
import type { ClipIndex } from '@gambit/core';
import type { CoachEvent } from '@gambit/shared';
import { fixtureIndex } from '../../../../../packages/core/src/coach/clips/fixtures.ts';
import { createMemoryStorage } from '../testUtils.ts';
import { configureVoiceDiagForTests, resetVoiceDiagForTests } from '../voiceDiag.ts';
import type { ClipPlanInfo } from '../voiceTypes.ts';
import { createClipAudio } from './clipAudio.ts';
import { createClipLibrary } from './clipLibrary.ts';
import { readClipStats } from './clipMemory.ts';
import { createClipVoice } from './clipVoice.ts';
import { HELLO_DAY, HELLO_DAY_2, LEAD, TAIL, WHOLE, greetingEvent, lessonEvent, recordedLine, recordedLines, recordedOverlay } from './testLesson.ts';
import { FAKE_BASE, FAKE_OVERLAY, FakeAudioContext, clipUrl, createFakeServer, joinFakeServers, publishFakeLibrary } from './testAudio.ts';

/** the static library has no greeting and no generic line: a greeting is silent until the overlay records it */
const STATIC = (): ClipIndex => fixtureIndex({ omit: ['generic'] });

function rig(overlay: ClipIndex | null, o: { state?: 'running' | 'suspended'; storage?: boolean } = {}) {
  const staticServer = createFakeServer(STATIC());
  const overlayServer = createFakeServer(overlay, { base: FAKE_OVERLAY, spaFallback: false, hash: '0000aa', libraryVersion: 1 });
  const ctx = new FakeAudioContext({ state: o.state ?? 'running', resumeBlocked: o.state === 'suspended' });
  const audio = createClipAudio({ createContext: () => ctx });
  const library = createClipLibrary({ baseUrl: FAKE_BASE, overlayUrl: FAKE_OVERLAY, fetch: joinFakeServers(staticServer, overlayServer), audio, idle: (cb) => cb() });
  const storage = o.storage === true ? createMemoryStorage() : null;
  const voice = createClipVoice({ audio, library, storage, rng: () => 0.5, hasUserActivation: () => true, gestureTarget: null });
  const plans: ClipPlanInfo[] = [];
  voice.onPlan((p) => plans.push(p));
  let version = 1;
  return {
    voice,
    ctx,
    library,
    overlayServer,
    plans,
    storage,
    /** the library loads, the child taps the page once (the audio context exists and runs from then on) */
    async start(): Promise<void> {
      await voice.init();
      voice.unlock();
    },
    /** the server publishes a new overlay with these takes; the layer re-reads it */
    async publish(index: ClipIndex): Promise<boolean> {
      version += 1;
      publishFakeLibrary(overlayServer.files, index, { root: FAKE_OVERLAY, hash: `0000${version.toString(16).padStart(2, '0')}`, libraryVersion: version });
      return (await voice.reloadOverlay?.()) ?? false;
    },
  };
}

async function speak(r: ReturnType<typeof rig>, event: CoachEvent): Promise<void> {
  const done = r.voice.speakEvent(event);
  await vi.advanceTimersByTimeAsync(30_000);
  await done;
}

describe('clipVoice — a non-lesson event\'s twin says its bubble\'s wording and names what it misses', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
  });

  it('no take of the line: silent, and the bubble\'s own wording is named for recording', async () => {
    const r = rig(null);
    await r.start();
    await speak(r, greetingEvent(1));
    expect(r.plans[0]).toMatchObject({ src: 'none', level: 6, clips: 0, lineMissing: [HELLO_DAY] });
    expect(r.ctx.played).toHaveLength(0);
  });

  it('the bubble\'s wording recorded: exactly that take plays, nothing is named', async () => {
    const r = rig(recordedLines([HELLO_DAY_2, HELLO_DAY]));
    await r.start();
    await speak(r, greetingEvent(1));
    expect(r.plans[0]).toMatchObject({ src: 'clip', clips: 1, heard: 'Добрый день!' });
    expect(r.plans[0]?.lineMissing).toBeUndefined();
    expect(r.overlayServer.requests).toContain(clipUrl(recordedLine(HELLO_DAY).id, CLIP_VOICE_KEY, FAKE_OVERLAY));
  });

  it('only another wording recorded: it stands in (as before), and the bubble\'s own wording is still named', async () => {
    const r = rig(recordedLines([HELLO_DAY_2]));
    await r.start();
    await speak(r, greetingEvent(1));
    expect(r.plans[0]).toMatchObject({ clips: 1, heard: 'Привет-привет, добрый день!', lineMissing: [HELLO_DAY] });
  });
});

describe('clipVoice — playLate: the recording landed while the bubble is up', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
  });

  it('silent a moment ago, recorded since: played whole, as the bubble reads — never reported as a plan, no bark', async () => {
    const r = rig(null);
    await r.start();
    const event = greetingEvent(1);
    await speak(r, event);
    expect(r.plans).toHaveLength(1);
    await expect(r.publish(recordedLines([HELLO_DAY]))).resolves.toBe(true);
    const heard: string[] = [];
    const done = r.voice.playLate?.(event, { onStart: (words) => heard.push(words) });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(done).resolves.toBe('played');
    expect(heard).toEqual(['Добрый день!']);
    expect(r.ctx.played).toHaveLength(1);
    // one plan was reported (the silent one): the late play adds nothing to ask for, nothing to count twice
    expect(r.plans).toHaveLength(1);
  });

  it('the library says it only with another wording (the bubble reads other words): not voiced, nothing plays', async () => {
    const r = rig(null);
    await r.start();
    const event = greetingEvent(1);
    await speak(r, event);
    await r.publish(recordedLines([HELLO_DAY_2]));
    const done = r.voice.playLate?.(event);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(done).resolves.toBe('not-voiced');
    expect(r.ctx.played).toHaveLength(0);
  });

  it('an answer twin may say any wording of its pool: its bubble takes the heard words at the start', async () => {
    const r = rig(null);
    await r.start();
    const answer = greetingEvent(1, { kind: 'answer' });
    await speak(r, answer);
    await r.publish(recordedLines([HELLO_DAY_2]));
    const heard: string[] = [];
    const done = r.voice.playLate?.(answer, { onStart: (words) => heard.push(words) });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(done).resolves.toBe('played');
    expect(heard).toEqual(['Привет-привет, добрый день!']);
  });

  it('a lesson phrase: only when every sentence has its take (whole or nothing)', async () => {
    const r = rig(recordedOverlay([WHOLE, LEAD]));
    await r.start();
    const lesson = lessonEvent();
    await expect(r.voice.playLate?.(lesson)).resolves.toBe('not-voiced');
    await r.publish(recordedOverlay([WHOLE, LEAD, TAIL]));
    const done = r.voice.playLate?.(lesson);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(done).resolves.toBe('played');
    expect(r.ctx.played).toHaveLength(3);
  });

  it('never into a suspended context: no resume, no gesture asked for, nothing scheduled', async () => {
    const r = rig(recordedLines([HELLO_DAY]), { state: 'suspended' });
    await r.start();
    const resumes = r.ctx.resumeCalls;
    await expect(r.voice.playLate?.(greetingEvent(1))).resolves.toBe('no-audio');
    expect(r.ctx.resumeCalls).toBe(resumes);
    expect(r.voice.needsUserGesture).toBe(false);
    expect(r.ctx.played).toHaveLength(0);
  });

  it('never over another phrase: busy while one is said or still loading', async () => {
    const r = rig(recordedLines([HELLO_DAY]));
    await r.start();
    r.overlayServer.delay(clipUrl(recordedLine(HELLO_DAY).id, CLIP_VOICE_KEY, FAKE_OVERLAY), 500);
    const saying = r.voice.speakEvent(greetingEvent(1));
    // loading its take: nothing is audible yet, the layer is busy all the same
    await expect(r.voice.playLate?.(greetingEvent(1))).resolves.toBe('busy');
    await vi.advanceTimersByTimeAsync(600);
    await expect(r.voice.playLate?.(greetingEvent(1))).resolves.toBe('busy');
    await vi.advanceTimersByTimeAsync(10_000);
    await saying;
    expect(r.ctx.played).toHaveLength(1);
  });

  it('the moment passed while its take loaded (a newer phrase, a stop, `stillCurrent` false): nothing plays', async () => {
    const r = rig(recordedLines([HELLO_DAY]));
    await r.start();
    const url = clipUrl(recordedLine(HELLO_DAY).id, CLIP_VOICE_KEY, FAKE_OVERLAY);
    r.overlayServer.delay(url, 500);
    const late = r.voice.playLate?.(greetingEvent(1));
    r.voice.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(late).resolves.toBe('stopped');
    expect(r.ctx.played).toHaveLength(0);

    const refused = r.voice.playLate?.(greetingEvent(1), { stillCurrent: () => false });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(refused).resolves.toBe('stopped');
    expect(r.ctx.played).toHaveLength(0);
  });

  it('a stop while it sounds cuts it: \'stopped\'; the next phrase goes as usual', async () => {
    const r = rig(recordedLines([HELLO_DAY]));
    await r.start();
    const late = r.voice.playLate?.(greetingEvent(1));
    await vi.advanceTimersByTimeAsync(200);
    expect(r.ctx.played).toHaveLength(1);
    const next = r.voice.speakEvent(greetingEvent(1));
    await expect(late).resolves.toBe('stopped');
    await vi.advanceTimersByTimeAsync(10_000);
    await next;
    expect(r.ctx.played).toHaveLength(2);
  });

  it('counts in the game\'s coverage as `late` (the silent utterance stays counted as silent)', async () => {
    const r = rig(null, { storage: true });
    await r.start();
    r.voice.setGame({ timeControlId: 'training' });
    const event = greetingEvent(1);
    await speak(r, event);
    await r.publish(recordedLines([HELLO_DAY]));
    const done = r.voice.playLate?.(event);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    r.voice.setGame(null);
    expect(readClipStats(r.storage)).toMatchObject({ utterances: 1, silent: 1, recorded: 0, late: 1 });
  });
});
