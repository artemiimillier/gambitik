import { describe, expect, it } from 'vitest';
import type { CoachEvent } from '@gambit/shared';
import { clipInputOf, compileSentence, compileText, genericLineOf, slotGuardOf, splitSentences, stripName } from './compile.ts';
import { fixtureIndex } from './fixtures.ts';
import { fragKey } from './keys.ts';
import { planClips } from './plan.ts';
import type { CompiledSentence, CompiledUnit } from './types.ts';

const keys = (s: CompiledSentence): string[] => s.units.map((u) => `${u.kind}:${u.key}`);
const noJitter = { jitter: false, rng: () => 0.99 };

describe('names are stripped (clips never say names; the bubble keeps them)', () => {
  it.each([
    ['Миша, подожди — давай вернём ход!', 'Миша', 'Подожди — давай вернём ход!'],
    ['Привет, Маша!', 'Маша', 'Привет!'],
    ['С добрым утром, Тигр! О, это ты!', 'Тигр', 'С добрым утром! О, это ты!'],
    ['Привет-привет, Миша! Я Гамбитик, твой шахматный друг. Сыграем?', 'Миша', 'Привет-привет! Я Гамбитик, твой шахматный друг. Сыграем?'],
    ['Молодец, Миша, так держать!', 'Миша', 'Молодец, так держать!'],
    ['Миша! Смотри.', 'Миша', 'Смотри.'],
  ])('%s', (text, name, want) => {
    expect(stripName(text, name)).toBe(want);
  });

  it('leaves other words and a missing name alone', () => {
    expect(stripName('Янтарь, смотри!', 'Ян')).toBe('Янтарь, смотри!');
    expect(stripName('Сегодня твой соперник — Лёва.', 'Миша')).toBe('Сегодня твой соперник — Лёва.');
    expect(stripName('Привет, Маша!', '')).toBe('Привет, Маша!');
  });
});

describe('sentences and seams', () => {
  it('splits sentences at . ! ? … (three dots count as …)', () => {
    expect(splitSentences('Шах! Смотри на зелёную стрелку: король на же два. Найдёшь?')).toEqual(['Шах!', 'Смотри на зелёную стрелку: король на же два.', 'Найдёшь?']);
    expect(splitSentences('Хм... так-так')).toEqual(['Хм…', 'так-так']);
    expect(splitSentences('  ')).toEqual([]);
  });

  it('never splits at a comma; splits at — : ;', () => {
    const s = compileSentence('Смотри, тут подарок: есть вилка!');
    expect(keys(s)).toEqual(['frag:f:смотри, тут подарок|:', 'frag:f:есть вилка|!']);
    const t = compileSentence('Так тоже можно, но слабее; играем дальше — вперёд!');
    expect(keys(t)).toEqual(['frag:f:так тоже можно, но слабее|;', 'frag:f:играем дальше|—', 'frag:f:вперед|!']);
    expect(t.slotAt).toBe(-1);
  });

  it('keeps hyphenated words whole', () => {
    expect(keys(compileSentence('И-го-го! '))).toEqual(['frag:f:и-го-го|!']);
    expect(keys(compileSentence('Стоп-стоп, подожди — давай вернём ход!'))).toEqual(['frag:f:стоп-стоп, подожди|—', 'frag:f:давай вернем ход|!']);
  });
});

describe('square slots', () => {
  it('merges a lone piece word with its square into a whole move unit', () => {
    const s = compileSentence('Мой совет — конь на эф шесть.');
    expect(keys(s)).toEqual(['frag:f:мой совет|—', 'move:nom:n:f6']);
    expect(s.slotAt).toBe(1);
    expect((s.units[1] as Extract<CompiledUnit, { kind: 'move' }>).text).toBe('конь на эф шесть');
    expect(keys(compileSentence('Конём на эф шесть — так мы давим на центр.'))).toEqual(['move:ins:n:f6', 'frag:f:так мы давим на центр|.']);
    expect(keys(compileSentence('Вот он: конь бьёт на а восемь!'))).toEqual(['frag:f:вот он|:', 'move:cap:n:a8']);
  });

  it('keeps the piece word with the words before the square («Соперник вывел коня» · «на эф шесть»)', () => {
    const s = compileSentence('Соперник вывел коня на эф шесть.');
    expect(keys(s)).toEqual(['frag:f:соперник вывел коня|', 'square:sq:f6']);
    expect(s.units[0]).toMatchObject({ text: 'Соперник вывел коня', end: '' });
    const t = compileSentence('Ходи пешкой на эф пять — открываешь дорогу слону и ферзю.');
    expect(keys(t)).toEqual(['frag:f:ходи пешкой|', 'square:sq:f5', 'frag:f:открываешь дорогу слону и ферзю|.']);
    expect(t.slotAt).toBe(1);
    // an accusative piece word is never a move unit, even alone
    expect(keys(compileSentence('Смотри: коня на эф шесть.'))).toEqual(['frag:f:смотри|:', 'frag:f:коня|', 'square:sq:f6']);
  });

  it('words after the square keep the fragment end', () => {
    const s = compileSentence('Осторожно: твой конь на эф четыре под боем!');
    expect(keys(s)).toEqual(['frag:f:осторожно|:', 'frag:f:твой конь|', 'square:sq:f4', 'frag:f:под боем|!']);
    expect(keys(compileSentence('Мой совет был такой: слон на дэ два, шах.'))).toEqual(['frag:f:мой совет был такой|:', 'move:nom:b:d2', 'frag:f:шах|.']);
  });

  it('marks what can never be voiced from clips', () => {
    expect(compileSentence('Смотри на эф шесть.').bad).toBe('noPiece');
    expect(compileSentence('Зелёная стрелка — конь с же один на эф три, синяя — пешка бьёт на дэ пять.').bad).toBe('noPiece');
    expect(compileSentence('Держим центр пешками цэ пять и е пять — это наш план.').bad).toBe('bareSquare');
    expect(compileSentence('Хороший ход — пешка бьёт на дэ четыре — выгодно бьёшь пешку на дэ четыре: даже после размена ты в плюсе.').bad).toBe('twoSlots');
    expect(compileSentence('Вот мои варианты: слон на бэ пять, шах или пешка бьёт на дэ четыре — выбирай!').bad).toBe('twoSlots');
  });

  it('a square must be the target of a known advised move (else the sentence falls down the ladder)', () => {
    const ok = compileSentence('Хороший ход — конь бьёт на дэ пять: меняешься конями.', ['Nxd5']);
    expect(ok.bad).toBeUndefined();
    expect(ok.units[1]).toMatchObject({ kind: 'move', key: 'cap:n:d5', san: 'Nxd5' });
    expect(compileSentence('Осторожно: твой конь на эф четыре под боем!', ['Nxd5']).bad).toBe('mismatch');
    // the right square with the wrong piece is a mismatch too
    expect(compileSentence('Мой совет — слон на дэ пять.', ['Nd5']).bad).toBe('mismatch');
    // a treasure waiting to be found: no square at all
    expect(compileSentence('Смотри, тут подарок: конь на цэ шесть без защиты!', []).bad).toBe('mismatch');
    const sq = compileSentence('Ходи пешкой на эф пять — открываешь дорогу слону и ферзю.', ['f5']);
    expect(sq.units[1]).toMatchObject({ kind: 'square', key: 'sq:f5', san: 'f5' });
  });
});

describe('golden harvest lines (the harvest simulation)', () => {
  it('a plan move', () => {
    const c = compileText('Пешка на дэ четыре — это по плану: ставишь пешку в центр и открываешь дорогу слону и ферзю.', { generic: 'generic.teachTurn', known: ['d4', 'e4'] });
    expect(c.sentences.map(keys)).toEqual([['move:nom:p:d4', 'frag:f:это по плану|:', 'frag:f:ставишь пешку в центр и открываешь дорогу слону и ферзю|.']]);
  });

  it('a check and the move out of it', () => {
    const c = compileText('Шах! Смотри на зелёную стрелку: король на же два — уводишь короля от шаха.', { generic: 'generic.teachTurn', known: ['Kg2'] });
    expect(c.sentences.map(keys)).toEqual([['frag:f:шах|!'], ['frag:f:смотри на зеленую стрелку|:', 'move:nom:k:g2', 'frag:f:уводишь короля от шаха|.']]);
    expect(c.sentences[1]?.units[1]).toMatchObject({ san: 'Kg2', end: '—' });
  });

  it('a danger with a square beside the advice: the danger falls, the advice stays', () => {
    const c = compileText('Осторожно: твоя пешка на бэ семь под боем! Ходи пешкой на эф пять — открываешь дорогу слону и ферзю.', { generic: 'generic.teachTurn', known: ['f5'] });
    expect(c.sentences[0]?.bad).toBe('mismatch');
    expect(keys(c.sentences[1] as CompiledSentence)).toEqual(['frag:f:ходи пешкой|', 'square:sq:f5', 'frag:f:открываешь дорогу слону и ферзю|.']);
  });

  it('a treasure turn names no move', () => {
    const c = compileText('Смотри, тут подарок: есть вилка! Найдёшь ход сама?', { generic: 'generic.teachTurn', known: [] });
    expect(c.sentences.map(keys)).toEqual([['frag:f:смотри, тут подарок|:', 'frag:f:есть вилка|!'], ['frag:f:найдешь ход сама|?']]);
  });

  it('a teacher take-back offer with the child’s name', () => {
    const c = compileText('Миша, подожди — давай вернём ход и подумаем вместе! Так теряется фигура, а я советовал: конь бьёт на эф четыре.', { name: 'Миша', generic: 'generic.takebackOffer', known: ['Nxf4'] });
    expect(c.sentences.map((s) => s.text)).toEqual(['Подожди — давай вернём ход и подумаем вместе!', 'Так теряется фигура, а я советовал: конь бьёт на эф четыре.']);
    expect(c.sentences.map(keys)).toEqual([['frag:f:подожди|—', 'frag:f:давай вернем ход и подумаем вместе|!'], ['frag:f:так теряется фигура, а я советовал|:', 'move:cap:n:f4']]);
  });

  it('an opponent idea with a square and no advice named', () => {
    const c = compileText('Так тоже можно, но заметно слабее: соперник теперь выводит слона и нападает на ферзя на е семь.', { generic: 'generic.teachReaction', known: ['Ng5'] });
    expect(c.sentences[0]?.bad).toBe('mismatch');
    const free = compileText('Так тоже можно, но заметно слабее: соперник теперь выводит слона и нападает на ферзя на е семь.', { generic: 'generic.teachReaction' });
    expect(free.sentences.map(keys)).toEqual([['frag:f:так тоже можно, но заметно слабее|:', 'frag:f:соперник теперь выводит слона и нападает на ферзя|', 'square:sq:e7']]);
  });
});

describe('from an event', () => {
  const event = (over: Partial<CoachEvent>): CoachEvent => ({ id: 'e1', kind: 'teachTurn', priority: 1, text: '', bubbleText: '', pose: 'talk', pauseClock: true, ...over });

  it('prefers the clip twin when a builder set one', () => {
    const clip = { sentences: [{ items: [{ line: 'treasure.gift' }], prio: 100, end: '!' as const }], generic: 'generic.teachTurn.turn' };
    expect(clipInputOf(event({ text: 'Смотри, тут подарок!', clip }))).toBe(clip);
  });

  it('compiles the text otherwise, with the name stripped, the SAN guard and the generic line of the moment', () => {
    const e = event({
      text: 'Миша, мой совет — конь на эф три.',
      pose: 'think',
      teach: { moment: 'turn', style: 'full', ply: 1, advice: [{ uci: 'g1f3', san: 'Nf3', source: 'engine', arrow: 'green' }], reveal: 'now' },
    });
    const c = clipInputOf(e, { name: 'Миша' });
    expect(c).toMatchObject({ src: 'text', generic: 'generic.teachTurn.turn.think', bark: 'think', moment: 'turn' });
    if (!c || !('src' in c)) throw new Error('compiled');
    expect(c.sentences.map(keys)).toEqual([['frag:f:мой совет|—', 'move:nom:n:f3']]);
  });

  it('a lesson event (with `say`) has no clip input: the planner gives silence and the bubble shows the words', () => {
    const v3 = event({
      text: 'Центр ещё свободен — займём его пешкой.',
      say: [{ pool: 'v3.aim.centerPawn', n: 0 }, { pool: 'v3.go.move', n: 2, piece: 'p' }],
      teach: { moment: 'turn', style: 'full', ply: 1, advice: [{ uci: 'e2e4', san: 'e4', source: 'book', arrow: 'green' }], reveal: 'now' },
    });
    expect(clipInputOf(v3)).toBeNull();
    expect(clipInputOf(v3, { name: 'Миша' })).toBeNull();
    // even an empty `say` marks a lesson event; a stray twin on it is not voiced either
    const clip = { sentences: [{ items: [{ line: 'treasure.gift' }], prio: 100, end: '!' as const }], generic: 'generic.teachTurn.turn' };
    expect(clipInputOf(event({ text: 'Смотри!', say: [], clip }))).toBeNull();
    // the planner: nothing to play — never the generic line of the moment
    const idx = fixtureIndex({ frags: [['Центр ещё свободен —', '—']], slots: [] });
    const plan = planClips(clipInputOf(v3), idx, noJitter);
    expect(plan.clips).toEqual([]);
    expect(plan.stats.generic).toBe(0);
    expect(plan.heard).toBe('');
    // the same text without `say` (a builder's event of ../events.ts) is still compiled
    const legacy = clipInputOf(event({ text: 'Центр ещё свободен — займём его пешкой.' }));
    expect(legacy).toMatchObject({ src: 'text' });
  });

  it('the SAN guard: the advice; nothing while a treasure waits; no guard without teach', () => {
    expect(slotGuardOf({ teach: { moment: 'turn', style: 'full', ply: 3, advice: [{ uci: 'e2e4', san: 'e4', source: 'book', arrow: 'green' }, { uci: 'd2d4', san: 'd4', source: 'book', arrow: 'blue' }], reveal: 'now' } })).toEqual(['e4', 'd4']);
    expect(slotGuardOf({ teach: { moment: 'turn', style: 'full', ply: 3, advice: [], reveal: 'later' } })).toEqual([]);
    expect(slotGuardOf({})).toBeUndefined();
  });

  it('names generic lines by kind, moment and pose', () => {
    expect(genericLineOf('teachTurn', 'turn', 'think')).toBe('generic.teachTurn.turn.think');
    expect(genericLineOf('praise')).toBe('generic.praise');
    expect(genericLineOf('gameEnd', undefined, 'cheer')).toBe('generic.gameEnd.cheer');
  });
});

describe('the bridge through the planner', () => {
  const frags = [
    ['Мой совет —', '—'],
    ['так мы давим на центр.', '.'],
    ['Соперник вывел коня', ''],
    ['Ходи пешкой', ''],
    ['открываешь дорогу слону и ферзю.', '.'],
  ] as const;

  it('voices a compiled sentence exactly: fragment · slot · fragment', () => {
    const idx = fixtureIndex({ frags, slots: ['nom:n:f6', 'sq:f6'] });
    const plan = planClips(compileText('Мой совет — конь на эф шесть: так мы давим на центр.', { generic: 'generic.teachTurn' }), idx, noJitter);
    expect(plan.src).toBe('text');
    expect(plan.level).toBe(1);
    expect(plan.clips.map((c) => c.role)).toEqual(['frag', 'slot', 'frag']);
    expect(plan.heard).toBe('Мой совет — конь на эф шесть: так мы давим на центр.');
    expect(plan.clips.map((c) => c.gapBeforeMs)).toEqual([0, 280, 240]);
  });

  it('trims after the slot when only later units miss (L3) — never before it', () => {
    const idx = fixtureIndex({ frags: frags.filter(([t]) => t !== 'так мы давим на центр.'), slots: ['nom:n:f6'] });
    const plan = planClips(compileText('Мой совет — конь на эф шесть — так мы давим на центр.', { generic: 'generic.teachTurn' }), idx, noJitter);
    expect(plan.heard).toBe('Мой совет — конь на эф шесть.');
    expect(plan.level).toBe(3);
    expect(plan.misses).toContainEqual({ key: `frag:${fragKey('так мы давим на центр', '.')}`, level: 3 });
  });

  it('never drops a fragment before the slot: the core sentence becomes the generic line instead', () => {
    const idx = fixtureIndex({ frags: frags.filter(([t]) => t !== 'Мой совет —'), slots: ['nom:n:f6'] });
    const plan = planClips(compileText('Мой совет — конь на эф шесть — так мы давим на центр.', { generic: 'generic.teachTurn.turn' }), idx, noJitter);
    expect(plan.level).toBe(5);
    expect(plan.clips.map((c) => c.role)).toEqual(['generic']);
    expect(plan.heard).not.toContain('эф шесть');
  });

  it('never voices a slot without the fragment that carries its piece', () => {
    const idx = fixtureIndex({ frags: frags.filter(([t]) => t !== 'Соперник вывел коня'), slots: ['sq:f6'] });
    const plan = planClips(compileText('Соперник вывел коня на эф шесть.', { generic: 'generic.teachTurn' }), idx, noJitter);
    expect(plan.clips.every((c) => c.role !== 'slot')).toBe(true);
    expect(plan.level).toBe(5);
    const withPiece = planClips(compileText('Соперник вывел коня на эф шесть.', { generic: 'generic.teachTurn' }), fixtureIndex({ frags, slots: ['sq:f6'] }), noJitter);
    expect(withPiece.heard).toBe('Соперник вывел коня на эф шесть.');
    expect(withPiece.clips.map((c) => [c.role, c.gapBeforeMs])).toEqual([
      ['frag', 0],
      ['slot', 250],
    ]);
  });

  it('a merged move falls back to its split form (L2)', () => {
    const idx = fixtureIndex({ frags, slots: ['head:nom:n', 'sq:f6'] });
    const plan = planClips(compileText('Мой совет — конь на эф шесть.', { generic: 'generic.teachTurn' }), idx, noJitter);
    expect(plan.level).toBe(2);
    expect(plan.heard).toBe('Мой совет — конь — на эф шесть.');
    expect(plan.clips.map((c) => c.role)).toEqual(['frag', 'split', 'split']);
    expect(plan.stats.split).toBe(1);
  });

  it('the advised move is the core of a compiled text; a mismatching danger is just dropped', () => {
    const idx = fixtureIndex({ frags, slots: ['sq:f5'] });
    const text = 'Осторожно: твоя пешка на бэ семь под боем! Ходи пешкой на эф пять — открываешь дорогу слону и ферзю.';
    const plan = planClips(compileText(text, { generic: 'generic.teachTurn', known: ['f5'] }), idx, noJitter);
    expect(plan.heard).toBe('Ходи пешкой на эф пять — открываешь дорогу слону и ферзю.');
    expect(plan.mismatch).toBe(true);
    expect(plan.stats.dropped).toBe(1);
    expect(plan.level).toBe(4);
  });
});
