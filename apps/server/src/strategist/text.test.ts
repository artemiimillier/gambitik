import { describe, expect, it } from 'vitest';
import { hasLatin, spokenProblem, spokenSquares, tidySentence, uciSquares, wordCount } from './text.ts';

describe('spoken text checks', () => {
  it('counts words, not dashes and quotes', () => {
    expect(wordCount('В этот раз разыграем Итальянскую партию — быстро выводим фигуры.')).toBe(9);
    expect(wordCount('  «Начни»  —  пешкой  ')).toBe(2);
    expect(wordCount('')).toBe(0);
  });

  it('finds the squares a phrase names, in every spoken form', () => {
    expect(spokenSquares('Начни пешкой на е четыре, потом конь на эф три.')).toEqual(['e4', 'f3']);
    expect(spokenSquares('Слон смотрит на слабую точку эф семь.')).toEqual(['f7']);
    expect(spokenSquares('ладья на аш один, ферзь на же-пять')).toEqual(['h1', 'g5']);
    expect(spokenSquares('клетка а семь и поле же два')).toEqual(['a7', 'g2']);
    // «а» / «же» as words of the sentence are not squares
    expect(spokenSquares('Это же три хода, а два коня уже в игре.')).toEqual([]);
    // no square inside another word («где четыре»)
    expect(spokenSquares('где четыре фигуры')).toEqual([]);
  });

  it('accepts a short warm Russian phrase', () => {
    const intro = 'В этот раз разыграем Итальянскую партию — быстро выводим фигуры и целимся в слабую точку. Начни пешкой на е четыре.';
    expect(spokenProblem(intro, { maxWords: 20, allowedSquares: new Set(['e2', 'e4']) })).toBeNull();
  });

  it('rejects what a child must not hear', () => {
    const check = { maxWords: 20 };
    expect(spokenProblem('', check)).toBe('empty');
    expect(spokenProblem('Начни ходом e4.', check)).toBe('Latin letters');
    expect(spokenProblem('Это плюс 0,3 для нас.', check)).toBe('digits');
    expect(spokenProblem('Раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать четырнадцать пятнадцать шестнадцать', { maxWords: 15 })).toMatch(/16 words/);
    expect(spokenProblem('Это лучший ход в позиции.', check)).toBe('«лучший ход»');
    expect(spokenProblem('У тебя осталось четыре минуты.', check)).toBe('the clock / time');
    expect(spokenProblem('Часы идут, думай быстрее.', check)).toBe('the clock / time');
    expect(spokenProblem('Ты играешь белыми, начинай.', check)).toBe('the colour of the pieces');
    expect(spokenProblem('Сейчас твой ход.', check)).toBe('whose turn it is');
    expect(spokenProblem('Движок советует коня.', check)).toBe('backstage words');
    expect(spokenProblem('Смотри **сюда**.', check)).toBe('markup characters');
    // «продвижение» is not the engine
    expect(spokenProblem('Продвижение пешки откроет слона.', check)).toBeNull();
  });

  it('rejects a square nobody allowed (an invented move)', () => {
    const allowed = new Set(['g1', 'f3']);
    expect(spokenProblem('Конь на эф три нападает на центр.', { maxWords: 15, allowedSquares: allowed })).toBeNull();
    expect(spokenProblem('Конь на эф три, а потом слон на цэ четыре.', { maxWords: 15, allowedSquares: allowed })).toMatch(/c4/);
  });

  it('tidies sentences and reads UCI squares', () => {
    expect(tidySentence('  выводим   коня ')).toBe('Выводим коня.');
    expect(tidySentence('Шах!')).toBe('Шах!');
    expect(uciSquares('e7e8q')).toEqual(['e7', 'e8']);
    expect(uciSquares('nonsense')).toEqual([]);
    expect(hasLatin('пешка на е четыре')).toBe(false);
  });
});
