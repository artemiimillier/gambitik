/**
 * The coach controller and «Дозапись голоса» (docs/voice-clips/ONDEMAND.md): a silent lesson plan in a live game turn asks the server
 * to record its missing sentences — never under automation, never muted, never outside a game or in an exam; the bubble
 * says «записываю голос…» only when every missing sentence came back queued / recording and the same bubble is still
 * shown, else «не озвучено»; the phrase itself is never held back. `voicePolicy()` — the lesson book's live probe —
 * only while the clip layer really speaks. Every other phrase too: a greeting, an answer, a thought reply
 * asks for the whole catalogue sentences its plan names (`lineMissing`) — in a game, or on the child's own screens
 * (`setRecordingScope`), never in an exam; a silent plan of any phrase is «не озвучено»; the black box says why nothing
 * went (`clip.gen.skip`). Fake layer, fake routes, fake timers: silent, free, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipGenHealth, ClipGenOutcome, ClipGenRequest, ClipGenRequestResult, ClipGenStatus, CoachEvent, HealthInfo, VoiceLayer } from '@gambit/shared';
import { createCoachController } from './coachController.ts';
import type { CoachController } from './coachController.ts';
import { createCoachStore } from './coachStore.ts';
import type { CoachStore } from './coachStore.ts';
import type { ClipGenApi } from './clips/clipOnDemand.ts';
import { HELLO_DAY, HELLO_DAY_2, greetingEvent, lessonEvent } from './clips/testLesson.ts';
import { SETTINGS_STORAGE_KEY } from './settings.ts';
import { createSilentVoice } from './silentVoice.ts';
import { createMemoryStorage, makeEvent, makeHealth } from './testUtils.ts';
import { configureVoiceDiagForTests, resetVoiceDiagForTests, voiceDiagRecent } from './voiceDiag.ts';
import type { ClipExtras, ClipLibraryStatus, ClipPlanInfo, ClipSpeakOptions, LessonTakeProbe } from './voiceTypes.ts';
import { createEmitter } from './voiceUtils.ts';

/** A clips layer with the «Дозапись голоса» extras, driven by hand: every `speakEvent` waits for `finish()`. */
interface FakeClipLayer extends VoiceLayer, ClipExtras {
  readonly kind: 'clips';
  speakEvent(event: CoachEvent, opts?: ClipSpeakOptions): Promise<void>;
  readonly calls: CoachEvent[];
  /** what the dry run answers (the real layer: the lesson planner over its library) */
  voicedLessons: boolean;
  /** units the book's probe finds */
  readonly recorded: Set<string>;
  readonly blockedKeys: Set<string>;
  reloads: number;
  library: ClipLibraryStatus;
  finish(): void;
  emitPlan(info: ClipPlanInfo): void;
}

function createFakeClipLayer(): FakeClipLayer {
  const speaking = createEmitter<boolean>();
  const plans = createEmitter<ClipPlanInfo>();
  let pending: (() => void) | null = null;
  const layer: FakeClipLayer = {
    kind: 'clips',
    calls: [],
    voicedLessons: false,
    recorded: new Set(),
    blockedKeys: new Set(),
    reloads: 0,
    library: { voiceKey: 'giselle-mm1', libraryVersion: 3, phrases: 1240, units: 2100 },
    init: () => Promise.resolve(),
    speak: () => Promise.resolve(),
    speakEvent(event) {
      layer.calls.push(event);
      return new Promise<void>((resolve) => {
        pending = () => {
          pending = null;
          resolve();
        };
      });
    },
    stop: () => pending?.(),
    onLevel: () => () => undefined,
    onSpeakingChange: (cb) => speaking.on(cb),
    dispose: () => undefined,
    msToSentenceEnd: () => null,
    endAfterSentence: () => false,
    replayLast: () => Promise.resolve(),
    onPlan: (cb) => plans.on(cb),
    prewarm: () => undefined,
    libraryStatus: () => layer.library,
    setGame: () => undefined,
    lessonProbe(): LessonTakeProbe {
      return { voiced: (key, text) => layer.recorded.has(`${key}|${text}`), blocked: (key) => layer.blockedKeys.has(key) };
    },
    canVoiceLesson: () => layer.voicedLessons,
    reloadOverlay() {
      layer.reloads += 1;
      layer.library = { ...layer.library, units: layer.library.units + 1 };
      return Promise.resolve(true);
    },
    // (which version it holds is not modelled here: every new status version is re-read)
    overlayVersion: () => null,
    finish: () => pending?.(),
    emitPlan: (info) => plans.emit(info),
  };
  return layer;
}

const READY: ClipGenHealth = { state: 'ready', overlay: true };

function statusOf(health: ClipGenHealth, patch: Partial<ClipGenStatus> = {}): ClipGenStatus {
  return {
    health,
    enabled: true,
    queue: 0,
    busy: false,
    overlay: { version: 1, units: 1 },
    spent: { today: '2026-09-24', todayMilli: 0, totalMilli: 0, prefetchMilli: 0 },
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
  /** the next POST answers with these outcomes (default: every sentence 'queued'); `hold` = answer only on `release()` */
  answer(outcomes: ClipGenOutcome[] | null, hold?: boolean): void;
  release(): void;
  setStatus(s: ClipGenStatus): void;
}

function setup(o: { preference?: string; health?: ClipGenHealth | null; automated?: boolean; silenced?: boolean; muted?: boolean } = {}): Harness {
  const store = createCoachStore();
  const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voice: o.preference ?? 'clips', ...(o.muted ? { muted: true } : {}) }) });
  const health: HealthInfo = { ...makeHealth(false, undefined, { runtimeAi: false }), ...(o.health === null ? {} : { clipGen: o.health ?? READY }) };
  let last: FakeClipLayer | null = null;
  let count = 0;
  const requests: ClipGenRequest[] = [];
  let statusCalls = 0;
  let next: ClipGenOutcome[] | null = null;
  let held: (() => void) | null = null;
  let holdNext = false;
  let status = statusOf(o.health ?? READY);
  const api: ClipGenApi = {
    request(body) {
      requests.push(body);
      const outcomes = next ?? body.sentences.map(() => 'queued' as const);
      const result: ClipGenRequestResult = { results: outcomes.map((outcome) => ({ outcome, keys: [] })), health: READY, queue: 1 };
      if (!holdNext) return Promise.resolve(result);
      holdNext = false;
      return new Promise((resolve) => {
        held = () => resolve(result);
      });
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
    isSilenced: () => o.silenced ?? false,
    isAutomated: () => o.automated ?? false,
    clipGen: api,
    createVoice(kind) {
      count += 1;
      if (count === 1 || kind !== 'clips') return createSilentVoice();
      last = createFakeClipLayer();
      return last;
    },
  });
  return {
    coach,
    store,
    layer() {
      if (!last) throw new Error('no clips layer');
      return last;
    },
    requests,
    statusCalls: () => statusCalls,
    answer(outcomes, hold = false) {
      next = outcomes;
      holdNext = hold;
    },
    release: () => held?.(),
    setStatus(s) {
      status = s;
    },
  };
}

const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

/** the layer's plan for a lesson phrase: silent, with its missing sentences (the real layer emits it at once) */
function silentPlan(event: CoachEvent, missing: number[]): ClipPlanInfo {
  return { eventId: event.id, kind: event.kind, src: 'none', level: 6, heard: '', ms: 0, clips: 0, lessonMissing: missing };
}

async function sayLesson(h: Harness, event: CoachEvent, missing: number[] = [1]): Promise<void> {
  void h.coach.say(event);
  await flush();
  h.layer().emitPlan(silentPlan(event, missing));
  await flush();
}

describe('coach controller — «Дозапись голоса»', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a silent lesson phrase in a live game: «не озвучено» at once, the missing sentence requested, then «записываю голос…»', async () => {
    const h = setup();
    await h.coach.init();
    h.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    const event = lessonEvent();
    void h.coach.say(event);
    await flush();
    // the phrase is shown at once with its mark — never held back for the recording
    expect(h.layer().calls).toEqual([event]);
    expect(h.store.getState()).toMatchObject({ bubbleText: event.bubbleText, unvoiced: true, unvoicedMark: 'unrecorded' });
    expect(h.coach.speaksAloud()).toBe(false);
    h.layer().emitPlan(silentPlan(event, [1]));
    await flush();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.sentences).toEqual([{ parts: [event.say?.[1], event.say?.[2]] }]);
    expect(h.store.getState()).toMatchObject({ unvoiced: true, unvoicedMark: 'recording' });
    // the next bubble drops the mark
    h.layer().finish();
    await flush();
    void h.coach.say(makeEvent({ kind: 'encourage', text: 'Дальше!' }));
    await flush();
    expect(h.store.getState()).toMatchObject({ unvoiced: false, unvoicedMark: null });
  });

  it('not every missing sentence will be recorded (a cap, a pause, given up): the mark stays «не озвучено»', async () => {
    for (const outcomes of [['queued', 'budget'], ['paused', 'paused'], ['recording', 'given-up'], ['voiced', 'queued']] as ClipGenOutcome[][]) {
      const h = setup();
      await h.coach.init();
      h.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
      h.answer(outcomes);
      await sayLesson(h, lessonEvent(), [0, 1]);
      expect(h.requests, outcomes.join()).toHaveLength(1);
      expect(h.store.getState(), outcomes.join()).toMatchObject({ unvoiced: true, unvoicedMark: 'unrecorded' });
    }
  });

  it('the answer comes after the bubble changed: the new bubble is never marked', async () => {
    const h = setup();
    await h.coach.init();
    h.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    h.answer(null, true);
    await sayLesson(h, lessonEvent());
    expect(h.requests).toHaveLength(1);
    h.layer().finish();
    await flush();
    void h.coach.say(lessonEvent());
    await flush();
    const second = h.store.getState();
    expect(second.unvoicedMark).toBe('unrecorded');
    h.release();
    await flush();
    expect(h.store.getState().unvoicedMark).toBe('unrecorded');
  });

  it('a voiced lesson plan: no mark, nothing requested; the dry run decides the first mark', async () => {
    const h = setup();
    await h.coach.init();
    h.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    h.layer().voicedLessons = true;
    const event = lessonEvent();
    void h.coach.say(event);
    await flush();
    expect(h.store.getState()).toMatchObject({ unvoiced: false, unvoicedMark: null });
    expect(h.coach.speaksAloud()).toBe(true);
    h.layer().emitPlan({ eventId: event.id, kind: event.kind, src: 'lesson', level: 1, heard: event.text, ms: 3000, clips: 3 });
    await flush();
    expect(h.requests).toHaveLength(0);
    expect(h.store.getState().unvoiced).toBe(false);
    // the dry run said «voiced», the real plan came out silent (a take failed): marked then
    h.layer().emitPlan(silentPlan(event, [0]));
    await flush();
    expect(h.store.getState()).toMatchObject({ unvoiced: true });
  });

  it('the lesson’s closing phrase (outcome + takeaway), said right after the game store ended the game, is requested', async () => {
    const h = setup();
    await h.coach.init();
    h.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    // gameStore.finishGame: notifyGameEnd() first, then runEnding() says the end event
    h.coach.onGameEnd();
    await sayLesson(h, lessonEvent(undefined, { kind: 'gameEnd' }), [0, 1]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.sentences).toHaveLength(2);
    // not any other phrase after the game, not a closing phrase much later, never after an exam
    h.layer().finish();
    await flush();
    await sayLesson(h, lessonEvent());
    expect(h.requests).toHaveLength(1);
    const late = setup();
    await late.coach.init();
    late.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    late.coach.onGameEnd();
    await vi.advanceTimersByTimeAsync(61_000);
    await sayLesson(late, lessonEvent(undefined, { kind: 'gameEnd' }), [0]);
    expect(late.requests).toHaveLength(0);
    const exam = setup();
    await exam.coach.init();
    exam.coach.onGameStart({ timeControlId: 'training', coachStyle: 'exam' });
    exam.coach.onGameEnd();
    await sayLesson(exam, lessonEvent(undefined, { kind: 'gameEnd' }), [0]);
    expect(exam.requests).toHaveLength(0);
  });

  it('never outside a live game turn: no game, an exam, an utterance with nothing to request', async () => {
    const outside = setup();
    await outside.coach.init();
    await sayLesson(outside, lessonEvent());
    expect(outside.requests).toHaveLength(0);
    expect(outside.store.getState().unvoicedMark).toBe('unrecorded');

    // an exam says no teacher's phrase at all; a lesson answer said there is still never recorded
    const exam = setup();
    await exam.coach.init();
    exam.coach.onGameStart({ timeControlId: 'training', coachStyle: 'exam' });
    const answer = lessonEvent(undefined, { kind: 'answer' });
    await sayLesson(exam, answer);
    expect(exam.layer().calls).toEqual([answer]);
    expect(exam.requests).toHaveLength(0);

    const nothing = setup();
    await nothing.coach.init();
    nothing.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    await sayLesson(nothing, lessonEvent(), []);
    expect(nothing.requests).toHaveLength(0);
  });

  it('an automated browser never requests (not one POST), a muted coach neither (the layer is not speaking)', async () => {
    const auto = setup({ automated: true });
    await auto.coach.init();
    auto.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    await sayLesson(auto, lessonEvent());
    expect(auto.requests).toHaveLength(0);
    expect(auto.statusCalls()).toBe(0);
    expect(auto.store.getState().unvoicedMark).toBe('unrecorded');

    const muted = setup();
    await muted.coach.init();
    muted.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    muted.coach.setMuted(true);
    void muted.coach.say(lessonEvent());
    await flush();
    expect(muted.layer().calls).toHaveLength(0);
    expect(muted.requests).toHaveLength(0);
    expect(muted.store.getState()).toMatchObject({ unvoiced: false, unvoicedMark: null });
  });

  it('status: checked once at load and at a game start; a new overlay version reloads the layer\'s library and the parent\'s line', async () => {
    const h = setup();
    await h.coach.init();
    await flush();
    expect(h.statusCalls()).toBe(1);
    expect(h.layer().reloads).toBe(1);
    h.setStatus(statusOf(READY, { overlay: { version: 2, units: 5 } }));
    h.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    await flush();
    expect(h.statusCalls()).toBe(2);
    expect(h.layer().reloads).toBe(2);
    expect(h.store.getState().clipLibrary?.units).toBe(2102);
    // another voice: no status at all
    const robot = setup({ preference: 'browser' });
    await robot.coach.init();
    robot.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    await flush();
    expect(robot.statusCalls()).toBe(0);
  });

  it('voicePolicy: the layer\'s live probe while the clip layer speaks — P(3), cheap growth only while the server records', async () => {
    const h = setup();
    await h.coach.init();
    const policy = h.coach.voicePolicy();
    expect(policy).toMatchObject({ minVoiced: 3, growCheap: true });
    h.layer().recorded.add('line:v3.whole.castle#1|Сделаем рокировку и спрячем короля в домик!');
    h.layer().blockedKeys.add('line:v3.idea.fork#4');
    expect(policy?.voiced('line:v3.whole.castle#1', 'Сделаем рокировку и спрячем короля в домик!')).toBe(true);
    expect(policy?.voiced('line:v3.whole.castle#2', 'Другие слова.')).toBe(false);
    expect(policy?.blocked?.('line:v3.idea.fork#4')).toBe(true);
    // muted: the default book
    h.coach.setMuted(true);
    expect(h.coach.voicePolicy()).toBeNull();
    h.coach.setMuted(false);
    expect(h.coach.voicePolicy()).not.toBeNull();

    // recording off (or no such server feature): the probe stays, the growth bias goes
    const off = setup({ health: { state: 'off', overlay: true } });
    await off.coach.init();
    expect(off.coach.voicePolicy()).toMatchObject({ minVoiced: 3, growCheap: false });
    const old = setup({ health: null });
    await old.coach.init();
    expect(old.coach.voicePolicy()?.growCheap).toBe(false);
    const parentOff = setup({ health: { state: 'paused', reason: 'parent-off', until: null, overlay: true } });
    await parentOff.coach.init();
    expect(parentOff.coach.voicePolicy()?.growCheap).toBe(false);

    // another voice, automation (the muted e2e clips layer included): null
    const robot = setup({ preference: 'browser' });
    await robot.coach.init();
    expect(robot.coach.voicePolicy()).toBeNull();
    const auto = setup({ automated: true });
    await auto.coach.init();
    expect(auto.coach.voicePolicy()).toBeNull();
  });
});

describe('coach controller — «Дозапись голоса» for every phrase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** what the layer planned for an older event's twin */
  function twinPlan(event: CoachEvent, patch: Partial<ClipPlanInfo> = {}): ClipPlanInfo {
    return { eventId: event.id, kind: event.kind, src: 'none', level: 6, heard: '', ms: 0, clips: 0, lineMissing: [HELLO_DAY], ...patch };
  }

  async function sayTwin(h: Harness, event: CoachEvent, plan: ClipPlanInfo = twinPlan(event)): Promise<void> {
    void h.coach.say(event);
    await flush();
    h.layer().emitPlan(plan);
    await flush();
  }

  const skips = (): Record<string, unknown>[] => voiceDiagRecent().filter((e) => e.e === 'clip.gen.skip') as Record<string, unknown>[];

  it('the home greeting (no game, the child\'s screens): «не озвучено», its line requested as ids, then «записываю голос…»', async () => {
    const h = setup();
    await h.coach.init();
    h.coach.setRecordingScope(true);
    const event = greetingEvent();
    void h.coach.say(event);
    await flush();
    // an older phrase: no dry run — its bubble is plain until the layer's plan says it is silent
    expect(h.store.getState()).toMatchObject({ bubbleText: event.bubbleText, unvoiced: false });
    h.layer().emitPlan(twinPlan(event));
    await flush();
    expect(h.requests).toEqual([{ sentences: [{ line: { id: 'greet.hello.day', n: 1 } }], kind: 'greeting' }]);
    expect(h.store.getState()).toMatchObject({ bubbleText: event.bubbleText, unvoiced: true, unvoicedMark: 'recording' });
    expect(voiceDiagRecent().some((e) => e.e === 'clip.gen' && e.src === 'line' && e.kind === 'greeting' && e.recording === true)).toBe(true);
  });

  it('outside a game only while the scope is on (never Settings / the playground); in a game always; never in an exam', async () => {
    const off = setup();
    await off.coach.init();
    await sayTwin(off, greetingEvent());
    expect(off.requests).toHaveLength(0);
    // silent all the same: the bubble says so
    expect(off.store.getState()).toMatchObject({ unvoiced: true, unvoicedMark: 'unrecorded' });
    expect(skips().at(-1)).toMatchObject({ kind: 'greeting', src: 'line', why: 'scope' });

    const game = setup();
    await game.coach.init();
    game.coach.onGameStart({ timeControlId: 'rapid10', coachStyle: 'helper' });
    await sayTwin(game, greetingEvent(1, { kind: 'gameStart' }));
    expect(game.requests).toHaveLength(1);

    const exam = setup();
    await exam.coach.init();
    exam.coach.setRecordingScope(true);
    exam.coach.onGameStart({ timeControlId: 'rapid10', coachStyle: 'exam' });
    await sayTwin(exam, greetingEvent(1, { kind: 'gameEnd' }));
    expect(exam.requests).toHaveLength(0);
    expect(skips().at(-1)).toMatchObject({ why: 'exam' });
    exam.layer().finish();
    await flush();
    // …except the exam's own fixed sentence, said only there: «Это экзамен — сегодня играем без подсказок…»
    const noHints = greetingEvent(1, { kind: 'encourage' });
    await sayTwin(exam, noHints, twinPlan(noHints, { lineMissing: [{ id: 'shell.noHints.exam', n: 1 }] }));
    expect(exam.requests).toEqual([{ sentences: [{ line: { id: 'shell.noHints.exam', n: 1 } }], kind: 'encourage' }]);
  });

  it('a voiced plan that used another wording asks for the bubble\'s own (no mark); a voiced answer asks what its layer names (its pool grows); lesson (`v3.*`) ids never go as lines', async () => {
    const h = setup();
    await h.coach.init();
    h.coach.setRecordingScope(true);
    const greeting = greetingEvent();
    await sayTwin(h, greeting, twinPlan(greeting, { src: 'clip', level: 1, clips: 1, heard: 'Привет-привет, добрый день!' }));
    expect(h.requests).toHaveLength(1);
    expect(h.store.getState()).toMatchObject({ unvoiced: false, unvoicedMark: null, bubbleText: greeting.bubbleText });
    h.layer().finish();
    await flush();

    // an answer from its own pools: its bubble takes the heard words; the wording its layer names (the pool still has
    // only a few) is asked for, with no mark — the child heard a voice
    const answer = greetingEvent(1, { kind: 'answer' });
    await sayTwin(h, answer, twinPlan(answer, { src: 'clip', level: 1, clips: 1, heard: 'Привет-привет, добрый день!', lineMissing: [HELLO_DAY_2] }));
    expect(h.store.getState()).toMatchObject({ bubbleText: 'Привет-привет, добрый день!', unvoiced: false, unvoicedMark: null });
    expect(h.requests.at(-1)).toEqual({ sentences: [{ line: HELLO_DAY_2 }], kind: 'answer' });
    expect(h.requests).toHaveLength(2);
    h.layer().finish();
    await flush();

    const lesson = greetingEvent(1, { kind: 'encourage' });
    await sayTwin(h, lesson, twinPlan(lesson, { lineMissing: [{ id: 'v3.whole.castle', n: 1 }] }));
    expect(h.requests).toHaveLength(2);
  });

  it('why nothing went is in the black box: no such server feature, recording off, automation', async () => {
    const old = setup({ health: null });
    await old.coach.init();
    old.coach.setRecordingScope(true);
    await sayTwin(old, greetingEvent());
    expect(old.requests).toHaveLength(0);
    expect(skips().at(-1)).toMatchObject({ why: 'no-health' });

    const off = setup({ health: { state: 'off', overlay: true } });
    await off.coach.init();
    off.coach.setRecordingScope(true);
    await sayTwin(off, greetingEvent());
    expect(skips().at(-1)).toMatchObject({ why: 'off' });

    const auto = setup({ automated: true });
    await auto.coach.init();
    auto.coach.setRecordingScope(true);
    await sayTwin(auto, greetingEvent());
    expect(auto.requests).toHaveLength(0);
    expect(skips().at(-1)).toMatchObject({ why: 'automation' });
  });
});
