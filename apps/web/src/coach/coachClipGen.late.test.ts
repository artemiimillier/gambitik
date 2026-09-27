/**
 * «Дозапись голоса», so that every phrase is heard: a phrase shown without its voice whose
 * recording lands while its bubble is still up is played in the same turn: the status is polled every 1.5 s, the
 * bubble stays up to 30 s, and the layer plays it (`playLate`) only when the SAME bubble is still shown and nothing
 * else is said — outside the queue (no `say()`: the game holds the child's clock through `onLateSpeech`; no arrows, no
 * `speaksAloud`), never interrupting, never after the
 * child moved, a newer phrase, a stop, mute, a hidden page, the quiz card, a game start, and never under automation.
 * Fake layer, fake routes, fake timers: silent, free, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipGenHealth, ClipGenOutcome, ClipGenRequest, ClipGenRequestResult, ClipGenStatus, CoachEvent, HealthInfo, VoiceLayer } from '@gambit/shared';
import { createCoachController } from './coachController.ts';
import type { CoachController, CoachPageLifecycle } from './coachController.ts';
import { createCoachStore } from './coachStore.ts';
import type { CoachStore } from './coachStore.ts';
import type { ClipGenApi } from './clips/clipOnDemand.ts';
import { HELLO_DAY, greetingEvent } from './clips/testLesson.ts';
import { SETTINGS_STORAGE_KEY } from './settings.ts';
import { createSilentVoice } from './silentVoice.ts';
import { createMemoryStorage, makeEvent, makeHealth } from './testUtils.ts';
import { configureVoiceDiagForTests, resetVoiceDiagForTests, voiceDiagRecent } from './voiceDiag.ts';
import type { ClipExtras, ClipLateOptions, ClipLateResult, ClipLibraryStatus, ClipPlanInfo, ClipSpeakOptions } from './voiceTypes.ts';
import { createEmitter } from './voiceUtils.ts';

/** A clips layer driven by hand: `speakEvent` waits for `finish()`, a late play sounds until `finishLate()` / `stop()`. */
interface FakeClipLayer extends VoiceLayer, ClipExtras {
  readonly kind: 'clips';
  speakEvent(event: CoachEvent, opts?: ClipSpeakOptions): Promise<void>;
  readonly calls: CoachEvent[];
  readonly lateCalls: CoachEvent[];
  /** what a late play does: 'sound' = it starts (onStart) and sounds until finishLate() / stop(); else it answers that */
  late: 'sound' | ClipLateResult;
  /** the words a late play says (default: the event's text) */
  lateHeard: string | null;
  /** how the late plays ended */
  readonly lateResults: ClipLateResult[];
  /** ms to the end of the sentence a late play is saying (null = far / unknown: a gentle stop cuts it) */
  sentenceLeftMs: number | null;
  /** how often the controller asked the layer to end after the sentence being heard */
  endAfterSentenceCalls: number;
  /** the server published a recording: the next reload changes the library */
  publish(): void;
  reloads: number;
  finish(): void;
  finishLate(): void;
  emitPlan(info: ClipPlanInfo): void;
}

function createFakeClipLayer(): FakeClipLayer {
  const speaking = createEmitter<boolean>();
  const plans = createEmitter<ClipPlanInfo>();
  let pending: (() => void) | null = null;
  let lateEnd: ((how: ClipLateResult) => void) | null = null;
  let published = 0;
  let loaded = 0;
  const library: ClipLibraryStatus = { voiceKey: 'giselle-mm1', libraryVersion: 3, phrases: 85, units: 85 };
  const layer: FakeClipLayer = {
    kind: 'clips',
    calls: [],
    lateCalls: [],
    late: 'sound',
    lateHeard: null,
    lateResults: [],
    sentenceLeftMs: null,
    endAfterSentenceCalls: 0,
    reloads: 0,
    init: () => Promise.resolve(),
    speak: () => Promise.resolve(),
    speakEvent(event) {
      lateEnd?.('stopped');
      layer.calls.push(event);
      return new Promise<void>((resolve) => {
        pending = () => {
          pending = null;
          resolve();
        };
      });
    },
    stop: () => {
      pending?.();
      lateEnd?.('stopped');
    },
    onLevel: () => () => undefined,
    onSpeakingChange: (cb) => speaking.on(cb),
    dispose: () => undefined,
    msToSentenceEnd: () => (lateEnd !== null ? layer.sentenceLeftMs : null),
    endAfterSentence: () => {
      if (lateEnd === null || layer.sentenceLeftMs === null) return false;
      layer.endAfterSentenceCalls += 1;
      return true;
    },
    replayLast: () => Promise.resolve(),
    onPlan: (cb) => plans.on(cb),
    prewarm: () => undefined,
    libraryStatus: () => library,
    setGame: () => undefined,
    lessonProbe: () => null,
    canVoiceLesson: () => false,
    reloadOverlay() {
      layer.reloads += 1;
      const changed = loaded !== published;
      loaded = published;
      return Promise.resolve(changed);
    },
    // the version this layer's library holds: what its last reload brought
    overlayVersion: () => loaded + 1,
    playLate(event: CoachEvent, opts: ClipLateOptions = {}): Promise<ClipLateResult> {
      layer.lateCalls.push(event);
      const done = (how: ClipLateResult): ClipLateResult => {
        layer.lateResults.push(how);
        return how;
      };
      if (layer.late !== 'sound') return Promise.resolve(done(layer.late));
      if (opts.stillCurrent && !opts.stillCurrent()) return Promise.resolve(done('stopped'));
      opts.onStart?.(layer.lateHeard ?? event.text);
      speaking.emit(true);
      return new Promise<ClipLateResult>((resolve) => {
        lateEnd = (how) => {
          lateEnd = null;
          speaking.emit(false);
          resolve(done(how));
        };
      });
    },
    publish() {
      published += 1;
    },
    finish: () => pending?.(),
    finishLate: () => lateEnd?.('played'),
    emitPlan: (info) => plans.emit(info),
  };
  return layer;
}

const READY: ClipGenHealth = { state: 'ready', overlay: true };

function statusOf(patch: Partial<ClipGenStatus> = {}): ClipGenStatus {
  return {
    health: READY,
    enabled: true,
    queue: 0,
    busy: false,
    overlay: { version: 1, units: 85 },
    spent: { today: '2026-09-25', todayMilli: 0, totalMilli: 0, prefetchMilli: 0 },
    caps: { dailyMilli: 3000, dailyMaxMilli: 15000, totalMilli: 60000 },
    givenUp: 0,
    ...patch,
  };
}

interface Harness {
  coach: CoachController;
  store: CoachStore;
  layer(): FakeClipLayer;
  requests: ClipGenRequest[];
  statusCalls(): number;
  answer(outcomes: ClipGenOutcome[]): void;
  /** the server works on the request (the status poller keeps going) */
  working(): void;
  /** the recording is published: a new overlay version, nothing outstanding */
  publish(): void;
  hide(): void;
}

function setup(o: { automated?: boolean; muted?: boolean } = {}): Harness {
  const store = createCoachStore();
  const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voice: 'clips', ...(o.muted ? { muted: true } : {}) }) });
  const health: HealthInfo = { ...makeHealth(false, undefined, { runtimeAi: false }), clipGen: READY };
  let last: FakeClipLayer | null = null;
  let count = 0;
  const requests: ClipGenRequest[] = [];
  let statusCalls = 0;
  let next: ClipGenOutcome[] | null = null;
  let status = statusOf();
  let version = 1;
  let hidden = false;
  let onVisibility: (() => void) | null = null;
  const page: CoachPageLifecycle = {
    isHidden: () => hidden,
    onVisibilityChange(cb) {
      onVisibility = cb;
      return () => undefined;
    },
    onPageHide: () => () => undefined,
  };
  const api: ClipGenApi = {
    request(body) {
      requests.push(body);
      const outcomes = next ?? body.sentences.map(() => 'queued' as const);
      const result: ClipGenRequestResult = { results: outcomes.map((outcome) => ({ outcome, keys: [] })), health: READY, queue: 1 };
      return Promise.resolve(result);
    },
    status() {
      statusCalls += 1;
      return Promise.resolve(status);
    },
  };
  const coach = createCoachController({
    store,
    getStorage: () => storage,
    getHealth: () => Promise.resolve(health),
    isAutomated: () => o.automated ?? false,
    clipGen: api,
    page,
    createVoice(kind) {
      count += 1;
      if (count === 1 || kind !== 'clips') return createSilentVoice();
      last = createFakeClipLayer();
      return last;
    },
  });
  const layer = (): FakeClipLayer => {
    if (!last) throw new Error('no clips layer');
    return last;
  };
  return {
    coach,
    store,
    layer,
    requests,
    statusCalls: () => statusCalls,
    answer(outcomes) {
      next = outcomes;
    },
    working() {
      status = statusOf({ queue: 1, busy: true, overlay: { version, units: 85 } });
    },
    publish() {
      version += 1;
      layer().publish();
      status = statusOf({ queue: 0, busy: false, overlay: { version, units: 85 + version } });
    },
    hide() {
      hidden = true;
      onVisibility?.();
    },
  };
}

const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);
const at = (ms: number): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);

function silentPlan(event: CoachEvent, lineMissing = [HELLO_DAY]): ClipPlanInfo {
  return { eventId: event.id, kind: event.kind, src: 'none', level: 6, heard: '', ms: 0, clips: 0, lineMissing };
}

/** the home screen: the greeting is shown without a voice, its line is requested, its silent timing ends after 2 s */
async function greetSilently(h: Harness, event: CoachEvent = greetingEvent()): Promise<{ event: CoachEvent; said: { done: boolean } }> {
  await h.coach.init();
  await flush();
  h.coach.setRecordingScope(true);
  const said = { done: false };
  void h.coach.say(event).then(() => {
    said.done = true;
  });
  await flush();
  h.layer().emitPlan(silentPlan(event));
  await flush();
  h.working();
  await at(2_000);
  h.layer().finish();
  await flush();
  return { event, said };
}

function lateDiags(): { ok?: unknown; why?: unknown; kind?: unknown }[] {
  return voiceDiagRecent().filter((e) => e.e === 'clip.late') as { ok?: unknown; why?: unknown; kind?: unknown }[];
}

describe('coach controller — «Дозапись голоса»: the recording lands while its bubble is up', () => {
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

  it('the home-screen greeting: recorded while it is shown → played at once; the mark goes; the bubble lingers as usual after it', async () => {
    const h = setup();
    const { event, said } = await greetSilently(h);
    expect(h.requests).toEqual([{ sentences: [{ line: { id: 'greet.hello.day', n: 1 } }], kind: 'greeting' }]);
    // the phrase itself was never held back for the recording: its promise (the game's clock hold) is over
    expect(said.done).toBe(true);
    expect(h.store.getState()).toMatchObject({ bubbleText: event.bubbleText, unvoiced: true, unvoicedMark: 'recording' });
    // well past the usual 6 s linger: the bubble waits for its voice
    await at(8_000);
    expect(h.store.getState()).toMatchObject({ bubbleText: event.bubbleText, unvoiced: true });
    expect(h.layer().lateCalls).toHaveLength(0);

    h.publish();
    await at(1_500);
    expect(h.layer().lateCalls).toEqual([event]);
    expect(h.store.getState()).toMatchObject({ bubbleText: event.bubbleText, unvoiced: false, unvoicedMark: null, speaking: true });
    // not a queued phrase: the game never waits for it, the calm arrow is not timed by it
    expect(h.coach.speaksAloud()).toBe(false);
    h.layer().finishLate();
    await flush();
    expect(h.store.getState().speaking).toBe(false);
    expect(lateDiags().at(-1)).toMatchObject({ kind: 'greeting', ok: true, why: 'played' });
    await at(5_900);
    expect(h.store.getState().bubbleText).toBe(event.bubbleText);
    await at(200);
    expect(h.store.getState().bubbleText).toBe('');
    // played once, never again
    await at(30_000);
    expect(h.layer().lateCalls).toHaveLength(1);
    expect(h.layer().calls).toHaveLength(1);
  });

  it('tells the game while a late phrase sounds (the game holds the child\'s clock meanwhile), also when it is cut', async () => {
    const h = setup();
    const heard: boolean[] = [];
    h.coach.onLateSpeech((on) => heard.push(on));
    await greetSilently(h);
    h.publish();
    await at(1_500);
    expect(heard).toEqual([true]);
    h.layer().finishLate();
    await flush();
    expect(heard).toEqual([true, false]);

    const cut = setup();
    const cutHeard: boolean[] = [];
    cut.coach.onLateSpeech((on) => cutHeard.push(on));
    await greetSilently(cut);
    cut.publish();
    await at(1_500);
    cut.coach.setMuted(true);
    await flush();
    expect(cutHeard).toEqual([true, false]);
  });

  it('polls the status every 1.5 s while the bubble waits, and stops once the recording is published', async () => {
    const h = setup();
    await greetSilently(h);
    const before = h.statusCalls();
    await at(6_000);
    expect(h.statusCalls() - before).toBe(4);
    h.publish();
    await at(1_500);
    const published = h.statusCalls();
    await at(30_000);
    expect(h.statusCalls()).toBe(published);
  });

  it('the window ends (30 s): the bubble goes with its mark, nothing plays later — the black box says why', async () => {
    const h = setup();
    const { event } = await greetSilently(h);
    await at(27_900);
    expect(h.store.getState().bubbleText).toBe(event.bubbleText);
    await at(200);
    expect(h.store.getState()).toMatchObject({ bubbleText: '', unvoiced: false });
    expect(lateDiags().at(-1)).toMatchObject({ ok: false, why: 'window' });
    h.publish();
    await at(5_000);
    expect(h.layer().lateCalls).toHaveLength(0);
  });

  it('never when the moment is over: a newer phrase, the child moved, a stop, mute, a hidden page, the quiz card, a game start, the parent\'s page', async () => {
    const cases: [string, (h: Harness) => void][] = [
      ['say', (h) => void h.coach.say(makeEvent({ kind: 'encourage', text: 'Дальше!', bubbleText: 'Дальше!' }))],
      ['board', (h) => h.coach.noteBoardChange()],
      ['stop', (h) => h.coach.stopSpeaking()],
      ['muted', (h) => h.coach.setMuted(true)],
      ['hidden', (h) => h.hide()],
      ['quiz', (h) => h.coach.setAskSuppressed(true)],
      ['game', (h) => h.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' })],
      // the parent opened Settings (the gate already open: nothing is said there)
      ['scope', (h) => h.coach.setRecordingScope(false)],
    ];
    for (const [why, act] of cases) {
      const h = setup();
      await greetSilently(h);
      act(h);
      await flush();
      h.publish();
      await at(3_000);
      expect(h.layer().lateCalls, why).toHaveLength(0);
      expect(lateDiags().at(-1), why).toMatchObject({ ok: false, why });
      h.coach.dispose();
    }
  });

  it('a late play already sounding stops at once when a newer phrase comes, the sound is switched off or a hard stop comes', async () => {
    for (const act of [(h: Harness) => void h.coach.say(makeEvent({ text: 'Дальше!' })), (h: Harness) => h.coach.setMuted(true), (h: Harness) => h.coach.stopSpeaking()]) {
      const h = setup();
      await greetSilently(h);
      h.publish();
      await at(1_500);
      expect(h.layer().lateCalls).toHaveLength(1);
      expect(h.store.getState().speaking).toBe(true);
      act(h);
      await flush();
      expect(h.layer().lateResults).toEqual(['stopped']);
      h.coach.dispose();
    }
  });

  it('the child moves while a late phrase sounds: chatter goes on to its end, as when said at once — never cut mid-word', async () => {
    const h = setup();
    await greetSilently(h);
    h.publish();
    await at(1_500);
    expect(h.store.getState().speaking).toBe(true);
    h.coach.noteBoardChange();
    await at(3_000);
    expect(h.layer().lateResults).toEqual([]);
    expect(h.store.getState().speaking).toBe(true);
    h.layer().finishLate();
    await flush();
    expect(h.layer().lateResults).toEqual(['played']);
  });

  it('a phrase that held the clock (or a gentle stop): it ends its sentence (≤ 2 s), or is cut when far from its end', async () => {
    for (const [name, act] of [
      ['move', (h: Harness) => h.coach.noteBoardChange()],
      ['grace', (h: Harness) => h.coach.stopSpeaking({ grace: true })],
    ] as const) {
      // near the sentence end: the layer ends after it; the stop grace is the safety cut
      const near = setup();
      await greetSilently(near, greetingEvent(1, { kind: 'answer', pauseClock: true }));
      near.publish();
      await at(1_500);
      near.layer().sentenceLeftMs = 800;
      act(near);
      await flush();
      expect(near.layer().endAfterSentenceCalls, name).toBe(1);
      expect(near.layer().lateResults, name).toEqual([]);
      await at(1_900);
      expect(near.layer().lateResults, name).toEqual([]);
      await at(200);
      expect(near.layer().lateResults, name).toEqual(['stopped']);
      near.coach.dispose();
      // far from it: cut now, as a phrase said at once would be
      const far = setup();
      await greetSilently(far, greetingEvent(1, { kind: 'answer', pauseClock: true }));
      far.publish();
      await at(1_500);
      act(far);
      await flush();
      expect(far.layer().lateResults, name).toEqual(['stopped']);
      far.coach.dispose();
    }
  });

  it('the recording was quicker than the phrase\'s own silent timing: it plays right after it, never over it', async () => {
    const h = setup();
    await h.coach.init();
    await flush();
    h.coach.setRecordingScope(true);
    const event = greetingEvent();
    void h.coach.say(event);
    await flush();
    h.layer().emitPlan(silentPlan(event));
    await flush();
    h.working();
    h.publish();
    await at(1_500);
    expect(h.layer().lateCalls).toHaveLength(0);
    h.layer().finish();
    await flush();
    expect(h.layer().lateCalls).toEqual([event]);
  });

  it('«already recorded» (this page\'s overlay was older): re-read, then played — once the phrase\'s silent timing is over', async () => {
    const h = setup();
    await h.coach.init();
    await flush();
    h.coach.setRecordingScope(true);
    h.answer(['voiced']);
    h.layer().publish();
    const event = greetingEvent();
    void h.coach.say(event);
    await flush();
    h.layer().emitPlan(silentPlan(event));
    await flush();
    expect(h.store.getState().unvoicedMark).toBe('unrecorded');
    h.layer().finish();
    await flush();
    expect(h.layer().lateCalls).toEqual([event]);
  });

  it('the library does not say it whole yet (one sentence still on its way): it waits for the next publish', async () => {
    const h = setup();
    await greetSilently(h);
    h.layer().late = 'not-voiced';
    // one sentence published, the other still being recorded
    h.publish();
    h.working();
    await at(1_500);
    expect(h.layer().lateCalls).toHaveLength(1);
    expect(h.store.getState().unvoiced).toBe(true);
    h.layer().late = 'sound';
    h.publish();
    await at(1_500);
    expect(h.layer().lateCalls).toHaveLength(2);
    expect(h.store.getState()).toMatchObject({ unvoiced: false, speaking: true });
  });

  it('a twin that can only ever say part of its bubble (the opponent\'s name, the practice idea): recorded, but never waited for', async () => {
    const h = setup();
    await h.coach.init();
    await flush();
    h.coach.setRecordingScope(true);
    const event = greetingEvent(1, { kind: 'gameStart' });
    void h.coach.say(event);
    await flush();
    h.layer().emitPlan({ ...silentPlan(event), partial: true });
    await flush();
    h.working();
    // asked for, and marked as being recorded (it is voiced from the next time on)
    expect(h.requests).toHaveLength(1);
    expect(h.store.getState()).toMatchObject({ unvoiced: true, unvoicedMark: 'recording' });
    await at(2_000);
    h.layer().finish();
    await flush();
    // the bubble goes after the usual linger: nothing would ever play it late
    await at(6_100);
    expect(h.store.getState().bubbleText).toBe('');
    h.publish();
    await at(5_000);
    expect(h.layer().lateCalls).toHaveLength(0);
    expect(lateDiags()).toEqual([]);
  });

  it('an answer twin says one of its wordings: the bubble shows the words really heard', async () => {
    const h = setup();
    const answer = greetingEvent(1, { kind: 'answer' });
    await greetSilently(h, answer);
    h.layer().lateHeard = 'Привет-привет, добрый день!';
    h.publish();
    await at(1_500);
    expect(h.store.getState()).toMatchObject({ bubbleText: 'Привет-привет, добрый день!', unvoiced: false });
  });

  it('touches nothing of the game: its arrows stay as the game left them', async () => {
    const h = setup();
    const arrows = { arrows: [{ from: 'g1', to: 'f3', color: 'green' as const }], highlights: [] };
    const { event } = await greetSilently(h, greetingEvent(1, { board: arrows }));
    expect(h.store.getState().annotations).toEqual(event.board);
    h.coach.clearAnnotations();
    h.publish();
    await at(1_500);
    h.layer().finishLate();
    await flush();
    expect(h.layer().lateCalls).toHaveLength(1);
    expect(h.store.getState().annotations).toBeNull();
  });

  it('never under automation (nothing is even requested), never muted', async () => {
    const auto = setup({ automated: true });
    await greetSilently(auto);
    auto.publish();
    await at(5_000);
    expect(auto.requests).toHaveLength(0);
    expect(auto.layer().lateCalls).toHaveLength(0);

    // muted from the start: the layer is not even asked to plan (the silent layer keeps the timing)
    const muted = setup({ muted: true });
    await muted.coach.init();
    muted.coach.setRecordingScope(true);
    void muted.coach.say(greetingEvent());
    await at(10_000);
    expect(muted.layer().calls).toHaveLength(0);
    expect(muted.requests).toHaveLength(0);
    expect(muted.layer().lateCalls).toHaveLength(0);
  });
});
