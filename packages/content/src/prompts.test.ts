import { describe, expect, it } from 'vitest';
import type { GameRecord, MoveClass, MoveJudgement } from '@gambit/shared';
import { MASCOT } from './mascot.ts';
import { COACH_SYSTEM_PROMPT_RU, REVIEW_PROMPT_RU, TEACHER_ADDENDUM_RU, buildReviewPrompt } from './prompts.ts';
import { LATIN_RE, sentenceCount } from './testUtils.ts';

/** Leftovers of unfinished prompt templates. Square brackets / angle brackets are not used in our prompts at all. */
const PROMPT_PLACEHOLDER_RE = /\{\{|\}\}|\$\{|<[^>\n]*>|\[[^\]\n]*\]|TODO|FIXME|XXX|lorem ipsum|\bundefined\b|\bNaN\b/i;

describe('COACH_SYSTEM_PROMPT_RU', () => {
  it('has no placeholders and no Latin letters at all (language-drift guard)', () => {
    expect(COACH_SYSTEM_PROMPT_RU).not.toMatch(PROMPT_PLACEHOLDER_RE);
    expect(COACH_SYSTEM_PROMPT_RU).not.toMatch(LATIN_RE);
  });

  it('is compact enough for session instructions', () => {
    expect(COACH_SYSTEM_PROMPT_RU.length).toBeGreaterThan(3000);
    // (the «Учитель» section — strategy + brevity — brings it to ~11 100)
    expect(COACH_SYSTEM_PROMPT_RU.length).toBeLessThan(12_000);
  });

  it('defines a warm, lively persona', () => {
    expect(COACH_SYSTEM_PROMPT_RU).toContain(MASCOT.name);
    expect(COACH_SYSTEM_PROMPT_RU).toMatch(/жеребёнок-конь/);
    expect(COACH_SYSTEM_PROMPT_RU).toMatch(/чуть озорной/);
    expect(COACH_SYSTEM_PROMPT_RU).toMatch(/старший друг лет двенадцати/);
  });

  it('is a CONVERSATIONAL coach: own words, no read-out app phrases', () => {
    // a «say the app phrase closely / in full» policy would make every reply a template
    expect(COACH_SYSTEM_PROMPT_RU).not.toMatch(/дословно|близко к тексту|произноси целиком|Готовую реплику/);
    expect(COACH_SYSTEM_PROMPT_RU).toMatch(/СВОИМИ СЛОВАМИ, живо и каждый раз по-разному/);
    expect(COACH_SYSTEM_PROMPT_RU).toMatch(/Реагируй на то, что сказал ребёнок/);
    expect(COACH_SYSTEM_PROMPT_RU).toMatch(/Хвали старание и способ думать/);
  });

  it.each([
    ['Russian only', /ТОЛЬКО ПО-РУССКИ/],
    ['one to three short sentences', /ОТ ОДНОГО ДО ТРЁХ КОРОТКИХ ПРЕДЛОЖЕНИЙ/],
    ['silence is fine', /ТИШИНА — ЭТО НОРМАЛЬНО/],
    ['does not narrate moves on its own', /Сам ходы не комментируй/],
    ['the teacher mode sends a moment on almost every move — that is normal', /в режиме «Учитель» оно присылает его почти на каждом ходу, это нормально/],
    ['one prompt for all styles: the app decides how much to help', /Как много помогать, решает приложение/],
    ['the teacher leads, the child chooses', /В режиме «Учитель» ты сам ведёшь ученика: показываешь хорошие ходы и объясняешь почему, а выбирает он/],
    ['advice: the move and ONE reason by our strategy', /Совет учителя: назови ход и одну причину, зачем он по нашей стратегии/],
    ['never read out what everybody sees: clocks, colour, whose turn', /НИКОГДА НЕ ОЗВУЧИВАЙ ТО, ЧТО И ТАК ВИДНО НА ЭКРАНЕ: часы и сколько у кого осталось, каким цветом играет ученик, чей сейчас ход/],
    ['the only clock word is «Поторопись!» on request', /Про часы единственное исключение — когда приложение просит сказать «Поторопись!»/],
    // colour / whose move: only when the child asks — the facts carry them as an «only if asked» reference
    ['colour or whose move only to a direct question', /Если ученик сам спросил, каким цветом он играет или чей ход, — ответь в двух словах/],
    ['the teacher speaks one or two sentences, twenty words at most', /В режиме «Учитель» — одно-два, не больше двадцати слов/],
    ['the moment: only what «Цель» asks, nothing of its own', /Скажи только то, что просит «Цель», — не больше\. От себя ничего не добавляй: ни других фактов, ни похвалы, ни хода соперника, ни новой темы, ни вопроса/],
    ['one strategy per game, a new one every game', /В каждой партии одна стратегия[^\n]*Каждую партию — новая/],
    ['the game starts with ONE phrase: strategy, why, first move — no wishes; a hello only on request, one word', /В начале партии — ОДНА фраза: какую стратегию разыграем, зачем и первый ход\. Без пожеланий удачи[^\n]*Поздороваться — только если приложение об этом просит, и одним словом/],
    ['a second take-back offer in the same position: short, «и этот ход теряет…», no «опять»', /новый ход тоже что-то теряет, приложение предложит вернуть ход ещё раз[^\n]*«И этот ход теряет ферзя — давай ещё подумаем!» Без упрёка и без слова «опять»/],
    ['each turn ≤ 20 words, ONE reason — the plan\'s goal for a plan move; a defence or a tactic is never «the plan»', /ОДНО-ДВА КОРОТКИХ ПРЕДЛОЖЕНИЯ, НЕ БОЛЬШЕ ДВАДЦАТИ СЛОВ: ход из строки «Можно назвать» и ОДНА причина\. Причина хода нашего плана — цель плана; защиту, взятие, тактику планом не называй/],
    // (so that remarks do not all begin with «По нашему плану…»)
    ['every remark begins differently, as «Цель» asks — not always «По нашему плану»', /НАЧИНАЙ КАЖДЫЙ РАЗ ПО-РАЗНОМУ, как просит «Цель», а не всегда «По нашему плану»/],
    ['after a deviation the plan goes on: its goal', /Если соперник свернул с нашей дороги — одной фразой: план идёт дальше, назови его цель/],
    ['nothing of its own on a turn', /НИЧЕГО НЕ ДОБАВЛЯЙ ОТ СЕБЯ: ни похвалы, ни хода соперника, ни новой темы, ни вопроса/],
    ['a new topic is rare and is the reason itself', /Новая тема — редко, только когда её приносит приложение: она и есть причина хода/],
    ['never the whole plan again', /Весь план заново не пересказывай/],
    // the format «соперник сходил туда-то → по стратегии иди сюда → почему»: asked by «Цель» about every second turn
    ['the opponent\'s move only when «Цель» asks — then ONE phrase: his move in a few words and our answer', /Ход соперника — только если «Цель» просит: одной фразой, его ход и наш ответ/],
    ['«что выберешь?» only on request', /«Что выберешь\?» спрашивай, только если приложение об этом просит/],
    ['never invent chess facts', /НИКОГДА НЕ ВЫДУМЫВАЙ/],
    ['tools are the only source of chess truth', /ВЫЗОВИ ИНСТРУМЕНТ/],
    ['the model does not calculate chess itself', /ТЫ НЕ СЧИТАЕШЬ ШАХМАТЫ САМ/],
    ['«what if I play…» goes to the move check', /проверка хода «а если я пойду…»/],
    ['a checked move is never called the best', /Не говори, лучший ли это ход/],
    ['a move only from «Можно назвать» or a level-4 hint', /СВОЙ СОВЕТ — КОНКРЕТНЫЙ ХОД — НАЗЫВАЙ ТОЛЬКО ЕСЛИ ОН ЕСТЬ В СТРОКЕ «МОЖНО НАЗВАТЬ» СООБЩЕНИЯ ПРИЛОЖЕНИЯ или в подсказке четвёртой ступени/],
    ['«Можно назвать» is the only list of nameable moves', /«Можно назвать» — единственный список ходов ученика/],
    ['advice is «good», never «the best», no numbers', /не «лучшими», и без цифр/],
    ['no invented popularity', /«все так играют»/],
    ['briefs are recognised by their lines', /«Момент», «Факты», «Можно назвать», «Цель», «Нельзя»/],
    ['briefs are never read out', /НИКОГДА НЕ ЗАЧИТЫВАЙ/],
    ['app words are never spoken', /«можно назвать», «цель», «приложение», «сообщение», «бриф»/],
    ['the forbid line is binding', /Всё, что в строке «Нельзя», — нельзя/],
    ['silent notes stay silent', /Служебные заметки о ходах/],
    ['no Latin notation in speech', /НИКОГДА не произноси латинские буквы/],
    ['spoken squares', /а, бэ, цэ, дэ, е, эф, жэ, аш/],
    ['never ask for personal data', /НИКОГДА НЕ СПРАШИВАЙ личные данные/],
    ['off-topic redirect', /Вернёмся к доске/],
    ['unsafe requests are declined gently', /мягко откажи/],
    ['take-back only after consent', /ТОЛЬКО после ясного согласия/],
    ['the app decides about take-backs', /принимает приложение, а не ты/],
    ['never shame', /НИКОГДА не стыди/],
    ['call a parent when the child is upset', /позвать маму или папу/],
    ['no secrets from parents', /в секрете от родителей/],
    ['prompt-injection resistance', /забыть эти правила/],
    ['noise handling', /не отвечай и жди/],
  ])('hard rule: %s', (_name, re) => {
    expect(COACH_SYSTEM_PROMPT_RU).toMatch(re);
  });

  it('has 6–9 examples of good vs bad replies; good ones are short and name a move only from «Можно назвать»', () => {
    const examples = COACH_SYSTEM_PROMPT_RU.slice(COACH_SYSTEM_PROMPT_RU.indexOf('# Примеры'));
    const numbered = [...examples.matchAll(/^\d\. /gm)];
    expect(numbered.length).toBeGreaterThanOrEqual(6);
    expect(numbered.length).toBeLessThanOrEqual(9);
    const good = [...examples.matchAll(/Хорошо: «([^»]+)»/g)].map((m) => m[1] ?? '');
    const bad = [...examples.matchAll(/Плохо[^:]*: „([^“]+)“/g)].map((m) => m[1] ?? '');
    expect(good.length).toBeGreaterThanOrEqual(5);
    expect(bad.length).toBeGreaterThanOrEqual(numbered.length);
    const spokenSquare = /(?<![а-яё])(а|бэ|цэ|дэ|е|эф|жэ|же|аш) (один|два|три|четыре|пять|шесть|семь|восемь)(?![а-яё])/;
    // example 9 (the teacher's advice by the game's strategy) is the only one that names moves
    const teacher = examples.slice(examples.indexOf('9. Совет учителя'));
    const header = teacher.split('\n')[0] ?? '';
    const allowed = /Можно назвать: ([^»]+)»/.exec(header)?.[1] ?? '';
    expect(allowed).toMatch(/слон на цэ четыре \(зелёная стрелка\); пешка на цэ три \(синяя стрелка\)/);
    const teacherGood = /Хорошо: «([^»]+)»/.exec(teacher)?.[1] ?? '';
    expect(teacherGood).toMatch(/слона на цэ четыре/);
    // («соперник сходил туда-то → по стратегии иди сюда → почему» — asked by «Цель», in ONE phrase)
    expect(header).toMatch(/Цель: сначала ход соперника, потом наш ответ по плану/);
    expect(teacherGood).toMatch(/^Соперник вывел коня на эф шесть — а мы по плану /);
    const teacherBad = [...teacher.matchAll(/Плохо[^:]*: „([^“]+)“/g)].map((m) => m[1] ?? '');
    expect(teacherBad.some((b) => /^Соперник/.test(b) && /выберешь\?/.test(b) && sentenceCount(b) >= 4)).toBe(true);
    // every square it says is in the app's message (the advice, the opponent's move, the target)
    for (const sq of teacherGood.match(new RegExp(spokenSquare.source, 'g')) ?? []) expect(header, sq).toContain(sq);
    expect(sentenceCount(teacherGood)).toBeLessThanOrEqual(2);
    expect(teacherGood.split(/\s+/).filter((w) => /[а-яё]/i.test(w)).length).toBeLessThanOrEqual(20);
    expect(teacherGood).not.toMatch(/выбер|лучший ход/i);
    for (const phrase of good.filter((p) => p !== teacherGood)) {
      expect(sentenceCount(phrase), phrase).toBeLessThanOrEqual(3);
      expect(phrase, phrase).not.toMatch(spokenSquare);
      expect(phrase, phrase).not.toMatch(/лучший ход/i);
    }
    // the teacher's bad examples: the clock and the colour read out; «the best move» + an evaluation in numbers
    expect(bad.some((b) => /минут/.test(b) && /белыми/.test(b))).toBe(true);
    expect(bad.some((b) => /Лучший ход/.test(b) && /плюс ноль/.test(b))).toBe(true);
    // the bad side shows each failure mode: robotic, reveals the move, too long, narrates every move, shames
    expect(bad.some((b) => /Рекомендуется/.test(b))).toBe(true);
    expect(bad.some((b) => spokenSquare.test(b))).toBe(true);
    expect(bad.some((b) => sentenceCount(b) === 1 && b.length > 150)).toBe(true);
    expect(bad.some((b) => /Соперник пошёл/.test(b))).toBe(true);
    expect(bad.some((b) => /зевнул/.test(b))).toBe(true);
  });

  it('every quoted phrase outside the bad examples stays within three sentences', () => {
    const quoted = [...COACH_SYSTEM_PROMPT_RU.matchAll(/«([^»]+)»/g)].map((m) => m[1] ?? '');
    expect(quoted.length).toBeGreaterThan(15);
    for (const phrase of quoted) expect(sentenceCount(phrase), phrase).toBeLessThanOrEqual(3);
  });

  it('the teacher addendum is part of the prompt, Russian only, no clock words said as facts', () => {
    expect(COACH_SYSTEM_PROMPT_RU).toContain(TEACHER_ADDENDUM_RU);
    expect(TEACHER_ADDENDUM_RU).not.toMatch(LATIN_RE);
    expect(TEACHER_ADDENDUM_RU).not.toMatch(PROMPT_PLACEHOLDER_RE);
    expect(TEACHER_ADDENDUM_RU).not.toMatch(/минут|секунд|часы/);
  });

  it('never tells the model it is «not a teacher» or to keep the best move to hint level 4 only (TEACHER-MODE §0.2)', () => {
    expect(COACH_SYSTEM_PROMPT_RU).not.toMatch(/не учитель у доски/);
    expect(COACH_SYSTEM_PROMPT_RU).not.toMatch(/НЕ КОММЕНТИРУЙ КАЖДЫЙ ХОД/);
    expect(COACH_SYSTEM_PROMPT_RU).not.toMatch(/ЛУЧШИЙ ХОД НАЗЫВАЙ ТОЛЬКО/);
  });
});

describe('REVIEW_PROMPT_RU', () => {
  it('has no placeholders', () => {
    expect(REVIEW_PROMPT_RU).not.toMatch(PROMPT_PLACEHOLDER_RE);
    expect(REVIEW_PROMPT_RU.length).toBeGreaterThan(1500);
  });

  it('asks for a child part and a parent part, grounded only in the supplied judgements', () => {
    expect(REVIEW_PROMPT_RU).toContain('«Для юного шахматиста»');
    expect(REVIEW_PROMPT_RU).toContain('«Для родителей»');
    expect(REVIEW_PROMPT_RU).toMatch(/ЕДИНСТВЕННЫЙ источник шахматных фактов/);
    expect(REVIEW_PROMPT_RU).toMatch(/НЕ придумывай ходы/);
    expect(REVIEW_PROMPT_RU).toMatch(/judgements/);
    expect(REVIEW_PROMPT_RU).toMatch(/summary\.keyMoments/);
    expect(REVIEW_PROMPT_RU).toMatch(/не больше трёх/);
    expect(REVIEW_PROMPT_RU).toMatch(/Никакого стыда/);
    expect(REVIEW_PROMPT_RU).toMatch(/markdown/);
  });

  it('mentions only field names that exist in the GameRecord contract', () => {
    const record = makeRecord();
    const known = new Set<string>([
      ...Object.keys(record),
      ...Object.keys(record.summary),
      ...Object.keys(record.summary.counts),
      ...Object.keys(record.judgements[0] ?? {}),
      'allowedMotif',
      'missedMotif',
      'motif',
      'playedSan',
      'keyMoments',
      // payload sections added by buildReviewPrompt + StudentProfile fields
      'student',
      'nickname',
      'address',
      // MotifId values translated in the prompt
      'fork', 'pin', 'skewer', 'hangingPiece', 'freeCapture', 'badTrade', 'discoveredAttack', 'doubleCheck',
      'removeDefender', 'trappedPiece', 'backRankMate', 'mateIn1', 'mateIn2', 'mateIn3', 'promotion', 'kingSafety',
      'development', 'center',
      // classifications, generic words, notation examples
      'best', 'excellent', 'JSON', 'GameRecord', 'markdown', 'm', 'f', 'Nf3', 'Qxd5', 'xd5', 'f3',
    ]);
    const words = new Set([...REVIEW_PROMPT_RU.matchAll(/[A-Za-z][A-Za-z0-9]*/g)].map((m) => m[0]));
    const unknown = [...words].filter((w) => !known.has(w));
    expect(unknown).toEqual([]);
  });
});

describe('buildReviewPrompt', () => {
  it('appends a compact, parseable JSON payload after the instructions', () => {
    const record = makeRecord();
    const prompt = buildReviewPrompt({
      record,
      student: { nickname: 'Чемпион', address: 'f', stage: 2 },
      personaName: 'Саша',
    });
    expect(prompt.startsWith(REVIEW_PROMPT_RU)).toBe(true);

    const payload = JSON.parse(prompt.slice(REVIEW_PROMPT_RU.length)) as {
      game: Record<string, unknown>;
      student?: Record<string, unknown>;
      summary: unknown;
      judgements: { ply: number; classification: MoveClass; fenBefore?: string; bestPvSan: string[] }[];
      events: { type: string }[];
      pgn: string;
    };
    expect(payload.game.personaId).toBe('sasha');
    expect(payload.game.personaName).toBe('Саша');
    expect(payload.game.result).toBe('0-1');
    expect(payload.student).toEqual({ nickname: 'Чемпион', address: 'f', stage: 2 });
    expect(payload.summary).toEqual(record.summary);
    expect(payload.pgn).toBe(record.pgn);

    // bad moves are all there, plain good opening moves are not, bulky fields are dropped
    expect(payload.judgements.map((j) => j.ply)).toEqual([13, 17, 21]);
    expect(payload.judgements.every((j) => j.fenBefore === undefined)).toBe(true);
    expect(payload.judgements.every((j) => j.bestPvSan.length <= 3)).toBe(true);

    // only review-relevant events survive
    expect(payload.events.map((e) => e.type)).toEqual(['takebackOffered', 'takebackDeclined']);
  });

  it('never sends what the child said (privacy)', () => {
    const prompt = buildReviewPrompt({ record: makeRecord(), student: { nickname: 'Чемпион', address: 'f', stage: 2 } });
    expect(prompt).not.toContain('я хочу атаковать');
    expect(prompt).not.toContain('childSaid');
    expect(REVIEW_PROMPT_RU).toContain('Слова ребёнка в данные не входят');
  });

  it('never leaks more of the profile than nickname, address and stage', () => {
    const profileLike = { nickname: 'Чемпион', address: 'm' as const, stage: 1, weaknesses: ['secret'], totals: {} };
    const prompt = buildReviewPrompt({ record: makeRecord(), student: profileLike });
    expect(prompt).not.toContain('secret');
    expect(prompt).not.toContain('weaknesses');
  });

  it('works without the optional inputs', () => {
    const prompt = buildReviewPrompt({ record: makeRecord() });
    const payload = JSON.parse(prompt.slice(REVIEW_PROMPT_RU.length)) as { student?: unknown };
    expect(payload.student).toBeUndefined();
  });
});

describe('MASCOT', () => {
  it('is Гамбитик with a set of catchphrases', () => {
    expect(MASCOT.name).toBe('Гамбитик');
    expect(MASCOT.catchphrases.length).toBeGreaterThanOrEqual(8);
    expect(new Set(MASCOT.catchphrases).size).toBe(MASCOT.catchphrases.length);
  });

  it('all phrases are short, Russian, without notation, placeholders or gendered address', () => {
    const all = [...MASCOT.catchphrases, ...Object.values(MASCOT.phrases).flat()];
    for (const [situation, variants] of Object.entries(MASCOT.phrases)) {
      expect(variants.length, situation).toBeGreaterThanOrEqual(2);
    }
    for (const phrase of all) {
      expect(phrase, phrase).not.toMatch(LATIN_RE);
      expect(phrase, phrase).not.toMatch(PROMPT_PLACEHOLDER_RE);
      expect(phrase.length, phrase).toBeLessThanOrEqual(140);
      expect(sentenceCount(phrase), phrase).toBeLessThanOrEqual(3);
      expect(phrase, phrase).not.toMatch(/(?:^|[^а-яё])ты\s+(?:[а-яё-]+\s+){0,2}[а-яё]+(?:ал|ала|ил|ила|ел|ела|ёл|шла)(?![а-яё])/i);
    }
    expect(MASCOT.personality).not.toMatch(LATIN_RE);
  });
});

// ───────────────────────── fixtures ─────────────────────────

function judgement(ply: number, san: string, classification: MoveClass, winPctLoss: number): MoveJudgement {
  return {
    ply,
    color: 'w',
    san,
    uci: 'a2a3',
    fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    fenAfter: 'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1',
    evalBefore: { cp: 20, mate: null },
    evalAfter: { cp: -300, mate: null },
    winPctBefore: 52,
    winPctAfter: 52 - winPctLoss,
    winPctLoss,
    classification,
    accuracy: 100 - winPctLoss,
    bestUci: 'g1f3',
    bestSan: 'Nf3',
    bestPvSan: ['Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3'],
    refutationPvSan: ['Qxf2+', 'Kd1', 'Qxg2', 'Re1'],
    refutationPvUci: ['f6f2', 'e1d1', 'f2g2', 'h1e1'],
    allowedMotif: classification === 'blunder' ? 'hangingPiece' : undefined,
    materialLossPawns: classification === 'blunder' ? 3 : 0,
    confidence: 'confirmed',
  };
}

function makeRecord(): GameRecord {
  const counts: Record<MoveClass, number> = { best: 5, excellent: 2, good: 3, inaccuracy: 0, mistake: 1, blunder: 1, missedWin: 0 };
  return {
    id: 'g-1',
    startedAt: '2026-09-21T10:00:00.000Z',
    endedAt: '2026-09-21T10:12:00.000Z',
    personaId: 'sasha',
    timeControlId: 'rapid10',
    childColor: 'w',
    result: '0-1',
    termination: 'checkmate',
    pgn: '1. e4 e5 2. Nf3 Nc6 0-1',
    events: [
      { t: 0, type: 'gameStart', data: {} },
      { t: 1000, type: 'move', ply: 1, data: { san: 'e4' } },
      { t: 60_000, type: 'takebackOffered', ply: 13, data: { motif: 'hangingPiece' } },
      { t: 65_000, type: 'takebackDeclined', ply: 13, data: {} },
      { t: 66_000, type: 'coachSaid', ply: 13, data: { text: 'Хорошо, решение твоё!' } },
      { t: 70_000, type: 'childSaid', ply: 14, data: { text: 'я хочу атаковать' } },
      { t: 700_000, type: 'gameEnd', data: {} },
    ],
    judgements: [
      judgement(1, 'e4', 'best', 0),
      judgement(3, 'Nf3', 'best', 0),
      judgement(13, 'Bd3', 'blunder', 28),
      judgement(17, 'h3', 'mistake', 12),
      judgement(21, 'Rad1', 'excellent', 1),
    ],
    summary: {
      accuracy: 71,
      acpl: 64,
      counts,
      takebacksOffered: 1,
      takebacksAccepted: 0,
      hintsUsed: 0,
      motifsMissed: [],
      motifsAllowed: ['hangingPiece'],
      openingName: 'Итальянская партия',
      keyMoments: [
        {
          ply: 13,
          fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          playedSan: 'Bd3',
          bestSan: 'Nf3',
          classification: 'blunder',
          motif: 'hangingPiece',
          explanation: 'Слон остался без защиты.',
        },
      ],
    },
    examMode: false,
  };
}
