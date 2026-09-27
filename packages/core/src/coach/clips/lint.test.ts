import { describe, expect, it } from 'vitest';
import type { ClipCatalogLine } from '@gambit/shared';
import { catalogFallbacks, catalogUnits, expandWording, linePieces, usesGender, usesPiece } from './catalog.ts';
import { FIXTURE_CATALOG } from './fixtures.ts';
import { hasFeminineSelfReference, hasSpokenSquare, lintCatalog, lintLine, lintText } from './lint.ts';

const rules = (text: string, role: Parameters<typeof lintText>[1], opts: Parameters<typeof lintText>[2] = {}): string[] => lintText(text, role, opts).map((i) => i.rule);

describe('catalogue placeholders', () => {
  it('fills piece forms and agreement from the variant', () => {
    expect(expandWording('{Твой} {конь} под боем!', { piece: 'r' })).toBe('Твоя ладья под боем!');
    expect(expandWording('{Твой} {конь} под боем!', { piece: 'n' })).toBe('Твой конь под боем!');
    expect(expandWording('— нападаешь на {коня}!', { piece: 'b' })).toBe('— нападаешь на слона!');
    expect(expandWording('— нападаешь на {коня}!', { piece: 'r' })).toBe('— нападаешь на ладью!');
    expect(expandWording('нет {коня:gen}', { piece: 'r' })).toBe('нет ладьи');
    expect(expandWording('Ходи {конём}!', { piece: 'q' })).toBe('Ходи ферзём!');
    expect(expandWording('{Конь} {p:ушёл|ушла} вперёд.', { piece: 'p' })).toBe('Пешка ушла вперёд.');
    expect(expandWording('Защити {его}!', { piece: 'p' })).toBe('Защити её!');
    expect(expandWording('Помоги {своего} {коня}!', { piece: 'q' })).toBe('Помоги своего ферзя!');
  });

  it("fills the knight's own word: a knight jumps, the others go", () => {
    const t = 'Куда может {n:прыгнуть|пойти} {конь} соперника?';
    expect(expandWording(t, { piece: 'n' })).toBe('Куда может прыгнуть конь соперника?');
    expect(expandWording(t, { piece: 'q' })).toBe('Куда может пойти ферзь соперника?');
    expect(expandWording('{n:прыгнуть|пойти}', {})).toBeNull();
    expect(expandWording('{n:прыгнуть}', { piece: 'n' })).toBeNull();
    expect(usesPiece('{n:прыгнуть|пойти}')).toBe(true);
    expect(usesGender('{n:прыгнуть|пойти}')).toBe(false);
  });

  it('fills the child’s gender', () => {
    expect(expandWording('Найдёшь ход {g:сам|сама}?', { g: 'f' })).toBe('Найдёшь ход сама?');
    expect(expandWording('Найдёшь ход {g:сам|сама}?', { g: 'm' })).toBe('Найдёшь ход сам?');
  });

  it('refuses a placeholder without its variant, or an unknown one', () => {
    expect(expandWording('Соперник вывел {коня}.')).toBeNull();
    expect(expandWording('Найдёшь ход {g:сам|сама}?', { piece: 'n' })).toBeNull();
    expect(expandWording('Смотри {куда}!', { piece: 'n', g: 'm' })).toBeNull();
    expect(expandWording('Без подстановок.')).toBe('Без подстановок.');
  });

  it('knows which variants a wording needs', () => {
    expect(usesPiece('— нападаешь на {коня}!')).toBe(true);
    expect(usesPiece('{p:ушёл|ушла}')).toBe(true);
    expect(usesPiece('Найдёшь ход {g:сам|сама}?')).toBe(false);
    expect(usesGender('Найдёшь ход {g:сам|сама}?')).toBe(true);
    expect(usesGender('— нападаешь на {коня}!')).toBe(false);
    expect(linePieces({ byPiece: true })).toEqual(['p', 'n', 'b', 'r', 'q']);
    expect(linePieces({ byPiece: ['k', 'q'] })).toEqual(['k', 'q']);
    expect(linePieces({})).toEqual([]);
  });
});

describe('catalogUnits: what gets recorded, into which pools', () => {
  const line = (over: Partial<ClipCatalogLine>): ClipCatalogLine => ({ id: 'x.line', role: 'whole', wordings: [], ...over });

  it('a piece wording ×5, a plain wording once — in every pool', () => {
    const units = catalogUnits(line({ id: 'reason.attack', role: 'tail', byPiece: true, wordings: [{ t: '— нападаешь на {коня}!' }, { t: '— и сразу в атаку!', mood: 'excited' }] }));
    expect(units.map((u) => u.unitKey)).toEqual([
      'line:reason.attack@p#1',
      'line:reason.attack@n#1',
      'line:reason.attack@b#1',
      'line:reason.attack@r#1',
      'line:reason.attack@q#1',
      'line:reason.attack#2',
    ]);
    expect(units[1]).toMatchObject({ piece: 'n', pool: 'reason.attack@n', pools: ['reason.attack@n'], text: '— нападаешь на коня!', role: 'tail' });
    expect(units[5]).toMatchObject({ pool: 'reason.attack', pools: ['reason.attack', 'reason.attack@p', 'reason.attack@n', 'reason.attack@b', 'reason.attack@r', 'reason.attack@q'], mood: 'excited' });
  });

  it('a gendered wording ×2, a neutral one once — in both gender pools', () => {
    const units = catalogUnits(line({ id: 'ask.find', byGender: true, wordings: [{ t: 'Найдёшь ход {g:сам|сама}?' }, { t: 'Поищешь?' }] }));
    expect(units.map((u) => [u.unitKey, u.text, u.pools])).toEqual([
      ['line:ask.find/m#1', 'Найдёшь ход сам?', ['ask.find/m']],
      ['line:ask.find/f#1', 'Найдёшь ход сама?', ['ask.find/f']],
      ['line:ask.find#2', 'Поищешь?', ['ask.find', 'ask.find/m', 'ask.find/f']],
    ]);
  });

  it('a wording that cannot be expanded is kept with text null (the lint reports it)', () => {
    const units = catalogUnits(line({ wordings: [{ t: 'Соперник вывел {коня}.' }] }));
    expect(units).toHaveLength(1);
    expect(units[0]?.text).toBeNull();
  });

  it('collects the L3 siblings', () => {
    expect(catalogFallbacks(FIXTURE_CATALOG)).toEqual({ 'teach.head.advice': 'teach.head.arrow', 'reason.attack': 'reason.good' });
  });
});

describe('the lint (catalogue voice rules)', () => {
  it('Гамбитик is a boy: feminine self-reference is an error, masculine is right', () => {
    for (const bad of ['Я так рада!', 'Я заметила вилку.', 'Ой, я уже поняла!', 'Я готова играть!', 'А я знала, что ты найдёшь!', 'Рада тебя видеть!', 'Мне самой интересно.', 'Я не заметила.', 'Я же тебе говорила!', 'Я немного задремала…', 'Я сама удивилась!']) {
      expect({ bad, hit: hasFeminineSelfReference(bad) }).toEqual({ bad, hit: true });
      expect(rules(bad, 'whole')).toContain('selfFeminine');
    }
    for (const ok of ['Я рад!', 'Я заметил вилку.', 'Я готов играть!', 'Я уже соскучился по шахматам.', 'Ты нашла вилку!', 'Найдёшь ход сама?', 'Я вижу, ты сама нашла!', 'Я вижу ты нашла!', 'Моя очередь думать.', 'Мне понравилось!', 'Я так рад, что ты пришла!', 'Я знаю, как у тебя дела.']) {
      expect({ ok, hit: hasFeminineSelfReference(ok) }).toEqual({ ok, hit: false });
    }
  });

  it('no squares outside slots: opponent moves, dangers and treasures are named without squares', () => {
    expect(hasSpokenSquare('Соперник вывел коня на эф шесть.')).toBe(true);
    expect(hasSpokenSquare('Твоя пешка на бэ семь под боем!')).toBe(true);
    expect(hasSpokenSquare('Соперник вывел коня.')).toBe(false);
    expect(hasSpokenSquare('Смотри, тут подарок!')).toBe(false);
    expect(rules('Соперник вывел коня на эф шесть.', 'whole')).toContain('square');
    expect(rules('конь на эф шесть', 'slot')).toEqual([]);
  });

  it('no Latin, no unfilled placeholder', () => {
    expect(rules('Ходи Nf3!', 'whole')).toContain('latin');
    expect(rules('Ходи {конём}!', 'whole')).toContain('placeholder');
    expect(rules('   ', 'whole')).toEqual(['empty']);
  });

  it('length caps: whole ≤ 12 words / 80 chars, head ≤ 5, tail ≤ 8, bark ≤ 3', () => {
    expect(rules('Раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать.', 'whole')).toEqual([]);
    expect(rules('Раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать.', 'whole')).toContain('length');
    expect(rules('Очень-очень-очень-очень-очень длинное слово, которое никак не помещается в восемьдесят символов!', 'whole')).toContain('length');
    expect(rules('Раз два три четыре пять шесть —', 'head')).toContain('length');
    expect(rules('— раз два три четыре пять шесть семь восемь девять.', 'tail')).toContain('length');
    expect(rules('Ого, вот это да, ух!', 'bark')).toContain('length');
  });

  it('seams: a head ends with — or :, a tail starts with its join and ends the sentence, a whole line ends it', () => {
    expect(rules('Мой совет —', 'head')).toEqual([]);
    expect(rules('Попробуй так:', 'head')).toEqual([]);
    expect(rules('Мой совет', 'head')).toContain('join');
    expect(rules('— так мы давим на центр.', 'tail')).toEqual([]);
    expect(rules('так мы давим на центр.', 'tail')).toContain('join');
    expect(rules('— так мы давим на центр', 'tail')).toContain('end');
    expect(rules('Смотри, тут подарок', 'whole')).toContain('end');
    expect(rules('Хм…', 'bark')).toEqual([]);
  });

  it('the right piece word for each piece variant; none in a wording every piece shares', () => {
    expect(rules('— нападаешь на слона!', 'tail', { piece: 'b' })).toEqual([]);
    expect(rules('— нападаешь на коня!', 'tail', { piece: 'b' })).toContain('pieceWord');
    expect(rules('— и слон в атаке!', 'tail', { sharedByPieces: true })).toContain('pieceWord');
  });

  it('the fixture catalogue is clean', () => {
    expect(lintCatalog(FIXTURE_CATALOG)).toEqual([]);
  });

  it('reports variant misuse, duplicates, unknown fallbacks and fallback loops', () => {
    const lines: ClipCatalogLine[] = [
      { id: 'a', role: 'whole', fallback: 'b', wordings: [{ t: 'Соперник вывел {коня}.' }] },
      { id: 'b', role: 'whole', fallback: 'a', wordings: [{ t: 'Найдёшь ход {g:сам|сама}?' }] },
      { id: 'b', role: 'whole', wordings: [{ t: 'Ещё раз.' }] },
      { id: 'c', role: 'whole', fallback: 'nowhere', wordings: [] },
    ];
    const issues = lintCatalog(lines);
    const has = (line: string, rule: string): boolean => issues.some((i) => i.line === line && i.rule === rule);
    expect(has('a', 'variant')).toBe(true);
    expect(has('a', 'placeholder')).toBe(true);
    expect(has('b', 'variant')).toBe(true);
    expect(has('b', 'duplicate')).toBe(true);
    expect(has('a', 'fallback')).toBe(true); // a → b → a
    expect(has('c', 'fallback')).toBe(true);
    expect(has('c', 'empty')).toBe(true);
  });

  it('lints every expanded variant of a line', () => {
    const line: ClipCatalogLine = { id: 'danger', role: 'whole', byPiece: true, wordings: [{ t: '{Твой} {конь} под боем на эф четыре!' }] };
    const issues = lintLine(line);
    expect(issues.filter((i) => i.rule === 'square')).toHaveLength(5);
    expect(issues[0]?.unitKey).toBe('line:danger@p#1');
  });
});
