/**
 * «Дозапись голоса» for the builders' events: a whole catalogue sentence as request ids and back — the same keys, words
 * and pools as the catalogue (and so the starter set, tier `pilot`) has, one lookup for the lesson and catalogue
 * namespaces, and which wording a twin's bubble shows.
 */
import { describe, expect, it } from 'vitest';
import type { ClipGenLine, ClipItem, ClipUtterance } from '@gambit/shared';
import { LESSON_LINES } from '@gambit/content';
import { catalogUnits } from './catalog.ts';
import { CLIP_CATALOG } from './catalog.ru.ts';
import {
  cheapestLineWording,
  isExcludedLine,
  lineKeyPlaceholderWords,
  lineKeyText,
  lineKeyTwins,
  lineRequestOf,
  lineUnitKeyOf,
  lineWordingOf,
  lineWordingText,
  parseLineUnitKey,
  resolveClipGenLine,
  spokenLineOf,
  twinWordingsOf,
} from './lines.ts';

const lineOf = (u: { line: string; wording: number; piece?: ClipGenLine['piece']; g?: 'm' | 'f' }): ClipGenLine => ({
  id: u.line,
  n: u.wording,
  ...(u.piece ? { piece: u.piece } : {}),
  ...(u.g ? { g: u.g } : {}),
});

describe('a catalogue unit as request ids', () => {
  it('every unit of the catalogue round-trips: the same key, words and pools', () => {
    let recordable = 0;
    for (const line of CLIP_CATALOG) {
      for (const u of catalogUnits(line)) {
        const l = lineOf(u);
        expect(lineWordingText(l), u.unitKey).toBe(u.text);
        expect(lineUnitKeyOf(l)).toBe(u.unitKey);
        const r = resolveClipGenLine(l);
        const want = line.role === 'whole' && !isExcludedLine(line.id);
        expect(r.ok, u.unitKey).toBe(want);
        if (r.ok) {
          recordable++;
          expect(r.unit).toEqual(u);
          // the web's normalisation of a twin item gives back exactly these ids
          expect(lineRequestOf({ line: line.id, ...(u.piece ? { piece: u.piece } : {}), ...(u.g ? { g: u.g } : {}) }, u.wording)).toEqual(l);
        }
        // the key names the same words for the tools
        expect(lineKeyText(u.unitKey)).toBe(u.text);
      }
    }
    expect(recordable).toBeGreaterThan(500);
  });

  it('the lesson and catalogue namespaces never meet', () => {
    expect(CLIP_CATALOG.filter((l) => l.id.startsWith('v3.')).map((l) => l.id)).toEqual([]);
    expect(LESSON_LINES.filter((l) => !l.id.startsWith('v3.')).map((l) => l.id)).toEqual([]);
    expect(spokenLineOf('v3.lead.advice')).toMatchObject({ source: 'lesson', role: 'lead' });
    expect(spokenLineOf('greet.hello.day')).toMatchObject({ source: 'catalog', role: 'whole', pieces: [], byGender: false });
    expect(spokenLineOf('ask.opp.hanging')).toMatchObject({ source: 'catalog', pieces: ['p', 'n', 'b', 'r', 'q'] });
    expect(spokenLineOf('no.such.line')).toBeUndefined();
    // a lesson id is never a catalogue sentence, even when asked as one
    expect(resolveClipGenLine({ id: 'v3.whole.castle', n: 1 })).toEqual({ ok: false, problem: 'lesson' });
  });

  it('refuses what may never be recorded as a whole catalogue sentence', () => {
    const problem = (l: ClipGenLine): string => {
      const r = resolveClipGenLine(l);
      return r.ok ? 'ok' : r.problem;
    };
    expect(problem({ id: 'greet.hello.day', n: 1 })).toBe('ok');
    expect(problem({ id: 'no.such.line', n: 1 })).toBe('unknown');
    expect(problem({ id: 'teach.head.advice', n: 1 })).toBe('role');
    expect(problem({ id: 'reason.fork', n: 1 })).toBe('role');
    expect(problem({ id: 'bark.cheer', n: 1 })).toBe('bark');
    expect(problem({ id: 'generic.greeting', n: 1 })).toBe('excluded');
    expect(problem({ id: 'generic', n: 1 })).toBe('excluded');
    expect(problem({ id: 'preview', n: 1 })).toBe('excluded');
    expect(problem({ id: 'greet.hello.day', n: 0 })).toBe('bad-n');
    expect(problem({ id: 'greet.hello.day', n: 99 })).toBe('bad-n');
    expect(problem({ id: 'greet.hello.day', n: 1.5 })).toBe('bad-n');
    // a variant the wording does not use, or misses
    expect(problem({ id: 'greet.hello.day', n: 1, piece: 'n' })).toBe('variant');
    expect(problem({ id: 'greet.hello.day', n: 1, g: 'f' })).toBe('variant');
    expect(problem({ id: 'greet.win', n: 1 })).toBe('variant');
    expect(problem({ id: 'greet.win', n: 2, g: 'f' })).toBe('variant');
    expect(problem({ id: 'ask.opp.hanging', n: 1 })).toBe('variant');
    expect(problem({ id: 'ask.opp.hanging', n: 3, piece: 'n' })).toBe('variant');
    // the line is not recorded for the king
    expect(problem({ id: 'ask.opp.hanging', n: 1, piece: 'k' })).toBe('piece');
    expect(problem({ id: 'ask.opp.hanging', n: 1, piece: 'q' })).toBe('ok');
    // the text itself is fine for any role (the planner plays a W line by it)
    expect(lineWordingText({ id: 'teach.head.advice', n: 1 })).toBe('Мой совет —');
    expect(lineWordingText({ id: 'greet.win', n: 1, g: 'f' })).toBe('В прошлый раз ты победила — здорово! Сыграем ещё?');
    expect(lineWordingText({ id: 'greet.win', n: 1 })).toBeNull();
  });

  it("normalises a twin's item to the wording's own variant", () => {
    expect(lineRequestOf({ line: 'greet.win', g: 'f' }, 1)).toEqual({ id: 'greet.win', n: 1, g: 'f' });
    // a plain wording of a gendered line is one recording for both
    expect(lineRequestOf({ line: 'greet.win', g: 'f' }, 2)).toEqual({ id: 'greet.win', n: 2 });
    expect(lineRequestOf({ line: 'ask.opp.hanging', piece: 'n' }, 1)).toEqual({ id: 'ask.opp.hanging', n: 1, piece: 'n' });
    expect(lineRequestOf({ line: 'ask.opp.hanging', piece: 'n' }, 3)).toEqual({ id: 'ask.opp.hanging', n: 3 });
    // the wording needs a variant the item does not carry
    expect(lineRequestOf({ line: 'ask.opp.hanging' }, 1)).toBeNull();
    expect(lineRequestOf({ line: 'greet.win' }, 1)).toBeNull();
    // never recorded on demand, though a W wording exists
    expect(lineRequestOf({ line: 'preview' }, 1)).toBeNull();
    expect(lineWordingOf({ line: 'preview' }, 1)).toEqual({ id: 'preview', n: 1 });
    expect(lineRequestOf({ line: 'generic.greeting' }, 1)).toBeNull();
    expect(lineRequestOf({ line: 'v3.whole.castle' }, 1)).toBeNull();
  });

  it('the cheapest wording: no placeholder first, then the fewest price blocks, then the lowest number; blocked keys skipped', () => {
    // «В прошлый раз ты {g:победил|победила}…» is gendered; «Помню твою прошлую победу. Поехали дальше?» is for both
    expect(cheapestLineWording({ line: 'greet.win', g: 'f' })).toBe(2);
    expect(cheapestLineWording({ line: 'greet.win', g: 'f' }, { skip: (key) => key === 'line:greet.win#2' })).toBe(4);
    expect(cheapestLineWording({ line: 'ask.opp.hanging', piece: 'q' })).toBe(3);
    expect(cheapestLineWording({ line: 'greet.hello.day' })).toBe(1);
    expect(cheapestLineWording({ line: 'teach.head.advice' })).toBeNull();
    expect(cheapestLineWording({ line: 'generic.greeting' })).toBeNull();
    expect(cheapestLineWording({ line: 'greet.hello.day' }, { skip: () => true })).toBeNull();
  });
});

describe('what a line unit key names (tools and server, both namespaces)', () => {
  it('parses a key', () => {
    expect(parseLineUnitKey('line:greet.win/f#1')).toEqual({ pool: 'greet.win', g: 'f', n: 1 });
    expect(parseLineUnitKey('line:ask.opp.hanging@q#2')).toEqual({ pool: 'ask.opp.hanging', piece: 'q', n: 2 });
    expect(parseLineUnitKey('slot:ins:n:f6')).toBeNull();
  });

  it('the words today, the placeholder words, the twins of a catalogue key', () => {
    expect(lineKeyText('line:greet.win/f#1')).toBe('В прошлый раз ты победила — здорово! Сыграем ещё?');
    expect(lineKeyText('line:greet.hello.day#99')).toBeNull();
    expect(lineKeyPlaceholderWords('line:greet.win/f#1')).toEqual(['победила']);
    expect(lineKeyPlaceholderWords('line:ask.opp.hanging@q#1')).toEqual(['твоего', 'ферзя']);
    expect(lineKeyPlaceholderWords('line:greet.hello.day#1')).toEqual([]);
    // different words for each piece: no twins; a twin always names the same words
    expect(lineKeyTwins('line:ask.opp.hanging@q#1', 'Он хочет забрать твоего ферзя!')).toEqual([]);
    for (const line of CLIP_CATALOG) for (const u of catalogUnits(line)) for (const twin of lineKeyTwins(u.unitKey, u.text ?? '')) expect(lineKeyText(twin), twin).toBe(u.text);
  });

  it('the same words on two catalogue lines are ONE unit: each key names the others as twins (one take, one payment)', () => {
    const byText = new Map<string, string[]>();
    for (const line of CLIP_CATALOG) {
      if (line.role !== 'whole') continue;
      for (const u of catalogUnits(line)) if (u.text !== null) byText.set(u.text, [...(byText.get(u.text) ?? []), u.unitKey]);
    }
    const groups = [...byText.entries()].filter(([, keys]) => new Set(keys.map((k) => parseLineUnitKey(k)?.pool)).size > 1);
    // «Привет!» of the greetings, the game's hello and the opener; «Поторопись!» of the teacher and the game …
    expect(groups.map(([t]) => t)).toEqual(expect.arrayContaining(['Привет!', 'Привет-привет!', 'Приве-е-ет!', 'Поторопись!', 'Ход конём!', 'Какие шахи теперь есть у соперника?']));
    for (const [text, keys] of groups) for (const key of keys) expect(lineKeyTwins(key, text), key).toEqual(expect.arrayContaining(keys.filter((k) => k !== key)));
    expect(lineKeyTwins('line:shell.hurry#1', 'Поторопись!')).toEqual(['line:teach.hurry#1']);
    // only for the words the key names today (a take of older words under a shifted number serves nothing else)
    expect(lineKeyTwins('line:shell.hurry#1', 'Скорее!')).toEqual([]);
    // a head, a tail, a bark or a lesson part never joins a whole sentence (another way of saying it)
    expect(lineKeyTwins('line:greet.hello.day#1', 'Добрый день!')).toEqual([]);
  });

  it('the lesson keys read as before', () => {
    expect(lineKeyTwins('line:v3.idea.promotion@p#1', '— она дойдёт до края и превратится!')).toEqual(['line:v3.idea.promotion@r#1']);
    expect(lineKeyPlaceholderWords('line:v3.self.develop/f#5')).toEqual(['сама']);
  });
});

describe('which wording the bubble shows (twinWordingsOf)', () => {
  const W = (item: ClipItem, prio = 100): ClipUtterance['sentences'][number] => ({ items: [item], prio, end: '.' });
  const ev = (text: string, sentences: ClipUtterance['sentences']): { text: string; clip: ClipUtterance } => ({ text, clip: { sentences, generic: 'generic.greeting' } });

  it('the whole bubble as one combination, the name stripped', () => {
    const greeting = ev('Добрый вечер, Миша! Доска ждёт! С чего начнём?', [W({ line: 'greet.hello.evening' }), W({ line: 'greet.none' }, 80)]);
    expect(twinWordingsOf(greeting, { name: 'Миша' })).toEqual([1, 3]);
    expect(twinWordingsOf(ev('В прошлый раз ты победила — здорово! Сыграем ещё?', [W({ line: 'greet.win', g: 'f' })]))).toEqual([1]);
    expect(twinWordingsOf(ev('Помню твою прошлую победу. Поехали дальше?', [W({ line: 'greet.win', g: 'f' })]))).toEqual([2]);
  });

  it('else each sentence against a run of the bubble, in order; unknown words stay null', () => {
    expect(twinWordingsOf(ev('Продолжаем нашу партию! Я рядом.', [W({ line: 'start.resumed' })]))).toEqual([1]);
    expect(twinWordingsOf(ev('Здравствуйте, уважаемый! Доска ждёт! С чего начнём?', [W({ line: 'greet.hello.day' }), W({ line: 'greet.none' }, 80)]))).toEqual([null, 3]);
    expect(twinWordingsOf(ev('Совсем другие слова.', [W({ line: 'greet.none' })]))).toEqual([null]);
    // a head · slot sentence has no wording of its own
    expect(twinWordingsOf(ev('Мой совет — конём на эф три.', [{ items: [{ line: 'teach.head.advice' }, { slot: 'ins', san: 'Nf3', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' }], prio: 100, end: '.' }]))).toEqual([null]);
    expect(twinWordingsOf({ text: 'Привет!' })).toEqual([]);
  });
});
