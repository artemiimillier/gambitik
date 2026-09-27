/**
 * The coach controller with «Записи» (docs/voice-clips/SPEC.md §5.2, §5.5, §8, §11): the chain ['clips', 'silent'],
 * `speakEvent` preferred over `speak(text)`, the phrase (and so the child's clock held by the game around `say`) ends
 * exactly when the layer's audible end resolves, the gentle stop by `msToSentenceEnd` / `endAfterSentence`, the
 * «Спроси» chips, per-game stats, the library line for the parent. Fakes only — silent and free.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoachEvent, VoiceLayer } from '@gambit/shared';
import { createCoachController, selectVoiceChain } from './coachController.ts';
import type { CoachAsk, CoachController, CoachTimings } from './coachController.ts';
import { createCoachStore } from './coachStore.ts';
import type { CoachStore } from './coachStore.ts';
import { createClipAudio } from './clips/clipAudio.ts';
import { createClipLibrary } from './clips/clipLibrary.ts';
import { pokeClip, whyNothingEvent } from './clips/clipAsk.ts';
import { createClipVoice } from './clips/clipVoice.ts';
import { createFakeServer, FAKE_BASE, FakeAudioContext } from './clips/testAudio.ts';
import { createSilentVoice } from './silentVoice.ts';
import { createMemoryStorage, makeEvent, makeHealth } from './testUtils.ts';
import { SETTINGS_STORAGE_KEY } from './settings.ts';
import { configureVoiceDiagForTests, resetVoiceDiagForTests, voiceDiagRecent } from './voiceDiag.ts';
import type { ClipExtras, ClipLibraryStatus, ClipPlanInfo, ClipSpeakOptions, VoiceKind } from './voiceTypes.ts';
import { createEmitter } from './voiceUtils.ts';

/** A clips layer the test drives by hand: every `speakEvent` waits for `finish()`. */
interface FakeClipLayer extends VoiceLayer, ClipExtras {
  readonly kind: 'clips';
  speakEvent(event: CoachEvent, opts?: ClipSpeakOptions): Promise<void>;
  readonly calls: { event: CoachEvent; opts: ClipSpeakOptions | undefined }[];
  readonly spoken: string[];
  readonly games: ({ timeControlId: string } | null)[];
  stopCalls: number;
  endAfterCalls: number;
  /** ms to the end of the sentence being heard (null = nothing audible) */
  sentenceLeft: number | null;
  finish(): void;
  emitSpeaking(value: boolean): void;
  /** what the planner decided for an event (the real layer emits it before the first sample) */
  emitPlan(info: ClipPlanInfo): void;
}

function createFakeClipLayer(): FakeClipLayer {
  const speaking = createEmitter<boolean>();
  const level = createEmitter<number>();
  const plans = createEmitter<ClipPlanInfo>();
  let pending: (() => void) | null = null;
  const status: ClipLibraryStatus = { voiceKey: 'giselle-mm1', libraryVersion: 3, phrases: 1240, units: 2100 };
  const layer: FakeClipLayer = {
    kind: 'clips',
    calls: [],
    spoken: [],
    games: [],
    stopCalls: 0,
    endAfterCalls: 0,
    sentenceLeft: null,
    init: () => Promise.resolve(),
    speak(text) {
      layer.spoken.push(text);
      return Promise.resolve();
    },
    speakEvent(event, opts) {
      layer.calls.push({ event, opts });
      speaking.emit(true);
      return new Promise<void>((resolve) => {
        pending = () => {
          pending = null;
          speaking.emit(false);
          resolve();
        };
      });
    },
    stop() {
      layer.stopCalls += 1;
      pending?.();
    },
    onLevel: (cb) => level.on(cb),
    onSpeakingChange: (cb) => speaking.on(cb),
    dispose: () => undefined,
    msToSentenceEnd: () => layer.sentenceLeft,
    endAfterSentence() {
      layer.endAfterCalls += 1;
      return layer.sentenceLeft !== null;
    },
    replayLast: () => Promise.resolve(),
    onPlan: (cb) => plans.on(cb),
    prewarm: () => undefined,
    libraryStatus: () => status,
    setGame(game) {
      layer.games.push(game);
    },
    finish: () => pending?.(),
    emitSpeaking: (value) => speaking.emit(value),
    emitPlan: (info) => plans.emit(info),
  };
  return layer;
}

interface Harness {
  coach: CoachController;
  store: CoachStore;
  layer(): FakeClipLayer;
  created: VoiceKind[];
}

function setup(opts: { preference?: string; silenced?: boolean; clipsWhenSilenced?: boolean; timings?: Partial<CoachTimings>; talkativeness?: string } = {}): Harness {
  const store = createCoachStore();
  const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voice: opts.preference ?? 'clips', ...(opts.talkativeness ? { talkativeness: opts.talkativeness } : {}) }) });
  const created: VoiceKind[] = [];
  let count = 0;
  let last: FakeClipLayer | null = null;
  const coach = createCoachController({
    store,
    getStorage: () => storage,
    getHealth: () => Promise.resolve(makeHealth(true, { live: true, preferred: 'live' })),
    isSilenced: () => opts.silenced ?? false,
    clipsWhenSilenced: () => opts.clipsWhenSilenced ?? false,
    createVoice(kind) {
      count += 1;
      if (count === 1) return createSilentVoice();
      created.push(kind);
      if (kind !== 'clips') return createSilentVoice();
      last = createFakeClipLayer();
      return last;
    },
    timings: { stopGraceMs: 2000, ...opts.timings },
  });
  return {
    coach,
    store,
    created,
    layer() {
      if (!last) throw new Error('no clips layer yet');
      return last;
    },
  };
}

const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

describe('coach controller — «Записи»', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('the chain: «clips» → clips, silent (the robot voice only if the parent picks it); automation stays silent', () => {
    const health = makeHealth(true, { live: true, preferred: 'live' });
    expect(selectVoiceChain('clips', health)).toEqual(['clips', 'silent']);
    expect(selectVoiceChain('clips', null)).toEqual(['clips', 'silent']);
    expect(selectVoiceChain('clips', health, true)).toEqual(['silent']);
    // the e2e opt-in: the real clips layer (muted by the factory) — never a paid or audible one, whatever the preference
    expect(selectVoiceChain('auto', health, true, { clipsWhenSilenced: true })).toEqual(['clips', 'silent']);
    expect(selectVoiceChain('auto', health, false, { clipsWhenSilenced: true })[0]).toBe('openai-live');
    // the other preferences are unchanged
    expect(selectVoiceChain('browser', health)).toEqual(['browser-tts', 'silent']);
    expect(selectVoiceChain('off', health)).toEqual(['silent']);
  });

  it('under automation the clips layer is built only with the opt-in', async () => {
    const silenced = setup({ silenced: true });
    await silenced.coach.init();
    expect(silenced.created).toEqual(['silent']);
    const optedIn = setup({ silenced: true, clipsWhenSilenced: true });
    await optedIn.coach.init();
    expect(optedIn.created).toEqual(['clips']);
    expect(optedIn.store.getState().voiceKind).toBe('clips');
  });

  it('a clips layer without a library: init() rejects → the silent layer speaks (bubble + timing)', async () => {
    const store = createCoachStore();
    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voice: 'clips' }) });
    const ctx = new FakeAudioContext();
    const coach = createCoachController({
      store,
      getStorage: () => storage,
      getHealth: () => Promise.resolve(makeHealth(false)),
      createVoice: (kind) =>
        kind === 'clips'
          ? createClipVoice({ audio: createClipAudio({ createContext: () => ctx }), library: createClipLibrary({ baseUrl: FAKE_BASE, fetch: createFakeServer(null).fetch }), storage: null, gestureTarget: null, hasUserActivation: () => true })
          : createSilentVoice(),
    });
    await coach.init();
    expect(store.getState().voiceKind).toBe('silent');
    expect(store.getState().clipLibrary).toBeNull();
    expect(voiceDiagRecent().some((e) => e.e === 'layer.fail' && e.kind === 'clips')).toBe(true);
  });

  it('play() hands the whole event to speakEvent (with the game\'s pace), never speak(text); the library line reaches the store', async () => {
    const h = setup();
    await h.coach.init();
    expect(h.store.getState()).toMatchObject({ voiceKind: 'clips', voiceModel: 'giselle-mm1', clipLibrary: { phrases: 1240, libraryVersion: 3 } });
    h.coach.onGameStart({ timeControlId: 'blitz5', coachStyle: 'teacher' });
    const event = makeEvent({ kind: 'teachTurn', text: 'Мой совет — конь на эф три.', pauseClock: true, teach: { moment: 'turn', style: 'short', ply: 1, advice: [] } });
    void h.coach.say(event);
    await flush();
    expect(h.layer().calls).toHaveLength(1);
    expect(h.layer().calls[0]?.event).toBe(event);
    expect(h.layer().calls[0]?.opts).toEqual({ interrupt: false, blitz: true });
    expect(h.layer().spoken).toEqual([]);
    // the bubble keeps the exact content, whatever the recordings say
    expect(h.store.getState().bubbleText).toBe(event.bubbleText);
  });

  it('an answer from recordings shows the words really heard (poke, «Спроси»); a teacher turn or a generic line keeps its bubble', async () => {
    const h = setup();
    await h.coach.init();
    const plan = (event: CoachEvent, over: Partial<ClipPlanInfo>): ClipPlanInfo => ({ eventId: event.id, kind: event.kind, src: 'clip', level: 1, heard: '', ms: 1500, clips: 1, ...over });

    // the idle tap: the dock's bubble said one catchphrase, the planner picked another take of the «poke» pool
    const poke = makeEvent({ kind: 'answer', priority: 1, text: 'Ход конём!', bubbleText: 'Ход конём!', clip: pokeClip('talk') });
    void h.coach.say(poke);
    await flush();
    expect(h.store.getState().bubbleText).toBe('Ход конём!');
    h.layer().emitPlan(plan(poke, { eventId: 'another-event', heard: 'Чужие слова.' }));
    expect(h.store.getState().bubbleText).toBe('Ход конём!');
    h.layer().emitPlan(plan(poke, { heard: 'Шахи, взятия, угрозы — проверим всё!' }));
    expect(h.store.getState().bubbleText).toBe('Шахи, взятия, угрозы — проверим всё!');
    h.layer().finish();
    await flush();

    // a line missing from the library (L5, the moment's generic line): the bubble keeps the exact content
    const why = whyNothingEvent();
    void h.coach.say(why);
    await flush();
    h.layer().emitPlan(plan(why, { src: 'generic', level: 5, heard: 'Хороший вопрос!' }));
    expect(h.store.getState().bubbleText).toBe(why.bubbleText);
    h.layer().finish();
    await flush();

    // a teacher turn: the bubble shows the move in notation, the voice says it — never replaced
    const teach = makeEvent({
      kind: 'teachTurn',
      text: 'Мой совет — конь на эф три.',
      bubbleText: 'Мой совет — Кf3.',
      teach: { moment: 'turn', style: 'short', ply: 1, advice: [] },
      clip: { sentences: [{ items: [{ line: 'teach.head.advice' }], prio: 100, end: '.' }], generic: 'generic.teachTurn.turn' },
    });
    void h.coach.say(teach);
    await flush();
    h.layer().emitPlan(plan(teach, { heard: 'Попробуй так: конём на эф три.' }));
    expect(h.store.getState().bubbleText).toBe('Мой совет — Кf3.');
    h.layer().finish();
    await flush();
  });

  it('say() resolves exactly when the layer\'s audible end does — the game\'s clock hold is the real sound', async () => {
    const h = setup();
    await h.coach.init();
    let done = false;
    void h.coach.say(makeEvent({ pauseClock: true })).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).toBe(false);
    expect(h.store.getState().speaking).toBe(true);
    h.layer().finish();
    await flush();
    expect(done).toBe(true);
    expect(h.store.getState().speaking).toBe(false);
  });

  it('the gentle stop: near the sentence end the layer ends there by itself; far from it the phrase is cut at once', async () => {
    const h = setup();
    await h.coach.init();
    // near: 800 ms to the end of the sentence being heard
    let first = false;
    void h.coach.say(makeEvent({ kind: 'teachTurn' })).then(() => {
      first = true;
    });
    await flush();
    h.layer().sentenceLeft = 800;
    h.coach.stopSpeaking({ grace: true });
    expect(h.layer().endAfterCalls).toBe(1);
    expect(h.layer().stopCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(700);
    h.layer().finish();
    await flush();
    expect(first).toBe(true);
    const grace = voiceDiagRecent().filter((e) => e.e === 'coach.grace');
    expect(grace.at(-1)).toMatchObject({ end: 'self', mode: 'finish' });

    // far: 3.5 s to go — cut now
    void h.coach.say(makeEvent({ kind: 'teachTurn' }));
    await flush();
    h.layer().sentenceLeft = 3500;
    h.coach.stopSpeaking({ grace: true });
    expect(h.layer().stopCalls).toBe(1);
    // nothing audible yet: cut at once too
    void h.coach.say(makeEvent({ kind: 'teachTurn' }));
    await flush();
    h.layer().sentenceLeft = null;
    h.coach.stopSpeaking({ grace: true });
    expect(h.layer().stopCalls).toBe(2);
  });

  it('talkativeness: only «Тихо» filters the recorded coach — at «Обычно» his short praise stays', async () => {
    const normal = setup({ talkativeness: 'normal' });
    await normal.coach.init();
    void normal.coach.say(makeEvent({ kind: 'praise', priority: 0 }));
    await flush();
    expect(normal.layer().calls).toHaveLength(1);
    const quiet = setup({ talkativeness: 'quiet' });
    await quiet.coach.init();
    void quiet.coach.say(makeEvent({ kind: 'praise', priority: 0 }));
    void quiet.coach.say(makeEvent({ kind: 'encourage', priority: 1 }));
    await flush();
    expect(quiet.layer().calls).toHaveLength(0);
    // urgent phrases and the teacher always pass
    void quiet.coach.say(makeEvent({ kind: 'takebackOffer', priority: 2 }));
    await flush();
    expect(quiet.layer().calls.map((c) => c.event.kind)).toEqual(['takebackOffer']);
  });

  it('«Спроси»: the game answers the chips (its sayEvent holds the clock); without it «Совет» and «Повтори» still work', async () => {
    const h = setup();
    await h.coach.init();
    const asked: CoachAsk[] = [];
    const off = h.coach.onAsk((q) => asked.push(q));
    h.coach.ask('why');
    h.coach.ask('opponent');
    expect(asked).toEqual(['why', 'opponent']);
    off();

    // no listener: «Повтори» says the last phrase again (a new id, the same words)
    const said = makeEvent({ kind: 'teachTurn', text: 'Смотри, тут подарок!' });
    void h.coach.say(said);
    await flush();
    h.layer().finish();
    await flush();
    expect(h.coach.lastSpoken?.id).toBe(said.id);
    h.coach.ask('repeat');
    await flush();
    expect(h.layer().calls).toHaveLength(2);
    expect(h.layer().calls[1]?.event).toMatchObject({ text: said.text, kind: said.kind });
    expect(h.layer().calls[1]?.event.id).not.toBe(said.id);
    h.layer().finish();
    await flush();

    // «Совет» without a listener is the hint button
    const hints: number[] = [];
    h.coach.onHintRequested(() => hints.push(1));
    h.coach.ask('hint');
    expect(hints).toEqual([1]);
  });

  it('per-game stats: the layer hears the game start and its end', async () => {
    const h = setup();
    await h.coach.init();
    h.coach.onGameStart({ timeControlId: 'rapid10', coachStyle: 'helper' });
    h.coach.onGameEnd();
    expect(h.layer().games).toEqual([{ timeControlId: 'rapid10' }, null]);
  });

  it('the lesson model (docs/TEACHING.md §4.5): a lesson phrase with no recording marks its bubble «не озвучено»; the next bubble drops the mark', async () => {
    const h = setup();
    await h.coach.init();
    const lesson = makeEvent({
      kind: 'teachTurn',
      text: 'Центр ещё свободен — займём его пешкой.',
      bubbleText: 'Центр ещё свободен — займём его пешкой.',
      teach: { moment: 'turn', style: 'short', ply: 1, advice: [] },
      say: [{ pool: 'v3.aim.center', n: 1 }, { pool: 'v3.go.move', n: 2, piece: 'p' }],
    });
    void h.coach.say(lesson);
    await flush();
    // the layer still gets the event (it plans nothing and keeps the bubble's reading time)
    expect(h.layer().calls[0]?.event).toBe(lesson);
    expect(h.store.getState()).toMatchObject({ bubbleText: lesson.bubbleText, unvoiced: true });
    h.layer().finish();
    await flush();
    // the bubble lingers with its mark, then both go
    expect(h.store.getState().unvoiced).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.store.getState()).toMatchObject({ bubbleText: '', unvoiced: false });

    // a non-lesson event (no `say`) is voiced as usual: no mark
    void h.coach.say(makeEvent({ kind: 'encourage', text: 'Отлично держишь центр!' }));
    await flush();
    expect(h.store.getState().unvoiced).toBe(false);
    h.layer().finish();
    await flush();

    // a lesson phrase WITH its twin whose plan still came out empty: the layer's plan marks it
    const twin = makeEvent({ kind: 'teachTurn', say: [{ pool: 'v3.lead.advice', n: 1 }], clip: { sentences: [{ items: [{ line: 'teach.head.advice' }], prio: 100, end: '.' }], generic: 'generic.teachTurn.turn' } });
    void h.coach.say(twin);
    await flush();
    expect(h.store.getState().unvoiced).toBe(false);
    h.layer().emitPlan({ eventId: twin.id, kind: twin.kind, src: 'none', level: 6, heard: '', ms: 0, clips: 0 });
    expect(h.store.getState().unvoiced).toBe(true);
    // another bubble in the middle (the game-sleep note, a caption) is not a lesson phrase
    h.layer().finish();
    await flush();
    void h.coach.say(makeEvent({ kind: 'encourage', text: 'Дальше!' }));
    await flush();
    expect(h.store.getState().unvoiced).toBe(false);
    h.layer().finish();
    await flush();
  });

  it('a lesson phrase with the sound off, or on another voice, is not «не озвучено» — the child chose the silence', async () => {
    const h = setup();
    await h.coach.init();
    h.coach.setMuted(true);
    void h.coach.say(makeEvent({ kind: 'teachTurn', say: [{ pool: 'v3.aim.center', n: 1 }] }));
    await flush();
    expect(h.store.getState().unvoiced).toBe(false);
    expect(h.layer().calls).toHaveLength(0);

    const robot = setup({ preference: 'browser' });
    await robot.coach.init();
    void robot.coach.say(makeEvent({ kind: 'teachTurn', say: [{ pool: 'v3.aim.center', n: 1 }] }));
    await flush();
    expect(robot.store.getState()).toMatchObject({ voiceKind: 'silent', unvoiced: false });
  });

  it('no microphone in this mode: «Микрофон закрыт» never asks, no steps appear', async () => {
    const h = setup();
    await h.coach.init();
    await expect(h.coach.retryMicrophone()).resolves.toBe(false);
    expect(h.store.getState().micHelp).toBe(false);
    expect(h.store.getState().micAvailable).toBe(false);
  });
});
