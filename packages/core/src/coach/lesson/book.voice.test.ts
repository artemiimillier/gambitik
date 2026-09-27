/**
 * The book's «recorded first» choice for the on-demand voice (`LessonVoicePolicy`, policy P(K)): the book prefers
 * wordings that already have a recording, grows a pool variant to K recorded wordings, never breaks the bag (fewest
 * plays in this game), keeps the theme / mini-lesson windows, grows cheaply and never grows with a blocked unit.
 * Without a policy (no getter, or a getter that returns null) it chooses exactly as before — pinned by a seeded digest
 * of the default book (computed with the book as it was before the voice policy existed).
 *
 * A SYNTHETIC library: plain, piece, gender, cheap-growth, theme, mini-lesson and quiz-button pools.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PieceType } from '@gambit/shared';
import { hash13 } from '../clips/keys.ts';
import { MINI_GUARD, THEME_GUARD, VOICE_NEUTRAL_POOL, createLessonBook, lessonUnitKey } from './book.ts';
import type { LessonBook, LessonBookInit, LessonVoicePolicy, PickArgs } from './book.ts';

vi.mock('@gambit/content', async (importOriginal) => {
  const real = await importOriginal<typeof import('@gambit/content')>();
  const line = (id: string, role: 'whole' | 'lead', ts: string[], subject?: 'mover') => ({
    id,
    role,
    ...(subject ? { subject } : {}),
    cue: [],
    min: 1,
    purpose: 'test',
    wordings: ts.map((t) => ({ t })),
  });
  const numbered = (word: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${word} ${i + 1}.`);
  const lines = [
    line('v3.t.plain', 'whole', ['Раз.', 'Два.', 'Три.', 'Четыре.', 'Пять.', 'Шесть.', 'Семь.', 'Восемь.']),
    line('v3.quiz.opt.t', 'whole', ['Один', 'Два', 'Три', 'Четыре', 'Пять', 'Шесть']),
    line('v3.t.piece', 'lead', ['Пойдём {конём}', 'Ходим {конём}', 'Сыграем {конём}', 'Сделаем ход', 'Вперёд, {конь}'], 'mover'),
    line('v3.t.gender', 'whole', ['Ты {g:сам|сама} нашёл.', 'Здорово!', 'Ты {g:готов|готова}?', 'Отлично.']),
    line('v3.t.cheap', 'whole', [
      'Очень длинная фраза про игру, в которой больше пятидесяти знаков, и она дорогая.',
      'Короткая фраза.',
      'Ещё одна очень длинная фраза про игру, в ней тоже больше пятидесяти знаков.',
      'Тоже короткая.',
    ]),
    line('v3.theme.t', 'whole', numbered('Тема', 10)),
    line('v3.mini.t', 'whole', numbered('Урок', 16)),
  ];
  const byId = new Map(lines.map((l) => [l.id, l] as const));
  return { ...real, lessonLine: (id: string) => byId.get(id) };
});

const ARGS: PickArgs = { stage: 3 };

/** A child's cache of recordings: every part is recorded right after it was said (on demand). */
function cache(policy: Partial<LessonVoicePolicy> & { minVoiced: number }, seeded: string[] = []): { set: Set<string>; voice: LessonVoicePolicy } {
  const set = new Set(seeded);
  return { set, voice: { growCheap: false, ...policy, voiced: (k) => set.has(k) } };
}

/** Say `times` wordings of a pool (each recorded after it was said); returns the wording numbers. */
function say(book: LessonBook, pool: string, times: number, rec: Set<string> | null, args: PickArgs = ARGS): number[] {
  const out: number[] = [];
  for (let i = 0; i < times; i++) {
    const p = book.pick(pool, args);
    if (!p) throw new Error(`no wording for ${pool}`);
    book.noteSaid(p.text);
    rec?.add(lessonUnitKey(p));
    out.push(p.n);
  }
  return out;
}

/** Games of one child: `perGame` picks of a pool per game, the book rebuilt from the stored history each game. */
function games(n: number, perGame: number, pool: string, voice: { set: Set<string>; voice: LessonVoicePolicy } | null, args: PickArgs = ARGS): number[][] {
  let history: unknown;
  const out: number[][] = [];
  for (let g = 0; g < n; g++) {
    const book = createLessonBook({ seed: 100 + g, history, ...(voice ? { voice: () => voice.voice } : {}) });
    out.push(say(book, pool, perGame, voice?.set ?? null, args));
    book.finishGame();
    history = book.snapshotHistory();
  }
  return out;
}

// ───────────────────────── the default book, pinned ─────────────────────────

const MIX_POOLS = ['v3.t.plain', 'v3.t.piece', 'v3.t.gender', 'v3.quiz.opt.t', 'v3.t.cheap', 'v3.theme.t', 'v3.mini.t'];
const MIX_ARGS: PickArgs[] = [
  { stage: 3 },
  { stage: 3, piece: 'n' },
  { stage: 1, piece: 'q', g: 'f' },
  { stage: 5, piece: 'p', avoid: [1, 2] },
  { stage: 3, freshOnly: true },
  { stage: 2, g: 'f', maxWords: 2 },
  { stage: 4, piece: 'r', g: 'm', maxSentences: 1 },
];

/** 8 games × 60 picks over every pool and argument mix: what was said, then the stored book. */
function mixedRun(extra: Pick<LessonBookInit, 'voice'> = {}): { said: string[]; history: unknown } {
  const said: string[] = [];
  let history: unknown;
  for (let g = 0; g < 8; g++) {
    const book = createLessonBook({ seed: 1000 + g, history, ...extra });
    for (let i = 0; i < 60; i++) {
      const p = book.pick(MIX_POOLS[i % MIX_POOLS.length] as string, MIX_ARGS[(i * 3 + g) % MIX_ARGS.length] as PickArgs);
      if (!p) {
        said.push('-');
        continue;
      }
      book.noteSaid(p.text);
      said.push(`${lessonUnitKey(p)} ${p.text}`);
    }
    book.finishGame();
    history = book.snapshotHistory();
  }
  return { said, history };
}

describe('lessonUnitKey', () => {
  it('is the manifest key of a said part (piece / g only when given)', () => {
    expect(lessonUnitKey({ pool: 'v3.lead.subject', n: 4, piece: 'p' })).toBe('line:v3.lead.subject@p#4');
    expect(lessonUnitKey({ pool: 'v3.praise.own.attack', n: 7, piece: 'n', g: 'm' })).toBe('line:v3.praise.own.attack@n/m#7');
    expect(lessonUnitKey({ pool: 'v3.themeTail.fortress', n: 2 })).toBe('line:v3.themeTail.fortress#2');
    expect(lessonUnitKey({ pool: 'v3.x', n: 1, piece: null, g: null })).toBe('line:v3.x#1');
  });

  it('is the key of exactly the variant the book said (piece / g only when the wording uses them)', () => {
    const book = createLessonBook({ seed: 4 });
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const p = book.pick('v3.t.piece', { stage: 3, piece: 'b', g: 'f' });
      if (!p) throw new Error('no pick');
      seen.add(lessonUnitKey(p));
      book.noteSaid(p.text);
    }
    // the plain wording #4 is one unit for every piece; nothing here uses the gender
    expect([...seen].sort()).toEqual(['line:v3.t.piece#4', 'line:v3.t.piece@b#1', 'line:v3.t.piece@b#2', 'line:v3.t.piece@b#3', 'line:v3.t.piece@b#5']);
  });
});

describe('LessonBook — no policy is the default book, byte for byte', () => {
  // hash13 of the run with the book of commit 2a4bfae (before the voice policy): the default book never changed
  const PINNED = '080f710a84ee4';

  it('the default book is pinned (seeded digest over 480 picks)', () => {
    const run = mixedRun();
    expect(run.said.filter((s) => s !== '-').length).toBeGreaterThan(400);
    expect(hash13(JSON.stringify(run))).toBe(PINNED);
  });

  it('a getter that returns null chooses exactly as the default book, and it is asked on every pick', () => {
    let asked = 0;
    const off = mixedRun({
      voice: () => {
        asked++;
        return null;
      },
    });
    expect(off).toEqual(mixedRun());
    // (quiz-button pools never ask: 1 of 7 pools, and a pick with no candidate returns before asking)
    expect(asked).toBeGreaterThan(300);
  });

  it('a policy with nothing recorded and no cheap growth chooses exactly as the default book (no probe = today)', () => {
    const blind = mixedRun({ voice: () => ({ minVoiced: 3, growCheap: false, voiced: () => false }) });
    expect(blind).toEqual(mixedRun());
    // … and so does one where every unit is blocked (nothing else fits: the bag decides as before)
    const allBlocked = mixedRun({ voice: () => ({ minVoiced: 3, growCheap: false, voiced: () => false, blocked: () => true }) });
    expect(allBlocked).toEqual(mixedRun());
  });

  it('with nothing recorded it chooses exactly as the default book across games (same PRNG, same history)', () => {
    const plain = games(6, 3, 'v3.t.plain', null);
    const voiced = games(6, 3, 'v3.t.plain', { set: new Set(), voice: { voiced: () => false, minVoiced: 3, growCheap: false } });
    expect(voiced).toEqual(plain);
  });

  it('stores the default book format (no voice fields; a stray `prevGame` field is dropped on restore)', () => {
    const c = cache({ minVoiced: 3 });
    const book = createLessonBook({ seed: 1, voice: () => c.voice });
    say(book, 'v3.t.plain', 2, null);
    book.finishGame();
    expect(Object.keys(book.snapshotHistory()).sort()).toEqual(['gameSeq', 'habitSaid', 'habits', 'minis', 'recent', 'takeaways', 'v']);
    const old = { ...book.snapshotHistory(), prevGame: { 'v3.t.plain': [1] } };
    expect(createLessonBook({ history: old }).snapshotHistory()).not.toHaveProperty('prevGame');
  });
});

describe('LessonBook — recorded first (voice on demand)', () => {
  it('the probe gets the unit key and the expanded text of the variant it would say', () => {
    const probed: [string, string][] = [];
    const book = createLessonBook({ seed: 2, voice: () => ({ minVoiced: 1, growCheap: false, voiced: (k, t) => (probed.push([k, t]), false) }) });
    book.pick('v3.t.piece', { stage: 3, piece: 'n' as PieceType, g: 'f' });
    expect(probed).toContainEqual(['line:v3.t.piece@n#1', 'Пойдём конём']);
    expect(probed).toContainEqual(['line:v3.t.piece#4', 'Сделаем ход']);
    const g: [string, string][] = [];
    createLessonBook({ seed: 2, voice: () => ({ minVoiced: 1, growCheap: false, voiced: (k, t) => (g.push([k, t]), false) }) }).pick('v3.t.gender', { stage: 3, g: 'f' });
    expect(g).toContainEqual(['line:v3.t.gender/f#1', 'Ты сама нашёл.']);
    expect(g).toContainEqual(['line:v3.t.gender#2', 'Здорово!']);
  });

  it('asks the getter on every pick (an overlay reloaded mid-game counts at once)', () => {
    const rec = new Set<string>();
    let live: LessonVoicePolicy | null = null;
    const book = createLessonBook({ seed: 11, voice: () => live });
    // with no policy the first game grows nothing; once a policy with 3 recordings appears it reuses them
    const first = say(book, 'v3.t.plain', 3, rec);
    book.newGame();
    live = { minVoiced: 3, growCheap: false, voiced: (k) => rec.has(k) };
    const second = say(book, 'v3.t.plain', 3, null);
    expect(new Set(second)).toEqual(new Set(first));
  });

  it('quiz-button pools ignore the policy (VOICE_NEUTRAL_POOL)', () => {
    expect(VOICE_NEUTRAL_POOL('v3.quiz.opt.t')).toBe(true);
    expect(VOICE_NEUTRAL_POOL('v3.quiz.cat.plan')).toBe(true);
    expect(VOICE_NEUTRAL_POOL('v3.bark.quiet')).toBe(true);
    expect(VOICE_NEUTRAL_POOL('v3.t.plain')).toBe(false);
    expect(VOICE_NEUTRAL_POOL('v3.quiz.question.oppIdea')).toBe(false);
    let asked = 0;
    const policy = (): LessonVoicePolicy => {
      asked++;
      return { minVoiced: 1, growCheap: true, voiced: (k) => k.endsWith('#6'), blocked: () => true };
    };
    const a = say(createLessonBook({ seed: 9 }), 'v3.quiz.opt.t', 6, null);
    const b = say(createLessonBook({ seed: 9, voice: policy }), 'v3.quiz.opt.t', 6, null);
    expect(b).toEqual(a);
    expect(asked).toBe(0);
  });

  it('the default book rotates to never-said wordings; the voice-aware one reuses its recordings once it has K', () => {
    const lazy = games(2, 3, 'v3.t.plain', null);
    expect(new Set([...(lazy[0] ?? []), ...(lazy[1] ?? [])]).size).toBe(6);
    const k3 = games(3, 3, 'v3.t.plain', cache({ minVoiced: 3 }));
    expect(new Set(k3[1])).toEqual(new Set(k3[0]));
    expect(new Set(k3[2])).toEqual(new Set(k3[0]));
  });

  it('P(3): grows a pool variant to exactly K recordings, then reuses them', () => {
    const c = cache({ minVoiced: 3 });
    const got = games(8, 1, 'v3.t.plain', c);
    expect(c.set.size).toBe(3);
    expect(new Set(got.flat()).size).toBe(3);
    // each piece variant grows on its own (the pool key carries the piece)
    const p = cache({ minVoiced: 3 });
    games(6, 1, 'v3.t.piece', p, { stage: 3, piece: 'n' });
    games(6, 1, 'v3.t.piece', p, { stage: 3, piece: 'b' });
    const knight = [...p.set].filter((k) => k.includes('@n#') || k === 'line:v3.t.piece#4');
    const bishop = [...p.set].filter((k) => k.includes('@b#') || k === 'line:v3.t.piece#4');
    expect(knight.length).toBeGreaterThanOrEqual(3);
    expect(bishop.length).toBeGreaterThanOrEqual(3);
  });

  it('grows a pool below K with new wordings (the least recently said rule decides as before)', () => {
    const c = cache({ minVoiced: 4 });
    const got = games(5, 1, 'v3.t.plain', c);
    expect(new Set(got.flat()).size).toBe(4);
    expect(c.set.size).toBe(4);
    // the 5th game reuses one of the four recordings
    expect(got.slice(0, 4).flat()).toContain(got[4]?.[0]);
  });

  it('keeps the bag hard: a recorded wording is not said twice in a game while an unsaid one fits', () => {
    const c = cache({ minVoiced: 2 }, [lessonUnitKey({ pool: 'v3.t.plain', n: 1 }), lessonUnitKey({ pool: 'v3.t.plain', n: 2 })]);
    const book = createLessonBook({ seed: 7, voice: () => c.voice });
    const said = say(book, 'v3.t.plain', 3, c.set);
    expect(new Set(said).size).toBe(3);
    expect(said.slice(0, 2).sort()).toEqual([1, 2]);
  });

  it(`never reuses a recorded theme announcement within ${THEME_GUARD} picks of its pool`, () => {
    const got = games(THEME_GUARD + 1, 1, 'v3.theme.t', cache({ minVoiced: 2 })).flat();
    expect(new Set(got).size).toBe(got.length);
  });

  it(`never reuses a recorded mini-lesson wording within ${MINI_GUARD} picks of its pool`, () => {
    const c = cache({ minVoiced: 2 });
    const got = games(MINI_GUARD + 1, 1, 'v3.mini.t', c).flat();
    expect(new Set(got).size).toBe(got.length);
    // after the window the recordings come back (the pool does not grow for ever)
    const more = games(MINI_GUARD + 4, 1, 'v3.mini.t', cache({ minVoiced: 2 })).flat();
    expect(new Set(more).size).toBeLessThan(more.length);
  });

  it('growCheap: a new recording in a piece pool is the plain wording first (one take serves every piece)', () => {
    const c = cache({ minVoiced: 3, growCheap: true });
    const book = createLessonBook({ seed: 3, voice: () => c.voice });
    const p = book.pick('v3.t.piece', { stage: 3, piece: 'n' as PieceType });
    expect(p?.n).toBe(4);
    expect(p?.piece).toBeUndefined();
  });

  it('growCheap: then the wording with the fewest started 50-character blocks (the TTS price)', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const c = cache({ minVoiced: 3, growCheap: true });
      const book = createLessonBook({ seed, voice: () => c.voice });
      expect([2, 4]).toContain(book.pick('v3.t.cheap', ARGS)?.n);
    }
    // without cheap growth the long ones are chosen too
    const firsts = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) firsts.add(createLessonBook({ seed, voice: () => cache({ minVoiced: 3 }).voice }).pick('v3.t.cheap', ARGS)?.n ?? 0);
    expect([...firsts].some((n) => n === 1 || n === 3)).toBe(true);
  });

  it('never grows with a blocked unit while the bag has another wording; says it (unvoiced) when nothing else is left', () => {
    const blockedKeys = new Set([1, 2, 3, 4, 5].map((n) => lessonUnitKey({ pool: 'v3.t.plain', n })));
    for (let seed = 1; seed <= 5; seed++) {
      const c = cache({ minVoiced: 3, blocked: (k) => blockedKeys.has(k) });
      const book = createLessonBook({ seed, voice: () => c.voice });
      const said = say(book, 'v3.t.plain', 4, c.set);
      expect(new Set(said.slice(0, 3))).toEqual(new Set([6, 7, 8]));
      // the bag stays hard: #6–#8 were said, only blocked ones are left
      expect([1, 2, 3, 4, 5]).toContain(said[3]);
    }
  });

  it('a blocked unit that has a recording is simply voiced', () => {
    const k1 = lessonUnitKey({ pool: 'v3.t.plain', n: 1 });
    const c = cache({ minVoiced: 1, blocked: (k) => k === k1 }, [k1]);
    const book = createLessonBook({ seed: 5, voice: () => c.voice });
    expect(book.pick('v3.t.plain', ARGS)?.n).toBe(1);
  });
});
