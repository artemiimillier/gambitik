import { describe, expect, it } from 'vitest';
import {
  autoVoiceKind,
  codexPauseRu,
  dailyLimitCostHint,
  dailyLimitOptions,
  describeDailyLimit,
  describeOpenAiKey,
  describePuzzles,
  describeTextAi,
  describeVoice,
  describeVoiceUsage,
  formatMinutesRu,
  micOptions,
  textAiProvider,
  voiceOptions,
  AI_OFF_CLIPS_NOTE,
  AI_OFF_LINE,
  aiOffVoiceChoice,
  aiOffVoiceOptions,
  describeVoiceAiOff,
  runtimeAiOf,
} from './healthText.ts';
import { AI_OFF_VOICE } from '../coach/settings.ts';
import { sampleHealth } from './testUtils.ts';

/** a server that allows generative AI in the child's game (GAMBIT_RUNTIME_AI on — docs/TEACHING.md §4.4) */
const aiOn = (overrides: Parameters<typeof sampleHealth>[0] = {}) => sampleHealth({ ai: { runtime: true }, ...overrides });
const withKey = aiOn({ voice: { realtime: true, model: 'gpt-realtime-2.1', voice: 'marin' }, llm: { codexCli: false, codexLoggedIn: false, openaiKey: true } });
const withLive = aiOn({
  voice: { realtime: true, model: 'gpt-realtime-2.1', voice: 'marin', live: true, liveModel: 'gpt-live-1', preferred: 'live' },
  llm: { codexCli: false, codexLoggedIn: false, openaiKey: true },
});

describe('voice options', () => {
  it('offers the five modes asked for, full duplex first among the live ones', () => {
    const options = voiceOptions(withLive);
    expect(options.map((option) => option.id)).toEqual(['auto', 'live', 'realtime', 'browser', 'off']);
    expect(options.map((option) => option.title)).toEqual([
      'Авто (лучший доступный)',
      'Живой голос — слушает и говорит одновременно',
      'Живой голос (gpt-realtime)',
      'Голос компьютера',
      'Выключен',
    ]);
    expect(options.find((option) => option.id === 'live')?.subtitle).toContain('gpt-live-1');
    expect(options.find((option) => option.id === 'browser')?.subtitle).toMatch(/Бесплатно.*робот/);
    expect(options.every((option) => !option.unavailable)).toBe(true);
  });

  it('both live voices need the API key', () => {
    for (const health of [sampleHealth(), null]) {
      const options = voiceOptions(health);
      expect(options.filter((option) => option.unavailable).map((option) => option.id)).toEqual(['live', 'realtime']);
      expect(options.find((option) => option.id === 'live')?.subtitle).toContain('.env');
    }
    // an older server that only knows the realtime model
    expect(voiceOptions(withKey).filter((option) => option.unavailable).map((option) => option.id)).toEqual(['live']);
  });

  it('«Авто» = preferred → live → realtime → голос компьютера, and says which one that is right now', () => {
    expect(autoVoiceKind(withLive)).toBe('openai-live');
    expect(autoVoiceKind(sampleHealth({ voice: { ...withLive.voice, preferred: 'realtime' } }))).toBe('openai-realtime');
    expect(autoVoiceKind(sampleHealth({ voice: { ...withLive.voice, live: false, preferred: 'live' } }))).toBe('openai-realtime');
    expect(autoVoiceKind(withKey)).toBe('openai-realtime');
    expect(autoVoiceKind(sampleHealth())).toBe('browser-tts');
    expect(autoVoiceKind(null)).toBe('browser-tts');
    expect(voiceOptions(withLive)[0]?.subtitle).toContain('gpt-live-1');
    expect(voiceOptions(withKey)[0]?.subtitle).toContain('gpt-realtime-2.1');
    expect(voiceOptions(sampleHealth())[0]?.subtitle).toContain('голос компьютера');
  });

  it('two microphone modes; the open one mentions headphones', () => {
    const options = micOptions();
    expect(options.map((option) => option.id)).toEqual(['open', 'push']);
    expect(options[0]?.title).toBe('Всегда слушает');
    expect(options[0]?.subtitle).toContain('наушники');
    expect(options[1]?.title).toBe('По кнопке');
  });
});

describe('describeVoice', () => {
  it('explains the free computer voice and how to enable the live one', () => {
    const status = describeVoice({ health: sampleHealth(), serverOnline: true, voiceKind: 'browser-tts', preference: 'auto', muted: false });
    expect(status.tone).toBe('ok');
    expect(status.summary).toContain('голос компьютера');
    const text = status.details.join(' ');
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).toContain('.env');
    expect(text).toContain('оплачивается отдельно');
    expect(text).toContain('$0,05');
  });

  it('names the full-duplex model when it is active, with headphones, privacy and price — without the how-to', () => {
    const status = describeVoice({ health: withLive, serverOnline: true, voiceKind: 'openai-live', preference: 'auto', muted: false, micMode: 'open' });
    expect(status.tone).toBe('ok');
    expect(status.summary).toContain('gpt-live-1');
    expect(status.summary).toContain('одновременно');
    const text = status.details.join(' ');
    expect(text).toContain('наушники');
    expect(text).toContain('серверы OpenAI');
    expect(text).toContain('$0,05');
    expect(text).not.toContain('OPENAI_API_KEY');
  });

  it('names model and voice of the realtime layer and the push-to-talk microphone', () => {
    const status = describeVoice({ health: withKey, serverOnline: true, voiceKind: 'openai-realtime', preference: 'realtime', muted: false, micMode: 'push' });
    expect(status.summary).toContain('gpt-realtime-2.1');
    expect(status.summary).toContain('marin');
    expect(status.details.join(' ')).toContain('по кнопке');
    expect(status.details.join(' ')).not.toContain('наденьте');
  });

  it('warns when the live voice was chosen but cannot work', () => {
    for (const preference of ['live', 'realtime'] as const) {
      const noKey = describeVoice({ health: sampleHealth(), serverOnline: true, voiceKind: 'browser-tts', preference, muted: false });
      expect(noKey.tone).toBe('warn');
      expect(noKey.details[0]).toContain('ключа OpenAI');
    }
    const fellBack = describeVoice({ health: withLive, serverOnline: true, voiceKind: 'browser-tts', preference: 'auto', muted: false });
    expect(fellBack.tone).toBe('warn');
    expect(fellBack.details[0]).toContain('не подключился');

    const downgraded = describeVoice({ health: withLive, serverOnline: true, voiceKind: 'openai-realtime', preference: 'live', muted: false });
    expect(downgraded.tone).toBe('info');
    expect(downgraded.details[0]).toContain('gpt-live-1');
  });

  it('a parent who chose the computer voice is not nagged about the live one', () => {
    const status = describeVoice({ health: withLive, serverOnline: true, voiceKind: 'browser-tts', preference: 'browser', muted: false });
    expect(status.tone).toBe('ok');
    expect(status.details.join(' ')).not.toContain('не подключился');
  });

  it('covers off, muted and server-down states', () => {
    expect(describeVoice({ health: sampleHealth(), serverOnline: true, voiceKind: 'silent', preference: 'off', muted: false }).summary).toContain('выключен');
    expect(describeVoice({ health: sampleHealth(), serverOnline: true, voiceKind: 'browser-tts', preference: 'auto', muted: true }).summary).toContain('приглушён');
    const down = describeVoice({ health: null, serverOnline: false, voiceKind: 'browser-tts', preference: 'auto', muted: false });
    expect(down.tone).toBe('warn');
    expect(down.details[0]).toContain('не отвечает');
  });

  it('never repeats a detail line', () => {
    const status = describeVoice({ health: sampleHealth(), serverOnline: true, voiceKind: 'browser-tts', preference: 'realtime', muted: false });
    expect(new Set(status.details).size).toBe(status.details.length);
  });
});

describe('OpenAI key line', () => {
  it('says whether the key is there, never anything about its value', () => {
    expect(describeOpenAiKey(withKey)).toContain('есть');
    expect(describeOpenAiKey(aiOn())).toContain('нет');
    expect(describeOpenAiKey(null)).toBeNull();
    expect(describeOpenAiKey(withKey)).not.toMatch(/sk-/);
  });

  it('without runtime AI the key is not used in the child\'s game — the line says so either way', () => {
    const keyButOff = sampleHealth({ llm: { codexCli: false, codexLoggedIn: false, openaiKey: true }, ai: { runtime: false } });
    expect(describeOpenAiKey(keyButOff)).toBe('Ключ OpenAI на этом компьютере: есть, но в партии ребёнка он не используется — ИИ выключен.');
    expect(describeOpenAiKey(sampleHealth())).toBe('Ключ OpenAI на этом компьютере: нет. Он и не нужен: в партии ребёнка ИИ не используется.');
  });
});

describe('live-voice minutes', () => {
  it('formats minutes in Russian', () => {
    expect(formatMinutesRu(0)).toBe('0 минут');
    expect(formatMinutesRu(Number.NaN)).toBe('0 минут');
    expect(formatMinutesRu(45)).toBe('меньше минуты');
    expect(formatMinutesRu(61)).toBe('1 минута');
    expect(formatMinutesRu(150)).toBe('3 минуты'); // 2.5 rounds up
    expect(formatMinutesRu(11 * 60)).toBe('11 минут');
    expect(formatMinutesRu(3600)).toBe('60 минут');
  });

  it('shows today / month and an honest, clearly approximate cost', () => {
    const lines = describeVoiceUsage({ todaySeconds: 300, monthSeconds: 6000, byProvider: { 'openai-live': 6000 } });
    expect(lines[0]).toBe('Живой голос сегодня: 5 минут. За этот месяц: 100 минут.');
    expect(lines[1]).toContain('$5,00'); // 100 min × $0.05
    expect(lines[1]).toMatch(/примерно|грубая/);
    expect(lines[1]).toContain('кабинете OpenAI');
  });

  it('without usage yet it only gives the price hint; without numbers from the server it says nothing', () => {
    const fresh = describeVoiceUsage({ todaySeconds: 0, monthSeconds: 0, byProvider: {} });
    expect(fresh[0]).toContain('0 минут');
    expect(fresh[1]).toContain('$0,05');
    expect(describeVoiceUsage(null)).toEqual([]);
  });
});

describe('the daily limit of the live voice', () => {
  it('offers 30 / 60 / 90 / 120 minutes or no limit', () => {
    expect(dailyLimitOptions()).toEqual([
      { id: 30, title: '30 мин' },
      { id: 60, title: '60 мин' },
      { id: 90, title: '90 мин' },
      { id: 120, title: '120 мин' },
      { id: 0, title: 'Без лимита' },
    ]);
  });

  it('a one-line price hint for the chosen limit', () => {
    expect(dailyLimitCostHint(60)).toBe('≈ $0,05 за минуту, 60 минут ≈ $3.');
    expect(dailyLimitCostHint(30)).toBe('≈ $0,05 за минуту, 30 минут ≈ $1,5.');
    expect(dailyLimitCostHint(120)).toBe('≈ $0,05 за минуту, 120 минут ≈ $6.');
    expect(dailyLimitCostHint(0)).toBe('≈ $0,05 за минуту, 60 минут ≈ $3.');
  });

  it('today\'s minutes against the limit, the price hint, then the daily and the idle rule (one sentence each)', () => {
    const lines = describeDailyLimit({ limitMin: 60, usage: { todaySeconds: 12 * 60, monthSeconds: 3000, byProvider: {} }, limitReached: false });
    expect(lines).toEqual([
      'Сегодня: 12 минут из 60.',
      '≈ $0,05 за минуту, 60 минут ≈ $3.',
      'Не больше 60 минут живого голоса в день, дальше Гамбитик пишет в облачке.',
      'В партии живой голос засыпает через 2 минуты без ходов и слов ребёнка, в фоновой вкладке — через 15 секунд.',
    ]);
    expect(describeDailyLimit({ limitMin: 60, usage: { todaySeconds: 3700, monthSeconds: 3700, byProvider: {} }, limitReached: true })[2]).toMatch(/исчерпан — до полуночи/);
    const none = describeDailyLimit({ limitMin: 0, usage: { todaySeconds: 0, monthSeconds: 0, byProvider: {} }, limitReached: false });
    expect(none[0]).toBe('Сегодня: 0 минут.');
    expect(none[2]).toMatch(/Дневного лимита нет/);
    // the server is silent: no numbers, the rules stay
    expect(describeDailyLimit({ limitMin: 90, usage: null, limitReached: false })).toHaveLength(3);
  });

  it('the cost note of the live voice tells the idle rules, not «open all game»', () => {
    const status = describeVoice({ health: withLive, serverOnline: true, voiceKind: 'openai-live', preference: 'auto', muted: false });
    const text = status.details.join(' ');
    expect(text).toContain('через 2 минуты без ходов и слов ребёнка');
    expect(text).toContain('в фоновой вкладке — через 15 секунд');
    expect(text).not.toContain('всю игру');
  });
});

describe('text AI status', () => {
  it('order: подписка Codex → OpenRouter → OpenAI API → шаблоны', () => {
    expect(textAiProvider(aiOn({ llm: { codexCli: true, codexLoggedIn: true, openaiKey: true, openrouterKey: true } }))).toBe('codex');
    expect(textAiProvider(aiOn({ llm: { codexCli: true, codexLoggedIn: false, openaiKey: true, openrouterKey: true } }))).toBe('openrouter');
    expect(textAiProvider(aiOn({ llm: { codexCli: true, codexLoggedIn: false, openaiKey: true } }))).toBe('openai-api');
    expect(textAiProvider(aiOn())).toBe('template');
    expect(textAiProvider(null)).toBe('unknown');
  });

  it('writes a parent-friendly line for each provider and always names the fallback chain', () => {
    expect(describeTextAi(aiOn({ llm: { codexCli: true, codexLoggedIn: true, openaiKey: false } })).summary).toContain('подписке ChatGPT');
    const openrouter = describeTextAi(aiOn({ llm: { codexCli: false, codexLoggedIn: false, openaiKey: false, openrouterKey: true } }));
    expect(openrouter.summary).toContain('OpenRouter');
    expect(openrouter.details.join(' ')).toContain('только текст');
    expect(describeTextAi(withKey).summary).toContain('OpenAI API');
    const template = describeTextAi(aiOn());
    expect(template.summary).toContain('шаблонов');
    expect(template.details.join(' ')).toContain('codex login');
    const installed = describeTextAi(aiOn({ llm: { codexCli: true, codexLoggedIn: false, openaiKey: false } }));
    expect(installed.details.join(' ')).toContain('вход не выполнен');
    for (const health of [withKey, aiOn(), aiOn({ llm: { codexCli: true, codexLoggedIn: true, openaiKey: false } })]) {
      expect(describeTextAi(health).details.join(' ')).toContain('подписка Codex → OpenRouter → OpenAI API → готовые шаблоны');
    }
    expect(describeTextAi(null).tone).toBe('warn');
  });

  it('never promises «по вашей подписке» while codex is over its limit, logged out or failing', () => {
    const until = new Date(2026, 8, 23, 14, 5).getTime();
    const llm = { codexCli: true, codexLoggedIn: true, openaiKey: false, openrouterKey: true };
    const limited = aiOn({ llm: { ...llm, codexPaused: { reason: 'limit', until } } });
    expect(textAiProvider(limited)).toBe('openrouter');
    const text = describeTextAi(limited);
    expect(text.summary).not.toContain('подписке');
    expect(text.details[0]).toBe('Лимит подписки Codex сейчас исчерпан — примерно до 14:05 тексты пишет следующий по порядку способ.');
    expect(textAiProvider(aiOn({ llm: { ...llm, codexPaused: { reason: 'login', until } } }))).toBe('openrouter');
    expect(codexPauseRu(aiOn({ llm: { ...llm, codexPaused: { reason: 'login', until } } }))).toContain('codex login');
    expect(textAiProvider(aiOn({ llm: { ...llm, codexPaused: { reason: 'failing', until } } }))).toBe('openrouter');
    // no key either: the free templates — and no «вход не выполнен» for a codex that is logged in
    const alone = describeTextAi(aiOn({ llm: { codexCli: true, codexLoggedIn: true, openaiKey: false, codexPaused: { reason: 'limit', until } } }));
    expect(alone.summary).toContain('шаблонов');
    expect(alone.details.join(' ')).not.toContain('вход не выполнен');
    expect(alone.details[0]).toContain('Лимит подписки Codex');
  });

  it('a codex too slow for the first line still writes the reviews; the strategy goes to the paid API for a while', () => {
    const until = new Date(2026, 8, 23, 18, 30).getTime();
    const slow = aiOn({ llm: { codexCli: true, codexLoggedIn: true, openaiKey: false, openrouterKey: true, codexPaused: { reason: 'slow', until } } });
    expect(textAiProvider(slow)).toBe('codex');
    const text = describeTextAi(slow);
    expect(text.summary).toContain('подписке ChatGPT');
    expect(text.details[0]).toBe('Стратегию в начале партии сейчас подбирает OpenRouter или OpenAI API (платно): подписка Codex отвечала слишком долго. Примерно в 18:30 снова попробуем подписку.');
    // nothing faster configured: the strategy still waits for codex — nothing to say
    expect(codexPauseRu(aiOn({ llm: { codexCli: true, codexLoggedIn: true, openaiKey: false, codexPaused: { reason: 'slow', until } } }))).toBeNull();
    expect(codexPauseRu(aiOn({ llm: { codexCli: true, codexLoggedIn: true, openaiKey: false } }))).toBeNull();
  });
});

describe('puzzles line', () => {
  it('mentions the import command only for the starter set', () => {
    expect(describePuzzles(sampleHealth())).toContain('pnpm puzzles:import');
    const big = describePuzzles(sampleHealth({ puzzles: { count: 50155 } }));
    expect(big).not.toContain('pnpm');
    expect(big).toMatch(/50.155/);
    expect(describePuzzles(null)).toBeNull();
  });
});

describe('no generative AI in the child\'s game (docs/TEACHING.md §4.4)', () => {
  it('runtimeAiOf: only an explicit `ai.runtime: true`; absent (an old server) and offline are off', () => {
    expect(runtimeAiOf(aiOn())).toBe(true);
    expect(runtimeAiOf(sampleHealth({ ai: { runtime: false } }))).toBe(false);
    expect(runtimeAiOf(sampleHealth())).toBe(false);
    expect(runtimeAiOf(null)).toBe(false);
  });

  it('three voices: «Записанный голос» (the default), «Голос компьютера — черновик», «Без голоса» — no live voice, no key hint', () => {
    const options = aiOffVoiceOptions();
    expect(options.map((o) => o.id)).toEqual(['clips', 'browser', 'off']);
    expect(options.map((o) => o.title)).toEqual(['Записанный голос', 'Голос компьютера — черновик', 'Без голоса']);
    expect(options[0]?.subtitle).toContain('по умолчанию');
    expect(options.every((o) => !o.unavailable)).toBe(true);
    expect(options.map((o) => `${o.title} ${o.subtitle}`).join(' ')).not.toMatch(/OpenAI|\.env|ключ|микрофон[ау]? нуж/i);
    expect(AI_OFF_LINE).toBe('Живой голос выключен: в партии ребёнка ИИ не используется.');
  });

  it('the pressed tile: a stored AI voice shows as the voice that really speaks; the free choices stay', () => {
    for (const stored of ['auto', 'live', 'realtime'] as const) expect(aiOffVoiceChoice(stored)).toBe(AI_OFF_VOICE);
    for (const stored of ['clips', 'browser', 'off'] as const) expect(aiOffVoiceChoice(stored)).toBe(stored);
  });

  it('the voice status: the robot voice is a draft; the recorded one says the new phrases are not recorded yet; nothing about keys or money', () => {
    const robot = describeVoiceAiOff({ voiceKind: 'browser-tts', muted: false, serverOnline: true });
    expect(robot.summary).toContain('черновой');
    const clips = describeVoiceAiOff({ voiceKind: 'clips', muted: false, serverOnline: true });
    expect(clips.details).toContain(AI_OFF_CLIPS_NOTE);
    expect(AI_OFF_CLIPS_NOTE).toContain('не озвучено');
    const silent = describeVoiceAiOff({ voiceKind: 'silent', muted: false, serverOnline: true });
    expect(silent.tone).toBe('info');
    expect(describeVoiceAiOff({ voiceKind: 'clips', muted: true, serverOnline: true }).summary).toContain('кнопкой «Звук»');
    expect(describeVoiceAiOff({ voiceKind: 'clips', muted: false, serverOnline: false }).tone).toBe('warn');
    for (const status of [robot, clips, silent]) {
      const text = [status.summary, ...status.details].join(' ');
      expect(text).not.toMatch(/OPENAI_API_KEY|\$0,05|OpenAI/);
    }
  });

  it('reviews and themes are templates, whatever keys or Codex the server has', () => {
    const everything = sampleHealth({ llm: { codexCli: true, codexLoggedIn: true, openaiKey: true, openrouterKey: true }, ai: { runtime: false } });
    const status = describeTextAi(everything);
    expect(status.summary).toContain('готовых шаблонов');
    expect(status.details.join(' ')).toContain('ИИ в приложении выключен');
    expect(status.summary).not.toContain('подписке');
    expect(describeTextAi(sampleHealth()).summary).toContain('готовых шаблонов');
    // the server is silent: unknown, as before
    expect(describeTextAi(null).tone).toBe('warn');
  });
});
