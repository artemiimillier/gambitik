/**
 * «Дозапись голоса»: the server renders a request's words itself from @gambit/content (ids only — R1) and refuses ids
 * that could never have been said; the pack recipe (D5) records a request in as few jobs as it allows.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ClipGenLine, ClipGenSentence } from '@gambit/shared';
import { PACK_SPLIT, PACK_TAG, joinSentence, parseLineUnitKey, resolveClipGenLine } from '@gambit/core';
import { buildJob, containsNickname, packUnits, renderSentence, ttsOfUnit, unitFromPiece } from './render.ts';
import type { RenderedUnit } from './render.ts';

/** The committed starter library (apps/web/public/voice): read only. */
const STATIC_VOICE = fileURLToPath(new URL('../../../../apps/web/public/voice/', import.meta.url));

const LEAD = { pool: 'v3.lead.advice', n: 1, piece: 'n' } as const; // «Давай сходим {конём}»
const TAIL = { pool: 'v3.idea.mate', n: 1 } as const; // «— и это мат!»
const WHOLE = { pool: 'v3.whole.castle', n: 16 } as const; // «Время для рокировки!»
const QUESTION = { pool: 'v3.self.center', n: 1 } as const; // «Пора заняться центром. Каким ходом?»

function units(s: ClipGenSentence): RenderedUnit[] {
  const r = renderSentence(s);
  if (!r.ok) throw new Error(`refused: ${r.code}`);
  return r.units;
}

describe('renderSentence', () => {
  it('renders a lead + tail exactly as the bubble shows it, with the manifest keys', () => {
    const r = renderSentence({ parts: [LEAD, TAIL] });
    expect(r).toMatchObject({ ok: true, text: 'Давай сходим конём — и это мат!' });
    const [lead, tail] = units({ parts: [LEAD, TAIL] });
    expect(lead).toMatchObject({ key: 'line:v3.lead.advice@n#1', text: 'Давай сходим конём', role: 'lead', alone: false, piece: true, pool: 'v3.lead.advice@n' });
    expect(tail).toMatchObject({ key: 'line:v3.idea.mate#1', text: '— и это мат!', role: 'tail', piece: false });
    // what the bubble shows is what the parts join to
    expect(joinSentence([lead!.text, tail!.text])).toBe('Давай сходим конём — и это мат!');
  });

  it('a lead said alone is marked (it needs a falling take and gets «.»)', () => {
    const r = renderSentence({ parts: [LEAD] });
    expect(r).toMatchObject({ ok: true, text: 'Давай сходим конём.' });
    const [lead] = units({ parts: [LEAD] });
    expect(lead?.alone).toBe(true);
    expect(ttsOfUnit(lead!)).toBe('Давай сходим конём.');
    expect(ttsOfUnit({ ...lead!, alone: false })).toBe('Давай сходим конём');
  });

  it('renders the gender variant and the stage 1–2 options sentence', () => {
    expect(units({ parts: [{ pool: 'v3.self.center', n: 3, g: 'f' }] })[0]).toMatchObject({ key: 'line:v3.self.center/f#3', text: 'Как сделать центр нашим? Найди сама!' });
    const quiz = units({ quiz: { kind: 'whichPiece', options: [{ piece: 'n' }, { piece: 'b' }, { piece: 'r' }] } });
    expect(quiz).toEqual([{ key: 'frag:f:конем, слоном или ладьей|?', text: 'Конём, слоном или ладьёй?', role: 'frag', kind: 'frag', alone: false, piece: false }]);
    const cats = renderSentence({ quiz: { kind: 'oppIdea', options: [{ say: { pool: 'v3.quiz.cat.attack', n: 1 } }, { say: { pool: 'v3.quiz.cat.capture', n: 1 } }, { say: { pool: 'v3.quiz.cat.develop', n: 1 } }] } });
    expect(cats).toMatchObject({ ok: true, text: 'Нападает, съедает фигуру или выводит фигуру?' });
  });

  it('refuses ids that could never have been said', () => {
    const code = (s: ClipGenSentence): string => {
      const r = renderSentence(s);
      return r.ok ? 'ok' : r.code;
    };
    expect(code({ parts: [{ pool: 'v3.nope', n: 1 }] })).toBe('unknown-pool');
    expect(code({ parts: [{ pool: 'teach.head.advice', n: 1 }] })).toBe('unknown-pool');
    expect(code({ parts: [{ ...WHOLE, n: 0 }] })).toBe('bad-n');
    expect(code({ parts: [{ ...WHOLE, n: 999 }] })).toBe('bad-n');
    // a piece on a wording without a piece placeholder, none on one with it, the gender likewise
    expect(code({ parts: [{ ...WHOLE, piece: 'n' }] })).toBe('variant');
    expect(code({ parts: [{ pool: 'v3.lead.advice', n: 1 }] })).toBe('variant');
    expect(code({ parts: [{ pool: 'v3.self.center', n: 3 }] })).toBe('variant');
    expect(code({ parts: [{ ...WHOLE, g: 'm' }] })).toBe('variant');
    // the king is never a victim
    expect(code({ parts: [{ pool: 'v3.opp.capture', n: 1, piece: 'k' }] })).toBe('piece-subject');
    expect(code({ parts: [{ pool: 'v3.opp.capture', n: 1, piece: 'n' }] })).toBe('ok');
    // a tail on its own, a tail before its lead, two wholes
    expect(code({ parts: [TAIL] })).toBe('tail-alone');
    expect(code({ parts: [TAIL, LEAD] as unknown as [typeof LEAD, typeof TAIL] })).toBe('order');
    expect(code({ parts: [WHOLE, WHOLE] })).toBe('order');
    // quiz buttons only inside the options sentence; the silent pose never
    expect(code({ parts: [{ pool: 'v3.quiz.cat.attack', n: 1 }] })).toBe('silent-pool');
    expect(code({ parts: [{ pool: 'v3.bark.quiet', n: 1 }] })).toBe('silent-pool');
    expect(code({ quiz: { kind: 'oppIdea', options: [{ say: WHOLE }, { piece: 'n' }, { piece: 'b' }] } })).toBe('quiz');
    expect(code({ quiz: { kind: 'oppIdea', options: [{ piece: 'n' }, { piece: 'b' }] } })).toBe('quiz');
  });

  it("refuses a sentence that contains the child's nickname", () => {
    expect(containsNickname('Время для рокировки!', 'Тигр')).toBe(false);
    expect(containsNickname('Тигр, время для рокировки!', 'тигр')).toBe(true);
    expect(containsNickname('Тигрёнок молодец', 'Тигр')).toBe(false);
    expect(containsNickname('Ход за тобой', 'я')).toBe(false);
    expect(renderSentence({ parts: [WHOLE] }, { nickname: 'Время' })).toEqual({ ok: false, code: 'nickname' });
    expect(renderSentence({ parts: [WHOLE] }, { nickname: 'Тигр' }).ok).toBe(true);
  });
});

describe('unitFromPiece (a paid take 2)', () => {
  it('renders a ledgered unit again from its key while the content still says the same', () => {
    expect(unitFromPiece({ key: 'line:v3.lead.advice@n#1', text: 'Давай сходим конём' })).toMatchObject({ role: 'lead', alone: true });
    expect(unitFromPiece({ key: 'line:v3.self.center/f#3', text: 'Как сделать центр нашим? Найди сама!' })).toMatchObject({ role: 'whole' });
    expect(unitFromPiece({ key: 'frag:f:конем, слоном или ладьей|?', text: 'Конём, слоном или ладьёй?' })).toMatchObject({ role: 'frag' });
    // the wording changed (a stale text) or the key is foreign: nothing is recorded
    expect(unitFromPiece({ key: 'line:v3.lead.advice@n#1', text: 'Давай сходим слоном' })).toBeNull();
    expect(unitFromPiece({ key: 'frag:f:что-то|?', text: 'Конём, слоном или ладьёй?' })).toBeNull();
    expect(unitFromPiece({ key: 'slot:ins:n:f6', text: 'конём на эф шесть' })).toBeNull();
  });
});

describe('the pack recipe', () => {
  it('records a lead + tail and a whole in one job, split at the tags', () => {
    const packs = packUnits([units({ parts: [LEAD, TAIL] }), units({ parts: [WHOLE] })]);
    expect(packs).toHaveLength(1);
    const built = buildJob(packs[0]!, 101);
    expect(built?.job.prompt).toBe(`Давай сходим конём${PACK_TAG}— и это мат!${PACK_TAG}Время для рокировки!`);
    expect(built?.job).toMatchObject({ take: 101, recipe: 'pack', split: { mode: PACK_SPLIT.mode, minSilenceMs: PACK_SPLIT.minSilenceMs }, tier: 'ondemand', batch: 'ondemand' });
    // the pieces keep the exact expansions (the stale-take guard), in spoken order, with how each part is said
    expect(built?.job.pieces).toEqual([
      { key: 'line:v3.lead.advice@n#1', text: 'Давай сходим конём', kind: 'line', tier: 'ondemand', role: 'lead', pool: 'v3.lead.advice@n' },
      { key: 'line:v3.idea.mate#1', text: '— и это мат!', kind: 'line', tier: 'ondemand', role: 'tail', pool: 'v3.idea.mate', mood: 'excited' },
      { key: 'line:v3.whole.castle#16', text: 'Время для рокировки!', kind: 'line', tier: 'ondemand', role: 'whole', pool: 'v3.whole.castle' },
    ]);
    // 58 code points with the tags: two started 50-character blocks
    expect(built?.milli).toBe(300);
  });

  it('a question is only ever the last part: the next group starts a new job', () => {
    const packs = packUnits([units({ parts: [QUESTION] }), units({ parts: [WHOLE] })]);
    expect(packs.map((p) => p.map((u) => u.key))).toEqual([['line:v3.self.center#1'], ['line:v3.whole.castle#16']]);
    expect(buildJob(packs[0]!, 101)?.job).toMatchObject({ recipe: 'single' });
    // a lead said alone is recorded as such (it gets «.» and must fall)
    expect(buildJob(packUnits([units({ parts: [LEAD] })])[0]!, 101)?.job.pieces[0]).toMatchObject({ role: 'leadAlone' });
    expect(buildJob(packs[0]!, 101)?.job.split).toBeUndefined();
    // a question last is fine
    expect(packUnits([units({ parts: [WHOLE] }), units({ parts: [QUESTION] })])).toHaveLength(1);
  });

  it('at most four parts in a job', () => {
    const one = units({ parts: [WHOLE] });
    const packs = packUnits(Array.from({ length: 5 }, (_, i) => one.map((u) => ({ ...u, key: `${u.key}~${i}` }))));
    expect(packs.map((p) => p.length)).toEqual([4, 1]);
  });
});

describe('a whole catalogue sentence (`line`: greetings, answers, take-back replies…)', () => {
  const line = (l: ClipGenLine): ClipGenSentence => ({ line: l });
  const code = (s: ClipGenSentence, nickname?: string): string => {
    const r = renderSentence(s, { nickname: nickname ?? null });
    return r.ok ? 'ok' : r.code;
  };

  it("renders the catalogue's own unit: its key, words, pool and every pool it joins", () => {
    expect(renderSentence(line({ id: 'greet.hello.day', n: 1 }))).toEqual({
      ok: true,
      text: 'Добрый день!',
      units: [{ key: 'line:greet.hello.day#1', text: 'Добрый день!', role: 'whole', kind: 'line', pool: 'greet.hello.day', alone: false, piece: false }],
    });
    // a gendered wording, and a plain one of the same line that serves both genders' pools
    expect(units(line({ id: 'greet.win', n: 1, g: 'f' }))[0]).toMatchObject({ key: 'line:greet.win/f#1', text: 'В прошлый раз ты победила — здорово! Сыграем ещё?', pool: 'greet.win/f' });
    expect(units(line({ id: 'greet.win', n: 1, g: 'f' }))[0]?.pools).toBeUndefined();
    expect(units(line({ id: 'greet.win', n: 2 }))[0]).toMatchObject({ key: 'line:greet.win#2', pool: 'greet.win', pools: ['greet.win', 'greet.win/m', 'greet.win/f'] });
    // a piece variant is less reusable (the queue puts it a little later)
    expect(units(line({ id: 'ask.opp.hanging', n: 1, piece: 'q' }))[0]).toMatchObject({ key: 'line:ask.opp.hanging@q#1', text: 'Он хочет забрать твоего ферзя!', piece: true });
    expect(units(line({ id: 'ask.opp.hanging', n: 3 }))[0]?.pools).toEqual(['ask.opp.hanging', 'ask.opp.hanging@p', 'ask.opp.hanging@n', 'ask.opp.hanging@b', 'ask.opp.hanging@r', 'ask.opp.hanging@q']);
  });

  it("the keys and words are the starter set's for the same wording: a recording joins the same library", () => {
    const index = JSON.parse(readFileSync(join(STATIC_VOICE, 'index.json'), 'utf8')) as { default: string; voices: Record<string, string> };
    const manifest = JSON.parse(readFileSync(join(STATIC_VOICE, index.voices[index.default] as string), 'utf8')) as { units: Record<string, { text: string }>; keys: Record<string, string[]> };
    let checked = 0;
    for (const [key, ids] of Object.entries(manifest.keys)) {
      const k = parseLineUnitKey(key);
      if (k === null) continue;
      const l: ClipGenLine = { id: k.pool, n: k.n, ...(k.piece ? { piece: k.piece } : {}), ...(k.g ? { g: k.g } : {}) };
      if (!resolveClipGenLine(l).ok) continue;
      const [unit] = units(line(l));
      expect(unit?.key).toBe(key);
      for (const id of ids) expect(manifest.units[id]?.text, key).toBe(unit?.text);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('refuses every id that is not a whole catalogue sentence it may record', () => {
    expect(code(line({ id: 'no.such.line', n: 1 }))).toBe('unknown-pool');
    // a lesson id never goes this way (its lead / tail / button rules live in `parts` / `quiz`)
    expect(code(line({ id: 'v3.whole.castle', n: 16 }))).toBe('unknown-pool');
    expect(code(line({ id: 'teach.head.advice', n: 1 }))).toBe('order');
    expect(code(line({ id: 'reason.fork', n: 1 }))).toBe('order');
    expect(code(line({ id: 'bark.cheer', n: 1 }))).toBe('silent-pool');
    expect(code(line({ id: 'generic.greeting', n: 1 }))).toBe('excluded');
    expect(code(line({ id: 'preview', n: 1 }))).toBe('excluded');
    expect(code(line({ id: 'greet.hello.day', n: 0 }))).toBe('bad-n');
    expect(code(line({ id: 'greet.hello.day', n: 99 }))).toBe('bad-n');
    expect(code(line({ id: 'greet.hello.day', n: 1, piece: 'n' }))).toBe('variant');
    expect(code(line({ id: 'greet.win', n: 1 }))).toBe('variant');
    expect(code(line({ id: 'greet.win', n: 2, g: 'm' }))).toBe('variant');
    expect(code(line({ id: 'ask.opp.hanging', n: 1, piece: 'k' }))).toBe('piece-subject');
    // the child's nickname is never recorded, even when it is an ordinary word of a wording
    expect(code(line({ id: 'greet.none', n: 3 }), 'Доска')).toBe('nickname');
    expect(code(line({ id: 'greet.none', n: 3 }), 'Тигр')).toBe('ok');
  });

  it('a paid take 2 renders it again from its key while the catalogue says the same', () => {
    expect(unitFromPiece({ key: 'line:greet.hello.day#1', text: 'Добрый день!' })).toMatchObject({ key: 'line:greet.hello.day#1', role: 'whole', kind: 'line', alone: false });
    expect(unitFromPiece({ key: 'line:greet.win#2', text: 'Помню твою прошлую победу. Поехали дальше?' })?.pools).toEqual(['greet.win', 'greet.win/m', 'greet.win/f']);
    expect(unitFromPiece({ key: 'line:greet.hello.day#1', text: 'Добрый вечер!' })).toBeNull();
    expect(unitFromPiece({ key: 'line:teach.head.advice#1', text: 'Мой совет —' })).toBeNull();
    expect(unitFromPiece({ key: 'line:generic.greeting#1', text: 'Привет! Сыграем?' })).toBeNull();
  });

  it('a greeting records in one pack; the pieces carry the pools the take joins', () => {
    const packs = packUnits([units(line({ id: 'greet.hello.day', n: 1 })), units(line({ id: 'greet.win', n: 2 }))]);
    expect(packs).toHaveLength(1);
    const built = buildJob(packs[0]!, 101);
    expect(built?.job.prompt).toBe(`Добрый день!${PACK_TAG}Помню твою прошлую победу. Поехали дальше?`);
    expect(built?.job.pieces).toEqual([
      { key: 'line:greet.hello.day#1', text: 'Добрый день!', kind: 'line', tier: 'ondemand', role: 'whole', pool: 'greet.hello.day' },
      { key: 'line:greet.win#2', text: 'Помню твою прошлую победу. Поехали дальше?', kind: 'line', tier: 'ondemand', role: 'whole', pool: 'greet.win', pools: ['greet.win', 'greet.win/m', 'greet.win/f'] },
    ]);
  });
});
