import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_CAPTIONS,
  HEADPHONES_NOTE,
  MIC_INDICATOR_LABELS,
  conversationButtonLabel,
  conversationIsActive,
  describeVoiceFallback,
  describeVoiceStatus,
  explainFailureCodeRu,
  hintButtonText,
  mascotTapAction,
  micIndicatorState,
  shouldShowHeadphonesNote,
  talkTapAction,
  VOICE_IDLE_RULE_RU,
  VOICE_LIMIT_CAPTION,
  voiceDailyRuleRu,
} from './voiceStatus.ts';

describe('dock texts for the voice state', () => {
  const base = { voiceConnected: true, muted: false, micAvailable: true, micMode: 'open', micMuted: false } as const;

  it('tells a parent which voice is active and what the microphone does', () => {
    expect(describeVoiceStatus({ ...base, voiceKind: 'openai-live' })).toBe('Голос: живой разговор OpenAI (Live) · соединение открыто · микрофон открыт.');
    expect(describeVoiceStatus({ ...base, voiceKind: 'openai-realtime', micMode: 'push', voiceConnected: false })).toBe(
      'Голос: живой голос OpenAI (Realtime) · соединение закрыто, пока Гамбитик молчит или спит · микрофон — по кнопке.',
    );
    expect(describeVoiceStatus({ ...base, voiceKind: 'openai-live', micMuted: true })).toMatch(/микрофон выключен ребёнком/);
    expect(describeVoiceStatus({ ...base, voiceKind: 'openai-live', micAvailable: false })).toMatch(/микрофон недоступен/);
    expect(describeVoiceStatus({ ...base, voiceKind: 'openai-live', muted: true })).toMatch(/звук приглушён кнопкой.*микрофон выключен\./);
    expect(describeVoiceStatus({ ...base, voiceKind: 'browser-tts' })).toBe('Голос: бесплатный голос браузера.');
    expect(describeVoiceStatus({ ...base, voiceKind: 'silent' })).toBe('Голос: выключен, реплики в облачке.');
  });

  it('names the model and the talkativeness for a parent (conversational voices only)', () => {
    expect(describeVoiceStatus({ ...base, voiceKind: 'openai-live', voiceModel: 'gpt-live-1', talkativeness: 'normal' })).toBe(
      'Голос: живой разговор OpenAI (Live), модель gpt-live-1 · соединение открыто · говорит сам в важные моменты · микрофон открыт.',
    );
    expect(describeVoiceStatus({ ...base, voiceKind: 'browser-tts', voiceModel: 'gpt-live-1' })).toBe('Голос: бесплатный голос браузера.');
  });

  it('adds the idle rule and the daily rule for a parent, one sentence each (paid voices only)', () => {
    expect(describeVoiceStatus({ ...base, voiceKind: 'openai-live', dailyLimitMin: 60 })).toBe(
      'Голос: живой разговор OpenAI (Live) · соединение открыто · микрофон открыт. ' +
        'В партии живой голос засыпает через 2 минуты без ходов и слов ребёнка, в фоновой вкладке — через 15 секунд. ' +
        'Не больше 60 минут живого голоса в день, дальше Гамбитик пишет в облачке.',
    );
    expect(describeVoiceStatus({ ...base, voiceKind: 'openai-live', dailyLimitMin: 90, limitReached: true })).toMatch(/Дневной лимит \(90 мин\) на сегодня исчерпан — до полуночи Гамбитик пишет в облачке\.$/);
    expect(describeVoiceStatus({ ...base, voiceKind: 'openai-realtime', dailyLimitMin: 0 })).toContain(VOICE_IDLE_RULE_RU);
    expect(describeVoiceStatus({ ...base, voiceKind: 'browser-tts', dailyLimitMin: 60 })).toBe('Голос: бесплатный голос браузера.');
    expect(voiceDailyRuleRu(0)).toMatch(/^Дневного лимита нет/);
    expect(VOICE_LIMIT_CAPTION).toBe('Лимит на сегодня');
  });

  it('«Поговорить» button: a caption for every state; a tap ends an active conversation, starts an off / failed one', () => {
    expect(CONVERSATION_CAPTIONS).toEqual({
      off: 'Поговорить',
      connecting: 'Подключаюсь…',
      listening: 'Слушаю',
      childSpeaking: 'Слушаю',
      thinking: 'Думаю…',
      coachSpeaking: 'Говорю',
      error: 'Не получилось — нажми ещё раз',
    });
    expect(conversationIsActive('off')).toBe(false);
    expect(conversationIsActive('error')).toBe(false);
    for (const state of ['connecting', 'listening', 'childSpeaking', 'thinking', 'coachSpeaking'] as const) {
      expect(conversationIsActive(state)).toBe(true);
      expect(conversationButtonLabel(state)).toMatch(/закончить разговор/);
    }
    expect(conversationButtonLabel('off')).toBe('Поговорить с Гамбитиком');
    expect(conversationButtonLabel('error')).toMatch(/Нажми ещё раз/);
  });

  it('mic indicator: muted beats asleep beats hearing; every state has a kind Russian label', () => {
    expect(micIndicatorState({ micMuted: true, asleep: true, childSpeaking: true, connected: true })).toBe('muted');
    expect(micIndicatorState({ micMuted: false, asleep: true, childSpeaking: false, connected: true })).toBe('asleep');
    expect(micIndicatorState({ micMuted: false, asleep: false, childSpeaking: true, connected: true })).toBe('hearing');
    expect(micIndicatorState({ micMuted: false, asleep: false, childSpeaking: false, connected: true })).toBe('open');
    // awake but no session yet: never promise «я тебя слышу» while nobody listens
    expect(micIndicatorState({ micMuted: false, asleep: false, childSpeaking: false, connected: false })).toBe('asleep');
    for (const label of Object.values(MIC_INDICATOR_LABELS)) expect(label).toMatch(/[а-яё]/i);
  });

  it('headphones note: only for an open microphone of a conversational voice without confirmed headphones', () => {
    const on = { voiceKind: 'openai-live', micAvailable: true, muted: false, micMode: 'open', headphonesConfirmed: false } as const;
    expect(shouldShowHeadphonesNote(on)).toBe(true);
    expect(shouldShowHeadphonesNote({ ...on, voiceKind: 'openai-realtime' })).toBe(true);
    expect(shouldShowHeadphonesNote({ ...on, headphonesConfirmed: true })).toBe(false);
    expect(shouldShowHeadphonesNote({ ...on, micMode: 'push' })).toBe(false);
    expect(shouldShowHeadphonesNote({ ...on, voiceKind: 'browser-tts' })).toBe(false);
    expect(shouldShowHeadphonesNote({ ...on, voiceKind: 'silent' })).toBe(false); // automation runs never see it
    expect(shouldShowHeadphonesNote({ ...on, muted: true })).toBe(false);
    expect(shouldShowHeadphonesNote({ ...on, micAvailable: false })).toBe(false);
    expect(HEADPHONES_NOTE).toEqual({
      text: 'Надень наушники — так Гамбитик не будет слышать сам себя',
      confirm: 'Я в наушниках',
      usePush: 'Буду нажимать кнопку',
    });
  });
});

describe('microphone refused by the browser (a dismissed prompt, a blocked site, an embedded preview window)', () => {
  it('says «Микрофон закрыт — нажми, чтобы разрешить» whatever he does meanwhile — it is not an error of the conversation', async () => {
    const { conversationCaption, conversationButtonLabel, MIC_BLOCKED_CAPTION, MIC_BLOCKED_SPOKEN } = await import('./voiceStatus.ts');
    expect(MIC_BLOCKED_CAPTION).toBe('Микрофон закрыт — нажми, чтобы разрешить');
    for (const state of ['listening', 'childSpeaking', 'thinking', 'coachSpeaking', 'error'] as const) {
      expect(conversationCaption(state, { micBlocked: true }), state).toBe(MIC_BLOCKED_CAPTION);
      expect(conversationButtonLabel(state, { micBlocked: true }), state).toMatch(/нажми, чтобы разрешить.*не слышу/);
    }
    // no session (yet): the ordinary captions
    expect(conversationCaption('off', { micBlocked: true })).toBe('Поговорить');
    expect(conversationCaption('connecting', { micBlocked: true })).toBe('Подключаюсь…');
    expect(conversationCaption('error')).toBe('Не получилось — нажми ещё раз');
    expect(conversationCaption('listening')).toBe('Слушаю');
    expect(MIC_BLOCKED_SPOKEN).not.toMatch(/[A-Za-z]/);
  });
});

describe('what a tap does (a tap while he speaks cuts him off)', () => {
  it('Гамбитик: unlock first, then wake, then — while he speaks — interrupt; otherwise a catchphrase', () => {
    expect(mascotTapAction({ needsUserGesture: true, asleep: true, speaking: true })).toBe('unlock');
    expect(mascotTapAction({ needsUserGesture: false, asleep: true, speaking: false })).toBe('wake');
    expect(mascotTapAction({ needsUserGesture: false, asleep: false, speaking: true })).toBe('interrupt');
    expect(mascotTapAction({ needsUserGesture: false, asleep: false, speaking: false })).toBe('poke');
  });

  it('«Поговорить»: a refused microphone is asked for again; on loudspeakers a tap while he speaks cuts in; with headphones it ends the talk as before', () => {
    const speakers = { voiceConnected: true, micAvailable: true, conversationState: 'coachSpeaking', micMode: 'open', headphonesConfirmed: false } as const;
    expect(talkTapAction(speakers)).toBe('interrupt');
    expect(talkTapAction({ ...speakers, headphonesConfirmed: true })).toBe('toggle');
    expect(talkTapAction({ ...speakers, micMode: 'push' })).toBe('toggle');
    for (const conversationState of ['off', 'listening', 'childSpeaking', 'thinking', 'error', 'connecting'] as const) {
      expect(talkTapAction({ ...speakers, conversationState }), conversationState).toBe('toggle');
    }
    expect(talkTapAction({ ...speakers, micAvailable: false })).toBe('retryMic');
    // not connected: nothing to ask the microphone for — start / end as usual
    expect(talkTapAction({ ...speakers, voiceConnected: false, micAvailable: false, conversationState: 'off' })).toBe('toggle');
    expect(conversationButtonLabel('coachSpeaking', { cutsIn: true })).toMatch(/перебить/);
  });
});

describe('the fallback model, told to a parent (minutes on gpt-realtime must not go unnoticed)', () => {
  it('explains a failure code in plain Russian and keeps the code for the black box', () => {
    expect(explainFailureCodeRu('502:voice-upstream:net:ENOTFOUND')).toBe('нет интернета или не нашёлся адрес OpenAI (502:voice-upstream:net:ENOTFOUND)');
    expect(explainFailureCodeRu('502:voice-upstream:net:UND_ERR_SOCKET')).toMatch(/^соединение с OpenAI оборвалось/);
    expect(explainFailureCodeRu('502:voice-upstream:timeout')).toMatch(/^OpenAI не ответил вовремя/);
    expect(explainFailureCodeRu('the SDP exchange timed out')).toMatch(/^OpenAI не ответил вовремя/);
    expect(explainFailureCodeRu('502:voice-upstream:http:503')).toMatch(/^сбой на стороне OpenAI/);
    expect(explainFailureCodeRu('502:voice-upstream:http:401')).toMatch(/^OpenAI не принял ключ/);
    expect(explainFailureCodeRu('502:voice-upstream:http:429')).toMatch(/^OpenAI просит подождать/);
    expect(explainFailureCodeRu('silent:3')).toMatch(/^модель несколько раз промолчала/);
    expect(explainFailureCodeRu('0:network')).toMatch(/^страница не достучалась до своего сервера/);
    expect(explainFailureCodeRu(null)).toBe('причина неизвестна');
  });

  it('names who speaks instead, why, and when the preferred voice is tried again; first in the dock status line', () => {
    const fallback = { from: 'openai-live', to: 'openai-realtime', reason: 'cannot connect', code: '502:voice-upstream:net:ENOTFOUND', retryAt: 1_000_000 + 90_000 } as const;
    const line = describeVoiceFallback(fallback, 1_000_000);
    expect(line).toBe(
      'Сейчас говорит запасной голос — живой голос OpenAI (Realtime): живой разговор OpenAI (Live) не подключился, нет интернета или не нашёлся адрес OpenAI (502:voice-upstream:net:ENOTFOUND). Попробую его снова в начале следующего разговора, не раньше чем через 2 мин.',
    );
    expect(describeVoiceFallback({ ...fallback, retryAt: 900_000 }, 1_000_000)).toMatch(/Попробую его снова в начале следующего разговора\.$/);
    expect(describeVoiceFallback({ ...fallback, reason: 'no API key', code: '503:no-api-key', retryAt: null }, 1_000_000)).toMatch(/больше не включится — проверьте ключ OpenAI/);
    expect(describeVoiceFallback(null)).toBeNull();

    const base = { voiceConnected: true, muted: false, micAvailable: true, micMode: 'open', micMuted: false } as const;
    const status = describeVoiceStatus({ ...base, voiceKind: 'openai-realtime', fallback, now: 1_000_000 });
    expect(status.startsWith('Сейчас говорит запасной голос')).toBe(true);
    expect(status).toContain('Голос: живой голос OpenAI (Realtime)');
    expect(describeVoiceStatus({ ...base, voiceKind: 'openai-live', fallback: null })).toBe('Голос: живой разговор OpenAI (Live) · соединение открыто · микрофон открыт.');
  });
});

describe('hintButtonText (teacher mode, docs/TEACHER-MODE.md §1.4)', () => {
  it('«Совет» for the teacher, «Подсказка» otherwise — Russian only', () => {
    expect(hintButtonText('teacher').caption).toBe('Совет');
    expect(hintButtonText('helper').caption).toBe('Подсказка');
    expect(hintButtonText('exam').caption).toBe('Подсказка');
    expect(hintButtonText(null).caption).toBe('Подсказка');
    for (const style of ['teacher', 'helper', 'exam', null] as const) {
      const { caption, title } = hintButtonText(style);
      expect(`${caption} ${title}`).not.toMatch(/[A-Za-z]/);
    }
  });
});

describe('the site\'s microphone is blocked: the exact steps for this browser', () => {
  const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
  const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';
  const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.0; rv:140.0) Gecko/20100101 Firefox/140.0';
  const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0';

  it('knows the browser: Chrome-like, Safari on a Mac, an iPad (a «Mac» with a touch screen) / iPhone, Firefox', async () => {
    const { micHelpBrowser } = await import('./voiceStatus.ts');
    expect(micHelpBrowser({ userAgent: MAC_CHROME, maxTouchPoints: 0 })).toBe('chrome');
    expect(micHelpBrowser({ userAgent: EDGE })).toBe('chrome');
    expect(micHelpBrowser({ userAgent: MAC_SAFARI, maxTouchPoints: 0 })).toBe('safari');
    expect(micHelpBrowser({ userAgent: MAC_SAFARI, maxTouchPoints: 5 })).toBe('ios');
    expect(micHelpBrowser({ userAgent: IPHONE })).toBe('ios');
    expect(micHelpBrowser({ userAgent: FIREFOX })).toBe('firefox');
    expect(micHelpBrowser({ userAgent: 'Node.js/26' })).toBe('other');
    expect(micHelpBrowser(undefined)).toBe('other');
  });

  it('Chrome: «Нажми на значок слева от адреса → Микрофон → Разрешить, потом обнови страницу»; said aloud without Latin letters', async () => {
    const { micHelpSpokenRu, micHelpStepsRu } = await import('./voiceStatus.ts');
    expect(micHelpStepsRu('chrome')).toBe('Нажми на значок слева от адреса → Микрофон → Разрешить, потом обнови страницу');
    expect(micHelpStepsRu('safari')).toMatch(/^Меню Safari → Настройки → Веб-сайты → Микрофон/);
    expect(micHelpStepsRu('ios')).toMatch(/«аА».*Настройки веб-сайта → Микрофон → Разрешить/);
    for (const browser of ['chrome', 'safari', 'ios', 'firefox', 'other'] as const) {
      expect(micHelpStepsRu(browser), browser).toMatch(/обнови страницу$/);
      const spoken = micHelpSpokenRu(browser);
      expect(spoken, browser).toMatch(/^Я тебя не слышу: браузер запретил микрофон\. Попроси взрослого .*страницу\.$/);
      expect(spoken, browser).not.toMatch(/[A-Za-z→]/);
    }
  });
});
