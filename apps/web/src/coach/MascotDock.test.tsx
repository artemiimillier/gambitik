import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import type { ConversationState } from '@gambit/shared';
import { createCoachController } from './coachController.ts';
import { INITIAL_COACH_STATE } from './coachStore.ts';
import type { CoachState, CoachStore } from './coachStore.ts';
import { MascotDock, RECORDING_MARK, UNVOICED_MARK } from './MascotDock.tsx';
import { createSilentVoice } from './silentVoice.ts';
import type { SoundMute, SoundState } from './soundMute.ts';
import { createMemoryStorage, makeHealth } from './testUtils.ts';
import { micHelpStepsRu } from './voiceStatus.ts';

function render(patch: Partial<CoachState>): string {
  // a server render reads the store's INITIAL state (zustand's server snapshot): the patch is the initial state here
  const store: CoachStore = create<CoachState>()(() => ({ ...INITIAL_COACH_STATE, ...patch }));
  // the dock only reads the store while rendering on the server; the controller is never started here
  const coach = createCoachController({ store, getHealth: () => Promise.resolve(makeHealth(false)), createVoice: () => createSilentVoice(), getStorage: () => createMemoryStorage() });
  return renderToStaticMarkup(<MascotDock coach={coach} store={store} />);
}

function storeFor(patch: Partial<CoachState>): CoachStore {
  return create<CoachState>()(() => ({ ...INITIAL_COACH_STATE, ...patch }));
}

function coachFor(patch: Partial<CoachState>) {
  return createCoachController({ store: storeFor(patch), getHealth: () => Promise.resolve(makeHealth(false)), createVoice: () => createSilentVoice(), getStorage: () => createMemoryStorage() });
}

/** a sound switch frozen in one state (the dock only reads it while rendering on the server) */
function soundSwitch(state: SoundState): SoundMute {
  return {
    state: () => state,
    subscribe: () => () => undefined,
    muteUntilMidnight: () => undefined,
    unmute: () => false,
    toggle: () => undefined,
    setAlwaysMuted: () => undefined,
    reconcile: () => undefined,
    dispose: () => undefined,
  };
}

/** the paid conversational voice — only with the server's runtime AI (docs/TEACHING.md §4.4) */
const LIVE: Partial<CoachState> = { voiceKind: 'openai-live', micAvailable: true, ready: true, voiceModel: 'gpt-live-1', headphonesConfirmed: true, runtimeAi: true };

describe('<MascotDock/> — the «Поговорить» button', () => {
  it('a conversational voice gets one big «Поговорить» button (with its caption); free voices and automation get none', () => {
    const html = render(LIVE);
    expect(html).toContain('class="gmb-talk"');
    expect(html).toContain('data-state="off"');
    expect(html).toContain('aria-label="Поговорить с Гамбитиком"');
    expect(html).toMatch(/<span class="gmb-talk-caption"[^>]*>Поговорить<\/span>/);

    for (const voiceKind of ['browser-tts', 'silent'] as const) expect(render({ ...LIVE, voiceKind })).not.toContain('gmb-talk');
    // muted: no conversation either (the speaker button brings the voice back)
    expect(render({ ...LIVE, muted: true })).not.toContain('gmb-talk');
  });

  it('no runtime AI (docs/TEACHING.md §4.4): no «Поговорить», no microphone button, no microphone / headphones notes — whatever voice is painted', () => {
    const off = { ...LIVE, runtimeAi: false };
    for (const patch of [
      {},
      { conversationState: 'listening' as const, micMode: 'push' as const },
      { headphonesConfirmed: false },
      { voiceConnected: true, micAvailable: false, micHelp: true, conversationState: 'listening' as const },
      { hearingCheck: true },
    ]) {
      const html = render({ ...off, ...patch });
      expect(html).not.toContain('gmb-talk');
      expect(html).not.toContain('Нажми и держи');
      expect(html).not.toContain('Я в наушниках');
      expect(html).not.toContain('data-kind="mic-help"');
      expect(html).not.toContain('gmb-hear');
    }
    // the same states with runtime AI do show them
    expect(render({ ...LIVE, headphonesConfirmed: false })).toContain('Я в наушниках');
    expect(render({ ...LIVE, conversationState: 'listening', micMode: 'push' })).toContain('Нажми и держи');
  });

  it('shows every conversation state: spinner, dots, captions; a tap on an active conversation ends it', () => {
    const cases: [ConversationState, string, RegExp | null][] = [
      ['connecting', 'Подключаюсь…', /gmb-talk-spinner/],
      ['listening', 'Слушаю', null],
      ['childSpeaking', 'Слушаю', null],
      ['thinking', 'Думаю…', /gmb-talk-dots/],
      ['coachSpeaking', 'Говорю', null],
      ['error', 'Не получилось — нажми ещё раз', null],
    ];
    for (const [conversationState, caption, extra] of cases) {
      const html = render({ ...LIVE, conversationState });
      expect(html).toContain(`data-state="${conversationState}"`);
      expect(html).toContain(`>${caption}</span>`);
      if (extra) expect(html).toMatch(extra);
      const active = conversationState !== 'error';
      expect(html).toContain(`data-active="${active ? 'true' : 'false'}"`);
      if (active) expect(html).toMatch(/aria-label="[^"]*Нажми, чтобы закончить разговор"/);
    }
  });

  it('«Подсказка» stays (secondary) in a game; push mode adds a hold-to-talk button only while the conversation runs', () => {
    const game = render({ ...LIVE, hasToolHost: true, hintAvailable: true });
    expect(game).toContain('aria-label="Подсказка"');
    expect(game).toContain('class="gmb-talk"');
    expect(game).not.toContain('Нажми и держи');
    expect(render({ ...LIVE, micMode: 'push', conversationState: 'listening' })).toContain('Нажми и держи, чтобы говорить с Гамбитиком');
    expect(render({ ...LIVE, micMode: 'push', conversationState: 'off' })).not.toContain('Нажми и держи');
  });

  it('teacher mode: the hint button reads «Совет» (it repeats the advice); helper «Подсказка»; an exam has none (docs/TEACHER-MODE.md §1.4)', () => {
    const teacher = render({ hasToolHost: true, hintAvailable: true, coachStyle: 'teacher' });
    expect(teacher).toMatch(/<button[^>]*class="gmb-round gmb-round-hint"[^>]*aria-label="Совет"/);
    expect(teacher).toMatch(/<span class="gmb-round-caption">Совет<\/span>/);
    expect(teacher).not.toContain('Подсказка');

    for (const coachStyle of ['helper', null] as const) {
      const html = render({ hasToolHost: true, hintAvailable: true, coachStyle });
      expect(html).toMatch(/<span class="gmb-round-caption">Подсказка<\/span>/);
      expect(html).not.toContain('>Совет<');
    }
    expect(render({ hasToolHost: true, hintAvailable: true, coachStyle: 'exam' })).not.toContain('gmb-round-hint');
    // outside a game there is no hint button at all
    expect(render({ hasToolHost: false, coachStyle: 'teacher' })).not.toContain('gmb-round-hint');
  });

  it('tells a parent which voice and model is active (title / description), with the idle and the daily rule', () => {
    const html = render({ ...LIVE, voiceConnected: true });
    expect(html).toContain('Голос: живой разговор OpenAI (Live), модель gpt-live-1');
    expect(html).toContain('засыпает через 2 минуты без ходов и слов ребёнка');
    expect(html).toContain('Не больше 60 минут живого голоса в день');
  });

  it('today\'s minutes used up: «Лимит на сегодня», disabled, with an explaining label', () => {
    const html = render({ ...LIVE, voiceLimitReached: true, hasToolHost: true });
    expect(html).toMatch(/<button[^>]*class="gmb-talk"[^>]*data-limit="true"[^>]*disabled=""/);
    expect(html).toMatch(/<span class="gmb-talk-caption"[^>]*>Лимит на сегодня<\/span>/);
    expect(html).toMatch(/aria-label="Лимит на сегодня: живой голос отдыхает до завтра, Гамбитик пишет в облачке\. Лимит выбирают родители в настройках"/);
    expect(html).toContain('на сегодня исчерпан');
    // «Подсказка» still works
    expect(html).toContain('aria-label="Подсказка"');
    expect(render(LIVE)).not.toContain('disabled=""');
  });
});

describe('<MascotDock/> — hearing self-check and the closed microphone', () => {
  it('the model spoke but nothing was heard: one big «Не слышно? Нажми сюда» button above the bubble', () => {
    const html = render({ ...LIVE, hearingCheck: true, conversationState: 'listening' });
    expect(html).toMatch(/<button type="button" class="gmb-hear"[^>]*aria-label="Не слышно Гамбитика\? Нажми сюда — я снова включу звук"/);
    expect(html).toContain('>Не слышно? Нажми сюда</span>');
    // not without the flag, not when muted (the speaker button is the way back), not on free voices
    expect(render({ ...LIVE, conversationState: 'listening' })).not.toContain('gmb-hear');
    expect(render({ ...LIVE, hearingCheck: true, muted: true })).not.toContain('gmb-hear');
    expect(render({ ...LIVE, hearingCheck: true, voiceKind: 'browser-tts' })).not.toContain('gmb-hear');
    // the gesture prompt already asks for a tap: no second request at the same time
    expect(render({ ...LIVE, hearingCheck: true, needsUserGesture: true })).not.toContain('gmb-hear');
  });

  it('a refused microphone (Chrome: prompt dismissed / site blocked) on an open session: «Микрофон закрыт — нажми, чтобы разрешить» while he goes on speaking', () => {
    for (const conversationState of ['listening', 'coachSpeaking'] as const) {
      const html = render({ ...LIVE, voiceConnected: true, micAvailable: false, conversationState });
      expect(html).toMatch(/<span class="gmb-talk-caption"[^>]*>Микрофон закрыт — нажми, чтобы разрешить<\/span>/);
      expect(html).toContain('data-mic-blocked="true"');
      expect(html).toContain(`data-state="${conversationState}"`);
      expect(html).toMatch(/aria-label="Микрофон закрыт — нажми, чтобы разрешить\. Пока я говорю, но тебя не слышу"/);
    }
    // a failed connect (no session) is the ordinary error
    const failed = render({ ...LIVE, voiceConnected: false, micAvailable: true, conversationState: 'error' });
    expect(failed).toContain('>Не получилось — нажми ещё раз</span>');
    expect(failed).toContain('data-mic-blocked="false"');
  });

  it('a site whose microphone the browser blocks (micHelp): the exact steps stay above the bubble with «Понятно» until it works', () => {
    const blocked = { ...LIVE, voiceConnected: true, micAvailable: false, conversationState: 'listening' as const };
    const html = render({ ...blocked, micHelp: true });
    expect(html).toMatch(/<div class="gmb-note" role="group" aria-label="Браузер запретил микрофон" data-kind="mic-help">/);
    // (the server render has no browser: the general steps; the browser's own ones are in voiceStatus.test.ts)
    expect(html).toContain(`<strong>Браузер запретил микрофон.</strong> ${micHelpStepsRu('other')}`);
    expect(html).toContain('>Понятно</button>');
    // gone without the flag, once the microphone works, when muted, on free voices
    expect(render(blocked)).not.toContain('data-kind="mic-help"');
    expect(render({ ...blocked, micHelp: true, micAvailable: true })).not.toContain('data-kind="mic-help"');
    expect(render({ ...blocked, micHelp: true, muted: true })).not.toContain('data-kind="mic-help"');
    expect(render({ ...blocked, micHelp: true, voiceKind: 'browser-tts' })).not.toContain('data-kind="mic-help"');
  });

  it('on loudspeakers the button says a tap while he speaks cuts him off; with headphones it ends the conversation as before', () => {
    const speakers = render({ ...LIVE, headphonesConfirmed: false, voiceConnected: true, conversationState: 'coachSpeaking' });
    expect(speakers).toContain('aria-label="Гамбитик говорит. Нажми, чтобы перебить его и сказать самому"');
    const headphones = render({ ...LIVE, headphonesConfirmed: true, voiceConnected: true, conversationState: 'coachSpeaking' });
    expect(headphones).toContain('aria-label="Говорю. Нажми, чтобы закончить разговор"');
  });

  it('the fallback model is named first in the parent\'s status line (title), with the reason', () => {
    const html = render({
      ...LIVE,
      voiceKind: 'openai-realtime',
      voiceFallback: { from: 'openai-live', to: 'openai-realtime', reason: 'cannot connect', code: '502:voice-upstream:net:UND_ERR_SOCKET', retryAt: null },
    });
    expect(html).toMatch(/title="Сейчас говорит запасной голос — живой голос OpenAI \(Realtime\): живой разговор OpenAI \(Live\) не подключился, соединение с OpenAI оборвалось/);
  });
});

describe('<MascotDock/> — the lesson model: «Спроси» for every voice, «не озвучено», the sound switch (docs/TEACHING.md §4.4–§4.5)', () => {
  const GAME: Partial<CoachState> = { ready: true, hasToolHost: true, hintAvailable: true, coachStyle: 'teacher' };

  it('«Спроси» in every game with every voice — the silent one and a muted coach too; none in an exam, outside a game, or while the quiz card is open', () => {
    for (const voiceKind of ['clips', 'browser-tts', 'silent', 'openai-live'] as const) {
      for (const muted of [false, true]) {
        const html = render({ ...GAME, voiceKind, muted, runtimeAi: voiceKind === 'openai-live' });
        expect(html, `${voiceKind} muted=${String(muted)}`).toMatch(/<button[^>]*class="gmb-round gmb-round-ask"/);
      }
    }
    expect(render({ ...GAME, voiceKind: 'silent', coachStyle: 'exam' })).not.toContain('gmb-round-ask');
    expect(render({ ...GAME, voiceKind: 'silent', hasToolHost: false })).not.toContain('gmb-round-ask');
    expect(render({ ...GAME, voiceKind: 'silent', askSuppressed: true })).not.toContain('gmb-round-ask');
    expect(renderToStaticMarkup(<MascotDock coach={coachFor({ ...GAME, voiceKind: 'silent', askSuppressed: true })} store={storeFor({ ...GAME, voiceKind: 'silent', askSuppressed: true })} initialAskOpen />)).not.toContain(
      'gmb-ask-chip',
    );
  });

  it('a lesson phrase with no recording: the bubble carries a small «не озвучено»; not on other bubbles, not on the gesture prompt', () => {
    const text = 'Центр ещё свободен — займём его пешкой.';
    const marked = render({ ...GAME, voiceKind: 'clips', bubbleText: text, unvoiced: true });
    expect(marked).toContain('data-unvoiced="true"');
    expect(marked).toContain(`<span class="gmb-bubble-unvoiced">${UNVOICED_MARK}</span>`);
    expect(UNVOICED_MARK).toBe('не озвучено');
    expect(render({ ...GAME, voiceKind: 'clips', bubbleText: text })).not.toContain('gmb-bubble-unvoiced');
    expect(render({ ...GAME, voiceKind: 'clips', bubbleText: '', unvoiced: true })).not.toContain('gmb-bubble-unvoiced');
    expect(render({ ...GAME, voiceKind: 'clips', bubbleText: text, unvoiced: true, needsUserGesture: true })).not.toContain('gmb-bubble-unvoiced');
  });

  it('«Дозапись голоса»: while the server records the phrase the same mark says «записываю голос…»; otherwise «не озвучено»', () => {
    const text = 'Центр ещё свободен — займём его пешкой.';
    const recording = render({ ...GAME, voiceKind: 'clips', bubbleText: text, unvoiced: true, unvoicedMark: 'recording' });
    expect(RECORDING_MARK).toBe('записываю голос…');
    expect(recording).toContain('data-unvoiced="true"');
    expect(recording).toContain(`<span class="gmb-bubble-unvoiced" data-mark="recording">${RECORDING_MARK}</span>`);
    expect(recording).not.toContain(UNVOICED_MARK);
    const unrecorded = render({ ...GAME, voiceKind: 'clips', bubbleText: text, unvoiced: true, unvoicedMark: 'unrecorded' });
    expect(unrecorded).toContain(`<span class="gmb-bubble-unvoiced">${UNVOICED_MARK}</span>`);
    expect(unrecorded).not.toContain(RECORDING_MARK);
    // no mark at all once the bubble is not marked, and never on the gesture prompt
    expect(render({ ...GAME, voiceKind: 'clips', bubbleText: text, unvoicedMark: 'recording' })).not.toContain('gmb-bubble-unvoiced');
    expect(render({ ...GAME, voiceKind: 'clips', bubbleText: text, unvoiced: true, unvoicedMark: 'recording', needsUserGesture: true })).not.toContain(RECORDING_MARK);
  });

  it('a pose without words (coach.showPose: a quiet turn\'s nod, the joy over a find): the pose, no bubble, no talking mouth', () => {
    for (const pose of ['talk', 'cheer'] as const) {
      const html = render({ ...GAME, voiceKind: 'clips', pose, bubbleText: '' });
      expect(html).toContain(`data-pose="${pose}"`);
      expect(html).toContain('data-talking="false"');
      expect(html).toMatch(/class="gmb-bubble" data-visible="false"/);
      expect(html).not.toContain('gmb-bubble-unvoiced');
    }
  });

  it('the speaker button drives the sound switch; under the parent\'s «Всегда без звука» it is locked', () => {
    const locked = soundSwitch({ voiceMuted: true, sfxMuted: true, muted: true, always: true, until: null });
    const html = renderToStaticMarkup(<MascotDock coach={coachFor({ muted: true })} store={storeFor({ muted: true })} soundMute={locked} />);
    expect(html).toMatch(/<button[^>]*class="gmb-round gmb-round-mute"[^>]*disabled=""/);
    expect(html).toContain('aria-label="Включить голос Гамбитика"');
    expect(html).toContain('title="Звук выключен в настройках для взрослых"');
    const free = soundSwitch({ voiceMuted: false, sfxMuted: false, muted: false, always: false, until: null });
    const open = renderToStaticMarkup(<MascotDock coach={coachFor({})} store={storeFor({})} soundMute={free} />);
    expect(open).toContain('aria-label="Выключить голос Гамбитика"');
    expect(open).not.toMatch(/gmb-round-mute"[^>]*disabled/);
  });
});
