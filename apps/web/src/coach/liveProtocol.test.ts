import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoachEvent, CoachToolHost } from '@gambit/shared';
import { CLARIFY_MOVE_FACTS_RU, buildBriefCommentary, buildFactsAnswer, buildUrgentBriefCommentary, clarifyPieceMoveFacts, hintFacts, whyNotFacts } from './coachBrief.ts';
import {
  LIVE_CONTEXT_PREFIX_RU,
  LIVE_SAY_POLICY_RU,
  LIVE_STOP_INSTRUCTION_RU,
  MAX_APPEND_CHARS,
  buildContextNote,
  buildUrgentSayCommentary,
  classifyChildRequest,
  createLiveProtocol,
} from './liveProtocol.ts';
import type { LiveClientEvent, LiveProtocol, LiveProtocolOptions } from './liveProtocol.ts';
import { makeEvent } from './testUtils.ts';
import type { SayProgress, SpeakOutcome } from './voiceTypes.ts';

interface Harness {
  protocol: LiveProtocol;
  sent: LiveClientEvent[];
  transcripts: string[];
  captions: string[];
  thinking: boolean[];
  childSpeaking: boolean[];
  ducks: boolean[];
  closed: string[];
  toolEvents: CoachEvent[];
  progress: SayProgress[];
  host: { current: CoachToolHost | null };
  /** events after the session-start boilerplate */
  types(): string[];
  start(): void;
}

function setup(options: LiveProtocolOptions = { questionSettleMs: 0 }): Harness {
  const sent: LiveClientEvent[] = [];
  const transcripts: string[] = [];
  const captions: string[] = [];
  const thinking: boolean[] = [];
  const childSpeaking: boolean[] = [];
  const ducks: boolean[] = [];
  const closed: string[] = [];
  const toolEvents: CoachEvent[] = [];
  const progress: SayProgress[] = [];
  const host: { current: CoachToolHost | null } = { current: null };
  let id = 0;
  const protocol = createLiveProtocol(
    {
      send: (event) => sent.push(event),
      getToolHost: () => host.current,
      onTranscript: (who, text) => transcripts.push(`${who}: ${text}`),
      onCoachTranscriptDelta: (text) => captions.push(text),
      onThinking: (value) => thinking.push(value),
      onToolCoachEvent: (event) => toolEvents.push(event),
      onChildSpeaking: (value) => childSpeaking.push(value),
      onDuck: (value) => ducks.push(value),
      onSessionClosed: (reason) => closed.push(reason),
      onSayProgress: (p) => progress.push(p),
    },
    // the settle wait for the child's last words has its own test (real default); here the transcript is always complete
    { newId: () => `ev_${++id}`, ...options },
  );
  return {
    protocol,
    sent,
    transcripts,
    captions,
    thinking,
    childSpeaking,
    ducks,
    closed,
    toolEvents,
    progress,
    host,
    types: () => sent.map((e) => e.type),
    start() {
      protocol.handleServerEvent({ type: 'session.started', event_id: 'event_started_1', session: { id: 'live_123', status: 'active', model: 'gpt-live-1' } });
      sent.length = 0;
    },
  };
}

const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);
const childSays = (delta: string): unknown => ({ type: 'session.input_transcript.delta', event_id: 'e', delta, start_ms: 0, end_ms: 400 });
const coachSays = (delta: string, startMs?: number, endMs?: number): unknown => ({
  type: 'session.output_transcript.delta',
  event_id: 'e',
  delta,
  ...(startMs !== undefined ? { start_ms: startMs, end_ms: endMs } : {}),
});

/** the analyser reports the coach's audio as audible for `ms`, frame by frame */
async function audibleFor(h: Harness, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 50) {
    h.protocol.noteOutputLevel(true);
    await vi.advanceTimersByTimeAsync(50);
  }
}
async function quietFor(h: Harness, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 50) {
    h.protocol.noteOutputLevel(false);
    await vi.advanceTimersByTimeAsync(50);
  }
}

function track(promise: Promise<SpeakOutcome>): { value: SpeakOutcome | null } {
  const box: { value: SpeakOutcome | null } = { value: null };
  void promise.then((v) => (box.value = v));
  return box;
}

describe('live protocol', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('encoding of client events', () => {
    it('session.started → one trusted instruction with the «own words, short, 1–2 sentences, nothing obvious, every fact exact, never judge a position» policy', async () => {
      const h = setup();
      expect(h.protocol.started).toBe(false);
      const started = h.protocol.whenStarted(5000);
      h.protocol.handleServerEvent({ type: 'session.started', session: { id: 'live_1' } });
      expect(await started).toBe(true);
      expect(h.sent).toEqual([{ type: 'session.instructions.append', event_id: 'ev_1', delegation_id: null, content: LIVE_SAY_POLICY_RU }]);
      // so that phrases do not feel pre-programmed, the policy does not ask to stay close to a text
      expect(LIVE_SAY_POLICY_RU).toMatch(/своими словами/);
      // short, and nothing the child already sees (e.g. the clocks) is voiced
      expect(LIVE_SAY_POLICY_RU).toContain('коротко, 1–2 предложения, не пересказывай очевидное');
      expect(LIVE_SAY_POLICY_RU).toMatch(/время на часах, цвет фигур, чей ход/);
      expect(LIVE_SAY_POLICY_RU).not.toMatch(/одно–три/);
      expect(LIVE_SAY_POLICY_RU).toMatch(/по-новому/);
      expect(LIVE_SAY_POLICY_RU).toMatch(/Факты передавай точно/);
      expect(LIVE_SAY_POLICY_RU).not.toMatch(/близко к тексту|целиком|дословно|одно-два предложения/);
      // it supersedes the older rule of the server's instructions, and keeps the child-safety basics
      expect(LIVE_SAY_POLICY_RU).toMatch(/важнее прежних правил/);
      expect(LIVE_SAY_POLICY_RU).toMatch(/Только по-русски и только о шахматах/);
      expect(LIVE_SAY_POLICY_RU).toMatch(/личное не спрашивай/);
      expect(LIVE_SAY_POLICY_RU).toMatch(/Позицию сам не оценивай/);
      // teacher mode (docs/TEACHER-MODE.md §6.1): the advice nearly every move is normal; the child's moves only from «Можно назвать»
      expect(LIVE_SAY_POLICY_RU).toMatch(/в режиме «Учитель» совет приходит почти на каждом ходу, это нормально/);
      expect(LIVE_SAY_POLICY_RU).toMatch(/только если он есть в строке «Можно назвать» или в подсказке четвёртой ступени/);
      expect(LIVE_SAY_POLICY_RU).toMatch(/если приложение назвало другое число — столько и говори/);
      expect(LIVE_SAY_POLICY_RU).not.toMatch(/[A-Za-z]/);
      // sent whole: under the clip that keeps an append below ~500 tokens
      expect(LIVE_SAY_POLICY_RU.length).toBeLessThanOrEqual(MAX_APPEND_CHARS);
      // a repeated event does not repeat the policy
      h.protocol.handleServerEvent({ type: 'session.started', session: { id: 'live_1' } });
      expect(h.sent).toHaveLength(1);
    });

    it('whenStarted gives up after its timeout, and never sends session.start (the HTTP request starts the session)', async () => {
      const h = setup();
      const started = h.protocol.whenStarted(3000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await started).toBe(false);
      expect(h.sent).toEqual([]);
    });

    it('speak = session.commentary.append with the bare Russian phrase, session-wide (delegation_id null)', async () => {
      const h = setup();
      h.start();
      void h.protocol.speak('  Отличный   ход!\nТак держать. ');
      await flush();
      expect(h.sent).toEqual([{ type: 'session.commentary.append', event_id: 'ev_2', delegation_id: null, content: 'Отличный ход! Так держать.' }]);
    });

    it('an urgent phrase is commentary sent at once (instructions stay in the session for good)', async () => {
      const h = setup();
      h.start();
      void h.protocol.speak('Стоп-стоп! Давай вернём ход.', { interrupt: true });
      await flush();
      expect(h.sent).toEqual([
        { type: 'session.commentary.append', event_id: 'ev_2', delegation_id: null, content: buildUrgentSayCommentary('Стоп-стоп! Давай вернём ход.') },
      ]);
      expect(String(h.sent[0]?.content)).toMatch(/почти дословно: «Стоп-стоп! Давай вернём ход\.»/);
      expect(String(h.sent[0]?.content)).not.toMatch(/замолчи/);
    });

    it('pushContext = session.thinking.append (silent facts); notes pushed before the start are kept (latest three) and flushed', () => {
      const h = setup();
      for (const note of ['раз', 'два', 'три', 'четыре']) h.protocol.pushContext(note);
      expect(h.sent).toEqual([]);
      h.protocol.handleServerEvent({ type: 'session.started' });
      expect(h.sent.filter((e) => e.type === 'session.thinking.append').map((e) => e.content)).toEqual(['два', 'три', 'четыре'].map(buildContextNote));

      h.sent.length = 0;
      h.protocol.pushContext('Ход 12: ученик сыграл слон эф четыре. Угроз нет.');
      h.protocol.pushContext('   ');
      expect(h.sent).toEqual([
        {
          type: 'session.thinking.append',
          event_id: expect.any(String) as string,
          delegation_id: null,
          content: 'Служебная заметка, вслух не произноси и не отвечай на неё: Ход 12: ученик сыграл слон эф четыре. Угроз нет.',
        },
      ]);
    });

    it('a note never lands in the middle of an app phrase (it would replace the greeting); it goes out right after it', async () => {
      const h = setup();
      h.start();
      const greeting = h.protocol.speak('Привет! Сегодня играем с Петей.');
      await flush();
      h.protocol.pushContext('Ход 1: ученик сыграл пешка е четыре.');
      h.protocol.pushContext('Ход 1: соперник сыграл пешка цэ шесть.');
      expect(h.types()).toEqual(['session.commentary.append']);
      await audibleFor(h, 1500);
      await quietFor(h, 800);
      expect(await greeting).toBe('spoken');
      expect(h.types()).toEqual(['session.commentary.append', 'session.thinking.append', 'session.thinking.append']);
      expect(String(h.sent[1]?.content)).toContain('пешка е четыре');
      // with nothing being said, a note goes out at once
      h.protocol.pushContext('Ход 2: ученик сыграл конь эф три.');
      expect(h.types()).toHaveLength(4);
    });

    it('context notes are marked as not-to-be-spoken, and the session policy explains the marker (bare notes get read aloud)', () => {
      expect(buildContextNote('Ход соперника: конь на эф шесть.').startsWith(LIVE_CONTEXT_PREFIX_RU)).toBe(true);
      expect(LIVE_CONTEXT_PREFIX_RU).toMatch(/^Служебная заметка/);
      expect(LIVE_SAY_POLICY_RU).toContain('Служебная заметка');
      expect(LIVE_SAY_POLICY_RU).toMatch(/вслух не произноси/);
      // Russian only: Latin tokens in the context raise the risk of language drift
      expect(LIVE_CONTEXT_PREFIX_RU).not.toMatch(/[A-Za-z]/);
    });

    it('content is clipped to stay under the documented 500-token limit', () => {
      const h = setup();
      h.start();
      h.protocol.pushContext('очень длинная заметка '.repeat(200));
      expect(String(h.sent[0]?.content).length).toBeLessThanOrEqual(MAX_APPEND_CHARS);
      expect(MAX_APPEND_CHARS).toBeLessThanOrEqual(1200);
    });

    it('setInputMuted sends the documented mute / unmute events once per change; a mute set before the start is applied at start', () => {
      const h = setup();
      h.protocol.setInputMuted(true);
      expect(h.sent).toEqual([]);
      h.protocol.handleServerEvent({ type: 'session.started' });
      expect(h.types()).toContain('session.input_audio.mute');
      h.sent.length = 0;
      h.protocol.setInputMuted(true);
      h.protocol.setInputMuted(false);
      h.protocol.setInputMuted(false);
      expect(h.sent).toEqual([{ type: 'session.input_audio.unmute', event_id: expect.any(String) as string }]);
    });

    it('an error the API reports after our session.close is expected — logged as info, not as a warning', () => {
      const h = setup();
      h.start();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      h.protocol.handleServerEvent({ type: 'error', error: { code: 'rate_limited' } });
      expect(warn).toHaveBeenCalledTimes(1);
      h.protocol.requestClose();
      h.protocol.handleServerEvent({ type: 'error', error: { code: 'context_injection_incomplete', message: 'The session closed before…' } });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith('[coach] live error after close:', 'context_injection_incomplete');
    });

    it('requestClose sends session.close', () => {
      const h = setup();
      h.protocol.requestClose();
      expect(h.sent).toEqual([]); // nothing to close yet
      h.start();
      h.protocol.requestClose();
      expect(h.types()).toEqual(['session.close']);
    });
  });

  describe('speak() completion (the Live API has no per-response "done" event)', () => {
    it('resolves once the coach has started talking and then stayed quiet for 700 ms', async () => {
      const h = setup();
      h.start();
      const result = track(h.protocol.speak('Посмотри, что под боем?'));
      await flush();
      await quietFor(h, 600); // the model has not started yet
      expect(result.value).toBeNull();
      await audibleFor(h, 2000);
      await quietFor(h, 600);
      expect(result.value).toBeNull(); // a pause shorter than 700 ms is just a breath
      await audibleFor(h, 800);
      await quietFor(h, 650);
      expect(result.value).toBeNull();
      await quietFor(h, 200);
      expect(result.value).toBe('spoken');
    });

    it('real timing: deltas arrive in step with the audio, so a 0.8 s pause after the FIRST sentence is not the end', async () => {
      const h = setup();
      h.start();
      // 69 characters → at least ~3.5 s of speech before «quiet + timeline ran out» may count as finished
      const result = track(h.protocol.speak('Сначала смотрим — потом ходим! Что хочет соперник? Мой ход безопасен?'));
      await flush();
      await quietFor(h, 1800); // the model needs a moment to start
      h.protocol.handleServerEvent(coachSays('Сначала смотрим — потом ходим.', 0, 2100));
      await audibleFor(h, 2200);
      await quietFor(h, 800); // the pause between the sentences; the timeline (2.1 s) has run out
      expect(result.value).toBeNull();
      h.protocol.handleServerEvent(coachSays(' Что хочет соперник?', 2900, 4500));
      await audibleFor(h, 1600);
      await quietFor(h, 100);
      h.protocol.handleServerEvent(coachSays(' Мой ход безопасен?', 4600, 6000));
      await audibleFor(h, 1400);
      expect(result.value).toBeNull();
      await quietFor(h, 800);
      expect(result.value).toBe('spoken');
    });

    it('a paraphrase much shorter than the text still ends: 2.5 s of silence is always the end', async () => {
      const h = setup();
      h.start();
      const result = track(h.protocol.speak('Сначала смотрим — потом ходим! Что хочет соперник? Мой ход безопасен?'));
      await flush();
      await audibleFor(h, 600); // «Смотри внимательно!» — and nothing more
      await quietFor(h, 2400);
      expect(result.value).toBeNull();
      await quietFor(h, 200);
      expect(result.value).toBe('spoken');
    });

    it('a pause between two sentences does not end the phrase while the transcript timeline says there is more', async () => {
      const h = setup();
      h.start();
      const result = track(h.protocol.speak('Первое предложение. Второе предложение.'));
      await flush();
      // the whole transcript arrives early: 0 … 5000 ms of speech
      h.protocol.handleServerEvent(coachSays('Первое предложение. ', 10_000, 12_000));
      h.protocol.handleServerEvent(coachSays('Второе предложение.', 12_900, 15_000));
      await audibleFor(h, 2000);
      await quietFor(h, 900); // 0.9 s of silence between the sentences
      expect(result.value).toBeNull();
      await audibleFor(h, 2100);
      await quietFor(h, 800);
      expect(result.value).toBe('spoken');
    });

    it('a wrong transcript timeline cannot hold the phrase for long: 2.5 s of silence always ends it', async () => {
      const h = setup();
      h.start();
      const result = track(h.protocol.speak('Коротко.'));
      await flush();
      h.protocol.handleServerEvent(coachSays('Коротко.', 0, 60_000));
      await audibleFor(h, 1000);
      await quietFor(h, 2400);
      expect(result.value).toBeNull();
      await quietFor(h, 300);
      expect(result.value).toBe('spoken');
    });

    it('deaf analyser: falls back to the output transcript — its timeline, then 700 ms without new words', async () => {
      const h = setup();
      h.start();
      const result = track(h.protocol.speak('Конь прыгает буквой гэ.'));
      await flush();
      h.protocol.noteOutputLevel(null);
      h.protocol.handleServerEvent(coachSays('Конь прыгает ', 4000, 5200));
      await vi.advanceTimersByTimeAsync(300);
      h.protocol.handleServerEvent(coachSays('буквой гэ.', 5200, 6500));
      await vi.advanceTimersByTimeAsync(2000);
      expect(result.value).toBeNull(); // 2.5 s of speech were announced, 2.3 s have passed
      await vi.advanceTimersByTimeAsync(600);
      expect(result.value).toBe('spoken');
    });

    it('deaf analyser and no timeline in the deltas: estimates the length from the words', async () => {
      const h = setup();
      h.start();
      const result = track(h.protocol.speak('Привет!'));
      await flush();
      h.protocol.noteOutputLevel(null);
      h.protocol.handleServerEvent(coachSays('Привет!'));
      await vi.advanceTimersByTimeAsync(1200);
      expect(result.value).toBeNull();
      await vi.advanceTimersByTimeAsync(300);
      expect(result.value).toBe('spoken');
    });

    it('hard cap: 12 s after the append the phrase is over, whatever the audio does', async () => {
      const h = setup();
      h.start();
      const result = track(h.protocol.speak('Фраза, после которой модель болтает без конца.'));
      await flush();
      await audibleFor(h, 11_900);
      expect(result.value).toBeNull();
      await audibleFor(h, 200);
      expect(result.value).toBe('spoken');
    });

    it("the model never says it → 'failed' after 5 s, and the model is told not to repeat what the fallback voice says now", async () => {
      const h = setup();
      h.start();
      const result = track(h.protocol.speak('Твой ход!'));
      await flush();
      h.protocol.handleServerEvent({ type: 'session.commentary.appended', client_event_id: 'ev_2' });
      await quietFor(h, 4900);
      expect(result.value).toBeNull();
      await quietFor(h, 200);
      expect(result.value).toBe('failed');
      const note = h.sent.at(-1);
      expect(note?.type).toBe('session.thinking.append');
      expect(String(note?.content)).toMatch(/уже само показало и озвучило.*«Твой ход!».*Не произноси/);
    });

    it('while the child is talking the model rightly holds the phrase back: that time does not count as failure', async () => {
      const h = setup();
      h.start();
      const result = track(h.protocol.speak('Хороший вопрос!', { interrupt: true }));
      await flush();
      for (let i = 0; i < 8; i++) {
        h.protocol.handleServerEvent(childSays('и ещё… '));
        await quietFor(h, 1000);
      }
      expect(result.value).toBeNull(); // 8 s of child speech, still waiting
      await audibleFor(h, 1500);
      await quietFor(h, 800);
      expect(result.value).toBe('spoken');
    });

    it('an error event about our append fails the phrase at once', async () => {
      const h = setup();
      h.start();
      const spoken = h.protocol.speak('Привет!');
      await flush();
      h.protocol.handleServerEvent({ type: 'error', error: { code: 'event_not_allowed', message: 'x', client_event_id: 'ev_2' } });
      expect(await spoken).toBe('failed');
    });

    it('a normal phrase waits for the child to finish (1.2 s without new words); an urgent one does not', async () => {
      const h = setup();
      h.start();
      h.protocol.handleServerEvent(childSays('а почему'));
      expect(h.protocol.childSpeaking).toBe(true);
      void h.protocol.speak('Обычная фраза.');
      await vi.advanceTimersByTimeAsync(1100);
      expect(h.sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(200); // 1.2 s without new words → the child has finished
      expect(h.types()).toEqual(['session.commentary.append']);

      const other = setup();
      other.start();
      other.protocol.handleServerEvent(childSays('а почему'));
      void other.protocol.speak('Стоп-стоп!', { interrupt: true });
      await flush();
      expect(other.types()).toEqual(['session.commentary.append']);
    });

    it('a phrase is never appended while the child is still asking, nor into the answer to the question', async () => {
      const h = setup();
      h.host.current = {
        getPositionSummary: vi.fn(() => Promise.resolve('Материал равный.')),
        getHint: vi.fn(() => Promise.resolve(makeEvent({ kind: 'hint', text: 'Какая фигура соперника без защиты?' }))),
        explainLastMove: vi.fn(() => Promise.resolve(null)),
        showOnBoard: vi.fn(),
        takeBackMove: vi.fn(() => true),
      };
      h.start();
      // the child asks a long question (4 s of transcript deltas)…
      h.protocol.handleServerEvent(childSays('Гамбитик, подскажи, '));
      const routine = track(h.protocol.speak('Два вопроса мастера.'));
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(1000);
        h.protocol.handleServerEvent(childSays('какой ход '));
      }
      expect(h.sent).toEqual([]);
      // …the model delegates and answers (filler, a short gap, the answer)
      h.protocol.handleServerEvent({ type: 'session.delegation.created', delegation: { id: 'del_1', type: 'client', target: 'client' } });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.types()).toEqual(['session.commentary.append']);
      expect(h.sent[0]?.delegation_id).toBe('del_1');
      await vi.advanceTimersByTimeAsync(700);
      await audibleFor(h, 1200); // «Так-так, дай прикину.»
      await quietFor(h, 900); // the gap before the delegated answer
      await audibleFor(h, 2500); // the answer
      expect(h.types()).toEqual(['session.commentary.append']);
      expect(routine.value).toBeNull();
      // only after a real pause the app phrase goes out
      await quietFor(h, 1200);
      expect(h.sent).toHaveLength(2);
      expect(String(h.sent[0]?.content)).toContain('Какая фигура соперника без защиты?');
      expect(h.sent[1]?.content).toBe('Два вопроса мастера.');
      await audibleFor(h, 1500);
      await quietFor(h, 800);
      expect(routine.value).toBe('spoken');
    });

    it('the wait is bounded: endless talk in the room (a TV) delays a normal phrase, it never silences the coach', async () => {
      const h = setup();
      h.start();
      const result = track(h.protocol.speak('Твой ход!'));
      for (let i = 0; i < 14; i++) {
        h.protocol.handleServerEvent(childSays('бу-бу-бу '));
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(h.types()).toEqual(['session.commentary.append']);
      expect(result.value).toBeNull();
    });

    it('stop() while a phrase is still waiting: the phrase is dropped, and the answer to the child is not cut off', async () => {
      const h = setup();
      h.start();
      await audibleFor(h, 300); // the model is answering the child on its own
      const waiting = h.protocol.speak('Похвала.');
      await flush();
      expect(h.sent).toEqual([]);
      h.protocol.cancelOutput();
      expect(await waiting).toBe('interrupted');
      await quietFor(h, 2000);
      expect(h.sent).toEqual([]); // neither the phrase nor a «замолчи» instruction
      expect(h.ducks).toEqual([]);
    });

    it('phrases are said one after another; an urgent one settles the waiting one as interrupted', async () => {
      const h = setup();
      h.start();
      const first = h.protocol.speak('первая');
      await flush();
      const second = track(h.protocol.speak('вторая'));
      await flush();
      expect(h.types()).toEqual(['session.commentary.append']);
      await audibleFor(h, 500);
      await quietFor(h, 800);
      expect(await first).toBe('spoken');
      await flush();
      expect(h.sent.map((e) => e.content)).toEqual(['первая', 'вторая']);

      const urgent = h.protocol.speak('срочная', { interrupt: true });
      await flush();
      expect(second.value).toBe('interrupted');
      await audibleFor(h, 500);
      await quietFor(h, 800);
      expect(await urgent).toBe('spoken');
    });

    it("reset() (connection lost): an unsaid phrase is 'failed' → the fallback voice says it; a half-said one is not repeated", async () => {
      const h = setup();
      h.start();
      const unsaid = h.protocol.speak('Привет!');
      await flush();
      h.protocol.reset();
      expect(await unsaid).toBe('failed');

      h.start();
      const halfSaid = h.protocol.speak('Длинная фраза.');
      await flush();
      await audibleFor(h, 300);
      h.protocol.reset();
      expect(await halfSaid).toBe('interrupted');
      expect(await h.protocol.speak('после обрыва')).toBe('failed');
    });
  });

  describe('speakBrief: the model says the situation in its OWN words', () => {
    const BRIEF = 'Ребёнок сыграл ферзь на дэ два. Теперь конь соперника может напасть на ферзя и короля сразу. Цель: предложить вернуть ход. Лучший ход не называть.';

    it('a normal brief = commentary framed «own words, 1–2 sentences, nothing obvious, facts exact» — never «verbatim» or «close to the text»', async () => {
      const h = setup();
      h.start();
      void h.protocol.speakBrief(BRIEF, { fallbackText: 'Стоп-стоп! Давай вернём ход.' });
      await flush();
      expect(h.sent).toEqual([{ type: 'session.commentary.append', event_id: 'ev_2', delegation_id: null, content: buildBriefCommentary(BRIEF) }]);
      const content = String(h.sent[0]?.content);
      expect(content).toMatch(/^Сейчас скажи ребёнку своими словами, коротко — одно–два предложения; не пересказывай очевидное/);
      expect(content).toMatch(/Не зачитывай это дословно: факты передай точно, ничего не добавляй от себя\./);
      expect(content).not.toMatch(/почти дословно|близко к тексту|целиком|скажи[^.]*дословно/i);
      // the whole situation reaches the model, after the frame
      expect(content.endsWith(`Ситуация: ${BRIEF}`)).toBe(true);
      // the template is NOT sent to the model: it is only the fallback voice's text
      expect(content).not.toContain('Стоп-стоп!');
      expect(h.progress).toEqual([{ type: 'sent' }]);
    });

    it('teacher mode: the brief\'s sentence budget replaces «одно–два» in the frame (short 1, full 2), urgent ones too', async () => {
      const h = setup();
      h.start();
      void h.protocol.speakBrief(BRIEF, { fallbackText: 'Конь на эф три.', maxSentences: 1 });
      await flush();
      const content = String(h.sent[0]?.content);
      expect(content).toBe(buildBriefCommentary(BRIEF, { maxSentences: 1 }));
      expect(content).toMatch(/^Сейчас скажи ребёнку своими словами одно короткое предложение, не больше; всего не больше пятнадцати слов; не пересказывай очевидное/);
      expect(content).not.toMatch(/одно–три|одно–два/);
      // the situation, then the hard cap once more («ничего лишнего»)
      expect(content.endsWith(`Ситуация: ${BRIEF} Помни: не больше пятнадцати слов, одна фраза, ничего не добавляй от себя.`)).toBe(true);

      const urgent = setup();
      urgent.start();
      void urgent.protocol.speakBrief(BRIEF, { interrupt: true, maxSentences: 2 });
      await flush();
      const urgentContent = String(urgent.sent.find((e) => e.type === 'session.commentary.append')?.content);
      expect(urgentContent).toBe(buildUrgentBriefCommentary(BRIEF, { maxSentences: 2 }));
      expect(urgentContent).toMatch(/^Важный момент — скажи ребёнку сразу, как только сможешь, своими словами одно–два коротких предложения, не больше;/);
    });

    it('a teacher\'s full / concept brief gets more time before the hard cap settles it (≈ 4 s per sentence above three)', async () => {
      const plain = setup();
      plain.start();
      const ordinary = track(plain.protocol.speakBrief(BRIEF));
      await flush();
      await audibleFor(plain, 14_500);
      expect(ordinary.value).toBe('spoken'); // 12 s + 2 s, as before

      const concept = setup();
      concept.start();
      const long = track(concept.protocol.speakBrief(BRIEF, { maxSentences: 5 }));
      await flush();
      await audibleFor(concept, 18_000);
      expect(long.value).toBeNull(); // still talking — not cut at 14 s
      await audibleFor(concept, 4_500);
      expect(long.value).toBe('spoken'); // 12 + 2 + 2 × 4 s
    });

    it('an urgent brief is COMMENTARY sent at once (an instruction is acknowledged but never spoken)', async () => {
      const h = setup();
      h.start();
      // the child is still talking: a normal brief would wait, an urgent one does not
      h.protocol.handleServerEvent(childSays('ой, а я'));
      void h.protocol.speakBrief(BRIEF, { interrupt: true });
      await flush();
      expect(h.sent).toEqual([{ type: 'session.commentary.append', event_id: 'ev_2', delegation_id: null, content: buildUrgentBriefCommentary(BRIEF) }]);
      const content = String(h.sent[0]?.content);
      expect(content).toMatch(/^Важный момент — скажи ребёнку сразу, как только сможешь, своими словами/);
      expect(content).not.toMatch(/почти дословно|близко к тексту|замолчи/);
    });

    it('an urgent brief while he is talking: a ONE-TIME stop instruction first (never a standing «be silent»), then the commentary', async () => {
      const h = setup();
      h.start();
      await audibleFor(h, 300);
      void h.protocol.speakBrief(BRIEF, { interrupt: true });
      await flush();
      expect(h.types()).toEqual(['session.instructions.append', 'session.commentary.append']);
      expect(h.sent[0]?.content).toBe(LIVE_STOP_INSTRUCTION_RU);
      expect(LIVE_STOP_INSTRUCTION_RU).toMatch(/^Одноразовое указание/);
      expect(LIVE_STOP_INSTRUCTION_RU).toMatch(/Потом говори как обычно/);
      expect(h.ducks).toEqual([true]);
    });

    it('a full-size take-back brief (≈ 960 chars, @gambit/core) keeps its «Цель» and «Нельзя» lines inside the append limit', async () => {
      const facts = [
        'Ход ученика: пешка на аш три.',
        'Теперь у соперника сильный ответ: конь бьёт на цэ два, шах, дальше, например, король на дэ два, потом конь бьёт на а один.',
        'После этого хода соперник ставит вилку (одна фигура нападает сразу на две).',
        'Соперник забирает пешку, а потом ладью.',
        'В итоге ученик теряет шесть пешек материала.',
        'Для ученика позиция была примерно равной, стала почти проигранной.',
        'На экране две кнопки: «Верну ход и подумаю» и «Оставлю свой ход».',
      ];
      const big = [
        'Момент: Ученик только что сделал ход, который что-то теряет; игра остановлена, часы стоят, приложение предлагает вернуть ход.',
        `Факты: ${facts.join(' ')}`,
        'Цель: Мягко останови и предложи вернуть ход; спроси, что теперь может сделать соперник, например: «Соперник готовит вилку — на какие две фигуры он нападёт?»; если ученик не видит опасность, можешь назвать ответ соперника; решение за ним: если хочет оставить ход — уважай это.',
        'Нельзя: Не называй лучший ход и клетку, куда идти; не ругай и не говори «зевок», «ошибка», «плохой ход».',
      ].join('\n');
      const h = setup();
      h.start();
      void h.protocol.speakBrief(big, { interrupt: true });
      await flush();
      const content = String(h.sent[0]?.content);
      expect(content.length).toBeLessThanOrEqual(MAX_APPEND_CHARS);
      expect(content).not.toMatch(/…$/);
      expect(content).toContain('Цель: Мягко останови и предложи вернуть ход');
      expect(content).toMatch(/Нельзя: Не называй лучший ход и клетку, куда идти; не ругай и не говори «зевок», «ошибка», «плохой ход»\.$/);
      expect(content).toContain('Ход ученика: пешка на аш три.');
    });

    it("the model's words stream as captions (for the bubble) and go to the journal; a brief is over after 1.1 s of quiet", async () => {
      const h = setup();
      h.start();
      const result = track(h.protocol.speakBrief(BRIEF));
      await flush();
      h.protocol.handleServerEvent(coachSays('Ой, подожди! ', 0, 900));
      await audibleFor(h, 900);
      h.protocol.handleServerEvent(coachSays('Давай вернём ход?', 900, 2000));
      await audibleFor(h, 1100);
      expect(h.progress).toEqual([
        { type: 'sent' },
        { type: 'caption', text: 'Ой, подожди!' },
        { type: 'caption', text: 'Ой, подожди! Давай вернём ход?' },
      ]);
      // not a free answer: no caption of its own
      expect(h.captions).toEqual([]);
      await quietFor(h, 900);
      expect(result.value).toBeNull(); // a breath between two of its own sentences
      await quietFor(h, 300);
      expect(result.value).toBe('spoken');
      await vi.advanceTimersByTimeAsync(1300);
      // what was really said reaches the journal (a verbatim app phrase would not)
      expect(h.transcripts).toEqual(['coach: Ой, подожди! Давай вернём ход?']);
    });

    it("the model never says it → 'failed' after 6 s; no «already said» note (a live session does not re-voice a brief)", async () => {
      const h = setup();
      h.start();
      const result = track(h.protocol.speakBrief(BRIEF, { fallbackText: 'Стоп-стоп! Давай вернём ход.' }));
      await flush();
      await quietFor(h, 5900);
      expect(result.value).toBeNull();
      await quietFor(h, 200);
      expect(result.value).toBe('failed');
      expect(h.types()).toEqual(['session.commentary.append']);
    });

    it('a wordless «...» of the model is neither a caption nor a journal line', async () => {
      const h = setup();
      h.start();
      h.protocol.handleServerEvent(coachSays('...'));
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.captions).toEqual([]);
      expect(h.transcripts).toEqual([]);
    });

    it('waits for the child to finish, like any app phrase, and stop() drops a waiting brief', async () => {
      const h = setup();
      h.start();
      h.protocol.handleServerEvent(childSays('а можно'));
      const waiting = h.protocol.speakBrief(BRIEF);
      await vi.advanceTimersByTimeAsync(500);
      expect(h.sent).toEqual([]);
      h.protocol.cancelOutput();
      expect(await waiting).toBe('interrupted');
      expect(h.progress).toEqual([]);
    });
  });

  describe('stopping the coach (there is no response.cancel in the Live API)', () => {
    it('cancelOutput ducks the local playback at once, sends an interrupting instruction and settles the phrase', async () => {
      const h = setup();
      h.start();
      const spoken = h.protocol.speak('Длинное объяснение.');
      await flush();
      await audibleFor(h, 400);
      h.sent.length = 0;

      h.protocol.cancelOutput();
      expect(await spoken).toBe('interrupted');
      expect(h.ducks).toEqual([true]);
      expect(h.sent).toEqual([{ type: 'session.instructions.append', event_id: expect.any(String) as string, delegation_id: null, content: LIVE_STOP_INSTRUCTION_RU }]);

      // the model falls silent → the playback opens again
      await audibleFor(h, 200);
      await quietFor(h, 350);
      expect(h.ducks).toEqual([true, false]);
    });

    it('never leaves the playback muted: 1.5 s later it is open again even without any signal', async () => {
      const h = setup();
      h.start();
      void h.protocol.speak('Фраза.');
      await flush();
      h.protocol.noteOutputLevel(null);
      h.protocol.handleServerEvent(coachSays('Фраза'));
      h.protocol.cancelOutput();
      expect(h.ducks).toEqual([true]);
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.ducks).toEqual([true, false]);
    });

    it('does nothing when the coach is silent', () => {
      const h = setup();
      h.start();
      h.protocol.cancelOutput();
      expect(h.sent).toEqual([]);
      expect(h.ducks).toEqual([]);
    });

    it('a new phrase right after a stop is heard: the duck is lifted when it is sent', async () => {
      const h = setup();
      h.start();
      void h.protocol.speak('старая');
      await flush();
      await audibleFor(h, 300);
      h.protocol.cancelOutput();
      void h.protocol.speak('новая', { interrupt: true });
      await flush();
      expect(h.ducks).toEqual([true, false]);
    });
  });

  describe('client delegation → CoachToolHost → commentary', () => {
    const delegation = (id = 'item_9tA2'): unknown => ({
      type: 'session.delegation.created',
      event_id: 'event_delegation',
      offset_ms: 1000,
      delegation: { id, type: 'delegation', target: 'client' },
    });
    const makeHost = (): CoachToolHost => ({
      getPositionSummary: vi.fn(() => Promise.resolve('Ходят белые. Конь на эф три под боем.')),
      getHint: vi.fn((level) => Promise.resolve(makeEvent({ kind: 'hint', hintLevel: level, text: `Подсказка ступени ${level}.`, bubbleText: `Ступень ${level}` }))),
      explainLastMove: vi.fn(() => Promise.resolve(makeEvent({ kind: 'explainBest', text: 'Сильнее было увести коня.' }))),
      showOnBoard: vi.fn(),
      takeBackMove: vi.fn(() => true),
    });

    it('the child asks for help → get the next hint from the engine-backed host → answer with the same delegation_id', async () => {
      const h = setup();
      h.start();
      const host = makeHost();
      h.host.current = host;
      h.protocol.handleServerEvent(childSays('Гамбитик, '));
      h.protocol.handleServerEvent(childSays('подскажи, пожалуйста!'));
      h.protocol.handleServerEvent(delegation('item_42'));
      await flush();

      expect(host.getHint).toHaveBeenCalledWith(1);
      expect(h.toolEvents.map((e) => e.text)).toEqual(['Подсказка ступени 1.']);
      // FACTS for the model to phrase, not the template to read out
      const [hintEvent] = h.toolEvents;
      if (!hintEvent) throw new Error('no hint event');
      expect(h.sent).toEqual([
        { type: 'session.commentary.append', event_id: expect.any(String) as string, delegation_id: 'item_42', content: buildFactsAnswer(hintFacts(hintEvent, 1)) },
      ]);
      const content = String(h.sent[0]?.content);
      expect(content).toMatch(/^Ответь ребёнку своими словами, опираясь только на эти факты/);
      expect(content).toMatch(/Подсказка ступени 1 из четырёх: Подсказка ступени 1\./);
      expect(content).toMatch(/не называй ни ход, ни клетку/);
      expect(h.thinking).toEqual([true]);
      // the spoken answer ends the thinking pose and is a free answer: caption + journal
      h.protocol.handleServerEvent(coachSays('Посмотри, что под боем.'));
      expect(h.thinking).toEqual([true, false]);
      expect(h.captions).toEqual(['Посмотри, что под боем.']);
    });

    it('«а почему не ферзём?» → compareMove({ piece }) and its facts go back; an older game (no compareMove) → evaluateMove / ask', async () => {
      const h = setup();
      h.start();
      const compareMove = vi.fn(() => Promise.resolve('Лучший ход ферзя — ферзь на аш пять, он немного слабее совета.'));
      const evaluateMove = vi.fn(() => Promise.resolve('не должен вызываться'));
      h.host.current = { ...makeHost(), compareMove, evaluateMove };
      h.protocol.handleServerEvent(childSays('А почему не ферзём?'));
      h.protocol.handleServerEvent(delegation('item_q'));
      await flush();
      expect(compareMove).toHaveBeenCalledWith({ piece: 'q' });
      expect(evaluateMove).not.toHaveBeenCalled();
      expect(h.sent).toEqual([
        {
          type: 'session.commentary.append',
          event_id: expect.any(String) as string,
          delegation_id: 'item_q',
          content: buildFactsAnswer(whyNotFacts('Лучший ход ферзя — ферзь на аш пять, он немного слабее совета.')),
        },
      ]);
      expect(String(h.sent[0]?.content)).toMatch(/сравни его с советом\. Факты: Лучший ход ферзя/);
      expect(String(h.sent[0]?.content)).not.toMatch(/[A-Za-z]/);

      // a named move goes as { move }
      await vi.advanceTimersByTimeAsync(20_000);
      h.sent.length = 0;
      h.protocol.handleServerEvent(childSays('а почему не конём на цэ три?'));
      h.protocol.handleServerEvent(delegation('item_n'));
      await flush();
      expect(compareMove).toHaveBeenLastCalledWith({ move: 'Nc3' });

      // an older game: the move alone through evaluateMove; a piece alone → the model asks where to
      const older = setup();
      older.start();
      const oldEvaluate = vi.fn(() => Promise.resolve('Ход ферзём на аш пять возможен.'));
      older.host.current = { ...makeHost(), evaluateMove: oldEvaluate };
      older.protocol.handleServerEvent(childSays('почему не ферзём на аш пять?'));
      older.protocol.handleServerEvent(delegation('item_o1'));
      await flush();
      expect(oldEvaluate).toHaveBeenCalledWith('Qh5');
      await vi.advanceTimersByTimeAsync(20_000);
      older.sent.length = 0;
      older.protocol.handleServerEvent(childSays('а почему не ферзём?'));
      older.protocol.handleServerEvent(delegation('item_o2'));
      await flush();
      expect(String(older.sent[0]?.content)).toBe(clarifyPieceMoveFacts('q'));

      // «а если не так?» — nothing named: ask, never guess
      const vague = setup();
      vague.start();
      vague.host.current = { ...makeHost(), compareMove };
      compareMove.mockClear();
      vague.protocol.handleServerEvent(childSays('а если не так?'));
      vague.protocol.handleServerEvent(delegation('item_v'));
      await flush();
      expect(compareMove).not.toHaveBeenCalled();
      expect(String(vague.sent[0]?.content)).toBe(CLARIFY_MOVE_FACTS_RU);
    });

    it('«а ещё варианты?» → repeatAdvice({ more: true }) in teacher mode; a game without advice climbs the ladder instead', async () => {
      expect(classifyChildRequest('а ещё варианты?')).toEqual({ intent: 'more' });
      expect(classifyChildRequest('какие ещё ходы есть?')).toEqual({ intent: 'more' });
      expect(classifyChildRequest('а другие ходы?')).toEqual({ intent: 'more' });
      // a named move is still a question about that move
      expect(classifyChildRequest('а ещё ход конём на эф три можно?')).toEqual({ intent: 'evaluate', move: 'Nf3' });

      const h = setup();
      h.start();
      const more = makeEvent({ kind: 'teachTurn', brief: 'Момент: ещё вариант.\nМожно назвать: слон на цэ четыре (синяя стрелка).\nЦель: покажи.', teach: { moment: 'repeat', style: 'short', ply: 3, advice: [] } });
      const repeatAdvice = vi.fn(() => Promise.resolve(more));
      const host = { ...makeHost(), repeatAdvice };
      h.host.current = host;
      h.protocol.handleServerEvent(childSays('А ещё варианты есть?'));
      h.protocol.handleServerEvent(delegation('item_m'));
      await flush();
      expect(repeatAdvice).toHaveBeenCalledWith({ more: true });
      expect(host.getHint).not.toHaveBeenCalled();
      expect(h.toolEvents).toEqual([more]);
      expect(String(h.sent[0]?.content)).toBe(buildFactsAnswer(hintFacts(more, 4)));

      const helper = setup();
      helper.start();
      const helperHost = { ...makeHost(), repeatAdvice: vi.fn(() => Promise.resolve(null)) };
      helper.host.current = helperHost;
      helper.protocol.handleServerEvent(childSays('а ещё варианты?'));
      helper.protocol.handleServerEvent(delegation('item_h'));
      await flush();
      expect(helperHost.getHint).toHaveBeenCalledWith(1);
    });

    it('teacher mode: «что мне ходить?» → getHint answers with the advice (teachTurn) — its moves may be named, no step caveat', async () => {
      const h = setup();
      h.start();
      const advice = makeEvent({
        kind: 'teachTurn',
        text: 'Смотри: пешка на е четыре или пешка на дэ четыре.',
        brief: 'Момент: ученик попросил совет ещё раз.\nФакты: Пешка встаёт в центр.\nМожно назвать: пешка на е четыре (зелёная стрелка); пешка на дэ четыре (синяя стрелка).\nЦель: коротко повтори.\nНельзя: не называй других ходов.',
        teach: { moment: 'repeat', style: 'short', ply: 1, advice: [{ uci: 'e2e4', san: 'e4', source: 'mainLine', arrow: 'green' }, { uci: 'd2d4', san: 'd4', source: 'mainLine', arrow: 'blue' }] },
      });
      const host = { ...makeHost(), getHint: vi.fn(() => Promise.resolve(advice)) };
      h.host.current = host;
      h.protocol.handleServerEvent(childSays('Что мне ходить?'));
      h.protocol.handleServerEvent(delegation('item_t'));
      await flush();
      expect(host.getHint).toHaveBeenCalledTimes(1);
      expect(h.toolEvents).toEqual([advice]);
      const content = String(h.sent[0]?.content);
      expect(content).toBe(buildFactsAnswer(hintFacts(advice, 1)));
      expect(content).toMatch(/Совет учителя/);
      expect(content).toMatch(/Можно назвать: пешка на е четыре/);
      expect(content).not.toMatch(/ступени|не называй ни ход, ни клетку/);
    });

    it('a delegation waits for the rest of the sentence before it picks the tool («а если я пойду… конём на эф три?»)', async () => {
      const h = setup({});
      h.start();
      const host = { ...makeHost(), evaluateMove: vi.fn(() => Promise.resolve('Ход конём на эф три возможен.')), analyzePosition: vi.fn(() => Promise.resolve('Позиция.')) };
      h.host.current = host;
      h.protocol.handleServerEvent(childSays('А если я пойду '));
      // the model delegates while the transcript still lags behind the child's voice
      h.protocol.handleServerEvent(delegation('item_7'));
      await vi.advanceTimersByTimeAsync(300);
      h.protocol.handleServerEvent(childSays('конём на эф три?'));
      await vi.advanceTimersByTimeAsync(300);
      expect(h.sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(600);
      expect(host.analyzePosition).not.toHaveBeenCalled();
      expect(host.evaluateMove).toHaveBeenCalledWith('Nf3');
      expect(h.sent[0]?.delegation_id).toBe('item_7');
    });

    it('the settle wait is bounded: endless talk in the room never holds a delegation longer than ~1.8 s', async () => {
      const h = setup({});
      h.start();
      const host = makeHost();
      h.host.current = host;
      h.protocol.handleServerEvent(childSays('бу-бу '));
      h.protocol.handleServerEvent(delegation('item_8'));
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(300);
        h.protocol.handleServerEvent(childSays('бу-бу '));
      }
      expect(h.sent.map((e) => e.delegation_id)).toEqual(['item_8']);
    });

    it('hint ladder is enforced in code: «покажи ход» never jumps to step 4 — one step per request, a new position starts over', async () => {
      const h = setup();
      h.start();
      const host = makeHost();
      let position = 'Позиция один.';
      host.getPositionSummary = vi.fn(() => Promise.resolve(position));
      h.host.current = host;

      const ask = async (words: string): Promise<void> => {
        h.protocol.handleServerEvent(childSays(words));
        h.protocol.handleServerEvent(delegation());
        await flush();
        await vi.advanceTimersByTimeAsync(1300); // the utterance ends
      };
      await ask('просто покажи ход');
      await ask('скажи мне лучший ход');
      await ask('помоги ещё');
      await ask('какой ход правильный, куда ходить');
      expect(vi.mocked(host.getHint).mock.calls.map(([level]) => level)).toEqual([1, 2, 3, 4]);

      position = 'Позиция два.';
      await ask('покажи ход');
      expect(vi.mocked(host.getHint).mock.calls.at(-1)).toEqual([1]);
    });

    it('«почему это ошибка?» → explainLastMove; nothing to explain → a kind neutral answer', async () => {
      const h = setup();
      h.start();
      const host = makeHost();
      h.host.current = host;
      h.protocol.handleServerEvent(childSays('а почему это ошибка'));
      h.protocol.handleServerEvent(delegation('d1'));
      await flush();
      expect(host.explainLastMove).toHaveBeenCalledTimes(1);
      expect(h.sent.at(-1)).toMatchObject({ delegation_id: 'd1' });
      expect(String(h.sent.at(-1)?.content)).toMatch(/^Ответь ребёнку своими словами.*Разбор последнего хода: Сильнее было увести коня\./);

      host.explainLastMove = vi.fn(() => Promise.resolve(null));
      h.protocol.handleServerEvent(delegation('d2'));
      await flush();
      expect(h.sent.at(-1)).toMatchObject({ delegation_id: 'd2' });
      expect(String(h.sent.at(-1)?.content)).toMatch(/ход нормальный/);
    });

    it('any other question gets the engine facts of the position — the model never judges the board itself', async () => {
      const h = setup();
      h.start();
      h.host.current = makeHost();
      h.protocol.handleServerEvent(childSays('кто сейчас выигрывает'));
      h.protocol.handleServerEvent(delegation('d3'));
      await flush();
      expect(h.sent.at(-1)).toMatchObject({ type: 'session.commentary.append', delegation_id: 'd3' });
      const content = String(h.sent.at(-1)?.content);
      // an older game without analyzePosition: its summary
      expect(content.endsWith('Факты о позиции: Ходят белые. Конь на эф три под боем.')).toBe(true);
      // the model relays prefixes literally (e.g. «Вот что нам говорит движок…»): tell it HOW to retell instead
      expect(content).toMatch(/^Ответь ребёнку своими словами, опираясь только на эти факты/);
      expect(content).toContain('слова «движок» и «ребёнок» не говори');
      expect(content).not.toMatch(/дословно|близко к тексту/);
    });

    it('«что хочет соперник?» / «как у меня дела?» → analyzePosition when the game has it (the richer facts)', async () => {
      const h = setup();
      h.start();
      const host: CoachToolHost = { ...makeHost(), analyzePosition: vi.fn(() => Promise.resolve('Соперник грозит забрать пешку на е четыре.')) };
      h.host.current = host;
      h.protocol.handleServerEvent(childSays('а что хочет сделать соперник?'));
      h.protocol.handleServerEvent(delegation('p1'));
      await flush();
      expect(host.analyzePosition).toHaveBeenCalledTimes(1);
      expect(host.getPositionSummary).not.toHaveBeenCalled();
      expect(String(h.sent.at(-1)?.content)).toMatch(/Факты о позиции: Соперник грозит забрать пешку на е четыре\.$/);
    });

    it('the child names a move → evaluateMove with normalised notation; the facts come back for the model to phrase', async () => {
      const h = setup();
      h.start();
      const evaluateMove = vi.fn((move: string) => Promise.resolve(`Такой ход возможен (${move === 'Nf3' ? 'конь' : move}), фигура там в безопасности.`));
      h.host.current = { ...makeHost(), evaluateMove };
      h.protocol.handleServerEvent(childSays('а если я пойду конём на эф три?'));
      h.protocol.handleServerEvent(delegation('m1'));
      await flush();
      expect(evaluateMove).toHaveBeenCalledWith('Nf3');
      const content = String(h.sent.at(-1)?.content);
      expect(h.sent.at(-1)).toMatchObject({ delegation_id: 'm1' });
      expect(content).toMatch(/^Ответь ребёнку своими словами/);
      expect(content).toContain('Такой ход возможен (конь), фигура там в безопасности.');
      // Latin notation never reaches the model's speech
      expect(content).not.toMatch(/Nf3/);

      await vi.advanceTimersByTimeAsync(1300);
      h.protocol.handleServerEvent(childSays('е два е четыре можно?'));
      h.protocol.handleServerEvent(delegation('m2'));
      await flush();
      expect(evaluateMove).toHaveBeenLastCalledWith('e2e4');
    });

    it('a move that is not clear («а если конём?») → the model is asked to clarify, nothing is guessed', async () => {
      const h = setup();
      h.start();
      const evaluateMove = vi.fn(() => Promise.resolve('…'));
      h.host.current = { ...makeHost(), evaluateMove };
      h.protocol.handleServerEvent(childSays('а если пойти конём?'));
      h.protocol.handleServerEvent(delegation('c1'));
      await flush();
      expect(evaluateMove).not.toHaveBeenCalled();
      expect(h.sent.at(-1)).toMatchObject({ delegation_id: 'c1', content: CLARIFY_MOVE_FACTS_RU });
    });

    it('an older game without evaluateMove: the position facts + «check it yourself», never an invented verdict', async () => {
      const h = setup();
      h.start();
      const host = makeHost();
      h.host.current = host;
      h.protocol.handleServerEvent(childSays('можно слоном на цэ четыре?'));
      h.protocol.handleServerEvent(delegation('o1'));
      await flush();
      expect(host.getPositionSummary).toHaveBeenCalled();
      expect(String(h.sent.at(-1)?.content)).toMatch(/Проверить этот ход отдельно сейчас не получится.*Сам ход не оценивай/);
    });

    it('the question may arrive a moment after the delegation: waits up to 800 ms for the transcript', async () => {
      const h = setup();
      h.start();
      const host = makeHost();
      h.host.current = host;
      h.protocol.handleServerEvent(delegation('d4'));
      await vi.advanceTimersByTimeAsync(300);
      expect(h.sent).toEqual([]);
      h.protocol.handleServerEvent(childSays('подскажи'));
      await flush();
      expect(host.getHint).toHaveBeenCalledWith(1);
    });

    it('no game → a friendly Russian answer; a broken or slow tool → a friendly apology; never silence', async () => {
      const h = setup();
      h.start();
      h.protocol.handleServerEvent(childSays('подскажи'));
      h.protocol.handleServerEvent(delegation('d5'));
      await flush();
      expect(String(h.sent.at(-1)?.content)).toMatch(/партия не идёт/);

      const host = makeHost();
      host.getHint = () => new Promise<CoachEvent>(() => undefined);
      h.host.current = host;
      h.protocol.handleServerEvent(delegation('d6'));
      await vi.advanceTimersByTimeAsync(6000);
      expect(h.sent.at(-1)).toMatchObject({ delegation_id: 'd6' });
      expect(String(h.sent.at(-1)?.content)).toMatch(/попроси спросить ещё раз.*Ничего не выдумывай/);
    });

    it("ignores delegations that OpenAI's own backend answers (target 'responses')", async () => {
      const h = setup();
      h.start();
      h.host.current = makeHost();
      h.protocol.handleServerEvent({ type: 'session.delegation.created', delegation: { id: 'x', type: 'delegation', target: 'responses' } });
      await flush();
      expect(h.sent).toEqual([]);
    });

    it('classifyChildRequest: named moves, position questions and the past tense', () => {
      expect(classifyChildRequest('а если я пойду конём на эф три?')).toEqual({ intent: 'evaluate', move: 'Nf3' });
      expect(classifyChildRequest('конь f3 хороший ход?')).toEqual({ intent: 'evaluate', move: 'Nf3' });
      expect(classifyChildRequest('можно пешкой е четыре')).toEqual({ intent: 'evaluate', move: 'e4' });
      expect(classifyChildRequest('короткая рокировка сейчас можно?')).toEqual({ intent: 'evaluate', move: 'O-O' });
      expect(classifyChildRequest('а если на эф три?')).toEqual({ intent: 'evaluate', move: null });
      // «what should I do with the knight» is a request for help, not a move
      expect(classifyChildRequest('подскажи, что делать с конём на эф три')).toEqual({ intent: 'hint', level: null });
      expect(classifyChildRequest('что хочет соперник?')).toEqual({ intent: 'position' });
      expect(classifyChildRequest('как у меня дела')).toEqual({ intent: 'position' });
      expect(classifyChildRequest('почему мой конь на эф три под ударом?')).toEqual({ intent: 'position' });
      expect(classifyChildRequest('я пошёл конём на эф три, почему это плохо?')).toEqual({ intent: 'explain' });
      expect(classifyChildRequest('почему это хорошо')).toEqual({ intent: 'explain' });
    });

    it('classifyChildRequest: «а почему не ферзём?» and friends are a comparison with the advice (whyNot) — checked before «а если…»', () => {
      // T10 (docs/TEACHER-MODE.md §8.2)
      expect(classifyChildRequest('а почему не ферзём?')).toEqual({ intent: 'whyNot', move: null, piece: 'q' });
      expect(classifyChildRequest('А почему не конём на цэ три?')).toEqual({ intent: 'whyNot', move: 'Nc3', piece: 'n' });
      expect(classifyChildRequest('почему бы не пешкой е четыре')).toEqual({ intent: 'whyNot', move: 'e4', piece: 'p' });
      expect(classifyChildRequest('а почему не рокировка?')).toEqual({ intent: 'whyNot', move: 'O-O', piece: null });
      expect(classifyChildRequest('а не лучше слоном?')).toEqual({ intent: 'whyNot', move: null, piece: 'b' });
      expect(classifyChildRequest('чем плох ход ладьёй на дэ один?')).toEqual({ intent: 'whyNot', move: 'Rd1', piece: 'r' });
      // «а если не так?» — a comparison even without a named move: the model asks which one
      expect(classifyChildRequest('а если не так?')).toEqual({ intent: 'whyNot', move: null, piece: null });
      // …but these stay what they were
      expect(classifyChildRequest('а если я пойду ферзём на аш пять?')).toEqual({ intent: 'evaluate', move: 'Qh5' });
      expect(classifyChildRequest('почему не получилось?')).toEqual({ intent: 'explain' });
      expect(classifyChildRequest('чем плох мой ход?')).toEqual({ intent: 'explain' });
      expect(classifyChildRequest('почему не защищён мой конь?')).toEqual({ intent: 'position' });
      expect(classifyChildRequest('я пошёл ферзём, почему это плохо?')).toEqual({ intent: 'explain' });
      expect(classifyChildRequest('почему нельзя конём?')).toEqual({ intent: 'explain' });
      // «взять пешку» names a capture target, not the piece that moves: nothing is guessed, the model asks
      expect(classifyChildRequest('а почему не взять пешку?')).toEqual({ intent: 'evaluate', move: null });
    });

    it('classifyChildRequest routes by keywords only', () => {
      expect(classifyChildRequest('Подскажи, пожалуйста')).toEqual({ intent: 'hint', level: null });
      expect(classifyChildRequest('я не знаю что делать')).toEqual({ intent: 'hint', level: null });
      expect(classifyChildRequest('покажи ход')).toEqual({ intent: 'hint', level: 4 });
      expect(classifyChildRequest('Куда мне ходить?')).toEqual({ intent: 'hint', level: 4 });
      // docs/TEACHER-MODE.md §7.1: «что мне ходить?» asks for the move too (teacher mode: the advice again)
      expect(classifyChildRequest('Что мне ходить?')).toEqual({ intent: 'hint', level: 4 });
      expect(classifyChildRequest('что теперь сходить')).toEqual({ intent: 'hint', level: 4 });
      expect(classifyChildRequest('почему так')).toEqual({ intent: 'explain' });
      expect(classifyChildRequest('я зевнул?')).toEqual({ intent: 'explain' });
      expect(classifyChildRequest('сколько у меня фигур')).toEqual({ intent: 'position' });
      expect(classifyChildRequest('')).toEqual({ intent: 'position' });
    });
  });

  describe('transcripts (deltas only — utterances are grouped here)', () => {
    it('groups deltas into utterances: each side ends one with its own 1.2 s pause — overlapping speech is not chopped', async () => {
      const h = setup();
      h.start();
      h.protocol.handleServerEvent(childSays('Привет, Гам'));
      expect(h.childSpeaking).toEqual([true]);
      // full duplex: the model starts before the child has finished
      await vi.advanceTimersByTimeAsync(200);
      h.protocol.handleServerEvent(coachSays('Привет'));
      await vi.advanceTimersByTimeAsync(200);
      h.protocol.handleServerEvent(childSays('битик. Как '));
      await vi.advanceTimersByTimeAsync(200);
      h.protocol.handleServerEvent(coachSays('о, я в деле!'));
      await vi.advanceTimersByTimeAsync(200);
      h.protocol.handleServerEvent(childSays('дела?'));
      expect(h.transcripts).toEqual([]);
      expect(h.captions).toEqual(['Привет', 'Привето, я в деле!']);
      await vi.advanceTimersByTimeAsync(1300);
      expect(h.transcripts).toEqual(['child: Привет, Гамбитик. Как дела?', 'coach: Привето, я в деле!']);
      expect(h.childSpeaking).toEqual([true, false]);
    });

    it('an app phrase handed to speak() is not reported back as a coach answer (the game journals it itself)', async () => {
      const h = setup();
      h.start();
      void h.protocol.speak('Ход конём!');
      await flush();
      h.protocol.handleServerEvent(coachSays('Ход '));
      h.protocol.handleServerEvent(coachSays('конём!'));
      await audibleFor(h, 300);
      await quietFor(h, 2000);
      expect(h.transcripts).toEqual([]);
      expect(h.captions).toEqual([]);
    });
  });

  describe('session bookkeeping', () => {
    it('remembers billed seconds from session.usage.updated and session.closed, and reports a server-side close', () => {
      const h = setup();
      h.start();
      expect(h.protocol.usageSeconds).toBeNull();
      h.protocol.handleServerEvent({ type: 'session.usage.updated', usage: { seconds: 42.5 }, context_window: { usage_ratio: 0.1 } });
      expect(h.protocol.usageSeconds).toBe(42.5);
      h.protocol.handleServerEvent({ type: 'session.closed', reason: 'expired', usage: { seconds: 61 } });
      expect(h.protocol.usageSeconds).toBe(61);
      expect(h.closed).toEqual(['expired']);
    });

    it('outputActive follows the audio, or the transcript when the analyser is deaf', async () => {
      const h = setup();
      h.start();
      expect(h.protocol.outputActive).toBe(false);
      h.protocol.noteOutputLevel(true);
      expect(h.protocol.outputActive).toBe(true);
      await quietFor(h, 400);
      expect(h.protocol.outputActive).toBe(false);

      h.protocol.noteOutputLevel(null);
      h.protocol.handleServerEvent(coachSays('слова'));
      expect(h.protocol.outputActive).toBe(true);
      await vi.advanceTimersByTimeAsync(1600);
      expect(h.protocol.outputActive).toBe(false);
    });

    it('tolerates acknowledgements, phone/transport events, info and garbage', () => {
      const h = setup();
      h.start();
      expect(() => {
        for (const event of [
          null,
          'text',
          { nope: true },
          { type: 'session.commentary.appended', client_event_id: 'x' },
          { type: 'session.thinking.appended', client_event_id: 'x' },
          { type: 'session.instructions.appended', client_event_id: 'x' },
          { type: 'session.input_audio.muted', client_event_id: 'x' },
          { type: 'session.updated' },
          { type: 'info', message: 'hello' },
          { type: 'response.event', event: { type: 'response.output_item.done' } },
          { type: 'transport.dtmf.received', digit: '1' },
          { type: 'session.delegation.created' },
          { type: 'session.output_transcript.delta' },
          { type: 'error' },
          { type: 'some.future.event' },
        ]) {
          h.protocol.handleServerEvent(event);
        }
      }).not.toThrow();
      expect(h.sent).toEqual([]);
    });
  });
});
