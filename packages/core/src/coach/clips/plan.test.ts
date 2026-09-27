import { describe, expect, it } from 'vitest';
import type { ClipItem, ClipSentence, ClipUtterance } from '@gambit/shared';
import { FIXTURE_CATALOG, catalogIndex, fixtureIndex } from './fixtures.ts';
import { catalogUnits } from './catalog.ts';
import { compileText } from './compile.ts';
import { mergeClipIndexes } from './keys.ts';
import {
  CLIP_CAPS,
  CLIP_GAPS_MS,
  CLIP_RECENCY_WINDOW,
  CLIP_RECENCY_WINDOW_LONG,
  clipCapsFor,
  clipSentenceShape,
  createClipRecency,
  defaultRecencyWindow,
  planClips,
  validateClipUtterance,
} from './plan.ts';
import type { ClipPlan, PlanContext } from './types.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const SCANDI = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
const ITALIAN = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

/** deterministic: first fresh take, a bark whenever allowed, exact table gaps */
const FIRST: PlanContext = { rng: () => 0, jitter: false };
/** deterministic: last fresh take, never a bark, exact table gaps */
const LAST: PlanContext = { rng: () => 0.99, jitter: false };

const head = (line = 'teach.head.advice'): ClipItem => ({ line });
const nf3: ClipItem = { slot: 'nom', san: 'Nf3', fen: START };
const tailN: ClipItem = { line: 'reason.attack', piece: 'n' };
const sentence = (items: ClipItem[], prio = 100, end: ClipSentence['end'] = '.'): ClipSentence => ({ items, prio, end });
const utter = (sentences: ClipSentence[], over: Partial<ClipUtterance> = {}): ClipUtterance => ({ sentences, generic: 'generic.teachTurn.turn', ...over });
const hst = (): ClipUtterance => utter([sentence([head(), nf3, tailN], 100, '!')]);
const roles = (p: ClipPlan): string[] => p.clips.map((c) => c.role);
const piecePools = (line: string): string[] => [line, ...['p', 'n', 'b', 'r', 'q'].map((p) => `${line}@${p}`)];

describe('the sentence grammar (§3.1)', () => {
  it('accepts only W, H·S, S·T, H·S·T', () => {
    const L: ClipItem = { line: 'x' };
    expect(clipSentenceShape([L])).toBe('W');
    expect(clipSentenceShape([L, nf3])).toBe('HS');
    expect(clipSentenceShape([nf3, L])).toBe('ST');
    expect(clipSentenceShape([L, nf3, L])).toBe('HST');
    expect(clipSentenceShape([])).toBeNull();
    expect(clipSentenceShape([L, L])).toBeNull();
    expect(clipSentenceShape([nf3])).toBeNull();
    expect(clipSentenceShape([nf3, nf3])).toBeNull();
    expect(clipSentenceShape([L, L, nf3])).toBeNull();
    expect(clipSentenceShape([L, nf3, L, L])).toBeNull();
  });

  it('validates a twin: ≤ 2 sentences, shapes, legal slots in their form, a generic line', () => {
    expect(validateClipUtterance(hst())).toEqual([]);
    const bad = utter([sentence([nf3, nf3]), sentence([head(), { slot: 'ins', san: 'exd5', fen: SCANDI }]), sentence([head()])], { generic: '' });
    const errors = validateClipUtterance(bad);
    expect(errors.some((e) => e.includes('3 sentences'))).toBe(true);
    expect(errors.some((e) => e.includes('sentence 0: not W'))).toBe(true);
    expect(errors.some((e) => e.includes('sentence 1: slot ins exd5'))).toBe(true);
    expect(errors).toContain('no generic line');
  });

  it('a shape the grammar does not know is never built: the core falls to the generic line', () => {
    const plan = planClips(utter([sentence([nf3, nf3])]), fixtureIndex(), LAST);
    expect(roles(plan)).toEqual(['generic']);
    expect(plan.level).toBe(5);
  });
});

describe('L1: a sentence as written', () => {
  it('H·S·T: head, whole move unit, piece tail — seams only at the dashes', () => {
    const plan = planClips(hst(), fixtureIndex(), FIRST);
    expect(plan.level).toBe(1);
    expect(plan.src).toBe('clip');
    expect(roles(plan)).toEqual(['head', 'slot', 'tail']);
    expect(plan.heard).toBe('Мой совет — конь на эф три — нападаешь на коня!');
    expect(plan.clips.map((c) => c.gapBeforeMs)).toEqual([0, CLIP_GAPS_MS.dash, CLIP_GAPS_MS.dash]);
    // audible timeline: durations (70 ms per char in the fixture) + gaps
    expect(plan.clips.map((c) => c.atMs)).toEqual([0, 770 + 280, 770 + 280 + 980 + 280]);
    expect(plan.ms).toBe(770 + 280 + 980 + 280 + 1400);
    expect(plan.sentences).toEqual([{ level: 1, text: plan.heard, fromMs: 0, toMs: plan.ms }]);
    expect(plan.misses).toEqual([]);
    expect(plan.stats).toEqual({ units: 3, slots: 1, split: 0, generic: 0, dropped: 0 });
  });

  it('a colon head gets the colon gap; a capture and castling are whole units too', () => {
    const colon = planClips(utter([sentence([head('teach.head.arrow'), { slot: 'cap', san: 'exd5', fen: SCANDI }])]), fixtureIndex(), FIRST);
    expect(colon.heard).toBe('Смотри на зелёную стрелку: пешка бьёт на дэ пять.');
    expect(colon.clips[1]?.gapBeforeMs).toBe(CLIP_GAPS_MS.colon);
    const castle = planClips(utter([sentence([head(), { slot: 'nom', san: 'O-O', fen: ITALIAN }])]), fixtureIndex(), FIRST);
    expect(castle.heard).toBe('Мой совет — короткая рокировка.');
  });

  it('a missing wording or take is just another one from the same pool', () => {
    const idx = fixtureIndex({ omit: ['line:teach.head.advice#1'] });
    const plan = planClips(hst(), idx, FIRST);
    expect(plan.level).toBe(1);
    expect(plan.heard).toBe('Попробуй так: конь на эф три — нападаешь на коня!');
    expect(plan.clips[1]?.gapBeforeMs).toBe(CLIP_GAPS_MS.colon);
  });

  it('takes the library says it failed to load are skipped like missing ones', () => {
    const idx = fixtureIndex();
    const advice1 = idx.pools['teach.head.advice']?.[0] as string;
    const plan = planClips(hst(), idx, { ...FIRST, available: (id) => id !== advice1 });
    expect(plan.clips[0]?.id).not.toBe(advice1);
    expect(plan.level).toBe(1);
  });

  it('prefers takes of the wanted mood (takes without a mood always qualify)', () => {
    const idx = fixtureIndex();
    const u = utter([sentence([{ line: 'praise.good' }], 100, '!')]);
    const texts = new Set<string>();
    for (const r of [0, 0.5, 0.99]) texts.add(planClips(u, idx, { rng: () => r, jitter: false, mood: 'excited' }).heard);
    expect([...texts].sort()).toEqual(['Здорово, я рад!', 'Отличный ход!']);
  });
});

describe('the ladder L1 → L6, in order', () => {
  it('walks down as recordings go missing', () => {
    const allTails = [...piecePools('reason.attack'), 'reason.good'];
    const steps: [string, string[], number, string][] = [
      ['everything recorded', [], 1, 'Мой совет — конь на эф три — нападаешь на коня!'],
      ['L2: no whole move unit → split form (the tail goes: ≤ 3 clips)', ['nom:n:f3'], 3, 'Мой совет — конь — на эф три.'],
      ['L3: no piece variant of the tail → its plain wording', ['reason.attack@n'], 3, 'Мой совет — конь на эф три — и сразу в атаку!'],
      ['L3: no tail at all → dropped', allTails, 3, 'Мой совет — конь на эф три.'],
      ['L3: no head → the catalogue sibling', ['teach.head.advice'], 3, 'Смотри на зелёную стрелку: конь на эф три — нападаешь на коня!'],
      ['L5: no head and no sibling → the generic line', ['teach.head.advice', 'teach.head.arrow'], 5, 'Смотри на зелёную стрелку!'],
      ['L5: no move unit and no split form → the generic line', ['nom:n:f3', 'sq:f3'], 5, 'Смотри на зелёную стрелку!'],
    ];
    for (const [what, omit, level, heard] of steps) {
      const plan = planClips(hst(), fixtureIndex({ omit }), FIRST);
      expect({ what, level: plan.level, heard: plan.heard }).toEqual({ what, level, heard });
    }
  });

  it('L2 records the missing whole unit; the split pair is one move', () => {
    const plan = planClips(utter([sentence([head(), nf3])]), fixtureIndex({ omit: ['nom:n:f3'] }), FIRST);
    expect(plan.level).toBe(2);
    expect(roles(plan)).toEqual(['head', 'split', 'split']);
    expect(plan.clips[2]?.gapBeforeMs).toBe(CLIP_GAPS_MS.split);
    expect(plan.misses).toEqual([{ key: 'slot:nom:n:f3', level: 2 }]);
    expect(plan.stats).toMatchObject({ slots: 1, split: 1 });
  });

  it('never more than 3 clips and 1 slot in a sentence', () => {
    for (const omit of [[], ['nom:n:f3'], ['reason.attack@n'], ['teach.head.advice']]) {
      const plan = planClips(hst(), fixtureIndex({ omit }), FIRST);
      for (let s = 0; s < plan.sentences.length; s++) {
        const inSentence = plan.clips.filter((c) => c.sentence === s && c.role !== 'bark');
        expect(inSentence.length).toBeLessThanOrEqual(3);
        expect(inSentence.filter((c) => c.role === 'slot').length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('L3 records the missing pool', () => {
    const plan = planClips(hst(), fixtureIndex({ omit: ['reason.attack@n'] }), FIRST);
    expect(plan.misses).toEqual([{ key: 'line:reason.attack@n', level: 3 }]);
  });

  it('L4: an optional sentence that misses is dropped, the core stays', () => {
    const u = utter([sentence([{ line: 'treasure.gift' }], 100, '!'), sentence([{ line: 'no.such.line' }], 60, '?')]);
    const plan = planClips(u, fixtureIndex(), FIRST);
    expect(plan.heard).toBe('Смотри, тут подарок!');
    expect(plan.level).toBe(4);
    expect(plan.stats.dropped).toBe(1);
    expect(plan.misses).toEqual([{ key: 'line:no.such.line', level: 4 }]);
  });

  it('L5: a core sentence that misses becomes the moment’s generic line (dotted parents too)', () => {
    const plan = planClips(utter([sentence([{ line: 'no.such.line' }])], { generic: 'generic.teachTurn.turn.talk' }), fixtureIndex(), FIRST);
    expect(plan.level).toBe(5);
    expect(plan.src).toBe('generic');
    expect(plan.heard).toBe('Смотри на зелёную стрелку!');
    expect(plan.stats.generic).toBe(1);
    const parent = planClips(utter([sentence([{ line: 'no.such.line' }])], { generic: 'generic.praise.cheer' }), fixtureIndex(), FIRST);
    expect(parent.heard).toBe('Давай дальше!');
  });

  it('L5 of a danger / hidden-treasure turn (pose «think», no arrow drawn) never walks up to a line that names an arrow', () => {
    // (the starter set records generic.teachTurn.turn «Смотри на стрелку…» but not every treasure line)
    const u = utter([sentence([{ line: 'treasure.free', piece: 'n' }]), sentence([{ line: 'ask.find', g: 'm' }], 60, '?')], { generic: 'generic.teachTurn.turn.think' });
    const plan = planClips(u, fixtureIndex(), FIRST);
    expect(plan.level).toBe(5);
    expect(plan.heard).toBe('Давай дальше! Найдёшь ход сам?');
    expect(plan.heard).not.toMatch(/стрелк/u);
    // with the kind's own «think» line recorded, that one is said
    const idx = fixtureIndex();
    const id = Object.keys(idx.units)[0] as string;
    const withThink = { ...idx, units: { ...idx.units, cthink0000001: { ...idx.units[id], text: 'Хм, тут надо подумать!' } }, pools: { ...idx.pools, 'generic.teachTurn.think': ['cthink0000001'] } } as typeof idx;
    expect(planClips(u, withThink, FIRST).heard).toBe('Хм, тут надо подумать! Найдёшь ход сам?');
  });

  it('L5 keeps what was recorded around the generic line, once', () => {
    const u = utter([sentence([{ line: 'danger.hanging', piece: 'r' }], 90, '!'), sentence([{ line: 'no.such' }]), sentence([{ line: 'no.such.either' }])]);
    const plan = planClips(u, fixtureIndex(), { ...FIRST, caps: { maxSentences: 3, maxMs: 60_000 } });
    expect(plan.heard).toBe('Твоя ладья под боем! Смотри на зелёную стрелку!');
    expect(plan.stats.generic).toBe(1);
  });

  it('L6: no library, or not even a generic line → nothing is voiced', () => {
    const none = planClips(hst(), null, FIRST);
    expect(none).toMatchObject({ level: 6, src: 'none', clips: [], heard: '', ms: 0 });
    expect(none.misses).toEqual([{ key: 'library', level: 6 }]);
    const bare = planClips(utter([sentence([{ line: 'no.such' }])], { generic: 'no.generic' }), fixtureIndex(), FIRST);
    expect(bare).toMatchObject({ level: 6, src: 'none', clips: [] });
    expect(bare.misses).toContainEqual({ key: 'line:no.generic', level: 6 });
  });
});

describe('variants by piece and by the child’s gender', () => {
  it('picks the piece variant and the child’s form', () => {
    const idx = fixtureIndex();
    expect(planClips(utter([sentence([{ line: 'opp.developed', piece: 'b' }])]), idx, FIRST).heard).toBe('Соперник вывел слона.');
    expect(planClips(utter([sentence([{ line: 'danger.hanging', piece: 'p' }], 100, '!')]), idx, FIRST).heard).toBe('Твоя пешка под боем!');
    expect(planClips(utter([sentence([{ line: 'ask.find', g: 'f' }], 100, '?')]), idx, FIRST).heard).toBe('Найдёшь ход сама?');
    expect(planClips(utter([sentence([{ line: 'ask.find', g: 'm' }], 100, '?')]), idx, FIRST).heard).toBe('Найдёшь ход сам?');
  });

  it('never says the other gender: a missing gendered pool falls to the neutral wording', () => {
    const idx = fixtureIndex({ omit: ['ask.find/f'] });
    const plan = planClips(utter([sentence([{ line: 'ask.find', g: 'f' }], 100, '?')]), idx, FIRST);
    expect(plan.heard).toBe('Поищешь?');
    expect(plan.level).toBe(3);
  });

  it('a plain wording of a piece line joins every piece pool', () => {
    const units = catalogUnits(FIXTURE_CATALOG.find((l) => l.id === 'reason.attack') as (typeof FIXTURE_CATALOG)[number]);
    const plain = units.find((u) => u.wording === 2);
    expect(plain?.pools).toEqual(piecePools('reason.attack'));
    const texts = new Set<string>();
    for (const r of [0, 0.99]) texts.add(planClips(hst(), fixtureIndex(), { rng: () => r, jitter: false }).clips[2]?.text ?? '');
    expect([...texts].sort()).toEqual(['— и сразу в атаку!', '— нападаешь на коня!']);
  });
});

describe('the SAN guard (§6.2)', () => {
  it('a move the event may not name is never voiced: the core becomes the generic line', () => {
    const plan = planClips(hst(), fixtureIndex(), { ...FIRST, allowedSans: ['e4'] });
    expect(plan.mismatch).toBe(true);
    expect(plan.level).toBe(5);
    expect(plan.heard).toBe('Смотри на зелёную стрелку!');
    expect(plan.heard).not.toContain('эф три');
  });

  it('a hidden treasure ([]) allows no move at all', () => {
    expect(planClips(hst(), fixtureIndex(), { ...FIRST, allowedSans: [] }).mismatch).toBe(true);
  });

  it('accepts the advised move in any notation of the same move', () => {
    expect(planClips(hst(), fixtureIndex(), { ...FIRST, allowedSans: ['Nf3+'] }).mismatch).toBe(false);
    const castle = utter([sentence([head(), { slot: 'nom', san: 'O-O', fen: ITALIAN }])]);
    expect(planClips(castle, fixtureIndex(), { ...FIRST, allowedSans: ['0-0'] }).heard).toBe('Мой совет — короткая рокировка.');
  });

  it('an illegal move or a form that does not fit is a mismatch too', () => {
    const illegal = planClips(utter([sentence([head(), { slot: 'nom', san: 'Nf6', fen: START }])]), fixtureIndex(), FIRST);
    expect(illegal).toMatchObject({ mismatch: true, level: 5 });
    const form = planClips(utter([sentence([head(), { slot: 'nom', san: 'exd5', fen: SCANDI }])]), fixtureIndex(), FIRST);
    expect(form).toMatchObject({ mismatch: true, level: 5 });
  });

  it('an optional sentence with a refused move is dropped, not replaced', () => {
    const u = utter([sentence([{ line: 'treasure.gift' }], 100, '!'), sentence([head(), nf3], 40)]);
    const plan = planClips(u, fixtureIndex(), { ...FIRST, allowedSans: [] });
    expect(plan.heard).toBe('Смотри, тут подарок!');
    expect(plan.mismatch).toBe(true);
    expect(plan.level).toBe(4);
  });
});

describe('gaps and timing (§5.3)', () => {
  it('sentence ends: 450 ms after . and !, 500 ms after ?', () => {
    const idx = fixtureIndex();
    const q = planClips(utter([sentence([{ line: 'ask.find', g: 'm' }], 100, '?'), sentence([{ line: 'treasure.gift' }], 50, '!')]), idx, FIRST);
    expect(q.clips[1]?.gapBeforeMs).toBe(CLIP_GAPS_MS.question);
    const dot = planClips(utter([sentence([{ line: 'treasure.gift' }], 100, '!'), sentence([{ line: 'ask.find', g: 'm' }], 50, '?')]), idx, FIRST);
    expect(dot.clips[1]?.gapBeforeMs).toBe(CLIP_GAPS_MS.sentence);
    expect(dot.sentences.map((s) => s.fromMs)).toEqual([0, dot.clips[1]?.atMs]);
    expect(dot.sentences[0]?.toMs).toBe((dot.clips[0]?.atMs ?? 0) + (dot.clips[0]?.ms ?? 0));
  });

  it('jitters every gap by ±30 ms', () => {
    // (a one-wording colon head, so the gap type is fixed whatever take the rng picks)
    const u = utter([sentence([head('teach.head.arrow'), nf3, tailN], 100, '!')]);
    const low = planClips(u, fixtureIndex(), { rng: () => 0 });
    expect(low.clips.map((c) => c.gapBeforeMs)).toEqual([0, CLIP_GAPS_MS.colon - 30, CLIP_GAPS_MS.dash - 30]);
    const high = planClips(u, fixtureIndex(), { rng: () => 0.999999 });
    expect(high.clips.map((c) => c.gapBeforeMs)).toEqual([0, CLIP_GAPS_MS.colon + 30, CLIP_GAPS_MS.dash + 30]);
    for (let i = 0; i < 20; i++) {
      const r = (i + 0.5) / 20;
      const g = planClips(u, fixtureIndex(), { rng: () => r }).clips[1]?.gapBeforeMs ?? 0;
      expect(Math.abs(g - CLIP_GAPS_MS.colon)).toBeLessThanOrEqual(30);
    }
  });

  it('5-minute games: every gap × 0.75, no barks', () => {
    const u = utter([sentence([head(), nf3, tailN], 100, '!'), sentence([{ line: 'ask.find', g: 'm' }], 100, '?')], { bark: 'cheer' });
    const plan = planClips(u, fixtureIndex(), { ...FIRST, blitz: true, caps: CLIP_CAPS.teacher });
    expect(plan.bark).toBe(false);
    expect(plan.clips.map((c) => c.gapBeforeMs)).toEqual([0, 210, 210, 338]);
  });
});

describe('barks (§7.5)', () => {
  const praise = (over: Partial<ClipUtterance> = {}): ClipUtterance => utter([sentence([{ line: 'praise.good' }], 100, '!')], { bark: 'cheer', ...over });

  it('before ≈ 35 % of priority-1 utterances, 200 ms before the line, heard first', () => {
    const plan = planClips(praise(), fixtureIndex(), { ...FIRST, priority: 1 });
    expect(plan.bark).toBe(true);
    expect(roles(plan)).toEqual(['bark', 'whole']);
    expect(plan.clips[1]?.gapBeforeMs).toBe(CLIP_GAPS_MS.bark);
    expect(plan.heard).toBe('Ого! Здорово, я рад!');
    expect(plan.clips[0]?.sentence).toBe(0);
    expect(plan.sentences[0]?.fromMs).toBe(0);
    expect(planClips(praise(), fixtureIndex(), { rng: () => 0.34, jitter: false }).bark).toBe(true);
    expect(planClips(praise(), fixtureIndex(), { rng: () => 0.35, jitter: false }).bark).toBe(false);
  });

  it('never twice in a row, never in blitz, never for priority 0 / 2, never before an interjection, never without a pool', () => {
    const idx = fixtureIndex();
    expect(planClips(praise(), idx, { ...FIRST, prevBark: true }).bark).toBe(false);
    expect(planClips(praise(), idx, { ...FIRST, blitz: true }).bark).toBe(false);
    expect(planClips(praise(), idx, { ...FIRST, priority: 2 }).bark).toBe(false);
    expect(planClips(praise(), idx, { ...FIRST, priority: 0 }).bark).toBe(false);
    expect(planClips(utter([sentence([{ line: 'praise.wow' }], 100, '!')], { bark: 'cheer' }), idx, FIRST).bark).toBe(false);
    expect(planClips(praise({ bark: 'oops' }), idx, FIRST).bark).toBe(false);
    expect(planClips(praise({ bark: undefined }), idx, FIRST).bark).toBe(false);
  });
});

describe('caps (§3.5): the bark, then prio < 100 sentences, then tails', () => {
  const two = (): ClipUtterance => utter([sentence([head(), nf3, tailN], 100, '!'), sentence([{ line: 'ask.find', g: 'm' }], 60, '?')], { bark: 'cheer' });

  it('teacher: ≤ 12 s — the bark and the optional sentence go, then the tail', () => {
    const idx = fixtureIndex({ msPerChar: 300 });
    const plan = planClips(two(), idx, { ...FIRST, caps: clipCapsFor({ kind: 'teachTurn', style: 'full' }) });
    expect(plan.bark).toBe(false);
    expect(plan.heard).toBe('Мой совет — конь на эф три.');
    expect(plan.ms).toBeLessThanOrEqual(12_000);
    expect(plan.long).toBe(false);
    expect(plan.stats.dropped).toBe(1);
    expect(plan.level).toBe(1); // a cap is no library miss
    expect(plan.misses).toEqual([]);
  });

  it('short / blitz: ≤ 1 sentence and 7 s — the core is never dropped (it is reported as long)', () => {
    const idx = fixtureIndex({ msPerChar: 300 });
    const plan = planClips(two(), idx, { ...FIRST, caps: clipCapsFor({ kind: 'teachTurn', style: 'full', blitz: true }) });
    expect(plan.sentences).toHaveLength(1);
    expect(plan.heard).toBe('Мой совет — конь на эф три.');
    expect(plan.long).toBe(true);
  });

  it('within the time budget only the sentence count is enforced', () => {
    const plan = planClips(two(), fixtureIndex(), { ...LAST, caps: CLIP_CAPS.short });
    expect(plan.sentences).toHaveLength(1);
    expect(roles(plan)).toEqual(['head', 'slot', 'tail']);
    expect(plan.long).toBe(false);
  });

  it('picks the caps by event', () => {
    expect(clipCapsFor({ kind: 'teachTurn', style: 'full' })).toEqual({ maxSentences: 2, maxMs: 12_000 });
    expect(clipCapsFor({ kind: 'teachTurn', style: 'short' })).toEqual({ maxSentences: 1, maxMs: 7_000 });
    expect(clipCapsFor({ kind: 'teachReaction', blitz: true })).toEqual({ maxSentences: 1, maxMs: 7_000 });
    expect(clipCapsFor({ kind: 'praise' })).toEqual({ maxSentences: 2, maxMs: 9_000 });
  });
});

describe('recency: no identical take within the last plays of its pool (§7.3)', () => {
  const advice = (): ClipUtterance => utter([sentence([head(), nf3])]);

  it('plays every take of a pool before repeating one, then the least recently heard', () => {
    const idx = fixtureIndex({ takes: 2 });
    expect(idx.pools['teach.head.advice']).toHaveLength(6);
    const rec = createClipRecency();
    const heads: string[] = [];
    for (let i = 0; i < 6; i++) {
      const plan = planClips(advice(), idx, { rng: () => 0.5, jitter: false, recency: rec });
      heads.push(plan.clips[0]?.id as string);
      rec.note(plan.clips.map((c) => c.id));
    }
    expect(new Set(heads).size).toBe(6);
    const seventh = planClips(advice(), idx, { rng: () => 0.5, jitter: false, recency: rec });
    expect(seventh.clips[0]?.id).toBe(heads[0]);
  });

  it('the window counts plays of the pool: outside it a take is fresh again', () => {
    const idx = fixtureIndex({ takes: 2 });
    const rec = createClipRecency();
    const pool = idx.pools['teach.head.advice'] as string[];
    rec.note([pool[0] as string, pool[1] as string, pool[2] as string]);
    const picks = new Set<string>();
    for (const r of [0, 0.3, 0.6, 0.99]) picks.add(planClips(advice(), idx, { rng: () => r, jitter: false, recency: rec, recencyWindow: () => 2 }).clips[0]?.id as string);
    // the two most recent (pool[2], pool[1]) are never picked; pool[0] is outside the window of 2
    expect(picks.has(pool[1] as string)).toBe(false);
    expect(picks.has(pool[2] as string)).toBe(false);
    expect(picks.has(pool[0] as string)).toBe(true);
  });

  it('one plan never uses the same take twice', () => {
    const u = utter([sentence([{ line: 'treasure.gift' }], 100, '!'), sentence([{ line: 'treasure.gift' }], 100, '!')]);
    const plan = planClips(u, fixtureIndex(), FIRST);
    expect(plan.clips[0]?.id).not.toBe(plan.clips[1]?.id);
  });

  it('greeting, game start and game end pools remember 20 plays', () => {
    expect(defaultRecencyWindow('teach.head.advice')).toBe(CLIP_RECENCY_WINDOW);
    expect(defaultRecencyWindow('greeting.hello')).toBe(CLIP_RECENCY_WINDOW_LONG);
    expect(defaultRecencyWindow('gameStart.teacher/f')).toBe(CLIP_RECENCY_WINDOW_LONG);
    expect(defaultRecencyWindow('generic.gameEnd')).toBe(CLIP_RECENCY_WINDOW_LONG);
    expect(defaultRecencyWindow('gameStarter')).toBe(CLIP_RECENCY_WINDOW);
  });

  it('persists across games: snapshot / restore, capped, junk ignored', () => {
    const rec = createClipRecency({ capacity: 3 });
    rec.note(['c0000000000001', 'c0000000000002', 'not-an-id', 'c0000000000003', 'c0000000000004']);
    expect(rec.snapshot()).toEqual(['c0000000000002', 'c0000000000003', 'c0000000000004']);
    rec.note(['c0000000000002']);
    expect(rec.snapshot()).toEqual(['c0000000000003', 'c0000000000004', 'c0000000000002']);
    const again = createClipRecency({ init: rec.snapshot() });
    expect((again.lastPlayed('c0000000000002') ?? 0) > (again.lastPlayed('c0000000000003') ?? 0)).toBe(true);
    expect(again.lastPlayed('c0000000000001')).toBeUndefined();
    again.restore(['<script>', 'c00000000000ff'] as string[]);
    expect(again.snapshot()).toEqual(['c00000000000ff']);
  });
});

describe('«Дозапись голоса»: the bubble\'s own wording first, and what a twin asks to have recorded', () => {
  const W = (line: string, variant: { piece?: 'p' | 'n' | 'b' | 'r' | 'q'; g?: 'm' | 'f' } = {}, prio = 100): ClipSentence => sentence([{ line, ...variant }], prio, '!');
  const greeting = (sentences: ClipSentence[]): ClipUtterance => ({ sentences, generic: 'generic.greeting', bark: 'wave' });
  const NO_BARK: PlanContext = { rng: () => 0.99, jitter: false };

  it('a known wording plays its own take, whatever the rng — the voice says the bubble', () => {
    const index = catalogIndex();
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const plan = planClips(greeting([W('greet.hello.day')]), index, { rng: () => r, jitter: false, wordings: [2] });
      expect(plan.heard).toBe('Привет-привет, добрый день!');
      expect(plan.level).toBe(1);
      expect(plan.lineMissing).toBeUndefined();
    }
    // a gendered wording and a plain one of the same gendered line
    expect(planClips(greeting([W('greet.win', { g: 'f' })]), index, { ...NO_BARK, wordings: [1] }).heard).toBe('В прошлый раз ты победила — здорово! Сыграем ещё?');
    expect(planClips(greeting([W('greet.win', { g: 'f' })]), index, { ...NO_BARK, wordings: [2] }).heard).toBe('Помню твою прошлую победу. Поехали дальше?');
    // an unknown wording: the pool as before
    expect(planClips(greeting([W('greet.hello.day')]), index, { ...NO_BARK, wordings: [null] }).level).toBe(1);
  });

  it("the bubble's wording without a take is asked for, even while the pool voiced another one", () => {
    const index = catalogIndex({ omit: ['line:greet.hello.day#2'] });
    const plan = planClips(greeting([W('greet.hello.day'), W('greet.none', {}, 80)]), index, { ...NO_BARK, wordings: [2, 3] });
    expect(plan.level).toBe(1);
    expect(plan.clips).toHaveLength(2);
    expect(plan.sentences[1]?.text).toBe('Доска ждёт! С чего начнём?');
    expect(plan.lineMissing).toEqual([{ id: 'greet.hello.day', n: 2 }]);
    // the variant is the wording's own: a gendered wording keeps its gender, a plain one of a piece line drops the piece
    const gendered = planClips(greeting([W('greet.win', { g: 'f' })]), catalogIndex({ omit: ['line:greet.win/f#1'] }), { ...NO_BARK, wordings: [1] });
    expect(gendered.lineMissing).toEqual([{ id: 'greet.win', n: 1, g: 'f' }]);
    const plain = planClips(greeting([W('ask.opp.hanging', { piece: 'q' })]), catalogIndex({ omit: ['line:ask.opp.hanging#3'] }), { ...NO_BARK, wordings: [3] });
    expect(plain.lineMissing).toEqual([{ id: 'ask.opp.hanging', n: 3 }]);
  });

  it('without a known wording: only a line with no take at all, its cheapest wording (a blocked one skipped)', () => {
    // the line has takes: nothing is asked, whatever wording the pool chose
    expect(planClips(greeting([W('greet.hello.day')]), catalogIndex({ omit: ['line:greet.hello.day#2'] }), NO_BARK).lineMissing).toBeUndefined();
    // no take of the line at all: the sentence falls to the generic line (L5) and its cheapest wording is asked for
    const none = catalogIndex({ omit: ['greet.hello.day'] });
    const plan = planClips(greeting([W('greet.hello.day')]), none, NO_BARK);
    expect(plan.level).toBe(5);
    expect(plan.lineMissing).toEqual([{ id: 'greet.hello.day', n: 1 }]);
    const merged = mergeClipIndexes({ ...none, fallbacks: none.fallbacks ?? {} }, { units: {}, keys: {}, pools: {}, blocked: ['line:greet.hello.day#1'] });
    expect(planClips(greeting([W('greet.hello.day')]), merged, NO_BARK).lineMissing).toEqual([{ id: 'greet.hello.day', n: 2 }]);
    // a line that fell to its sibling (L3): a wording for both genders first
    const sibling = planClips(greeting([W('greet.win', { g: 'f' })]), catalogIndex({ omit: ['greet.win', 'greet.win/m', 'greet.win/f'] }), NO_BARK);
    expect(sibling.level).toBe(3);
    expect(sibling.lineMissing).toEqual([{ id: 'greet.win', n: 2 }]);
    // an optional sentence dropped (L4) is asked for too; one line twice is asked once
    const twice = planClips(greeting([W('greet.hello.day'), W('greet.hello.day', {}, 80)]), none, NO_BARK);
    expect(twice.lineMissing).toEqual([{ id: 'greet.hello.day', n: 1 }]);
  });

  it('the same words recorded for another line serve this one: played, and never asked for again', () => {
    // «Привет!» exists only as the game's hello (`hello.game#1`); the day greeting's own wording 5 says the same words
    const index = catalogIndex({ omit: ['line:greet.hello.day#5', 'line:greet.hello.evening#5', 'line:greet.hello.night#3', 'line:start.open.greet#14'] });
    const plan = planClips(greeting([W('greet.hello.day')]), index, { ...NO_BARK, wordings: [5] });
    expect(plan.heard).toBe('Привет!');
    expect(plan.clips.map((c) => c.id)).toEqual(index.keys['line:hello.game#1']);
    expect(plan.lineMissing).toBeUndefined();
  });

  it('a free-worded answer (`grow`): any recorded wording plays; the line grows to a few recorded wordings, one at a time', () => {
    const answer = (line: string): ClipUtterance => ({ sentences: [W(line)], generic: 'generic.answer.thought', bark: 'cheer' });
    // nothing recorded: its cheapest wording (silent now)
    const none = planClips(answer('thought.easy'), catalogIndex({ omit: ['thought.easy'] }), { ...NO_BARK, grow: 3 });
    expect(none.level).toBe(5);
    expect(none.lineMissing).toEqual([{ id: 'thought.easy', n: 2 }]);
    // one of its two wordings recorded: voiced by it, and the other one is asked for (the next time he may say that)
    const one = planClips(answer('thought.easy'), catalogIndex({ omit: ['line:thought.easy#2'] }), { ...NO_BARK, grow: 3 });
    expect(one.heard).toBe('Легко? Тогда в следующий раз позовём соперника посильнее!');
    expect(one.lineMissing).toEqual([{ id: 'thought.easy', n: 2 }]);
    // every wording recorded (a line with fewer wordings than `grow`), or `grow` reached: nothing more
    expect(planClips(answer('thought.easy'), catalogIndex(), { ...NO_BARK, grow: 3 }).lineMissing).toBeUndefined();
    // (poke #7 counts as recorded: the same words are recorded as a thought reply)
    const poke = catalogIndex({ omit: ['line:poke#4', 'line:poke#5', 'line:poke#6', 'line:poke#7', 'line:poke#8', 'line:poke#9'] });
    expect(planClips(answer('poke'), poke, { ...NO_BARK, grow: 4 }).lineMissing).toBeUndefined();
    expect(planClips(answer('poke'), poke, { ...NO_BARK, grow: 5 }).lineMissing).toHaveLength(1);
    // without `grow`: only a line with no take at all, as before
    expect(planClips(answer('thought.easy'), catalogIndex({ omit: ['line:thought.easy#2'] }), NO_BARK).lineMissing).toBeUndefined();
  });

  it("a bubble whose words are no wording of the line (a null in `wordings`) asks for nothing: never words it does not show", () => {
    const none = catalogIndex({ omit: ['greet.hello.day'] });
    expect(planClips(greeting([W('greet.hello.day')]), none, { ...NO_BARK, wordings: [null] }).lineMissing).toBeUndefined();
    // the other sentence, whose wording is known, is still asked for
    const two = planClips(greeting([W('greet.hello.day'), W('greet.none', {}, 80)]), catalogIndex({ omit: ['greet.hello.day', 'greet.none'] }), { ...NO_BARK, wordings: [null, 3] });
    expect(two.lineMissing).toEqual([{ id: 'greet.none', n: 3 }]);
  });

  it('existence, not availability: a take that failed to load is not missing', () => {
    const plan = planClips(greeting([W('greet.hello.day')]), catalogIndex(), { ...NO_BARK, wordings: [1], available: () => false });
    expect(plan.clips).toEqual([]);
    expect(plan.lineMissing).toBeUndefined();
    expect(planClips(greeting([W('greet.hello.day')]), null, { ...NO_BARK, wordings: [1] }).lineMissing).toBeUndefined();
  });

  it('never a head, a tail, a slot, a generic line, a line the web may not record, or a compiled text', () => {
    const bare = catalogIndex({ omit: ['teach.head.advice', ...piecePools('reason.attack'), 'generic.teachTurn.turn', 'generic.teachTurn', 'generic', 'preview'] });
    const hs = utter([sentence([head(), { slot: 'ins', san: 'Nf3', fen: START }, tailN])]);
    expect(planClips(hs, bare, NO_BARK).lineMissing).toBeUndefined();
    expect(planClips(greeting([W('preview')]), bare, { ...NO_BARK, wordings: [1] }).lineMissing).toBeUndefined();
    expect(planClips(greeting([W('preview')]), bare, NO_BARK).lineMissing).toBeUndefined();
    const text = compileText('Совсем новые слова!', { generic: 'generic.greeting' });
    expect(planClips(text, catalogIndex({ omit: ['generic.greeting', 'generic'] }), NO_BARK).lineMissing).toBeUndefined();
  });
});
