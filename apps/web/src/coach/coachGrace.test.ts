/**
 * Fast play (a 5-minute «Учитель» game: dozens of plies in a few minutes, so most teacher remarks would end
 * «interrupted» — each chopped mid-word when he moved while Гамбитик was still talking). `stopSpeaking({ grace: true })`:
 * waiting phrases and a phrase not heard yet go at once; the phrase he hears ends its sentence (Live: seen in its
 * caption) or its last words (a text read whole) within `stopGraceMs`; then the newest remark comes. Urgent phrases
 * and hard stops still cut at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthInfo } from '@gambit/shared';
import { createCoachController } from './coachController.ts';
import type { CoachController, CoachTimings } from './coachController.ts';
import { createCoachStore } from './coachStore.ts';
import type { CoachStore } from './coachStore.ts';
import { createSilentVoice } from './silentVoice.ts';
import { createFakeVoice, createMemoryStorage, makeEvent, makeHealth } from './testUtils.ts';
import type { FakeVoice } from './testUtils.ts';
import { configureVoiceDiagForTests, resetVoiceDiagForTests, voiceDiagRecent } from './voiceDiag.ts';
import type { VoiceKind } from './voiceTypes.ts';

interface Harness {
  coach: CoachController;
  store: CoachStore;
  voice(): FakeVoice;
}

const HEALTH: Record<'browser-tts' | 'openai-live' | 'openai-realtime', HealthInfo> = {
  'browser-tts': makeHealth(false),
  'openai-live': makeHealth(false, { live: true, preferred: 'live' }),
  'openai-realtime': makeHealth(true),
};

function setup(kind: keyof typeof HEALTH, timings: Partial<CoachTimings> = {}): Harness {
  const store = createCoachStore();
  let count = 0;
  let last: FakeVoice | null = null;
  const coach = createCoachController({
    store,
    getStorage: () => createMemoryStorage(),
    getHealth: () => Promise.resolve(HEALTH[kind]),
    createVoice(created: VoiceKind) {
      count += 1;
      // the very first layer is the controller's private silent one (used while muted)
      if (count === 1) return createSilentVoice();
      last = createFakeVoice({ kind: created, conversational: created === 'openai-live' || created === 'openai-realtime' });
      return last;
    },
    timings: { stopGraceMs: 2000, sentenceTailMs: 300, ...timings },
  });
  return {
    coach,
    store,
    voice() {
      if (!last) throw new Error('no voice was created yet');
      return last;
    },
  };
}

const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

const graceEnds = (): unknown[] => voiceDiagRecent().filter((entry) => entry.e === 'coach.grace').map((entry) => entry.end);
const lastStop = (): Record<string, unknown> | undefined => voiceDiagRecent().filter((entry) => entry.e === 'coach.stop').at(-1);

/** a teacher's remark of the position at `ply` (the model says it in its own words) */
function teachTurn(ply: number, text = 'Ходи конём на эф три: он смотрит в центр.') {
  return makeEvent({
    kind: 'teachTurn',
    text,
    bubbleText: text,
    brief: `Момент: совет хода ${ply}.`,
    pauseClock: true,
    teach: { moment: 'turn', style: 'full', ply, advice: [] },
  });
}

describe('coach controller — the child moves while he speaks (fast play)', () => {
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

  describe('Live: the caption comes in step with the voice — the sentence being said ends, then he stops', () => {
    it('mid-sentence: he goes on to the end of the sentence (+ its last word), not a word further; nothing chopped', async () => {
      const h = setup('openai-live');
      await h.coach.init();
      const said = h.coach.say(teachTurn(10));
      await flush();
      h.voice().emitSayProgress({ type: 'caption', text: 'Смотри, конь на эф три' });
      await vi.advanceTimersByTimeAsync(500);

      h.coach.stopSpeaking({ grace: true });
      expect(h.voice().stopCalls).toBe(0);
      expect(lastStop()).toMatchObject({ grace: 'sentence' });
      await vi.advanceTimersByTimeAsync(600);
      h.voice().emitSayProgress({ type: 'caption', text: 'Смотри, конь на эф три смотрит в центр.' });
      // the words run a little ahead of the sound: the last word is let out
      await vi.advanceTimersByTimeAsync(250);
      expect(h.voice().stopCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(60);
      expect(h.voice().stopCalls).toBe(1);
      await said;
      expect(graceEnds()).toEqual(['sentence']);
      expect(h.store.getState().bubbleText).toBe('Смотри, конь на эф три смотрит в центр.');
    });

    it('between two sentences (the caption ended one a moment ago): he stops right there — the pause is silent', async () => {
      const h = setup('openai-live');
      await h.coach.init();
      void h.coach.say(teachTurn(10));
      await flush();
      h.voice().emitSayProgress({ type: 'caption', text: 'Конь на эф три смотрит в центр.' });
      await vi.advanceTimersByTimeAsync(700);
      h.coach.stopSpeaking({ grace: true });
      expect(h.voice().stopCalls).toBe(1);
      expect(graceEnds()).toEqual(['sentence']);
    });

    it('a sentence that does not end within the grace is cut then (bounded — the child is waiting for the next advice)', async () => {
      const h = setup('openai-live');
      await h.coach.init();
      void h.coach.say(teachTurn(10));
      await flush();
      h.voice().emitSayProgress({ type: 'caption', text: 'Смотри' });
      h.coach.stopSpeaking({ grace: true });
      await vi.advanceTimersByTimeAsync(1900);
      h.voice().emitSayProgress({ type: 'caption', text: 'Смотри, конь на эф три смотрит' });
      expect(h.voice().stopCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(150);
      expect(h.voice().stopCalls).toBe(1);
      expect(graceEnds()).toEqual(['timeout']);
    });

    it('a remark the child does not hear yet (the model is still composing it) is dropped at once, like the waiting ones', async () => {
      const h = setup('openai-live');
      await h.coach.init();
      const first = h.coach.say(teachTurn(10));
      const waiting = h.coach.say(makeEvent({ text: 'Ещё одна фраза.' }));
      await flush();
      h.coach.stopSpeaking({ grace: true });
      expect(h.voice().stopCalls).toBe(1);
      await first;
      await waiting;
      expect(h.voice().briefs).toHaveLength(1);
      expect(lastStop()).toMatchObject({ grace: 'none' });
      expect(graceEnds()).toEqual([]);
    });

    it('it ends by itself inside the grace: spoken to the end, and the newest remark comes right after — the stale ones never', async () => {
      const h = setup('openai-live');
      await h.coach.init();
      const first = h.coach.say(teachTurn(10));
      const stale = h.coach.say(teachTurn(10, 'Или слон на цэ четыре.'));
      await flush();
      h.voice().emitSayProgress({ type: 'caption', text: 'Конь на эф три' });
      h.coach.stopSpeaking({ grace: true });
      await stale; // dropped at once: it was about the old position
      // the child's move brings the next position's remark while the sentence is still ending
      const next = h.coach.say(teachTurn(12, 'Теперь рокируйся.'));
      await flush();
      expect(h.voice().briefs).toHaveLength(1);
      h.voice().finish();
      await first;
      await flush();
      expect(h.voice().stopCalls).toBe(0);
      expect(graceEnds()).toEqual(['self']);
      expect(h.voice().briefs.map((b) => b.brief)).toEqual(['Момент: совет хода 10.', 'Момент: совет хода 12.']);
      h.voice().finish();
      await next;
    });

    it('an urgent phrase (priority 2: a take-back offer, a danger) still cuts in at once', async () => {
      const h = setup('openai-live');
      await h.coach.init();
      const first = h.coach.say(teachTurn(10));
      await flush();
      h.voice().emitSayProgress({ type: 'caption', text: 'Конь на эф три' });
      h.coach.stopSpeaking({ grace: true });
      const urgent = h.coach.say(makeEvent({ kind: 'takebackOffer', priority: 2, text: 'Стоп! Вернём ход?', brief: 'Момент: зевок.' }));
      await flush();
      expect(h.voice().stopCalls).toBe(1);
      await first;
      await flush();
      expect(graceEnds()).toEqual(['urgent']);
      expect(h.voice().briefs.at(-1)).toMatchObject({ brief: 'Момент: зевок.', interrupt: true });
      h.voice().finish();
      await urgent;
    });

    it('a hard stop (take-back, game over, a tap on him) during the grace cuts at once', async () => {
      const h = setup('openai-live');
      await h.coach.init();
      const first = h.coach.say(teachTurn(10));
      await flush();
      h.voice().emitSayProgress({ type: 'caption', text: 'Конь на эф три' });
      h.coach.stopSpeaking({ grace: true });
      h.coach.stopSpeaking({ grace: true }); // a second move: the first deadline stands
      expect(h.voice().stopCalls).toBe(0);
      h.coach.stopSpeaking({ clearBubble: true });
      expect(h.voice().stopCalls).toBe(1);
      await first;
      expect(graceEnds()).toEqual(['stop']);
      expect(h.store.getState().bubbleText).toBe('');
    });

    it('without `grace` nothing changes: the phrase is cut at once', async () => {
      const h = setup('openai-live');
      await h.coach.init();
      void h.coach.say(teachTurn(10));
      await flush();
      h.voice().emitSayProgress({ type: 'caption', text: 'Конь на эф три' });
      h.coach.stopSpeaking();
      expect(h.voice().stopCalls).toBe(1);
      expect(lastStop()).not.toHaveProperty('grace');
    });
  });

  describe('a text read whole (browser voice, Realtime words that run ahead): only a nearly finished phrase may end', () => {
    it('its last words (≤ the grace by its length): it ends by itself', async () => {
      const h = setup('browser-tts');
      await h.coach.init();
      const said = h.coach.say(makeEvent({ text: 'Молодец, так держать!' }));
      await flush();
      await vi.advanceTimersByTimeAsync(800);
      h.coach.stopSpeaking({ grace: true });
      expect(h.voice().stopCalls).toBe(0);
      expect(lastStop()).toMatchObject({ grace: 'finish' });
      await vi.advanceTimersByTimeAsync(900);
      h.voice().finish();
      await said;
      expect(h.voice().stopCalls).toBe(0);
      expect(graceEnds()).toEqual(['self']);
    });

    it('…and a voice slower than expected is still cut when the grace runs out', async () => {
      const h = setup('browser-tts');
      await h.coach.init();
      const said = h.coach.say(makeEvent({ text: 'Молодец, так держать!' }));
      await flush();
      await vi.advanceTimersByTimeAsync(500);
      h.coach.stopSpeaking({ grace: true });
      expect(h.voice().stopCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(2000);
      await said;
      expect(h.voice().stopCalls).toBe(1);
      expect(graceEnds()).toEqual(['timeout']);
    });

    it('far from its end: stale — cut at once', async () => {
      const h = setup('browser-tts');
      await h.coach.init();
      const said = h.coach.say(makeEvent({ text: 'Смотри: соперник вывел коня и напал на пешку е четыре, её надо защитить — например, конём на цэ три.' }));
      await flush();
      await vi.advanceTimersByTimeAsync(500);
      h.coach.stopSpeaking({ grace: true });
      expect(h.voice().stopCalls).toBe(1);
      await said;
      expect(lastStop()).toMatchObject({ grace: 'none' });
    });

    it('Realtime: its caption (ahead of the voice) is the whole phrase — the time left decides', async () => {
      const h = setup('openai-realtime');
      await h.coach.init();
      const said = h.coach.say(teachTurn(10));
      await flush();
      h.voice().emitSayProgress({ type: 'caption', text: 'Конь на эф три — в центр!' });
      await vi.advanceTimersByTimeAsync(1200);
      h.coach.stopSpeaking({ grace: true });
      // not in step with the voice: a sentence end in the caption says nothing about where the voice is
      expect(h.voice().stopCalls).toBe(0);
      expect(lastStop()).toMatchObject({ grace: 'finish' });
      h.voice().finish();
      await said;
      expect(graceEnds()).toEqual(['self']);

      const long = setup('openai-realtime');
      await long.coach.init();
      void long.coach.say(teachTurn(10));
      await flush();
      long.voice().emitSayProgress({ type: 'caption', text: 'Смотри: соперник вывел коня и напал на пешку. Защити её конём на цэ три — и он будет в игре.' });
      await vi.advanceTimersByTimeAsync(300);
      long.coach.stopSpeaking({ grace: true });
      expect(long.voice().stopCalls).toBe(1);
    });

    it('the free voice says a brief\'s template (the model could not): that template is what the child hears', async () => {
      const h = setup('openai-live');
      await h.coach.init();
      void h.coach.say(teachTurn(10, 'Конь в центр!'));
      await flush();
      h.voice().emitSayProgress({ type: 'fallback' });
      // nothing sounds yet: nothing to let finish
      h.coach.stopSpeaking({ grace: true });
      expect(h.voice().stopCalls).toBe(1);

      const heard = setup('openai-live');
      await heard.coach.init();
      const said = heard.coach.say(teachTurn(10, 'Конь в центр!'));
      await flush();
      heard.voice().emitSpeaking(false);
      heard.voice().emitSayProgress({ type: 'fallback' });
      heard.voice().emitSpeaking(true);
      heard.coach.stopSpeaking({ grace: true });
      expect(heard.voice().stopCalls).toBe(0);
      heard.voice().finish();
      await said;
    });
  });

  it('the black box keeps only codes: how each gentle stop ended, never words', async () => {
    const h = setup('openai-live');
    await h.coach.init();
    void h.coach.say(teachTurn(10));
    await flush();
    h.voice().emitSayProgress({ type: 'caption', text: 'Конь на эф три.' });
    await vi.advanceTimersByTimeAsync(400);
    h.coach.stopSpeaking({ grace: true });
    expect(voiceDiagRecent().find((entry) => entry.e === 'coach.grace')).toMatchObject({ end: 'sentence', mode: 'sentence', phrase: 'teachTurn' });
    expect(JSON.stringify(voiceDiagRecent())).not.toMatch(/[А-Яа-яЁё]/);
  });
});
