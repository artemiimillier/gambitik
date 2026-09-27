/**
 * Controller tests for hearing and being heard («я всё равно его не слышу, и походу он меня тоже»):
 * the hearing self-check, a refused microphone on an OPEN session, the idle rule during the coach's own words, and
 * the black box of the controller's decisions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoachToolHost } from '@gambit/shared';
import { createCoachController } from './coachController.ts';
import type { CoachController, CoachControllerDeps, CoachTimings } from './coachController.ts';
import { createCoachStore } from './coachStore.ts';
import type { CoachStore } from './coachStore.ts';
import type { HearingProblem } from './rtcSession.ts';
import { createSilentVoice } from './silentVoice.ts';
import { createFakeVoice, createMemoryStorage, makeEvent, makeHealth } from './testUtils.ts';
import type { FakeVoice } from './testUtils.ts';
import { configureVoiceDiagForTests, resetVoiceDiagForTests, voiceDiagRecent } from './voiceDiag.ts';
import type { MicPermission } from './voiceDiag.ts';
import { micHelpSpokenRu, micHelpStepsRu } from './voiceStatus.ts';
import { createEmitter } from './voiceUtils.ts';

interface HealthyVoice extends FakeVoice {
  emitHearingProblem(problem: HearingProblem): void;
  emitHearingOk(): void;
  recheckCalls: number;
  retryCalls: number;
  retryResult: boolean;
}

/** a conversational fake with the playback / microphone health extras of sessionVoice */
function healthyVoice(): HealthyVoice {
  const voice = createFakeVoice({ kind: 'openai-live', conversational: true }) as HealthyVoice;
  const problems = createEmitter<HearingProblem>();
  const ok = createEmitter<void>();
  voice.recheckCalls = 0;
  voice.retryCalls = 0;
  voice.retryResult = false;
  voice.emitHearingProblem = (problem) => problems.emit(problem);
  voice.emitHearingOk = () => ok.emit();
  Object.assign(voice, {
    onHearingProblem: (cb: (problem: HearingProblem) => void) => problems.on(cb),
    onHearingOk: (cb: () => void) => ok.on(cb),
    recheckAudio: () => {
      voice.recheckCalls += 1;
      return Promise.resolve({ play: 'ok', ctx: 'running' });
    },
    retryMicrophone: () => {
      voice.retryCalls += 1;
      return Promise.resolve(voice.retryResult);
    },
  });
  return voice;
}

interface Harness {
  coach: CoachController;
  store: CoachStore;
  voice(): HealthyVoice;
  openAttempts(): number;
}

function setup(timings: Partial<CoachTimings> = {}, extra: Partial<CoachControllerDeps> = {}): Harness {
  const store = createCoachStore();
  let count = 0;
  let last: HealthyVoice | null = null;
  const coach = createCoachController({
    store,
    getStorage: () => createMemoryStorage(),
    getHealth: () => Promise.resolve(makeHealth(false, { live: true, preferred: 'live' })),
    createVoice(kind) {
      count += 1;
      if (count === 1) return createSilentVoice();
      if (kind !== 'openai-live') return createFakeVoice({ kind });
      last = healthyVoice();
      return last;
    },
    timings,
    ...extra,
  });
  return {
    coach,
    store,
    voice() {
      if (!last) throw new Error('no live voice');
      return last;
    },
    openAttempts: () => last?.openCalls ?? 0,
  };
}

const host = (): CoachToolHost => ({
  getPositionSummary: () => Promise.resolve('…'),
  getHint: () => Promise.resolve(makeEvent({ kind: 'hint' })),
  explainLastMove: () => Promise.resolve(null),
  showOnBoard: () => undefined,
  takeBackMove: () => false,
});

describe('coach controller — hearing and being heard', () => {
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

  it('the layer says «the model spoke, nothing was heard» → the dock\'s «Не слышно?» flag; the click re-unlocks inside the gesture and clears it', async () => {
    const h = setup();
    await h.coach.init();
    expect(h.store.getState().hearingCheck).toBe(false);
    h.voice().emitHearingProblem('notPlaying');
    expect(h.store.getState().hearingCheck).toBe(true);

    const pending = h.coach.recheckHearing();
    // synchronous part: the layer's unlock ran inside the click
    expect(h.voice().recheckCalls).toBe(1);
    expect(h.store.getState().hearingCheck).toBe(false);
    expect(await pending).toEqual({ play: 'ok', ctx: 'running' });
    expect(voiceDiagRecent().find((entry) => entry.e === 'hear.check')).toMatchObject({ play: 'ok', ctx: 'running' });

    // a later utterance that was heard fine clears a new suspicion by itself
    h.voice().emitHearingProblem('silent');
    expect(h.store.getState().hearingCheck).toBe(true);
    h.voice().emitHearingOk();
    expect(h.store.getState().hearingCheck).toBe(false);
  });

  it('«cannot measure» (suspended AudioContext) is offered once; after a click it is not offered again', async () => {
    const h = setup();
    await h.coach.init();
    h.voice().emitHearingProblem('noMeter');
    expect(h.store.getState().hearingCheck).toBe(true);
    await h.coach.recheckHearing();
    h.voice().emitHearingProblem('noMeter');
    expect(h.store.getState().hearingCheck).toBe(false);
    // a real problem still is
    h.voice().emitHearingProblem('notPlaying');
    expect(h.store.getState().hearingCheck).toBe(true);
  });

  it('muted / the session put to sleep: no «Не слышно?» button', async () => {
    const h = setup();
    await h.coach.init();
    h.voice().emitHearingProblem('silent');
    h.coach.setMuted(true);
    expect(h.store.getState().hearingCheck).toBe(false);
    h.voice().emitHearingProblem('silent');
    expect(h.store.getState().hearingCheck).toBe(false);
  });

  it('a refused microphone on an OPEN session is not «reconnected»: no new billed session, «Микрофон закрыт» stays; a tap asks again on the same session', async () => {
    const h = setup({ reconnectDelayMs: 100 });
    await h.coach.init();
    h.coach.setToolHost(host());
    h.coach.onGameStart({ timeControlId: 'rapid10' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.openAttempts()).toBe(1);
    expect(h.voice().connected).toBe(true);

    // Chrome: the permission prompt was dismissed → the layer reports 'error' while connected
    h.voice().emitConversationState('error');
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.openAttempts()).toBe(1);
    expect(h.voice().sessionCalls.suspend).toBe(0);
    expect(h.store.getState().conversationState).toBe('error');
    expect(voiceDiagRecent().some((entry) => entry.e === 'reconnect.skip' && entry.why === 'mic')).toBe(true);

    // the child taps «Микрофон закрыт»
    h.voice().retryResult = true;
    expect(await h.coach.retryMicrophone()).toBe(true);
    expect(h.voice().retryCalls).toBe(1);
    expect(h.openAttempts()).toBe(1);
  });

  it('a dropped session (not connected) is still reopened, bounded', async () => {
    const h = setup({ reconnectDelayMs: 100 });
    await h.coach.init();
    h.coach.setToolHost(host());
    h.coach.onGameStart({ timeControlId: 'rapid10' });
    await vi.advanceTimersByTimeAsync(0);
    h.voice().emitConnected(false);
    h.voice().emitConversationState('off');
    await vi.advanceTimersByTimeAsync(200);
    expect(h.openAttempts()).toBe(2);
    expect(voiceDiagRecent().some((entry) => entry.e === 'reconnect' && entry.attempt === 1)).toBe(true);
  });

  it('in a game the 2-minute idle rule does not cut the coach off mid-word: it waits while his voice is audible (bounded)', async () => {
    const h = setup({ voiceIdleInGameMs: 10_000, idleBusyGraceMs: 5000 });
    await h.coach.init();
    h.coach.setToolHost(host());
    h.coach.onGameStart({ timeControlId: 'rapid10' });
    await vi.advanceTimersByTimeAsync(0);
    // the model talks on its own (an answer, no app phrase in flight)
    h.voice().emitSpeaking(true);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(h.voice().sessionCalls.suspend).toBe(0);
    h.voice().emitSpeaking(false);
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.voice().sessionCalls.suspend).toBe(1);
    expect(voiceDiagRecent().find((entry) => entry.e === 'sleep')).toMatchObject({ reason: 'gameIdle' });
  });

  it('...but a voice that never stops talking cannot keep the paid session open beyond the grace', async () => {
    const h = setup({ voiceIdleInGameMs: 10_000, idleBusyGraceMs: 5000 });
    await h.coach.init();
    h.coach.setToolHost(host());
    h.coach.onGameStart({ timeControlId: 'rapid10' });
    await vi.advanceTimersByTimeAsync(0);
    h.voice().emitSpeaking(true);
    await vi.advanceTimersByTimeAsync(16_500);
    expect(h.voice().sessionCalls.suspend).toBe(1);
  });

  it('the black box gets the controller\'s decisions: layer, game start, stops and why', async () => {
    const h = setup();
    await h.coach.init();
    h.coach.setToolHost(host());
    h.coach.onGameStart({ timeControlId: 'blitz5', coachStyle: 'helper' });
    await vi.advanceTimersByTimeAsync(0);
    void h.coach.say(makeEvent({ brief: 'Момент: проверка.' }));
    await vi.advanceTimersByTimeAsync(0);
    h.coach.stopSpeaking();
    const names = voiceDiagRecent().map((entry) => entry.e);
    expect(names).toContain('layer');
    expect(names).toContain('game.start');
    expect(voiceDiagRecent().find((entry) => entry.e === 'coach.stop')).toMatchObject({ why: 'stopSpeaking' });
    // no words ever: only codes and numbers
    expect(JSON.stringify(voiceDiagRecent())).not.toMatch(/[А-Яа-яЁё]/);
  });
});

describe('coach controller — a site whose microphone is blocked (Chrome)', () => {
  let permission: MicPermission = 'unknown';
  const permissionChange = createEmitter<MicPermission>();
  const permissionDeps = (): Partial<CoachControllerDeps> => ({
    micPermission: () => permission,
    onMicPermissionChange: (cb) => permissionChange.on(cb),
    micHelpBrowser: () => 'chrome',
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
    permission = 'unknown';
    permissionChange.clear();
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function openGame(extra: Partial<CoachControllerDeps> = permissionDeps()): Promise<Harness> {
    const h = setup({}, extra);
    await h.coach.init();
    h.coach.setToolHost(host());
    h.coach.onGameStart({ timeControlId: 'blitz5', coachStyle: 'teacher' });
    await vi.advanceTimersByTimeAsync(0);
    return h;
  }

  it('«denied»: the tap does not ask again (it cannot work) — the steps are shown and said instead', async () => {
    const h = await openGame();
    permission = 'denied';
    expect(await h.coach.retryMicrophone()).toBe(false);
    expect(h.voice().retryCalls).toBe(0);
    expect(h.store.getState().micHelp).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.voice().spoken.map((s) => s.text)).toContain(micHelpSpokenRu('chrome'));
    expect(h.store.getState().bubbleText).toBe(micHelpStepsRu('chrome'));
    expect(voiceDiagRecent().find((entry) => entry.e === 'mic.retry.skip')).toMatchObject({ perm: 'denied' });

    // a second tap a moment later: the steps stay, he does not repeat them
    h.voice().finish();
    expect(await h.coach.retryMicrophone()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.voice().spoken.filter((s) => s.text === micHelpSpokenRu('chrome'))).toHaveLength(1);
    expect(h.voice().retryCalls).toBe(0);
  });

  it('the parent allows it in the site settings: the steps go by themselves (the session attaches the microphone, no reload)', async () => {
    const h = await openGame();
    permission = 'denied';
    await h.coach.retryMicrophone();
    expect(h.store.getState().micHelp).toBe(true);
    permission = 'granted';
    permissionChange.emit('granted');
    expect(h.store.getState().micHelp).toBe(false);
    expect(voiceDiagRecent().find((entry) => entry.e === 'mic.help.done')).toMatchObject({ perm: 'granted' });

    // «Спрашивать» again counts too (the session asks at once); the microphone working clears it as well
    permission = 'denied';
    await h.coach.retryMicrophone();
    permissionChange.emit('prompt');
    expect(h.store.getState().micHelp).toBe(false);
  });

  it('not blocked («prompt» / unknown): the tap asks again on the same session; still refused → the steps', async () => {
    const h = await openGame();
    permission = 'prompt';
    h.voice().retryResult = false;
    expect(await h.coach.retryMicrophone()).toBe(false);
    expect(h.voice().retryCalls).toBe(1);
    expect(h.store.getState().micHelp).toBe(true);

    // it works now: the microphone is back and the note is gone; «Понятно» closes it too
    h.voice().retryResult = true;
    permission = 'unknown';
    expect(await h.coach.retryMicrophone()).toBe(true);
    expect(h.voice().retryCalls).toBe(2);
    h.coach.dismissMicHelp();
    expect(h.store.getState().micHelp).toBe(false);
  });

  it('the default permission source is the one the black box watches (no Permissions API → «unknown» → ask again)', async () => {
    const h = await openGame({});
    h.voice().retryResult = true;
    expect(await h.coach.retryMicrophone()).toBe(true);
    expect(h.voice().retryCalls).toBe(1);
    expect(h.store.getState().micHelp).toBe(false);
  });
});
