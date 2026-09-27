/**
 * The coach controller's lesson-model seams for the game (docs/TEACHING.md §2.2, §4.6):
 *   - `showPose(pose, ms)` — a quiet turn's nod, the joy over a find over the praise cap: a pose without words, no
 *     bubble, no sound, no queue;
 *   - `speaksAloud()` — the phrase being said is really heard (the game shows the calm advice's arrow after the reading
 *     time when it is not: the silent layer, muted, «не озвучено», a click still needed, a page that cannot play).
 * Fakes only — silent and free.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoachEvent, VoiceLayer } from '@gambit/shared';
import { createCoachController } from './coachController.ts';
import type { CoachController } from './coachController.ts';
import { createCoachStore } from './coachStore.ts';
import type { CoachStore } from './coachStore.ts';
import { SETTINGS_STORAGE_KEY } from './settings.ts';
import { createSilentVoice } from './silentVoice.ts';
import { createFakeVoice, createMemoryStorage, makeEvent, makeHealth } from './testUtils.ts';
import type { FakeVoice, FakeVoiceOptions } from './testUtils.ts';
import type { ClipExtras, ClipLibraryStatus, ClipPlanInfo, ClipSpeakOptions, VoiceKind } from './voiceTypes.ts';
import { createEmitter } from './voiceUtils.ts';

// ───────────────────────── harness ─────────────────────────

/** A «Записи» layer driven by hand: every `speakEvent` waits for `finish()`; the plan is emitted by the test. */
interface FakeClipLayer extends VoiceLayer, ClipExtras {
  readonly kind: 'clips';
  speakEvent(event: CoachEvent, opts?: ClipSpeakOptions): Promise<void>;
  readonly calls: CoachEvent[];
  finish(): void;
  emitPlan(info: ClipPlanInfo): void;
}

function createFakeClipLayer(): FakeClipLayer {
  const speaking = createEmitter<boolean>();
  const level = createEmitter<number>();
  const plans = createEmitter<ClipPlanInfo>();
  let pending: (() => void) | null = null;
  const status: ClipLibraryStatus = { voiceKey: 'giselle-mm1', libraryVersion: 3, phrases: 10, units: 10 };
  const layer: FakeClipLayer = {
    kind: 'clips',
    calls: [],
    init: () => Promise.resolve(),
    speak: () => Promise.resolve(),
    speakEvent(event) {
      layer.calls.push(event);
      speaking.emit(true);
      return new Promise<void>((resolve) => {
        pending = () => {
          pending = null;
          speaking.emit(false);
          resolve();
        };
      });
    },
    stop: () => pending?.(),
    onLevel: (cb) => level.on(cb),
    onSpeakingChange: (cb) => speaking.on(cb),
    dispose: () => undefined,
    msToSentenceEnd: () => null,
    endAfterSentence: () => false,
    replayLast: () => Promise.resolve(),
    onPlan: (cb) => plans.on(cb),
    prewarm: () => undefined,
    libraryStatus: () => status,
    setGame: () => undefined,
    finish: () => pending?.(),
    emitPlan: (info) => plans.emit(info),
  };
  return layer;
}

interface Harness {
  coach: CoachController;
  store: CoachStore;
  /** the last layer the controller built (not its private silent one) */
  layer(): FakeVoice | FakeClipLayer;
}

function setup(opts: { preference?: string; muted?: boolean; voice?: FakeVoiceOptions } = {}): Harness {
  const store = createCoachStore();
  const settings = { voice: opts.preference ?? 'browser', ...(opts.muted ? { muted: true } : {}) };
  const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(settings) });
  let count = 0;
  let last: FakeVoice | FakeClipLayer | null = null;
  const coach = createCoachController({
    store,
    getStorage: () => storage,
    getHealth: () => Promise.resolve(makeHealth(false)),
    createVoice(kind: VoiceKind) {
      count += 1;
      // the very first layer is the controller's private silent one (muted phrases go there)
      if (count === 1) return createSilentVoice();
      if (kind === 'silent') {
        const silent = createSilentVoice();
        return silent;
      }
      last = kind === 'clips' ? createFakeClipLayer() : createFakeVoice({ kind, ...opts.voice });
      return last;
    },
  });
  return {
    coach,
    store,
    layer() {
      if (!last) throw new Error('no voice layer yet');
      return last;
    },
  };
}

const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

/** a lesson phrase (`say`) — `clip` makes it a recorded one */
function lessonEvent(patch: Partial<CoachEvent> = {}): CoachEvent {
  return makeEvent({
    kind: 'teachTurn',
    text: 'Центр ещё свободен — займём его пешкой.',
    bubbleText: 'Центр ещё свободен — займём его пешкой.',
    teach: { moment: 'turn', style: 'short', ply: 1, advice: [] },
    say: [{ pool: 'v3.aim.center', n: 1 }],
    ...patch,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ───────────────────────── showPose ─────────────────────────

describe('coach.showPose — a pose without words (docs/TEACHING.md §2.2)', () => {
  it('a quiet turn\'s nod: the pose for its time, then idle — no bubble, no sound, nothing queued', async () => {
    const h = setup();
    await h.coach.init();
    const voice = h.layer() as FakeVoice;
    h.coach.showPose('talk', 900);
    expect(h.store.getState()).toMatchObject({ pose: 'talk', bubbleText: '', speaking: false, unvoiced: false });
    expect(voice.spoken).toEqual([]);
    await vi.advanceTimersByTimeAsync(850);
    expect(h.store.getState().pose).toBe('talk');
    await vi.advanceTimersByTimeAsync(100);
    expect(h.store.getState().pose).toBe('idle');
    expect(h.store.getState().bubbleText).toBe('');
    expect(voice.spoken).toEqual([]);
    // it never counts as «being said»: nothing to hear
    expect(h.coach.speaksAloud()).toBe(false);
  });

  it('an animated pose keeps its own minimum time (cheer 2.4 s), a silly length is capped', async () => {
    const h = setup();
    await h.coach.init();
    h.coach.showPose('cheer', 1_500);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.store.getState().pose).toBe('cheer');
    await vi.advanceTimersByTimeAsync(500);
    expect(h.store.getState().pose).toBe('idle');

    h.coach.showPose('think', 60_000);
    await vi.advanceTimersByTimeAsync(10_050);
    expect(h.store.getState().pose).toBe('idle');
    // nothing for a zero / broken length
    h.coach.showPose('cheer', 0);
    h.coach.showPose('cheer', Number.NaN);
    expect(h.store.getState().pose).toBe('idle');
  });

  it('the bubble of an earlier phrase stays with its own timer — the pose does not clear or renew it', async () => {
    const h = setup();
    await h.coach.init();
    const done = h.coach.say(makeEvent({ text: 'Хороший ход!', bubbleText: 'Хороший ход!', pose: 'talk' }));
    await flush();
    (h.layer() as FakeVoice).finish();
    await done;
    h.coach.showPose('talk', 900);
    expect(h.store.getState()).toMatchObject({ pose: 'talk', bubbleText: 'Хороший ход!' });
    await vi.advanceTimersByTimeAsync(6_100);
    expect(h.store.getState()).toMatchObject({ pose: 'idle', bubbleText: '' });
  });

  it('a phrase being said keeps its pose; the next phrase drops the hold', async () => {
    const h = setup();
    await h.coach.init();
    const voice = h.layer() as FakeVoice;
    const first = h.coach.say(makeEvent({ pose: 'think' }));
    await flush();
    h.coach.showPose('cheer', 1_000);
    expect(h.store.getState().pose).toBe('think');
    voice.finish();
    await first;

    h.coach.showPose('cheer', 5_000);
    expect(h.store.getState().pose).toBe('cheer');
    void h.coach.say(makeEvent({ pose: 'wave' }));
    await flush();
    expect(h.store.getState().pose).toBe('wave');
    voice.finish();
    await flush();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(h.store.getState().pose).toBe('idle');
  });

  it('never wakes a sleeping mascot; nothing after dispose', async () => {
    const h = setup();
    await h.coach.init();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(h.store.getState()).toMatchObject({ pose: 'sleep', asleep: true });
    h.coach.showPose('cheer', 1_500);
    expect(h.store.getState()).toMatchObject({ pose: 'sleep', asleep: true });

    h.coach.dispose();
    h.coach.showPose('cheer', 1_500);
    expect(h.store.getState().pose).toBe('sleep');
  });
});

// ───────────────────────── speaksAloud ─────────────────────────

describe('coach.speaksAloud — is the phrase really heard? (docs/TEACHING.md §4.6)', () => {
  it('a sounding voice while it says the phrase: true; before and after it: false', async () => {
    const h = setup();
    await h.coach.init();
    expect(h.coach.speaksAloud()).toBe(false);
    const done = h.coach.say(makeEvent());
    await flush();
    expect(h.coach.speaksAloud()).toBe(true);
    (h.layer() as FakeVoice).finish();
    await done;
    expect(h.coach.speaksAloud()).toBe(false);
  });

  it('muted: the phrase goes to the silent layer — false; the sound switched off mid-phrase — false from then on', async () => {
    const muted = setup({ muted: true });
    await muted.coach.init();
    void muted.coach.say(makeEvent());
    await flush();
    expect(muted.store.getState()).toMatchObject({ speaking: true, muted: true });
    expect(muted.coach.speaksAloud()).toBe(false);

    const h = setup();
    await h.coach.init();
    void h.coach.say(makeEvent({ text: 'Длинная фраза, которую он говорит вслух прямо сейчас.' }));
    await flush();
    expect(h.coach.speaksAloud()).toBe(true);
    h.coach.setMuted(true);
    expect(h.coach.speaksAloud()).toBe(false);
  });

  it('the silent voice (voice «off», automation): false while the bubble is up', async () => {
    const h = setup({ preference: 'off' });
    await h.coach.init();
    expect(h.store.getState().voiceKind).toBe('silent');
    void h.coach.say(makeEvent());
    await flush();
    expect(h.store.getState().speaking).toBe(true);
    expect(h.coach.speaksAloud()).toBe(false);
  });

  it('a click still needed (the phrase waits behind the lock), or a page that cannot play («Не слышно?»): false', async () => {
    const locked = setup({ voice: { gestureGated: true, needsGesture: true } });
    await locked.coach.init();
    void locked.coach.say(makeEvent());
    await flush();
    expect(locked.store.getState().needsUserGesture).toBe(true);
    expect(locked.coach.speaksAloud()).toBe(false);

    const h = setup();
    await h.coach.init();
    void h.coach.say(makeEvent());
    await flush();
    expect(h.coach.speaksAloud()).toBe(true);
    h.store.setState({ hearingCheck: true });
    expect(h.coach.speaksAloud()).toBe(false);
  });

  it('«Записи»: a recorded phrase — true; a lesson phrase «не озвучено» (no twin, or its plan came out empty) — false', async () => {
    const h = setup({ preference: 'clips' });
    await h.coach.init();
    const layer = h.layer() as FakeClipLayer;
    expect(h.store.getState().voiceKind).toBe('clips');

    // a non-lesson event (no `say`): voiced as usual
    const plain = h.coach.say(makeEvent({ kind: 'encourage' }));
    await flush();
    expect(h.coach.speaksAloud()).toBe(true);
    layer.finish();
    await plain;

    // a lesson phrase with no recording: the layer plays nothing, the bubble says «не озвучено»
    const unrecorded = lessonEvent();
    const first = h.coach.say(unrecorded);
    await flush();
    expect(h.store.getState().unvoiced).toBe(true);
    expect(h.coach.speaksAloud()).toBe(false);
    layer.finish();
    await first;

    // a recorded twin: heard — until its plan comes out empty
    const twin = lessonEvent({ clip: { sentences: [{ items: [{ line: 'teach.head.advice' }], prio: 100, end: '.' }], generic: 'generic.teachTurn.turn' } });
    void h.coach.say(twin);
    await flush();
    expect(h.coach.speaksAloud()).toBe(true);
    layer.emitPlan({ eventId: twin.id, kind: twin.kind, src: 'none', level: 6, heard: '', ms: 0, clips: 0 });
    expect(h.coach.speaksAloud()).toBe(false);
    layer.finish();
    await flush();
  });
});
