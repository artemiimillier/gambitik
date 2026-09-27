import { describe, expect, it } from 'vitest';
import type { KeyMoment } from '@gambit/shared';
import { buildTemplateReview, moveClassLabelRu, moveNumberLabel, suggestPuzzleTheme, timesRu } from './review.ts';
import { PERSONA, backRankBlunder, bestMoveJudgement, counts, forkBlunder, gameRecord, judgement, profile, queenBlunder, summary } from './test-fixtures.ts';

describe('buildTemplateReview', () => {
  it('has every section in order', () => {
    const md = buildTemplateReview(gameRecord(), PERSONA, profile());
    const order = ['# Разбор партии: Миша — Петя', '## Результат', '## Точность', '| Качество хода | Сколько |', '## Ключевые моменты', '## Что получилось', '## Над чем поработать', '## Задачи на завтра'];
    let at = -1;
    for (const heading of order) {
      const next = md.indexOf(heading);
      expect(next, heading).toBeGreaterThan(at);
      at = next;
    }
    expect(md).toContain('_21.09.2026 · 10 минут · Миша играет белыми_');
    expect(md.endsWith('\n')).toBe(true);
    expect(md).not.toMatch(/undefined|NaN|\[object/);
  });

  it('states the result from the child\'s point of view', () => {
    expect(buildTemplateReview(gameRecord({ result: '0-1', childColor: 'w' }), PERSONA, profile())).toContain('**Поражение** — это тоже урок. Счёт 0-1 (мат).');
    expect(buildTemplateReview(gameRecord({ result: '0-1', childColor: 'b' }), PERSONA, profile())).toContain('**Победа!** Счёт 0-1 (мат).');
    expect(buildTemplateReview(gameRecord({ result: '1/2-1/2', termination: 'stalemate' }), PERSONA, profile())).toContain('**Ничья.** Счёт 1/2-1/2 (пат).');
    expect(buildTemplateReview(gameRecord({ result: '*', termination: 'abandoned' }), PERSONA, profile())).toContain('**Партия не доиграна.** Счёт — (партия не доиграна).');
    expect(buildTemplateReview(gameRecord({ examMode: true, timeControlId: 'training', childColor: 'b' }), PERSONA, profile())).toContain(
      'тренировка без часов · Миша играет чёрными · экзамен без подсказок',
    );
  });

  it('shows accuracy and the table of move-quality counts', () => {
    const md = buildTemplateReview(gameRecord(), PERSONA, profile());
    expect(md).toContain('**71%** — хорошая игра, есть куда расти.');
    for (const row of ['| Лучший ход ★ | 6 |', '| Отличный ход ✓ | 3 |', '| Хороший ход · | 8 |', '| Неточность ?! | 2 |', '| Ошибка ? | 1 |', '| Зевок ?? | 1 |', '| Упущенный шанс ◇ | 0 |']) {
      expect(md).toContain(row);
    }
    expect(md).toContain('Тренер предлагал вернуть ход: 1 (принято: 1). Подсказок: 1.');
  });

  it('describes a key moment: played vs best in Russian notation + motif explanation', () => {
    const md = buildTemplateReview(gameRecord(), PERSONA, profile());
    expect(md).toContain('### 1. Ход 12. h3 — зевок');
    expect(md).toContain('- Сыграно: **12. h3** ??');
    expect(md).toContain('- Сильнее было: **12. 0-0-0**');
    expect(md).toContain('- Тема: Вилка');
    expect(md).toContain('- Как мог ответить соперник: Кxc2+ Крd2 Кxa1');
    expect(md).toContain('Соперник получает вилку — одна его фигура нападает сразу на две твои.');
  });

  it('prefers the explanation written by the analysis module', () => {
    const rec = gameRecord();
    rec.summary.keyMoments[0]!.explanation = 'Конь прыгнул на цэ два и напал на короля и ладью.';
    const md = buildTemplateReview(rec, PERSONA, profile());
    expect(md).toContain('Конь прыгнул на цэ два и напал на короля и ладью.');
    expect(md).not.toContain('Соперник получает вилку');
  });

  it('shows at most three key moments', () => {
    const j = forkBlunder();
    const moment = (n: number): KeyMoment => ({ ply: n, fenBefore: j.fenBefore, playedSan: j.san, bestSan: j.bestSan, classification: 'mistake', explanation: `Момент ${n}.` });
    const md = buildTemplateReview(gameRecord({ summary: summary({ keyMoments: [1, 2, 3, 4, 5].map(moment) }) }), PERSONA, profile());
    expect(md).toContain('### 3. ');
    expect(md).not.toContain('### 4. ');
  });

  it('falls back to the costliest judged moves when the summary has no key moments', () => {
    const black = judgement({
      fen: 'r3k2r/ppp2ppp/8/8/3N4/8/PPP2PPP/R3K2R b KQkq - 0 12',
      played: 'h6',
      best: 'O-O-O',
      refutation: ['Nb5'],
      over: { ply: 24, winPctLoss: 25, missedMotif: 'kingSafety' },
    });
    const rec = gameRecord({
      judgements: [
        queenBlunder({ ply: 5, winPctLoss: 45 }),
        backRankBlunder({ ply: 59, winPctLoss: 50 }),
        black,
        forkBlunder({ ply: 23, winPctLoss: 12 }),
        queenBlunder({ ply: 7, winPctLoss: 4, classification: 'good' }),
      ],
      summary: summary({ keyMoments: [] }),
    });
    const md = buildTemplateReview(rec, PERSONA, profile());
    // three worst, in game order
    expect(md.indexOf('### 1. Ход 3. Фxe5+ — зевок')).toBeGreaterThan(0);
    expect(md.indexOf('### 2. Ход 12… h6')).toBeGreaterThan(md.indexOf('### 1.'));
    expect(md.indexOf('### 3. Ход 30. Лa7')).toBeGreaterThan(md.indexOf('### 2.'));
    expect(md).not.toContain('### 4.');
    expect(md).toContain('- Сильнее было: **12… 0-0-0**');
    expect(md).toContain('Был ход, после которого королю стало бы спокойнее.');
    expect(md).toContain('Появляется угроза мата на последней линии');
  });

  it('says so when there was nothing decisive', () => {
    const rec = gameRecord({ judgements: [], summary: summary({ keyMoments: [], motifsAllowed: [], counts: counts({ mistake: 0, blunder: 0 }) }) });
    const md = buildTemplateReview(rec, PERSONA, profile());
    expect(md).toContain('Решающих промахов в этой партии не было — так держать!');
    expect(md).toContain('Серьёзных промахов не было.');
    expect(md).toContain('Любые задачи по своему уровню');
  });

  it('lists strengths that the data supports, with gender', () => {
    const clean = summary({ takebacksAccepted: 2, takebacksOffered: 2, hintsUsed: 0, counts: counts({ blunder: 0 }), openingName: 'Итальянская партия' });
    const md = buildTemplateReview(gameRecord({ summary: clean }), PERSONA, profile({ address: 'f', nickname: 'Маша' }));
    expect(md).toContain('- Сильных ходов (лучших и отличных): 9 из 20.');
    expect(md).toContain('- Ни одного зевка за всю партию — внимательная игра.');
    // no journal proof of a better retry → no take-back claim at all
    expect(md).not.toMatch(/Вернула ход/);
    expect(md).toContain('- Дебют партии: Итальянская партия.');
    const rough = summary({ takebacksAccepted: 0, counts: counts({ best: 0, excellent: 0, blunder: 5 }) });
    expect(buildTemplateReview(gameRecord({ summary: rough }), PERSONA, profile())).toContain('- Старался и искал хорошие ходы — это главное.');
  });

  it('praises a take-back as «нашла лучше» only when the retry is provably better', () => {
    const attempt = queenBlunder({ ply: 5, winPctLoss: 45 });
    const better = judgement({ setup: ['e4', 'e5', 'Qh5', 'Nc6'], played: 'Nf3', best: 'Bc4', over: { ply: 5, winPctLoss: 3, classification: 'good' } });
    const accepted = { t: 10, type: 'takebackAccepted' as const, ply: 5, data: { uci: attempt.uci, san: attempt.san } };
    const s = summary({ takebacksAccepted: 1, takebacksOffered: 1 });
    const girl = profile({ address: 'f', nickname: 'Маша' });

    const improved = buildTemplateReview(gameRecord({ summary: s, judgements: [attempt, better], events: [accepted] }), PERSONA, girl);
    expect(improved).toContain('- Вернула ход и нашла продолжение лучше (1 раз) — отличная работа.');

    // the very same blunder replayed: neutral wording, no «нашла лучше»
    const same = buildTemplateReview(gameRecord({ summary: s, judgements: [attempt, queenBlunder({ ply: 5, winPctLoss: 45 })], events: [accepted] }), PERSONA, girl);
    expect(same).toContain('- Вернула ход и подумала ещё раз (1 раз) — полезная привычка.');
    expect(same).not.toMatch(/нашла продолжение лучше/);

    // a different but WORSE move is not an improvement either
    const worse = judgement({ setup: ['e4', 'e5', 'Qh5', 'Nc6'], played: 'Qxh7', best: 'Bc4', over: { ply: 5, winPctLoss: 60 } });
    const md = buildTemplateReview(gameRecord({ summary: s, judgements: [attempt, worse], events: [accepted] }), PERSONA, profile());
    expect(md).toContain('- Вернул ход и подумал ещё раз (1 раз) — полезная привычка.');
  });

  it('a proud moment is shown as the child\'s strong move — nothing was «сильнее», nobody «ответил»', () => {
    const j = bestMoveJudgement('fork', { ply: 23 });
    const proud: KeyMoment = { ply: j.ply, fenBefore: j.fenBefore, playedSan: j.san, bestSan: j.bestSan, classification: 'best', motif: 'fork', explanation: 'Красивая вилка — нападение сразу на две фигуры!' };
    const md = buildTemplateReview(gameRecord({ judgements: [j], summary: summary({ keyMoments: [proud] }) }), PERSONA, profile());
    expect(md).toContain('### 1. Ход 12. Кb5 — лучший ход');
    expect(md).toContain('- Сильный ход партии: **12. Кb5** ★');
    expect(md).toContain('Красивая вилка');
    expect(md).not.toContain('Сильнее было');
    expect(md).not.toContain('Как мог ответить соперник');
  });

  it('keeps English opening names and internal ids out of the Russian text', () => {
    const english = buildTemplateReview(gameRecord({ summary: summary({ openingName: 'Goldsmith Defense' }) }), PERSONA, profile());
    expect(english).not.toContain('Goldsmith');
    expect(english).not.toContain('Дебют партии');
    const md = buildTemplateReview(gameRecord({ summary: summary({ motifsAllowed: ['hangingPiece'] }) }), PERSONA, profile());
    expect(md).not.toMatch(/`[A-Za-z]+`/);
    expect(md).not.toMatch(/hangingPiece|removeDefender/);
  });

  it('turns allowed / missed motifs into growth points and a puzzle theme', () => {
    const s = summary({ motifsAllowed: ['hangingPiece', 'hangingPiece', 'removeDefender'], motifsMissed: ['mateIn1', 'hangingPiece'] });
    const md = buildTemplateReview(gameRecord({ summary: s }), PERSONA, profile());
    expect(md).toContain('- **Фигура без защиты** (соперник смог это использовать).');
    expect(md).toContain('- **Уничтожение защитника** (соперник смог это использовать).');
    expect(md).toContain('- **Мат в один ход** (спрятанное сокровище — такой ход был на доске).');
    expect(md).toContain('Тема: **Фигура без защиты**. Пяти–шести задач хватит.');
  });

  it('an unjudged game (the engine could not start) claims neither 0% accuracy nor a flawless game', () => {
    const rec = gameRecord({
      judgements: [],
      summary: summary({ accuracy: 0, acpl: 0, keyMoments: [], motifsAllowed: [], counts: counts({ best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 }) }),
    });
    const md = buildTemplateReview(rec, PERSONA, profile());
    expect(md).toContain('движок не смог проверить ходы');
    expect(md).not.toContain('**0%**');
    expect(md).not.toContain('| Качество хода |');
    expect(md).not.toContain('Решающих промахов в этой партии не было');
    expect(md).not.toContain('Серьёзных промахов не было');
    expect(md).not.toMatch(/undefined|NaN/);
  });

  it('works without a nickname', () => {
    expect(buildTemplateReview(gameRecord(), PERSONA, profile({ nickname: ' ' }))).toContain('# Разбор партии: Ученик — Петя');
  });

  it('never shames', () => {
    const md = buildTemplateReview(gameRecord(), PERSONA, profile());
    expect(md).not.toMatch(/плох|глуп|ужасн|стыд|слаб/i);
  });
});

describe('helpers', () => {
  it('moveNumberLabel', () => {
    expect(moveNumberLabel('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe('1.');
    expect(moveNumberLabel('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1')).toBe('1…');
    expect(moveNumberLabel('garbage')).toBe('1.');
  });

  it('moveClassLabelRu', () => {
    expect(moveClassLabelRu('blunder')).toBe('Зевок');
    expect(moveClassLabelRu('missedWin')).toBe('Упущенный шанс');
  });

  it('timesRu', () => {
    expect([1, 2, 4, 5, 11, 12, 21, 22, 25].map(timesRu)).toEqual(['1 раз', '2 раза', '4 раза', '5 раз', '11 раз', '12 раз', '21 раз', '22 раза', '25 раз']);
  });

  it('suggestPuzzleTheme', () => {
    expect(suggestPuzzleTheme(summary({ motifsAllowed: ['removeDefender'] }))).toEqual({ theme: 'capturingDefender', title: 'Уничтожение защитника', motif: 'removeDefender' });
    // no puzzle theme for "development" → next usable motif
    expect(suggestPuzzleTheme(summary({ motifsAllowed: ['development'], motifsMissed: ['pin'] }))?.theme).toBe('pin');
    expect(suggestPuzzleTheme(summary({ motifsAllowed: ['development', 'center'], motifsMissed: [] }))).toBeUndefined();
    expect(suggestPuzzleTheme(summary({ motifsAllowed: [], motifsMissed: [] }))).toBeUndefined();
  });
});
