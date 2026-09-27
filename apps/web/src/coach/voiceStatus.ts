/**
 * Small Russian texts of the dock that depend on the voice state: the unobtrusive status line for a parent
 * (dock `title` + screen-reader description), the «Поговорить» button and the microphone indicator — and what a tap on
 * Гамбитик / on «Поговорить» does in which state (a tap while he speaks cuts him off). Pure functions.
 */
import type { CoachStyle, ConversationState, MicMode, Talkativeness } from '@gambit/shared';
import type { VoiceFallbackInfo } from './coachStore.ts';
import type { ClipLibraryStatus, VoiceKind } from './voiceTypes.ts';
import { isOpenAiVoiceKind } from './voiceTypes.ts';

export interface VoiceStatusInput {
  voiceKind: VoiceKind;
  voiceConnected: boolean;
  muted: boolean;
  micAvailable: boolean;
  micMode: MicMode;
  micMuted: boolean;
  /** model id of the conversational voice (parent-facing; may be Latin — a child never hears this) */
  voiceModel?: string | null;
  talkativeness?: Talkativeness;
  /** the parent's daily budget of paid voice, minutes (0 = none); given → the idle and daily rules are added */
  dailyLimitMin?: number;
  /** today's minutes are used up */
  limitReached?: boolean;
  /** the preferred paid voice gave up and another one speaks: said first, with the reason */
  fallback?: VoiceFallbackInfo | null;
  /** clock for «через N мин» (tests) */
  now?: number;
  /** «Записи»: the library the clips layer loaded (phrases, version) */
  clipLibrary?: ClipLibraryStatus | null;
}

/**
 * The dock's round hint button (docs/TEACHER-MODE.md §1.4): in teacher mode it is «Совет» — it repeats the teacher's
 * advice (arrows again) — otherwise «Подсказка» (the hint ladder). `caption` is the visible word and the accessible name.
 */
export function hintButtonText(coachStyle: CoachStyle | null): { caption: string; title: string } {
  return coachStyle === 'teacher'
    ? { caption: 'Совет', title: 'Совет: покажу хорошие ходы ещё раз' }
    : { caption: 'Подсказка', title: 'Подсказка' };
}

/** The idle rule of the paid voice, one sentence for a parent (dock status line + Settings). */
export const VOICE_IDLE_RULE_RU = 'В партии живой голос засыпает через 2 минуты без ходов и слов ребёнка, в фоновой вкладке — через 15 секунд.';

/** The daily rule of the paid voice, one sentence for a parent. */
export function voiceDailyRuleRu(limitMin: number, limitReached = false): string {
  if (!Number.isFinite(limitMin) || limitMin <= 0) return 'Дневного лимита нет: живой голос работает, сколько нужно.';
  if (limitReached) return `Дневной лимит (${limitMin} мин) на сегодня исчерпан — до полуночи Гамбитик пишет в облачке.`;
  return `Не больше ${limitMin} минут живого голоса в день, дальше Гамбитик пишет в облачке.`;
}

const TALKATIVENESS_NAMES: Record<Talkativeness, string> = {
  quiet: 'говорит сам только о важном',
  normal: 'говорит сам в важные моменты',
  chatty: 'говорит сам часто',
};

const VOICE_NAMES: Record<VoiceKind, string> = {
  'openai-live': 'живой разговор OpenAI (Live)',
  'openai-realtime': 'живой голос OpenAI (Realtime)',
  'browser-tts': 'бесплатный голос браузера',
  silent: 'выключен, реплики в облачке',
  clips: 'записанный голос (бесплатно)',
};

/** «1 240 фраз, версия 3» — the recorded library, for a parent (dock status line, Settings). */
export function clipLibraryLineRu(library: Pick<ClipLibraryStatus, 'phrases' | 'libraryVersion'>): string {
  const n = Math.max(0, Math.floor(library.phrases));
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'фраза' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'фразы' : 'фраз';
  return `${n.toLocaleString('ru-RU').replace(/[\u00a0\u202f]/g, ' ')} ${word}, версия ${library.libraryVersion}`;
}

/**
 * The short code of a failure ('502:voice-upstream:net:ENOTFOUND', 'timeout', 'silent:3' …) in plain Russian for a parent,
 * with the code itself in brackets (for whoever reads the black box later). Latin in the code is fine: a child never
 * hears this line.
 */
export function explainFailureCodeRu(code: string | null): string {
  if (code === null || code === '') return 'причина неизвестна';
  const net = /net:([A-Z_]+)/.exec(code)?.[1] ?? null;
  const http = /http:(\d{3})/.exec(code)?.[1] ?? /^(\d{3}):/.exec(code)?.[1] ?? null;
  let text: string;
  if (net === 'ENOTFOUND' || net === 'EAI_AGAIN') text = 'нет интернета или не нашёлся адрес OpenAI';
  else if (net === 'UND_ERR_SOCKET' || net === 'ECONNRESET' || net === 'EPIPE') text = 'соединение с OpenAI оборвалось';
  else if (net === 'ECONNREFUSED' || net === 'ENETUNREACH' || net === 'EHOSTUNREACH') text = 'сеть не пускает к OpenAI';
  else if (net !== null && /CERT|TLS|SSL/.test(net)) text = 'защищённое соединение не установилось (прокси или антивирус?)';
  else if (net !== null) text = 'сеть не дала связаться с OpenAI';
  else if (/timeout|timed out/.test(code)) text = 'OpenAI не ответил вовремя';
  else if (code.startsWith('silent:')) text = 'модель несколько раз промолчала';
  else if (http === '401' || http === '403') text = 'OpenAI не принял ключ';
  else if (http === '429') text = 'OpenAI просит подождать (лимит или баланс)';
  else if (http !== null && http.startsWith('5')) text = 'сбой на стороне OpenAI';
  else if (/^0:network/.test(code)) text = 'страница не достучалась до своего сервера';
  else text = 'не получилось подключиться';
  return `${text} (${code})`;
}

const FALLBACK_REASONS_RU: Record<string, string> = {
  'cannot connect': 'не подключился',
  'the model keeps silent': 'молчал',
  'no API key': 'без ключа',
};

/**
 * The paid voice fell back to the next model: which one speaks, why the preferred one does not, when it is tried again.
 * null when all is as preferred. For a parent (dock status line, Settings).
 */
export function describeVoiceFallback(fallback: VoiceFallbackInfo | null | undefined, now: number = Date.now()): string | null {
  if (!fallback) return null;
  const why = FALLBACK_REASONS_RU[fallback.reason] ?? 'не заработал';
  const next =
    fallback.retryAt === null
      ? 'Сам он больше не включится — проверьте ключ OpenAI и перезагрузите страницу.'
      : fallback.retryAt > now
        ? `Попробую его снова в начале следующего разговора, не раньше чем через ${Math.max(1, Math.ceil((fallback.retryAt - now) / 60_000))} мин.`
        : 'Попробую его снова в начале следующего разговора.';
  return `Сейчас говорит запасной голос — ${VOICE_NAMES[fallback.to]}: ${VOICE_NAMES[fallback.from]} ${why}, ${explainFailureCodeRu(fallback.code)}. ${next}`;
}

/** One line for a parent: which voice is active, whether the paid session is open, what the microphone does. */
export function describeVoiceStatus(input: VoiceStatusInput): string {
  const fallbackLine = describeVoiceFallback(input.fallback, input.now);
  const line = describeVoiceStatusLine(input);
  return fallbackLine === null ? line : `${fallbackLine} ${line}`;
}

function describeVoiceStatusLine(input: VoiceStatusInput): string {
  const model = isOpenAiVoiceKind(input.voiceKind) && input.voiceModel ? `, модель ${input.voiceModel}` : '';
  const parts = [`Голос: ${VOICE_NAMES[input.voiceKind]}${model}`];
  if (input.muted && input.voiceKind !== 'silent') parts.push('звук приглушён кнопкой');
  // «Записи»: which library, and that nothing listens
  if (input.voiceKind === 'clips') {
    if (input.clipLibrary) parts.push(clipLibraryLineRu(input.clipLibrary));
    parts.push('без микрофона');
  }
  if (isOpenAiVoiceKind(input.voiceKind)) {
    parts.push(input.voiceConnected ? 'соединение открыто' : 'соединение закрыто, пока Гамбитик молчит или спит');
    if (input.talkativeness) parts.push(TALKATIVENESS_NAMES[input.talkativeness]);
    if (!input.micAvailable) parts.push('микрофон недоступен');
    else if (input.muted) parts.push('микрофон выключен');
    else if (input.micMode === 'push') parts.push('микрофон — по кнопке');
    else parts.push(input.micMuted ? 'микрофон выключен ребёнком' : 'микрофон открыт');
  }
  const line = `${parts.join(' · ')}.`;
  if (!isOpenAiVoiceKind(input.voiceKind) || input.dailyLimitMin === undefined) return line;
  return `${line} ${VOICE_IDLE_RULE_RU} ${voiceDailyRuleRu(input.dailyLimitMin, input.limitReached === true)}`;
}

export type MicIndicatorState = 'hearing' | 'open' | 'muted' | 'asleep';

/**
 * 'asleep' also covers "awake but the session is not open" (nothing was said yet, the connection dropped):
 * the indicator must never promise «я тебя слышу» while nobody listens.
 */
export function micIndicatorState(input: { micMuted: boolean; asleep: boolean; childSpeaking: boolean; connected: boolean }): MicIndicatorState {
  if (input.micMuted) return 'muted';
  if (input.asleep || !input.connected) return 'asleep';
  return input.childSpeaking ? 'hearing' : 'open';
}

export const MIC_INDICATOR_LABELS: Record<MicIndicatorState, string> = {
  hearing: 'Гамбитик тебя слушает',
  open: 'Гамбитик тебя слышит — просто говори. Нажми, чтобы выключить микрофон',
  muted: 'Микрофон выключен. Нажми, чтобы Гамбитик снова тебя слышал',
  asleep: 'Гамбитик сейчас не слушает. Нажми, чтобы он тебя услышал',
};

/** the shared settings contract: shown once while the open microphone runs without confirmed headphones */
export const HEADPHONES_NOTE = {
  text: 'Надень наушники — так Гамбитик не будет слышать сам себя',
  confirm: 'Я в наушниках',
  usePush: 'Буду нажимать кнопку',
} as const;

export function shouldShowHeadphonesNote(input: {
  voiceKind: VoiceKind;
  micAvailable: boolean;
  muted: boolean;
  micMode: MicMode;
  headphonesConfirmed: boolean;
}): boolean {
  return isOpenAiVoiceKind(input.voiceKind) && input.micAvailable && !input.muted && input.micMode === 'open' && !input.headphonesConfirmed;
}

// ───────────────────────── the «Поговорить» button ─────────────────────────

/** the button's caption under the icon, per conversation state */
export const CONVERSATION_CAPTIONS: Record<ConversationState, string> = {
  off: 'Поговорить',
  connecting: 'Подключаюсь…',
  listening: 'Слушаю',
  childSpeaking: 'Слушаю',
  thinking: 'Думаю…',
  coachSpeaking: 'Говорю',
  error: 'Не получилось — нажми ещё раз',
};

/** today's minutes of the paid voice are used up: the button is disabled and says so */
export const VOICE_LIMIT_CAPTION = 'Лимит на сегодня';
export const VOICE_LIMIT_LABEL = 'Лимит на сегодня: живой голос отдыхает до завтра, Гамбитик пишет в облачке. Лимит выбирают родители в настройках';

/** true = a tap ends the conversation («Пока!»); false = a tap starts it (again) */
export function conversationIsActive(state: ConversationState): boolean {
  return state !== 'off' && state !== 'error';
}

/**
 * The voice session is up but the browser refused the microphone (a dismissed prompt, a blocked site, an embedded preview
 * window). Not an error of the conversation: he goes on speaking; the button says what a tap does.
 */
export const MIC_BLOCKED_CAPTION = 'Микрофон закрыт — нажми, чтобы разрешить';
export const MIC_BLOCKED_LABEL = 'Микрофон закрыт — нажми, чтобы разрешить. Пока я говорю, но тебя не слышу';

/** the same, said aloud — no Latin letters in speech */
export const MIC_BLOCKED_SPOKEN =
  'Я говорю, но тебя не слышу: браузер не дал микрофон. Открой меня в Хроме или Сафари и разреши микрофон — тогда поболтаем.';

// ───────────────────────── the site's microphone is blocked: where to allow it ─────────────────────────

/**
 * The permission is «denied» for the site: every «Микрофон закрыт» tap would ask again and fail at once. Asking cannot work then; the parent has to allow it in the browser. The steps depend on it.
 */
export type MicHelpBrowser = 'chrome' | 'safari' | 'ios' | 'firefox' | 'other';

/** Chrome / Edge / Яндекс (Chromium) · Safari on a Mac · an iPad / iPhone (any browser there is Safari inside) · Firefox */
export function micHelpBrowser(nav: { userAgent?: string; maxTouchPoints?: number } | undefined): MicHelpBrowser {
  const ua = nav?.userAgent ?? '';
  // iPadOS Safari introduces itself as a Mac — with a touch screen
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1)) return 'ios';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\/|Chromium\/|Edg\/|YaBrowser\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

export const MIC_HELP_TITLE = 'Браузер запретил микрофон';
export const MIC_HELP_DISMISS = 'Понятно';

const MIC_HELP_STEPS_RU: Readonly<Record<MicHelpBrowser, string>> = {
  chrome: 'Нажми на значок слева от адреса → Микрофон → Разрешить, потом обнови страницу',
  safari: 'Меню Safari → Настройки → Веб-сайты → Микрофон → у этого сайта «Разрешить», потом обнови страницу',
  ios: 'Нажми «аА» слева от адреса → Настройки веб-сайта → Микрофон → Разрешить, потом обнови страницу',
  firefox: 'Нажми на значок слева от адреса → убери запрет микрофона (крестик), потом обнови страницу',
  other: 'Разреши микрофон для этого сайта в настройках браузера (значок слева от адреса), потом обнови страницу',
};

/** said aloud — no Latin letters, no arrows */
const MIC_HELP_SPOKEN_RU: Readonly<Record<MicHelpBrowser, string>> = {
  chrome: 'нажать на значок слева от адреса, выбрать «Микрофон» и «Разрешить», а потом обновить страницу',
  safari: 'в меню Сафари открыть «Настройки», потом «Веб-сайты» и «Микрофон», разрешить этот сайт и обновить страницу',
  ios: 'нажать на буквы слева от адреса, открыть «Настройки веб-сайта», выбрать «Микрофон» и «Разрешить», а потом обновить страницу',
  firefox: 'нажать на значок слева от адреса, убрать запрет микрофона и обновить страницу',
  other: 'разрешить микрофон в настройках браузера — значок слева от адреса — и обновить страницу',
};

/** what the dock shows: the exact steps for this browser */
export function micHelpStepsRu(browser: MicHelpBrowser): string {
  return MIC_HELP_STEPS_RU[browser];
}

/** what he says when the tap cannot help */
export function micHelpSpokenRu(browser: MicHelpBrowser): string {
  return `Я тебя не слышу: браузер запретил микрофон. Попроси взрослого ${MIC_HELP_SPOKEN_RU[browser]}.`;
}

/** caption under the icon; `micBlocked` = connected to the voice, but no microphone (whatever the coach does meanwhile) */
export function conversationCaption(state: ConversationState, opts: { micBlocked?: boolean } = {}): string {
  if (opts.micBlocked && state !== 'off' && state !== 'connecting') return MIC_BLOCKED_CAPTION;
  return CONVERSATION_CAPTIONS[state];
}

/** accessible name of the button: what it does now */
export function conversationButtonLabel(state: ConversationState, opts: { micBlocked?: boolean; cutsIn?: boolean } = {}): string {
  if (state === 'off') return 'Поговорить с Гамбитиком';
  if (opts.micBlocked && state !== 'connecting') return MIC_BLOCKED_LABEL;
  if (state === 'error') return 'Не получилось подключиться. Нажми ещё раз, чтобы поговорить с Гамбитиком';
  if (opts.cutsIn) return 'Гамбитик говорит. Нажми, чтобы перебить его и сказать самому';
  return `${CONVERSATION_CAPTIONS[state]}. Нажми, чтобы закончить разговор`;
}

// ───────────────────────── what a tap does ─────────────────────────

export type MascotTapAction = 'unlock' | 'wake' | 'interrupt' | 'poke';

/**
 * A tap on Гамбитик: the first one unlocks the sound, a sleeping one wakes up, one that SPEAKS is cut off (on
 * laptop speakers the echo guard keeps the microphone closed while he talks, so a tap is the child's way in), otherwise he answers with a catchphrase.
 */
export function mascotTapAction(input: { needsUserGesture: boolean; asleep: boolean; speaking: boolean }): MascotTapAction {
  if (input.needsUserGesture) return 'unlock';
  if (input.asleep) return 'wake';
  if (input.speaking) return 'interrupt';
  return 'poke';
}

export type TalkTapAction = 'retryMic' | 'interrupt' | 'toggle';

/**
 * A tap on «Поговорить»: a refused microphone is asked for again (on the same session); on loudspeakers (open microphone,
 * no headphones — the echo guard is on) a tap while he speaks cuts him off instead of ending the conversation; with
 * headphones the child simply talks over him (full duplex) and the tap ends the conversation.
 */
export function talkTapAction(input: {
  voiceConnected: boolean;
  micAvailable: boolean;
  conversationState: ConversationState;
  micMode: MicMode;
  headphonesConfirmed: boolean;
}): TalkTapAction {
  if (input.voiceConnected && !input.micAvailable) return 'retryMic';
  if (input.conversationState === 'coachSpeaking' && input.micMode === 'open' && !input.headphonesConfirmed) return 'interrupt';
  return 'toggle';
}
