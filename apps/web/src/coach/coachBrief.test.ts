import { describe, expect, it } from 'vitest';
import { TEACH_BRIEF_CHARS } from '@gambit/core';
import {
  BRIEF_RESPONSE_INSTRUCTIONS_RU,
  LIVE_APPEND_MAX_CHARS,
  MAIN_FIRST_RU,
  NO_OBVIOUS_RU,
  OWN_WORDS_RULE_RU,
  TEACH_MAX_SENTENCES,
  briefResponseInstructions,
  buildBriefCommentary,
  buildFactsAnswer,
  buildUrgentBriefCommentary,
  clarifyPieceMoveFacts,
  fitBrief,
  hintFacts,
  sentenceBudgetRu,
  teachMaxSentences,
  whyNotFacts,
} from './coachBrief.ts';
import { makeEvent } from './testUtils.ts';

const BRIEF = [
  'Момент: Ученик сделал ход, который теряет ферзя.',
  'Факты: Первый факт про ход. Второй факт про ответ соперника. Третий факт про материал. Четвёртый факт про кнопки.',
  'Цель: Мягко предложи вернуть ход.',
  'Нельзя: Не называй лучший ход.',
].join('\n');

describe('fitBrief: a long brief loses facts, never its goal or what must not be said', () => {
  it('a brief that fits becomes one line, unchanged otherwise', () => {
    expect(fitBrief(BRIEF, 1000)).toBe(BRIEF.replace(/\n/g, ' '));
  });

  it('drops fact sentences from the end until it fits', () => {
    const full = fitBrief(BRIEF, 1000);
    const fitted = fitBrief(BRIEF, full.length - 20);
    expect(fitted.length).toBeLessThanOrEqual(full.length - 20);
    expect(fitted).toContain('Факты: Первый факт про ход. Второй факт про ответ соперника. Третий факт про материал.');
    expect(fitted).not.toContain('Четвёртый');
    expect(fitted).toContain('Цель: Мягко предложи вернуть ход.');
    expect(fitted.endsWith('Нельзя: Не называй лучший ход.')).toBe(true);
  });

  it('cuts the first fact itself only when nothing else is left, keeping the other lines whole', () => {
    const fitted = fitBrief(BRIEF, 160);
    expect(fitted.length).toBeLessThanOrEqual(160);
    expect(fitted).toContain('Цель: Мягко предложи вернуть ход.');
    expect(fitted.endsWith('Нельзя: Не называй лучший ход.')).toBe(true);
  });

  it('a brief without a facts line (or hopelessly long other lines) is cut hard as the last resort', () => {
    const noFacts = 'Момент: ' + 'очень '.repeat(60) + 'длинно.\nЦель: Коротко.';
    const fitted = fitBrief(noFacts, 100);
    expect(fitted.length).toBeLessThanOrEqual(100);
    expect(fitted.endsWith('…')).toBe(true);
  });

  it('the Live frames never exceed the append limit, whatever the brief', () => {
    const huge = BRIEF.replace('Первый факт про ход.', 'Очень длинный факт. '.repeat(80));
    for (const content of [buildBriefCommentary(huge), buildUrgentBriefCommentary(huge)]) {
      expect(content.length).toBeLessThanOrEqual(LIVE_APPEND_MAX_CHARS);
      expect(content).toContain('Нельзя: Не называй лучший ход.');
      expect(content).toContain('Цель: Мягко предложи вернуть ход.');
    }
  });
});

describe('teacher mode (docs/TEACHER-MODE.md §2.7, §6.1, §7.1)', () => {
  const TEACH_BRIEF = [
    'Момент: соперник сыграл пешкой на е пять; ход ученика; ты в режиме «Учитель».',
    'Факты: Соперник поставил пешку в центр. Конь на эф три выходит в игру и нападает на пешку на е пять. Конь на цэ три тоже выходит в игру. План: слон на цэ четыре и рокировка.',
    'Можно назвать: конь на эф три (зелёная стрелка); конь на цэ три (синяя стрелка).',
    'Цель: покажи оба хода и чем они хороши; спроси, какой выберет ученик.',
    'Нельзя: не называй других ходов ученика, кроме строки «Можно назвать»; не говори «лучший ход».',
  ].join('\n');

  it('the sentence budget of a style: short 1, everything else two («коротко и понятно») — only teacher events carry one', () => {
    expect(TEACH_MAX_SENTENCES).toEqual({ short: 1, full: 2, concept: 2 });
    expect(teachMaxSentences({ teach: { moment: 'turn', style: 'short', ply: 1, advice: [] } })).toBe(1);
    expect(teachMaxSentences({ teach: { moment: 'turn', style: 'full', ply: 3, advice: [] } })).toBe(2);
    // the strategy intro / a new topic: two sentences at most, too
    expect(teachMaxSentences({ teach: { moment: 'openingPlan', style: 'concept', ply: 1, advice: [] } })).toBe(2);
    expect(teachMaxSentences({})).toBeUndefined();
    expect([1, 2, 3, 4, 5, 9, 0].map(sentenceBudgetRu)).toEqual([
      'одно короткое предложение',
      'одно–два коротких предложения',
      'одно–три коротких предложения',
      'до четырёх коротких предложений',
      'до пяти коротких предложений',
      'до пяти коротких предложений',
      'одно короткое предложение',
    ]);
  });

  it('frames: one or two sentences, never what the child sees (clock, colours, whose turn); the budget replaces it; Latin-free', () => {
    expect(buildBriefCommentary(TEACH_BRIEF)).toBe(buildBriefCommentary(TEACH_BRIEF, {}));
    expect(buildBriefCommentary(TEACH_BRIEF)).toMatch(/^Сейчас скажи ребёнку своими словами, коротко — одно–два предложения; не пересказывай очевидное — время на часах, цвет фигур, чей ход/);
    const short = buildBriefCommentary(TEACH_BRIEF, { maxSentences: 1 });
    // the word cap first (a live model stretches sentences to 30 words): 15 words for one sentence, 20 for two
    expect(short).toMatch(/^Сейчас скажи ребёнку своими словами одно короткое предложение, не больше; всего не больше пятнадцати слов; не пересказывай очевидное/);
    const two = buildBriefCommentary(TEACH_BRIEF, { maxSentences: 2 });
    expect(two).toMatch(/^Сейчас скажи ребёнку своими словами одно–два коротких предложения, не больше; всего не больше двадцати слов;/);
    // only what «Цель» asks (a model voices every extra the brief carries) — and the point first (fast play: a
    // remark cut after its first words has still said the move and why)
    expect(two).toMatch(/; скажи только то, что просит «Цель», — ничего от себя; начни с главного\. Не зачитывай это дословно: факты передай точно\. Ситуация: /);
    expect(short).toContain(`; ${MAIN_FIRST_RU}. `);
    // … and the hard cap once more AFTER the situation
    expect(short.endsWith(' Помни: не больше пятнадцати слов, одна фраза, ничего не добавляй от себя.')).toBe(true);
    expect(two.endsWith(' Помни: не больше двадцати слов, одна-две фразы, ничего не добавляй от себя.')).toBe(true);
    const urgentTwo = buildUrgentBriefCommentary(TEACH_BRIEF, { maxSentences: 2 });
    expect(urgentTwo).toMatch(/своими словами одно–два коротких предложения, не больше; всего не больше двадцати слов; не пересказывай очевидное/);
    expect(urgentTwo).toMatch(/факты передай точно, скажи только то, что просит «Цель», — ничего от себя\. Ситуация: /);
    expect(urgentTwo.endsWith(' Помни: не больше двадцати слов, одна-две фразы, ничего не добавляй от себя.')).toBe(true);
    // the ordinary (non-teacher) frames carry no tail
    expect(buildBriefCommentary(TEACH_BRIEF)).not.toMatch(/Помни:/);
    expect(briefResponseInstructions({ maxSentences: 2 })).toMatch(/Скажи только то, что просит «Цель», — ничего от себя; начни с главного\. Помни: не больше двадцати слов/);
    // the urgent frame and the ordinary ones do not carry it: an urgent phrase is never cut by the child's move
    for (const text of [urgentTwo, buildBriefCommentary(TEACH_BRIEF), briefResponseInstructions()]) expect(text).not.toContain(MAIN_FIRST_RU);
    expect(buildUrgentBriefCommentary(TEACH_BRIEF)).toMatch(/одно–два коротких предложения; не пересказывай очевидное/);
    expect(briefResponseInstructions()).toBe(BRIEF_RESPONSE_INSTRUCTIONS_RU);
    expect(BRIEF_RESPONSE_INSTRUCTIONS_RU).toMatch(/одно–два коротких предложения, живо и тепло, как весёлый старший друг; не пересказывай очевидное/);
    expect(briefResponseInstructions({ maxSentences: 1 })).toMatch(/своими словами, одно короткое предложение, не больше, живо/);
    // nothing in any frame asks for three or more sentences
    for (const text of [buildBriefCommentary('Момент: ход.'), buildUrgentBriefCommentary('Момент: ход.'), BRIEF_RESPONSE_INSTRUCTIONS_RU, OWN_WORDS_RULE_RU, buildFactsAnswer('Факт.')]) {
      expect(text).not.toMatch(/одно–три|четыр|пяти/);
      expect(text).toMatch(/очевидное|одно–два|Одно–два/);
    }
    for (const text of [short, two, buildUrgentBriefCommentary(TEACH_BRIEF, { maxSentences: 2 }), briefResponseInstructions({ maxSentences: 1 }), OWN_WORDS_RULE_RU, NO_OBVIOUS_RU]) {
      expect(text).not.toMatch(/[A-Za-z]/);
      expect(text).not.toMatch(/\d/);
    }
  });

  it('a teacher brief of the core\'s full budget reaches the model whole: the frame + its closing cap leave room for it', () => {
    // (the core fits a teacher brief to TEACH_BRIEF_CHARS and knows what it dropped; here nothing may be cut again)
    for (const maxSentences of [1, 2]) {
      for (const build of [buildBriefCommentary, buildUrgentBriefCommentary]) {
        const room = LIVE_APPEND_MAX_CHARS - build('', { maxSentences }).length;
        expect(room, `${build.name} ${maxSentences}`).toBeGreaterThanOrEqual(Math.max(TEACH_BRIEF_CHARS.full, TEACH_BRIEF_CHARS.concept, TEACH_BRIEF_CHARS.short));
      }
    }
  });

  it('fitBrief never cuts «Можно назвать», «Цель», «Нельзя» of a teacher brief — facts go first', () => {
    const huge = TEACH_BRIEF.replace('Соперник поставил пешку в центр.', 'Очень длинный факт о позиции. '.repeat(60));
    for (const content of [buildBriefCommentary(huge, { maxSentences: 2 }), buildUrgentBriefCommentary(huge, { maxSentences: 1 })]) {
      expect(content.length).toBeLessThanOrEqual(LIVE_APPEND_MAX_CHARS);
      expect(content).toContain('Можно назвать: конь на эф три (зелёная стрелка); конь на цэ три (синяя стрелка).');
      expect(content).toContain('Цель: покажи оба хода и чем они хороши; спроси, какой выберет ученик.');
      expect(content).toContain('Нельзя: не называй других ходов ученика, кроме строки «Можно назвать»; не говори «лучший ход».');
    }
  });

  it('hintFacts: a teacher\'s advice (teachTurn) has no ladder caveat — its moves may be named; a «treasure» names nothing', () => {
    const advice = makeEvent({ kind: 'teachTurn', brief: TEACH_BRIEF, teach: { moment: 'repeat', style: 'full', ply: 3, advice: [] } });
    for (const level of [1, 2, 3, 4] as const) {
      const facts = hintFacts(advice, level);
      expect(facts).toMatch(/^Совет учителя/);
      expect(facts).toContain('Можно назвать: конь на эф три');
      expect(facts).not.toMatch(/ступени|не называй ни ход, ни клетку/);
      expect(facts).toMatch(/называть можно/);
    }
    const treasure = makeEvent({ kind: 'teachTurn', text: 'Тут подарок! Найдёшь?', teach: { moment: 'turn', style: 'full', ply: 5, advice: [], reveal: 'later' } });
    expect(hintFacts(treasure, 1)).toMatch(/ход и клетку, куда идти, не называй/);
    // the ladder is unchanged for every other event
    const hint = makeEvent({ kind: 'hint', text: 'Что под боем?' });
    expect(hintFacts(hint, 2)).toMatch(/^Подсказка ступени 2 из четырёх: Что под боем\? На этой ступени не называй/);
    expect(hintFacts(hint, 4)).toMatch(/^Подсказка четвёртой, последней ступени/);
  });

  it('why-not texts are Russian only', () => {
    for (const piece of ['p', 'n', 'b', 'r', 'q', 'k'] as const) expect(clarifyPieceMoveFacts(piece)).not.toMatch(/[A-Za-z]/);
    expect(clarifyPieceMoveFacts('n')).toMatch(/про ход конём, но куда именно — непонятно/);
    expect(whyNotFacts('Ферзь на аш пять немного слабее совета.')).toMatch(/^Ребёнок спросил про свой вариант хода — сравни его с советом\. Факты: Ферзь на аш пять немного слабее совета\./);
  });
});
