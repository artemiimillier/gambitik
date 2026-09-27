/**
 * «Дозапись голоса» through the real clip layer (docs/voice-clips/ONDEMAND.md): a lesson phrase without a twin is played from
 * its own recorded units (core `planLessonClips`) — the static library and the overlay merged — the whole utterance or
 * nothing; a silent plan names the sentences that could be recorded (`lessonMissing`); the book's probe and the dry
 * run read the library live; an overlay reload counts from the next phrase. Fake fetch, fake AudioContext: silent, free.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIP_VOICE_KEY, buildGameEnd, buildGameStart, buildGreeting, lessonUnitKey } from '@gambit/core';
import { TIME_CONTROLS } from '@gambit/shared';
import type { ClipIndex } from '@gambit/core';
import { catalogIndex, fixtureIndex } from '../../../../../packages/core/src/coach/clips/fixtures.ts';
import { PERSONA, profile, seededRng, summary } from '../../../../../packages/core/src/coach/test-fixtures.ts';
import { configureVoiceDiagForTests, resetVoiceDiagForTests, voiceDiagRecent } from '../voiceDiag.ts';
import type { ClipPlanInfo } from '../voiceTypes.ts';
import { createClipAudio } from './clipAudio.ts';
import { createClipLibrary } from './clipLibrary.ts';
import { thoughtReplyEvent } from './clipAsk.ts';
import { createClipVoice } from './clipVoice.ts';
import { LEAD, TAIL, WHOLE, lessonEvent, recordedOverlay, recordedUnit } from './testLesson.ts';
import { FAKE_BASE, FAKE_OVERLAY, FakeAudioContext, clipUrl, createFakeServer, joinFakeServers, publishFakeLibrary } from './testAudio.ts';

function rig(overlay: ClipIndex | null, staticIndex: ClipIndex = fixtureIndex()) {
  const staticServer = createFakeServer(staticIndex);
  const overlayServer = createFakeServer(overlay, { base: FAKE_OVERLAY, spaFallback: false, hash: '0000aa', libraryVersion: 1 });
  const ctx = new FakeAudioContext({ state: 'running' });
  const audio = createClipAudio({ createContext: () => ctx });
  const library = createClipLibrary({ baseUrl: FAKE_BASE, overlayUrl: FAKE_OVERLAY, fetch: joinFakeServers(staticServer, overlayServer), audio, idle: (cb) => cb() });
  let rngCalls = 0;
  const voice = createClipVoice({
    audio,
    library,
    storage: null,
    rng: () => {
      rngCalls += 1;
      return 0.5;
    },
    hasUserActivation: () => true,
    gestureTarget: null,
  });
  const plans: ClipPlanInfo[] = [];
  voice.onPlan((p) => plans.push(p));
  return { voice, ctx, library, overlayServer, plans, rngCalls: () => rngCalls };
}

async function speak(r: ReturnType<typeof rig>, event: ReturnType<typeof lessonEvent>): Promise<void> {
  const done = r.voice.speakEvent(event);
  await vi.advanceTimersByTimeAsync(30_000);
  await done;
}

describe('clipVoice — a lesson phrase from its recorded units («Дозапись голоса»)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
  });

  it('every sentence recorded: the whole utterance plays, from the overlay\'s origin, as the bubble says it', async () => {
    const r = rig(recordedOverlay([WHOLE, LEAD, TAIL]));
    await r.voice.init();
    const event = lessonEvent();
    expect(r.voice.canVoiceLesson?.(event)).toBe(true);
    await speak(r, event);
    expect(r.plans[0]).toMatchObject({ eventId: event.id, src: 'lesson', clips: 3, heard: event.text });
    expect(r.plans[0]?.lessonMissing).toBeUndefined();
    expect(r.ctx.played).toHaveLength(3);
    expect(r.overlayServer.requests).toContain(clipUrl(recordedUnit(TAIL).id, CLIP_VOICE_KEY, FAKE_OVERLAY));
  });

  it('one sentence missing: nothing plays (never half an utterance, never a generic line) and the missing sentence is named', async () => {
    const r = rig(recordedOverlay([WHOLE, LEAD]));
    await r.voice.init();
    const event = lessonEvent();
    const before = r.rngCalls();
    // the dry run the controller uses for the first mark: no randomness of the layer consumed
    expect(r.voice.canVoiceLesson?.(event)).toBe(false);
    expect(r.rngCalls()).toBe(before);
    await speak(r, event);
    expect(r.plans[0]).toMatchObject({ src: 'none', level: 6, clips: 0, heard: '', lessonMissing: [1] });
    expect(r.ctx.played).toHaveLength(0);
    expect(voiceDiagRecent().some((e) => e.e === 'clip.lesson' && e.voiced === false && e.missing === 1)).toBe(true);
  });

  it('the book\'s probe reads the library live: a reload that publishes the missing unit counts from the next phrase', async () => {
    const r = rig(recordedOverlay([WHOLE, LEAD]));
    await r.voice.init();
    const probe = r.voice.lessonProbe?.();
    expect(probe?.voiced(lessonUnitKey(WHOLE), recordedUnit(WHOLE).text)).toBe(true);
    expect(probe?.voiced(lessonUnitKey(TAIL), recordedUnit(TAIL).text)).toBe(false);
    // a stale take (another text under the key) is not a recording of it
    expect(probe?.voiced(lessonUnitKey(WHOLE), 'Другие слова.')).toBe(false);
    expect(probe?.blocked(lessonUnitKey(TAIL))).toBe(false);

    publishFakeLibrary(r.overlayServer.files, recordedOverlay([WHOLE, LEAD, TAIL]), { root: FAKE_OVERLAY, hash: '0000bb', libraryVersion: 2, extra: { blocked: ['line:v3.idea.mate#9'] } });
    await expect(r.voice.reloadOverlay?.()).resolves.toBe(true);
    expect(r.voice.overlayVersion?.()).toBe(2);
    // the same probe object — never a captured index
    expect(probe?.voiced(lessonUnitKey(TAIL), recordedUnit(TAIL).text)).toBe(true);
    expect(probe?.blocked('line:v3.idea.mate#9')).toBe(true);
    await speak(r, lessonEvent());
    expect(r.plans[0]).toMatchObject({ src: 'lesson', clips: 3 });
  });

  it('a take that fails to load: the plan is made again without it — silent as a whole, the sentence named for recording', async () => {
    const r = rig(recordedOverlay([WHOLE, LEAD, TAIL]));
    await r.voice.init();
    r.overlayServer.fail(clipUrl(recordedUnit(TAIL).id, CLIP_VOICE_KEY, FAKE_OVERLAY), 404);
    await speak(r, lessonEvent());
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0]).toMatchObject({ src: 'none', clips: 0, lessonMissing: [1] });
    expect(r.ctx.played).toHaveLength(0);
    // a failed take is not «recorded» for the book either
    expect(r.voice.lessonProbe?.()?.voiced(lessonUnitKey(TAIL), recordedUnit(TAIL).text)).toBe(false);
  });

  it('no library loaded: no probe, no dry-run voice', () => {
    const r = rig(null);
    expect(r.voice.lessonProbe?.()).toBeNull();
    expect(r.voice.canVoiceLesson?.(lessonEvent())).toBe(false);
  });
});

describe('clipVoice — a free-worded answer keeps its variety («Дозапись голоса» for every phrase)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
  });

  it('a thought reply says any recorded wording (its bubble takes the words heard), not always its first', async () => {
    const r = rig(null, catalogIndex());
    await r.voice.init();
    for (let i = 0; i < 4; i++) await speak(r, thoughtReplyEvent('easy'));
    expect(new Set(r.plans.map((p) => p.heard))).toEqual(new Set(['Легко? Тогда в следующий раз позовём соперника посильнее!', 'Здорово! Значит, пора играть посложнее!']));
    // every wording recorded: nothing to ask for
    expect(r.plans.every((p) => p.lineMissing === undefined)).toBe(true);
  });

  it('a pool with fewer recorded wordings than a few grows: the next unrecorded one is asked for while the answer is voiced', async () => {
    const r = rig(null, catalogIndex({ omit: ['line:thought.easy#1'] }));
    await r.voice.init();
    await speak(r, thoughtReplyEvent('easy'));
    expect(r.plans[0]).toMatchObject({ clips: 1, heard: 'Здорово! Значит, пора играть посложнее!', lineMissing: [{ id: 'thought.easy', n: 1 }] });
  });
});

describe('clipVoice — whether the recordings can ever say the bubble whole (late play waits only for such a phrase)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
  });

  it('a game start whose opener names the opponent, a game end with its practice idea: partial; a greeting, an answer, a lesson: whole', async () => {
    const r = rig(null, catalogIndex({ omit: ['start.open', 'start.tail.coached', 'end.win', 'end.praise.tried', 'greet.hello.day', 'greet.none', 'thought.easy'] }));
    await r.voice.init();
    const rng = seededRng(3);
    const kid = profile({ nickname: '', address: 'm' });
    const start = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.rapid10, childColor: 'w', profile: kid, coachStyle: 'helper' }, () => 0);
    expect(start.text).toMatch(/Петя/u);
    const end = buildGameEnd({ result: '1-0', childColor: 'w', termination: 'resign', summary: summary(), persona: PERSONA, profile: kid }, () => 0);
    const greeting = buildGreeting({ profile: kid, hour: 14 }, rng);
    for (const event of [start, end, greeting, thoughtReplyEvent('easy'), lessonEvent()]) await speak(r, event);
    expect(r.plans.map((p) => [p.kind, p.partial === true])).toEqual([
      ['gameStart', true],
      ['gameEnd', true],
      ['greeting', false],
      ['answer', false],
      ['teachTurn', false],
    ]);
  });
});
