import { describe, expect, it } from 'vitest';
import type { EvRecord, GameRecord, TurnRecord } from './config.ts';
import { parseRun } from './report.ts';
import { beforeAfterMarkdown, boardInWords, chooseBeforeAfter, chooseSampleGames, cuesInWords, moveLabelRu, sampleIndexMarkdown, transcriptMarkdown } from './transcript.ts';

let n = 0;
function ev(game: string, text: string, o: Partial<EvRecord> = {}): EvRecord {
  return { t: 'ev', game, n: n++, afterPly: 0, ply: 1, atMs: 0, source: 'turn', moment: 'advice', kind: 'teachTurn', priority: 1, text, bubble: text, say: [], cues: [], ...o };
}

function turn(ply: number, o: Partial<TurnRecord> = {}): TurnRecord {
  return {
    ply,
    fen: '',
    moment: 'advice',
    advice: { uci: 'g1f3', san: 'Nf3' },
    adviceHidden: false,
    revealAfterMs: null,
    hints: [],
    quiz: null,
    reveal: null,
    buttons: [],
    move: { uci: 'g1f3', san: 'Nf3', how: 'arrow', arrowShown: true, thinkMs: 3000 },
    legacy: 'Мой совет — конь на эф три: выводишь коня.',
    ...o,
  };
}

function game(id: string, o: Partial<GameRecord> = {}): GameRecord {
  return {
    t: 'game',
    game: id,
    child: 1,
    stage: 1,
    gameNo: 1,
    seed: 1,
    name: 'Миша',
    address: 'm',
    childColor: 'w',
    tc: 'blitz5',
    persona: 'petya',
    strategyId: 'italian',
    strategyTitle: 'Итальянская партия',
    family: 'development',
    plies: [],
    turns: [],
    result: '1-0',
    termination: 'checkmate',
    takeaway: 'Сначала конь, потом слон.',
    takeawayKey: 'theme.development',
    events: 0,
    bookBytes: 100,
    legacyStart: 'В этот раз разыграем Итальянскую партию. Начни пешкой на е четыре.',
    ...o,
  };
}

describe('small words', () => {
  it('moves in Russian notation', () => {
    expect(moveLabelRu(1, 'Nf3')).toBe('1. Кf3');
    expect(moveLabelRu(2, 'Nc6')).toBe('1… Кc6');
    expect(moveLabelRu(9, 'O-O')).toBe('5. 0-0');
    expect(moveLabelRu(10, 'Qxh7#')).toBe('5… Фxh7#');
  });

  it('cues and boards in plain words', () => {
    expect(
      cuesInWords([
        { kind: 'move', sentence: 0, squares: ['g1', 'f3'], arrows: [{ from: 'g1', to: 'f3' }], tone: 'good', at: 'end' },
        { kind: 'attacks', sentence: 0, squares: ['d4', 'e5'], tone: 'good' },
        { kind: 'flank', sentence: 1, squares: [], tone: 'info' },
      ]),
    ).toBe('стрелка g1→f3 (после фразы); подсветка d4 e5 — куда будет бить фигура; фланг (не рисуется)');
    expect(boardInWords({ arrows: [{ from: 'e2', to: 'e4', color: 'green' }], highlights: [{ square: 'e4', color: 'yellow' }, { square: 'd4', color: 'yellow' }] })).toBe('зелёная стрелка e2→e4; подсветка e4 d4 (жёлтая)');
  });
});

describe('one game as a transcript', () => {
  const g = game('c2g04', {
    child: 2,
    stage: 2,
    gameNo: 4,
    name: 'Маша',
    address: 'f',
    childColor: 'b',
    tc: 'rapid10',
    persona: 'sonya',
    plies: [
      { by: 'bot', uci: 'e2e4', san: 'e4', thinkMs: 1000 },
      { by: 'child', uci: 'e7e5', san: 'e5', thinkMs: 3000 },
      { by: 'bot', uci: 'g1f3', san: 'Nf3', thinkMs: 1000 },
      { by: 'child', uci: 'b8c6', san: 'Nc6', thinkMs: 5000 },
      { by: 'bot', uci: 'f1c4', san: 'Bc4', thinkMs: 1000 },
      { by: 'child', uci: 'g8f6', san: 'Nf6', thinkMs: 3000 },
    ],
    turns: [
      turn(2, { advice: { uci: 'e7e5', san: 'e5' }, move: { uci: 'e7e5', san: 'e5', how: 'arrow', arrowShown: true, thinkMs: 3000 } }),
      turn(4, {
        moment: 'quiz',
        adviceHidden: true,
        advice: { uci: 'b8c6', san: 'Nc6' },
        quiz: { id: 'q4', kind: 'oppIdea', question: 'Что задумал соперник?', options: [{ id: 'attack', label: 'Нападает' }, { id: 'develop', label: 'Выводит фигуру' }, { id: 'center', label: 'Занимает центр' }], correctId: 'attack', how: 'right', pressed: 'attack', atMs: 4000 },
        move: { uci: 'b8c6', san: 'Nc6', how: 'arrow', arrowShown: true, thinkMs: 5000 },
      }),
      turn(6, { moment: 'quiet', advice: { uci: 'g8f6', san: 'Nf6' }, takeback: { uci: 'd8h4', san: 'Qh4', accepted: true, again: false }, move: { uci: 'g8f6', san: 'Nf6', how: 'retry', arrowShown: true, thinkMs: 3000 } }),
    ],
  });
  const events = [
    ev('c2g04', 'Сегодня главное — центр.', { source: 'start', moment: 'theme', afterPly: 1, ply: 2 }),
    ev('c2g04', 'Займём центр пешкой — так задумано.', { afterPly: 1, ply: 2, cues: [{ kind: 'move', sentence: 0, squares: [], arrows: [{ from: 'e7', to: 'e5' }], tone: 'good', at: 'end' }] }),
    ev('c2g04', 'Пешка в центре — теперь она смотрит на клетки соперника.', { source: 'reaction', moment: 'result', afterPly: 2, ply: 2 }),
    ev('c2g04', 'Как думаешь, что задумал соперник?', {
      moment: 'quiz',
      afterPly: 3,
      ply: 4,
      arrowHidden: true,
      quiz: { id: 'q4', kind: 'oppIdea', ply: 4, question: 'Как думаешь, что задумал соперник?', options: [{ id: 'attack', label: 'Нападает' }, { id: 'develop', label: 'Выводит фигуру' }, { id: 'center', label: 'Занимает центр' }], correctId: 'attack' },
    }),
    ev('c2g04', 'Верно! Конь напал на пешку.', { source: 'answer', moment: 'answer', afterPly: 3, ply: 4, atMs: 4000, pressed: { optionId: 'attack', label: 'Нападает', correct: true, how: 'right' } }),
    ev('c2g04', 'Ага.', { source: 'bark', moment: 'quiet', kind: 'bark', bubble: '', afterPly: 5, ply: 6, board: { arrows: [{ from: 'g8', to: 'f6', color: 'green' }], highlights: [] } }),
    ev('c2g04', 'Стоп-стоп! Ферзя могут съесть. Вернём ход?', { source: 'takebackOffer', moment: 'takeback', kind: 'takebackOffer', afterPly: 6, ply: 6 }),
    ev('c2g04', 'Хорошо, возвращаем.', { source: 'takebackReply', moment: 'takeback', kind: 'teachReaction', afterPly: 6, ply: 6 }),
    ev('c2g04', 'Напомню: ходим конём — он встанет ближе к центру.', { source: 'repeat', moment: 'repeat', afterPly: 6, ply: 6, atMs: 6000 }),
    ev('c2g04', 'Конь в игре!', { source: 'reaction', moment: 'result', afterPly: 6, ply: 6 }),
    ev('c2g04', 'Наша взяла! Сначала конь, потом слон.', { source: 'end', moment: 'end', kind: 'gameEnd', afterPly: 6, ply: 6 }),
  ];

  it('has the header, the start, the moves, the quiz, the quiet move, the take-back and the end', () => {
    const md = transcriptMarkdown(g, events);
    expect(md).toContain('# Партия c2g04: ступень 2, 10 минут, чёрные');
    expect(md).toContain('| Ученик | Маша (девочка), 4-я партия подряд |');
    expect(md).toContain('| Соперник | Соня |');
    expect(md).toContain('«Итальянская партия», семья «развитие»');
    expect(md).toContain('| Итог | поражение (мат), 6 полуходов |');
    expect(md).toContain('_Первым ходит соперник._');
    expect(md).toContain('**1. e4** (соперник)');
    expect(md).toContain('- **Гамбитик** (тема): «Сегодня главное — центр.»');
    expect(md).toContain('[доска: стрелка e7→e5 (после фразы)]');
    expect(md).toContain('**1… e5** (ты) — по стрелке');
    expect(md).toContain('кнопки: [Нападает] [Выводит фигуру] [Занимает центр] · верный ответ: «Нападает»');
    expect(md).toContain('[доска: стрелки пока нет]');
    expect(md).toContain('- _Ребёнок нажал «Нападает» — верно._');
    expect(md).toContain('(через 4 с, ответ на вопрос)');
    expect(md).toContain('_(молчит — стрелка на доске: зелёная стрелка g8→f6; короткий звук «Ага.»)_');
    expect(md).toContain('**3… Фh4** (ты) — этот ход потом вернули');
    expect(md).toContain('**3… Кf6** (ты) — второй раз, после возврата');
    expect(md.indexOf('Фh4')).toBeLessThan(md.indexOf('Стоп-стоп'));
    expect(md.indexOf('Напомню')).toBeLessThan(md.indexOf('**3… Кf6**'));
    expect(md).toContain('- **Гамбитик** (совет ещё раз, после возврата): «Напомню: ходим конём — он встанет ближе к центру.»');
    expect(md).not.toContain('Ребёнок нажал «Совет»');
    expect(md.indexOf('**3… Кf6**')).toBeLessThan(md.indexOf('Конь в игре!'));
    expect(md).toContain('## Конец партии');
    expect(md).toContain('- **Гамбитик**: «Наша взяла! Сначала конь, потом слон.»');
    expect(md).toContain('Главный вывод на карточке итога: «Сначала конь, потом слон.»');
    expect(md).not.toMatch(/\n{3,}/);
  });

  it('two take-backs in one position, a declined «и этот ход…», and the hints only until the advice is shown', () => {
    const g2 = game('c3g02', {
      child: 3,
      stage: 3,
      plies: [
        { by: 'child', uci: 'e2e4', san: 'e4', thinkMs: 3000 },
        { by: 'bot', uci: 'e7e5', san: 'e5', thinkMs: 1000 },
        { by: 'child', uci: 'b1c3', san: 'Nc3', thinkMs: 9000 },
      ],
      turns: [
        turn(1, { moment: 'treasure', adviceHidden: true, advice: { uci: 'e2e4', san: 'e4' }, hints: [{ atMs: 8000, board: { arrows: [], highlights: [{ square: 'e4', color: 'yellow' }] } }, { atMs: 15000, board: { arrows: [{ from: 'e2', to: 'e4', color: 'green' }], highlights: [] } }], hintsStopMs: 10000, reveal: { atMs: 10000, by: 'button' }, move: { uci: 'e2e4', san: 'e4', how: 'arrow', arrowShown: true, thinkMs: 16000 } }),
        turn(3, {
          advice: { uci: 'g1f3', san: 'Nf3' },
          takeback: {
            uci: 'd1h5',
            san: 'Qh5',
            accepted: true,
            again: true,
            tries: [
              { uci: 'd1h5', san: 'Qh5', offered: true, accepted: true, again: false },
              { uci: 'f1a6', san: 'Ba6', offered: true, accepted: false, again: true },
            ],
          },
          move: { uci: 'f1a6', san: 'Ba6', how: 'retry', arrowShown: true, thinkMs: 9000 },
        }),
      ],
    });
    g2.plies[2] = { by: 'child', uci: 'f1a6', san: 'Ba6', thinkMs: 9000 };
    const list = [
      ev('c3g02', 'Стоп! Что теперь может съесть соперник?', { source: 'takebackOffer', moment: 'takeback', afterPly: 3, ply: 3 }),
      ev('c3g02', 'Вовремя остановились — это главное! Ферзь без защиты.', { source: 'takebackReply', moment: 'takeback', afterPly: 3, ply: 3 }),
      ev('c3g02', 'Давай сходим конём — он встанет ближе к центру.', { source: 'repeat', moment: 'repeat', afterPly: 3, ply: 3 }),
      ev('c3g02', 'Погоди-ка, и так не выйдет. Что теперь может съесть соперник?', { source: 'takebackOffer', moment: 'takeback', afterPly: 3, ply: 3 }),
      ev('c3g02', 'Так и сыграем. Слон без защиты.', { source: 'takebackReply', moment: 'takeback', afterPly: 3, ply: 3 }),
    ];
    const md = transcriptMarkdown(g2, list);
    expect(md).toContain('через 8 с подсказка на доске');
    expect(md).not.toContain('через 15 с подсказка');
    expect(md).toContain('**2. Фh5** (ты) — этот ход потом вернули');
    expect(md).toContain('**2. Сa6** (ты) — Гамбитик снова предложил вернуть ход, ребёнок оставил');
    expect(md.indexOf('Вовремя остановились')).toBeLessThan(md.indexOf('**2. Сa6**'));
    expect(md.indexOf('**2. Сa6**')).toBeLessThan(md.indexOf('Погоди-ка'));
  });

  it('sample games: exact matches when they exist, the closest otherwise; «было → стало»', () => {
    const g1 = game('c1g01', { plies: [{ by: 'child', uci: 'g1f3', san: 'Nf3', thinkMs: 1 }], turns: [turn(1)] });
    const g7 = game('c1g07', { gameNo: 7, tc: 'rapid10' });
    const g4 = game('c4g05', { child: 4, stage: 4, gameNo: 5, tc: 'training' });
    const run = parseRun([
      ...events,
      g,
      ev('c1g01', 'Давай сходим конём — он встанет ближе к центру.', { ply: 1 }),
      g1,
      g7,
      ev('c4g05', 'Совет.', { moment: 'advice' }),
      g4,
    ]);
    const picks = chooseSampleGames(run);
    expect(picks.map((p) => [p.slot, p.game.game, p.exact])).toEqual([
      [1, 'c1g01', true],
      [2, 'c2g04', true],
      [3, 'c4g05', false],
      [4, 'c1g07', true],
    ]);
    expect(picks[2]?.note).toContain('в ней нет: мини-урок');
    const ba = chooseBeforeAfter(picks, run);
    expect(ba.length).toBeGreaterThan(0);
    const md = beforeAfterMarkdown(ba, picks);
    expect(md).toContain('**Было:** «Мой совет — конь на эф три: выводишь коня.»');
    expect(md).toContain('**Стало:** «Давай сходим конём — он встанет ближе к центру.»');
    expect(md).toContain('## Начало партии');
    expect(sampleIndexMarkdown(picks, { seed: 1, games: 4 })).toContain('(game1-blitz-stage1-white.md)');
  });
});
