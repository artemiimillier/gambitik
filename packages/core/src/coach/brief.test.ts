import { describe, expect, it } from 'vitest';
import {
  FORBID_BEST_WORD,
  FORBID_MOVE_FOR_CHILD,
  FORBID_OTHER_MOVES,
  FORBID_POPULARITY,
  MAX_BRIEF_CHARS,
  MAX_TEACH_BRIEF_CHARS,
  capturedAlongRu,
  composeBrief,
  hangingListRu,
  materialBalanceRu,
  pawnsAccRu,
  spokenLineRu,
  stripLatinRu,
  studentWords,
  winChanceChangeRu,
  winChanceWordsRu,
} from './brief.ts';
import { hanging, queenBlunder } from './test-fixtures.ts';

describe('composeBrief', () => {
  it('builds the four lines, drops empty parts and ends sentences properly', () => {
    const text = composeBrief({
      moment: 'ученик сделал ход',
      facts: ['ход ученика: конь на эф три', null, '', false, 'на экране две кнопки: «Да» и «Нет»'],
      goal: ['похвали', 'Спроси, что дальше.'],
      forbid: ['не называй лучший ход', undefined],
    });
    expect(text).toBe(
      [
        'Момент: Ученик сделал ход.',
        'Факты: Ход ученика: конь на эф три. На экране две кнопки: «Да» и «Нет».',
        'Цель: Похвали; спроси, что дальше.',
        'Нельзя: Не называй лучший ход.',
      ].join('\n'),
    );
    expect(composeBrief({ moment: 'пауза', goal: 'молчи' })).toBe('Момент: Пауза.\nЦель: Молчи.');
  });

  it('never lets Latin letters through', () => {
    const text = composeBrief({ moment: 'соперник Peter сыграл Nf3', facts: ['ход Qxf7#'], goal: 'скажи e4' });
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(stripLatinRu('конь Nf3 на месте')).toBe('конь на месте');
    expect(stripLatinRu('просто текст')).toBe('просто текст');
  });
});

describe('words for the model', () => {
  it('pawns, material and chances in words, from the child\'s side', () => {
    expect(pawnsAccRu(1)).toBe('одну пешку');
    expect(pawnsAccRu(3)).toBe('три пешки');
    expect(pawnsAccRu(-8)).toBe('восемь пешек');
    expect(pawnsAccRu(21)).toBe('21 пешку');
    expect(materialBalanceRu({ material: { w: 39, b: 39, diff: 0 } }, 'w')).toBe('материал равный');
    expect(materialBalanceRu({ material: { w: 39, b: 36, diff: 3 } }, 'w')).toBe('материала у ученика больше на три пешки');
    expect(materialBalanceRu({ material: { w: 39, b: 36, diff: 3 } }, 'b', studentWords({ address: 'f' }))).toBe('материала у соперника больше на три пешки');
    expect(winChanceWordsRu(50)).toBe('позиция примерно равная');
    expect(winChanceWordsRu(95, studentWords({ address: 'f' }))).toBe('для ученицы позиция почти выигранная');
    expect(winChanceChangeRu(53, 8)).toBe('для ученика позиция была примерно равной, стала почти проигранной');
    expect(winChanceChangeRu(50, 55)).toBe('для ученика позиция по-прежнему примерно равная');
    expect(winChanceChangeRu(Number.NaN, 70)).toBe('для ученика позиция была примерно равной, стала хорошей');
  });

  it('spoken lines, captured pieces and hanging pieces never contain Latin', () => {
    const j = queenBlunder();
    expect(spokenLineRu(j.fenAfter, j.refutationPvSan)).toEqual(['конь бьёт на е пять']);
    expect(spokenLineRu('broken', ['e4'])).toEqual([]);
    expect(capturedAlongRu(j.fenAfter, j.refutationPvUci)).toEqual(['ферзя']);
    expect(hangingListRu([hanging('f3', 'n', 'w', 300), hanging('e5', 'p', 'b', 100), hanging('a2', 'p', 'w', 50)], 'w')).toBe('конь на эф три');
    expect(hangingListRu([], 'w')).toBeNull();
    const s = studentWords({ address: 'f' });
    expect([s.nom, s.gen, s.dat, s.acc, s.g('сделал', 'сделала')]).toEqual(['ученица', 'ученицы', 'ученице', 'ученицу', 'сделала']);
  });
});

describe('the teacher line «Можно назвать» (TEACHER-MODE §6.1)', () => {
  it('sits between «Факты» and «Цель», keeps its lower-case start, joins with «;» and ends with a dot', () => {
    const text = composeBrief({
      moment: 'ход ученика',
      facts: ['пешка на е четыре встаёт в центр'],
      advice: ['пешка на е четыре (зелёная стрелка)', null, '', 'пешка на дэ четыре (синяя стрелка)'],
      goal: 'спроси, какой ход выберет ученик',
      forbid: [FORBID_OTHER_MOVES],
    });
    expect(text.split('\n').map((l) => l.split(':')[0])).toEqual(['Момент', 'Факты', 'Можно назвать', 'Цель', 'Нельзя']);
    expect(text).toContain('\nМожно назвать: пешка на е четыре (зелёная стрелка); пешка на дэ четыре (синяя стрелка).\n');
  });

  it('is omitted when there is nothing to name, and never lets Latin through', () => {
    expect(composeBrief({ moment: 'пауза', advice: [], goal: 'молчи' })).toBe('Момент: Пауза.\nЦель: Молчи.');
    expect(composeBrief({ moment: 'ход', advice: ['Nf3 (зелёная стрелка)'], goal: 'цель' })).not.toMatch(/[A-Za-z]/);
  });

  it('the teacher constants are the spec wording, Latin-free', () => {
    expect(MAX_TEACH_BRIEF_CHARS).toBe(1000);
    expect(MAX_TEACH_BRIEF_CHARS).toBeLessThan(MAX_BRIEF_CHARS);
    expect(FORBID_OTHER_MOVES).toBe('не называй других ходов ученика, кроме строки «Можно назвать»');
    expect(FORBID_BEST_WORD).toBe('не говори «лучший ход» — говори «хороший», «сильный»; никаких цифр и оценок');
    expect(FORBID_POPULARITY).toBe('не говори, что «все так играют» или «самый популярный ход», если этого нет в фактах');
    expect(FORBID_MOVE_FOR_CHILD).toBe('не делай ход за ученика: решает он');
    for (const f of [FORBID_OTHER_MOVES, FORBID_BEST_WORD, FORBID_POPULARITY, FORBID_MOVE_FOR_CHILD]) expect(f).not.toMatch(/[A-Za-z]/);
  });
});
