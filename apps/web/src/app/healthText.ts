/**
 * Parent-friendly Russian explanations of what GET /api/health (and GET /api/voice/usage) report: which voice is
 * speaking, whether the OpenAI key is there, how the microphone works, who writes the post-game reviews and how
 * many minutes of paid live voice were used. Pure functions.
 *
 * The lesson model (docs/TEACHING.md §4.4): generative AI in the child's game only when the server says
 * `health.ai.runtime === true` (`runtimeAiOf`; absent or offline = off). Off: three voices — «Записанный голос»,
 * «Голос компьютера — черновик», «Без голоса» — and the line «Живой голос выключен…»; reviews are templates.
 *
 * «Дозапись голоса» (docs/voice-clips/ONDEMAND.md): the parent's card «Дозапись новых фраз» — when it shows, the daily cap choices, the
 * confirmation, the spend and counts, and why recording pauses, in plain Russian (`health.clipGen`, GET /voice/clips/status).
 */
import type { ClipGenHealth, ClipGenPauseReason, ClipGenStatus, HealthInfo, VoiceLayer } from '@gambit/shared';
import type { VoiceUsage } from '../api/client.ts';
import { VOICE_IDLE_RULE_RU, voiceDailyRuleRu } from '../coach/voiceStatus.ts';
import { AI_OFF_VOICE, VOICE_DAILY_LIMIT_CHOICES, effectiveVoicePreference } from '../coach/settings.ts';
import { pluralRu } from '../ui/plural.ts';
import type { DailyLimitChoice, MicChoice, TalkativenessChoice, VoiceChoice } from './voiceSettings.ts';

export type VoiceKind = VoiceLayer['kind'];

export interface VoiceOption {
  id: VoiceChoice;
  title: string;
  subtitle: string;
  /** the option cannot work right now (no API key on the server) */
  unavailable: boolean;
}

export interface MicOption {
  id: MicChoice;
  title: string;
  subtitle: string;
}

export interface StatusText {
  tone: 'ok' | 'info' | 'warn';
  /** one sentence: what is active right now */
  summary: string;
  /** optional how-to lines for the parent */
  details: string[];
}

export const DEFAULT_LIVE_MODEL = 'gpt-live-1';
/** A rule of thumb for the full-duplex model; shown as a hint, never as a bill. */
export const LIVE_VOICE_USD_PER_MINUTE = 0.05;

const ENV_KEY_HOWTO =
  'Чтобы включить живой голос, откройте файл .env в папке приложения, впишите строку OPENAI_API_KEY=ваш_ключ и запустите «Шахматы» заново.';
const LIVE_COST_NOTE = `Живой голос оплачивается отдельно по тарифам OpenAI API (подписка ChatGPT его не покрывает): ${DEFAULT_LIVE_MODEL} — примерно $${LIVE_VOICE_USD_PER_MINUTE.toFixed(2).replace('.', ',')} за каждую минуту открытого разговора, даже молчаливую. Поэтому разговор засыпает сам: в партии — через 2 минуты без ходов и слов ребёнка (следующий ход будит его), вне партии — через полторы минуты тишины, в фоновой вкладке — через 15 секунд, при закрытии страницы — сразу; в партии на 1 минуту он выключен. Пока Гамбитик спит или разговор выключен кнопкой «Поговорить», деньги не тратятся.`;
const LIVE_PRIVACY_NOTE = 'Живой голос работает через серверы OpenAI: пока Гамбитик слушает, туда передаётся звук с микрофона.';

function liveAvailable(health: HealthInfo | null): boolean {
  return health?.voice.live === true;
}

function realtimeAvailable(health: HealthInfo | null): boolean {
  return health?.voice.realtime === true;
}

function liveModelOf(health: HealthInfo | null): string {
  const model = health?.voice.liveModel;
  return typeof model === 'string' && model.trim() !== '' ? model : DEFAULT_LIVE_MODEL;
}

/** What «Авто» resolves to: health.voice.preferred → live → realtime → browser. */
export function autoVoiceKind(health: HealthInfo | null): VoiceKind {
  const live = liveAvailable(health);
  const realtime = realtimeAvailable(health);
  if (health?.voice.preferred === 'live' && live) return 'openai-live';
  if (health?.voice.preferred === 'realtime' && realtime) return 'openai-realtime';
  if (live) return 'openai-live';
  if (realtime) return 'openai-realtime';
  return 'browser-tts';
}

export function voiceOptions(health: HealthInfo | null): VoiceOption[] {
  const live = liveAvailable(health);
  const realtime = realtimeAvailable(health);
  const auto = autoVoiceKind(health);
  const needsKey = 'Нужен ключ OpenAI в файле .env';
  return [
    {
      id: 'auto',
      title: 'Авто (лучший доступный)',
      subtitle:
        auto === 'openai-live'
          ? `Сейчас это живой голос ${liveModelOf(health)}`
          : auto === 'openai-realtime'
            ? `Сейчас это живой голос ${health?.voice.model ?? 'gpt-realtime'}`
            : 'Сейчас это голос компьютера',
      unavailable: false,
    },
    {
      id: 'live',
      title: 'Живой голос — слушает и говорит одновременно',
      subtitle: live ? `${liveModelOf(health)}: можно перебивать и разговаривать, как с человеком` : needsKey,
      unavailable: !live,
    },
    {
      id: 'realtime',
      title: 'Живой голос (gpt-realtime)',
      subtitle: realtime ? `${health?.voice.model ?? 'gpt-realtime'}: отвечает, когда ребёнок договорил` : needsKey,
      unavailable: !realtime,
    },
    { id: 'browser', title: 'Голос компьютера', subtitle: 'Бесплатно и без интернета, звучит как робот', unavailable: false },
    { id: 'off', title: 'Выключен', subtitle: 'Гамбитик пишет в облачке и молчит', unavailable: false },
  ];
}

// ───────────────────────── no generative AI in the child's game (docs/TEACHING.md §4.4) ─────────────────────────

/** The server allows generative AI in the child's game; absent (an old server) or no answer = no. */
export function runtimeAiOf(health: HealthInfo | null | undefined): boolean {
  return health?.ai?.runtime === true;
}

/** The line under the voice tiles when the live voice is off (e2e 04 looks for it). */
export const AI_OFF_LINE = 'Живой голос выключен: в партии ребёнка ИИ не используется.';
/** What the recorded voice says (and does not say yet) — the lesson's new phrases are not recorded until the next step. */
export const AI_OFF_CLIPS_NOTE = 'Фразы урока, у которых ещё нет записи, Гамбитик показывает в облачке с пометкой «не озвучено».';

/**
 * The three voices without runtime AI, «Записанный голос» first (the default: stored 'auto' / 'live' / 'realtime'
 * mean `AI_OFF_VOICE`). The robot voice is a draft: it reads every lesson phrase, but sounds like a robot.
 */
export function aiOffVoiceOptions(): VoiceOption[] {
  return [
    {
      id: 'clips',
      title: 'Записанный голос',
      subtitle: `Голос Giselle, фразы записаны заранее. Бесплатно, без микрофона и без интернета${AI_OFF_VOICE === 'clips' ? '. Выбран по умолчанию' : ''}`,
      unavailable: false,
    },
    {
      id: 'browser',
      title: 'Голос компьютера — черновик',
      subtitle: `Читает вслух каждую фразу урока, но звучит как робот. Бесплатно${AI_OFF_VOICE === 'browser' ? '. Выбран по умолчанию' : ''}`,
      unavailable: false,
    },
    { id: 'off', title: 'Без голоса', subtitle: 'Гамбитик пишет в облачке и молчит', unavailable: false },
  ];
}

/** The tile pressed without runtime AI: a stored AI voice shows as the voice that really speaks (never rewritten). */
export function aiOffVoiceChoice(stored: VoiceChoice): VoiceChoice {
  return effectiveVoicePreference(stored, false);
}

/** The voice status without runtime AI (the recorded voice has its own, clipSettings.ts describeClipsVoice). */
export function describeVoiceAiOff(args: { voiceKind: VoiceKind; muted: boolean; serverOnline: boolean }): StatusText {
  const { voiceKind, muted, serverOnline } = args;
  const details: string[] = [];
  let summary: string;
  let tone: StatusText['tone'] = 'ok';
  if (voiceKind === 'browser-tts') {
    summary = 'Сейчас говорит голос компьютера — черновой вариант: читает каждую фразу урока, но звучит как робот.';
    details.push('Чтобы голос звучал мягче, установите улучшенный русский голос: Системные настройки → Универсальный доступ → Устный контент → Системный голос → Управление голосами → Русский.');
  } else if (voiceKind === 'clips') {
    summary = 'Сейчас говорит записанный голос — бесплатно и без микрофона.';
    details.push(AI_OFF_CLIPS_NOTE);
  } else {
    summary = 'Голос выключен — Гамбитик показывает реплики в облачке.';
    tone = 'info';
  }
  if (muted && voiceKind !== 'silent') {
    summary = 'Голос Гамбитика сейчас выключен кнопкой «Звук» — реплики видны в облачке.';
    tone = 'info';
  }
  if (!serverOnline) {
    tone = 'warn';
    details.unshift('Сервер тренера не отвечает. Играть можно и сейчас: ходы считает шахматный движок на этом компьютере.');
  }
  return { tone, summary, details: [...new Set(details)] };
}

export function micOptions(): MicOption[] {
  return [
    { id: 'open', title: 'Всегда слушает', subtitle: 'Можно просто говорить. Нужны наушники' },
    { id: 'push', title: 'По кнопке', subtitle: 'Гамбитик слушает, пока нажата кнопка с микрофоном' },
  ];
}

export interface TalkativenessOption {
  id: TalkativenessChoice;
  title: string;
  subtitle: string;
}

/** How often the LIVE coach speaks up by itself (answers to the child and urgent moments are always there). */
export function talkativenessOptions(): TalkativenessOption[] {
  return [
    { id: 'quiet', title: 'Тихо', subtitle: 'Только важное: предложит вернуть ход и ответит на вопросы' },
    { id: 'normal', title: 'Обычно', subtitle: 'Ещё начало и конец партии, угрозы соперника, хорошие находки' },
    { id: 'chatty', title: 'Болтливо', subtitle: 'Ещё мелкие похвалы и комментарии' },
  ];
}

function isLiveKind(kind: VoiceKind): boolean {
  return kind === 'openai-live' || kind === 'openai-realtime';
}

export function describeVoice(args: {
  health: HealthInfo | null;
  serverOnline: boolean;
  voiceKind: VoiceKind;
  preference: VoiceChoice;
  muted: boolean;
  micMode?: MicChoice;
}): StatusText {
  const { health, serverOnline, voiceKind, preference, muted } = args;
  const details: string[] = [];
  let summary: string;
  let tone: StatusText['tone'] = 'ok';

  if (voiceKind === 'openai-live') {
    summary = `Сейчас говорит живой голос OpenAI — слушает и говорит одновременно (модель ${liveModelOf(health)}${health ? `, голос ${health.voice.voice}` : ''}).`;
  } else if (voiceKind === 'openai-realtime') {
    summary = `Сейчас говорит живой голос OpenAI${health ? ` (модель ${health.voice.model}, голос ${health.voice.voice})` : ''}.`;
  } else if (voiceKind === 'browser-tts') {
    summary = 'Сейчас говорит голос компьютера — бесплатно и без интернета.';
    details.push('Если голос звучит как робот, установите улучшенный русский голос: Системные настройки → Универсальный доступ → Устный контент → Системный голос → Управление голосами → Русский.');
  } else {
    summary = 'Голос выключен — Гамбитик показывает реплики в облачке.';
    tone = 'info';
  }

  if (isLiveKind(voiceKind)) {
    details.push(
      args.micMode === 'push'
        ? 'Микрофон работает по кнопке: Гамбитик слушает, только пока нажата кнопка с микрофоном.'
        : 'Микрофон слушает всё время — наденьте ребёнку наушники, иначе Гамбитик будет слышать сам себя.',
      LIVE_PRIVACY_NOTE,
      LIVE_COST_NOTE,
    );
  }

  if (muted && voiceKind !== 'silent') {
    summary = 'Голос Гамбитика приглушён кнопкой с динамиком — реплики видны в облачке.';
    tone = 'info';
  }

  const anyLive = liveAvailable(health) || realtimeAvailable(health);
  const wantsLive = preference === 'auto' || preference === 'live' || preference === 'realtime';
  if (!serverOnline) {
    tone = 'warn';
    details.unshift('Сервер тренера не отвечает, поэтому живой голос недоступен. Голос компьютера работает и без сервера.');
  } else if (health && !anyLive) {
    if (preference === 'live' || preference === 'realtime') {
      tone = 'warn';
      details.unshift('Выбран живой голос, но ключа OpenAI на этом компьютере нет — пока говорит голос компьютера.');
    }
    details.push(ENV_KEY_HOWTO, LIVE_COST_NOTE);
  } else if (health && anyLive && voiceKind === 'browser-tts' && wantsLive) {
    tone = 'warn';
    details.unshift('Живой голос сейчас не подключился (нет интернета, ключ не подошёл или модель недоступна) — говорит голос компьютера.');
  } else if (health && preference === 'live' && voiceKind === 'openai-realtime') {
    tone = 'info';
    details.unshift(`Модель ${liveModelOf(health)} сейчас недоступна — Гамбитик говорит через ${health.voice.model}.`);
  }

  return { tone, summary, details: [...new Set(details)] };
}

/** «Ключ OpenAI на этом компьютере: есть / нет» — null while the server is silent. */
export function describeOpenAiKey(health: HealthInfo | null): string | null {
  if (!health) return null;
  const present = health.llm.openaiKey || liveAvailable(health) || realtimeAvailable(health);
  if (!runtimeAiOf(health)) {
    // the key may lie in .env, but nothing in the child's game uses it
    return present
      ? 'Ключ OpenAI на этом компьютере: есть, но в партии ребёнка он не используется — ИИ выключен.'
      : 'Ключ OpenAI на этом компьютере: нет. Он и не нужен: в партии ребёнка ИИ не используется.';
  }
  return present
    ? 'Ключ OpenAI на этом компьютере: есть (хранится только в файле .env, в браузер не попадает).'
    : 'Ключ OpenAI на этом компьютере: нет. Без него работают голос компьютера и шаблонные разборы — бесплатно.';
}

// ───────────────────────── live-voice minutes ─────────────────────────

/** 0 → «0 минут», 45 s → «меньше минуты», 61 s → «1 минута», 3600 s → «60 минут». */
export function formatMinutesRu(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 минут';
  if (seconds < 60) return 'меньше минуты';
  const minutes = Math.round(seconds / 60);
  return `${minutes} ${pluralRu(minutes, 'минута', 'минуты', 'минут')}`;
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2).replace('.', ',')}`;
}

/**
 * Lines about the paid live voice: minutes today / this month and an HONEST cost hint (an estimate by a
 * rule of thumb — the real bill is in the OpenAI account). Empty when the server has no numbers.
 */
export function describeVoiceUsage(usage: VoiceUsage | null): string[] {
  if (!usage) return [];
  const lines = [`Живой голос сегодня: ${formatMinutesRu(usage.todaySeconds)}. За этот месяц: ${formatMinutesRu(usage.monthSeconds)}.`];
  if (usage.monthSeconds >= 60) {
    const estimate = (usage.monthSeconds / 60) * LIVE_VOICE_USD_PER_MINUTE;
    lines.push(
      `Это примерно ${formatUsd(estimate)} за месяц, если считать по ${formatUsd(LIVE_VOICE_USD_PER_MINUTE)} за минуту (${DEFAULT_LIVE_MODEL}). Оценка грубая — точные цифры в личном кабинете OpenAI.`,
    );
  } else {
    lines.push(`Ориентир по цене: ${DEFAULT_LIVE_MODEL} — около ${formatUsd(LIVE_VOICE_USD_PER_MINUTE)} за минуту разговора.`);
  }
  return lines;
}

// ───────────────────────── the daily limit ─────────────────────────

export interface DailyLimitOption {
  id: DailyLimitChoice;
  title: string;
}

/** 30 / 60 / 90 / 120 minutes a day, or no limit */
export function dailyLimitOptions(): DailyLimitOption[] {
  return VOICE_DAILY_LIMIT_CHOICES.map((id) => ({ id, title: id === 0 ? 'Без лимита' : `${id} мин` }));
}

/** $3, $1,5 — the price hint without trailing zeros */
function formatUsdShort(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return `$${String(rounded).replace('.', ',')}`;
}

/** «≈ $0,05 за минуту, 60 минут ≈ $3» — for the chosen limit (no limit: the hour as the example) */
export function dailyLimitCostHint(limitMin: number): string {
  const minutes = limitMin > 0 ? limitMin : 60;
  return `≈ ${formatUsd(LIVE_VOICE_USD_PER_MINUTE)} за минуту, ${minutes} ${pluralRu(minutes, 'минута', 'минуты', 'минут')} ≈ ${formatUsdShort(minutes * LIVE_VOICE_USD_PER_MINUTE)}.`;
}

/**
 * The lines next to the limit choice: today's minutes against the limit (when the server gave numbers), the price hint,
 * and the two rules — idle and daily — one sentence each.
 */
export function describeDailyLimit(args: { limitMin: number; usage: VoiceUsage | null; limitReached: boolean }): string[] {
  const { limitMin, usage, limitReached } = args;
  const lines: string[] = [];
  if (usage) lines.push(limitMin > 0 ? `Сегодня: ${formatMinutesRu(usage.todaySeconds)} из ${limitMin}.` : `Сегодня: ${formatMinutesRu(usage.todaySeconds)}.`);
  lines.push(dailyLimitCostHint(limitMin), voiceDailyRuleRu(limitMin, limitReached), VOICE_IDLE_RULE_RU);
  return lines;
}

// ───────────────────────── who writes the reviews ─────────────────────────

export type TextAiProvider = 'codex' | 'openrouter' | 'openai-api' | 'template' | 'unknown';

/**
 * Codex writes the texts right now: installed, logged in and not paused by its usage limit, a failed login or repeated
 * failures (`llm.codexPaused`). A codex that is only too slow for a game's first line still writes the reviews.
 */
function codexWrites(health: HealthInfo): boolean {
  const pause = health.llm.codexPaused;
  return health.llm.codexCli && health.llm.codexLoggedIn && (pause === undefined || pause.reason === 'slow');
}

/** Server order (LLM_PROVIDER=auto): подписка Codex → OpenRouter → OpenAI API → шаблоны. */
export function textAiProvider(health: HealthInfo | null): TextAiProvider {
  if (!health) return 'unknown';
  if (codexWrites(health)) return 'codex';
  if (health.llm.openrouterKey === true) return 'openrouter';
  if (health.llm.openaiKey) return 'openai-api';
  return 'template';
}

const TEXT_AI_CHAIN = 'Порядок такой: подписка Codex → OpenRouter → OpenAI API → готовые шаблоны. Если один способ недоступен, берётся следующий — ничего не ломается.';
const ENGINE_NOTE = 'Оценки ходов всегда считает шахматный движок на этом компьютере — ИИ только пересказывает их понятными словами.';
const ENGINE_NOTE_AI_OFF = 'Оценки ходов считает шахматный движок на этом компьютере, а слова Гамбитика написаны заранее и проверены.';

function clockRu(epochMs: number): string {
  const at = new Date(epochMs);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** Why the subscription is not used right now (server: `llm.codexPaused`) — one line for the parent, or null. */
export function codexPauseRu(health: HealthInfo | null): string | null {
  const pause = health?.llm.codexPaused;
  if (!health || !pause || !health.llm.codexCli) return null;
  const at = clockRu(pause.until);
  switch (pause.reason) {
    case 'limit':
      return `Лимит подписки Codex сейчас исчерпан — примерно до ${at} тексты пишет следующий по порядку способ.`;
    case 'login':
      return 'Codex сообщил, что вход не выполнен: выполните в Терминале команду codex login — тогда снова заработает подписка.';
    case 'failing':
      return `Codex несколько раз подряд не ответил — примерно до ${at} тексты пишет следующий по порядку способ.`;
    case 'slow':
      // only when something faster exists: otherwise the strategy still waits for codex
      return health.llm.openrouterKey === true || health.llm.openaiKey
        ? `Стратегию в начале партии сейчас подбирает OpenRouter или OpenAI API (платно): подписка Codex отвечала слишком долго. Примерно в ${at} снова попробуем подписку.`
        : null;
  }
}

export function describeTextAi(health: HealthInfo | null): StatusText {
  // no generative AI: the server writes every text from templates, whatever keys or Codex it has (§4.4)
  if (health && !runtimeAiOf(health)) {
    return {
      tone: 'info',
      summary: 'Разборы партий и темы «Учителя» собираются из готовых шаблонов — бесплатно и без интернета.',
      details: [ENGINE_NOTE_AI_OFF, 'ИИ в приложении выключен: ни разборы, ни фразы в партии его не используют.'],
    };
  }
  const pauseLine = codexPauseRu(health);
  const withPause = (details: string[]): string[] => (pauseLine !== null ? [pauseLine, ...details] : details);
  switch (textAiProvider(health)) {
    case 'codex':
      return {
        tone: 'ok',
        summary: 'Разборы партий и стратегию «Учителя» пишет Codex по вашей подписке ChatGPT.',
        details: withPause(['Если недельный лимит подписки закончится, текст напишет следующий по порядку способ.', TEXT_AI_CHAIN, ENGINE_NOTE]),
      };
    case 'openrouter':
      return {
        tone: 'ok',
        summary: 'Разборы партий пишет ИИ через OpenRouter (ключ из файла .env).',
        details: withPause(['Каждый разбор стоит немного денег на счёте OpenRouter. Голос через OpenRouter не идёт — только текст.', TEXT_AI_CHAIN, ENGINE_NOTE]),
      };
    case 'openai-api':
      return {
        tone: 'ok',
        summary: 'Разборы партий пишет OpenAI API (ключ из файла .env).',
        details: withPause(['Каждый разбор стоит немного денег на счёте OpenAI API.', TEXT_AI_CHAIN, ENGINE_NOTE]),
      };
    case 'template': {
      const details = withPause([ENGINE_NOTE]);
      // a paused codex (its limit, repeated failures) is logged in: the pause line above says what happens
      if (!(pauseLine !== null && health?.llm.codexLoggedIn === true)) {
        details.push(
          health?.llm.codexCli
            ? 'Codex установлен, но вход не выполнен: выполните в Терминале команду codex login — и разборы станут подробнее.'
            : 'Чтобы разборы стали подробнее, установите Codex CLI и войдите в него (codex login) или впишите OPENROUTER_API_KEY либо OPENAI_API_KEY в файл .env.',
        );
      }
      details.push(TEXT_AI_CHAIN);
      return { tone: 'info', summary: 'Разборы партий собираются из готовых шаблонов — бесплатно и без интернета.', details };
    }
    case 'unknown':
      return {
        tone: 'warn',
        summary: 'Сервер тренера не отвечает — статус ИИ неизвестен.',
        details: ['Запустите «Шахматы.command» ещё раз. Играть можно и сейчас.'],
      };
  }
}

export function describePuzzles(health: HealthInfo | null): string | null {
  if (!health) return null;
  const count = health.puzzles.count;
  if (count >= 5000) return `Задач в базе: ${count.toLocaleString('ru-RU')}.`;
  return `Задач в базе: ${count.toLocaleString('ru-RU')} (стартовый набор). Большая база загружается командой pnpm puzzles:import в папке приложения.`;
}

// ───────────────────────── «Дозапись голоса»: recording missing lesson phrases (docs/voice-clips/ONDEMAND.md) ─────────────────────────

/** The parent's daily cap choices, credits; only those up to the server's maximum (`CLIP_GEN_DAILY_MAX`) are offered. */
export const CLIP_GEN_CAP_CHOICES = [3, 6, 10, 15] as const;

/** Said on the card whatever the state: the server never reads the account (it would need the Higgsfield account's e-mail). */
export const CLIP_GEN_BALANCE_NOTE = 'Баланс Higgsfield сервер не проверяет.';

/**
 * The card shows only when this server can record at all: it answers, it has the feature and it is not off in `.env`,
 * and the page is not driven by automation (a test must never see, let alone press, a paid switch).
 */
export function clipGenCardVisible(args: { health: HealthInfo | null; serverOnline: boolean; automated: boolean }): boolean {
  const clipGen = args.health?.clipGen;
  return args.serverOnline && !args.automated && clipGen !== undefined && clipGen.state !== 'off';
}

/** Milli-credits in Russian: 1350 → «1,35», 12 600 → «12,6», 3000 → «3». */
export function formatCreditsRu(milli: number): string {
  const credits = Math.round((Number.isFinite(milli) ? Math.max(0, milli) : 0) / 10) / 100;
  return String(credits).replace('.', ',');
}

/** «3 кредитов», «1 кредита», «0,5 кредита» — after «не больше». */
function creditsGenitiveRu(milli: number): string {
  const text = formatCreditsRu(milli);
  return `${text} ${milli % 1000 === 0 ? pluralRu(milli / 1000, 'кредита', 'кредитов', 'кредитов') : 'кредита'}`;
}

/**
 * The daily cap choices (milli-credits): 3 / 6 / 10 / 15 up to the server's maximum, plus the maximum itself when it is
 * none of them (CLIP_GEN_DAILY_MAX=5 caps at 5, not at 3) and the cap the server applies now when it is none of them
 * either — the pressed button must always be the cap that is really spent up to.
 */
export function clipGenCapChoices(dailyMaxMilli: number, currentMilli?: number): number[] {
  const max = Number.isFinite(dailyMaxMilli) ? Math.max(0, Math.floor(dailyMaxMilli)) : 0;
  const choices = new Set(CLIP_GEN_CAP_CHOICES.map((c) => c * 1000).filter((c) => c <= max));
  const top = CLIP_GEN_CAP_CHOICES[CLIP_GEN_CAP_CHOICES.length - 1] * 1000;
  if (max > 0 && max < top) choices.add(max);
  if (currentMilli !== undefined && Number.isFinite(currentMilli) && currentMilli > 0 && currentMilli <= max) choices.add(Math.floor(currentMilli));
  return [...choices].sort((a, b) => a - b);
}

/** The confirmation before the paid switch goes on (docs/voice-clips/ONDEMAND.md; the price with tag packing). */
export function clipGenConfirmText(capMilli: number): string {
  return `Платно: ≈ 0,15–0,75 кредита Higgsfield за реплику, не больше ${creditsGenitiveRu(capMilli)} в день. В первый раз фраза сначала без голоса: голос — через несколько секунд или со следующего раза. Включить?`;
}

/** Why recording pauses, for the parent (the part for the server's owner names the fix). */
export const CLIP_GEN_PAUSE_RU: Record<ClipGenPauseReason, string> = {
  'parent-off': 'Дозапись выключена переключателем.',
  'no-budget': 'Не задан общий бюджет: владельцу — строка CLIP_GEN_BUDGET в файле .env.',
  'no-cli': 'На этом компьютере не найдена программа Higgsfield.',
  'no-tools': 'Нет программ для проверки записи (ffmpeg или whisper).',
  'temp-data': 'Приложение запущено с временной папкой данных — там дозапись не работает.',
  'data-dir': 'Не задана или не совпадает папка данных: владельцу — строка CLIP_GEN_DATA_DIR в файле .env.',
  'no-overlay': 'Папка для новых записей выключена или не подходит: владельцу — строка VOICE_OVERLAY_DIR в файле .env.',
  login: 'Вход в Higgsfield истёк — владельцу: higgsfield auth login.',
  rate: 'Higgsfield просит подождать — продолжу чуть позже.',
  failing: 'Несколько записей подряд не удались — небольшая пауза.',
  price: 'Higgsfield изменил цену — дозапись остановлена до перезапуска.',
  model: 'Higgsfield изменил голосовую модель — дозапись остановлена до перезапуска.',
  audit: 'Сверка расходов в журнале записей не сошлась — нужна проверка владельца.',
  'tool-busy': 'Сейчас записывает инструмент владельца — продолжу, когда он закончит.',
  'day-cap': 'Дневной лимит исчерпан — продолжу завтра.',
  'total-cap': 'Общий бюджет исчерпан — нужно решение владельца.',
  duplicate: 'Найдены лишние платные задания — дозапись остановлена до проверки владельца.',
  'no-credits': 'На счёте Higgsfield закончились кредиты.',
  unresolved: 'Сервер ещё не знает, чем кончилось прошлое задание, — новые не начинает.',
};

/**
 * Pauses that end only when a person acts (sign in, top up the account): their time is when the server LOOKS again,
 * not when the problem goes away — «до 14:30» would read as «credits come back at 14:30».
 */
const CLIP_GEN_RECHECK: ReadonlySet<ClipGenPauseReason> = new Set<ClipGenPauseReason>(['login', 'no-credits']);

/** The pause in one sentence (with «до 14:30» for a timed one); null when recording is not paused. */
export function clipGenPauseRu(health: ClipGenHealth, now: number = Date.now()): string | null {
  if (health.state !== 'paused') return null;
  const why = health.reason ? CLIP_GEN_PAUSE_RU[health.reason] : 'Дозапись на паузе.';
  // «до завтра» is already in the day cap's words
  if (typeof health.until !== 'number' || health.until <= now || health.reason === 'day-cap') return why;
  if (health.reason !== undefined && CLIP_GEN_RECHECK.has(health.reason)) return `${why.replace(/[.!]$/u, '')}; проверю снова в ${clockRu(health.until)}.`;
  return `${why.replace(/[.!]$/u, '')} (до ${clockRu(health.until)}).`;
}

/** Recording asks only while the recorded voice really speaks (docs/voice-clips/ONDEMAND.md): said when another voice is chosen. */
export const CLIP_GEN_CLIPS_ONLY_RU = 'Работает только когда говорит «Записанный голос»: сейчас выбран другой голос или звук выключен.';

/**
 * The card's status: what happens now, today's and the total spend, the counts, the balance note. `clipsVoice`: does
 * the recorded voice speak in this browser now (false = another voice or the sound off: nothing is ever asked for, and
 * the card must not promise recordings; undefined = not known yet).
 */
export function describeClipGen(status: ClipGenStatus, now: number = Date.now(), o: { clipsVoice?: boolean | null } = {}): StatusText {
  const { health, spent, caps } = status;
  const pause = health.reason === 'parent-off' && !status.enabled ? null : clipGenPauseRu(health, now);
  const otherVoice = o.clipsVoice === false;
  const summary = !status.enabled
    ? 'Выключено: новые фразы остаются без голоса.'
    : pause !== null
      ? `На паузе. ${pause}`
      : otherVoice
        ? `Включено, но сейчас ничего не записывается. ${CLIP_GEN_CLIPS_ONLY_RU}`
        : status.busy
          ? 'Включено: сейчас записываю новую фразу.'
          : 'Включено: новые фразы записываются, когда Гамбитик говорит их впервые.';
  const details = [
    `Сегодня: ${formatCreditsRu(spent.todayMilli)} из ${formatCreditsRu(caps.dailyMilli)} кр. · всего: ${formatCreditsRu(spent.totalMilli)} из ${formatCreditsRu(caps.totalMilli)} кр. (потолок в .env).`,
  ];
  if (spent.prefetchMilli > 0) details.push(`Заранее записано владельцем: на ${formatCreditsRu(spent.prefetchMilli)} кр.`);
  // phrases recorded on first use (an older server only reports the takes of the whole folder, the prefetch included)
  const recorded = status.recorded !== undefined ? `Новых фраз записано: ${status.recorded}` : `Записей в папке новых фраз: ${status.overlay?.units ?? 0}`;
  details.push(`${recorded} · в очереди: ${status.queue} · не прошли проверку: ${status.givenUp}.`);
  if ((status.stuck ?? 0) > 0) details.push(`Не удалось обработать уже оплаченных записей: ${status.stuck} — владельцу: перезапустите сервер, он попробует снова (платить заново не нужно).`);
  if (otherVoice && !status.enabled) details.push(CLIP_GEN_CLIPS_ONLY_RU);
  details.push(CLIP_GEN_BALANCE_NOTE);
  return { tone: !status.enabled || (otherVoice && pause === null) ? 'info' : pause !== null || (status.stuck ?? 0) > 0 ? 'warn' : 'ok', summary, details };
}
