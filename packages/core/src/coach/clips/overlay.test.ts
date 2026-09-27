/**
 * «Дозапись голоса»: the static library merged with the recorded overlay — new objects on every merge (the planner
 * caches by identity), the text index (a shifted wording number never makes existing audio stale), `blocked`, and the
 * exact-text lookup every consumer shares (planner, book probe, server dedup).
 */
import { describe, expect, it } from 'vitest';
import { buildClipIndex, lessonQuizKey, mergeClipIndexes, normUnitText, takesForUnit, unitTextKey } from './keys.ts';
import type { ClipIndexEntry } from './keys.ts';

const base = buildClipIndex([
  { id: 'c0000000000001', key: 'line:v3.lead.advice@n#1', text: 'Давай сходим конём', ms: 900, pools: ['v3.lead.advice@n'] },
  { id: 'c0000000000002', key: 'line:v3.idea.mate#1', text: '— и это мат!', ms: 700, pools: ['v3.idea.mate'] },
] satisfies ClipIndexEntry[]);

const overlayEntries: ClipIndexEntry[] = [
  // the writers inserted a wording: the take recorded as #2 now serves #3 of the same text
  { id: 'c00000000000a1', key: 'line:v3.aim.develop#2', text: 'Нашим фигурам пора в игру', ms: 1100, pools: ['v3.aim.develop'] },
  { id: 'c00000000000a2', key: 'line:v3.idea.mate#1', text: '— и это мат!', ms: 720, pools: ['v3.idea.mate'], ctx: 'cont' },
  { id: 'c00000000000a3', key: 'frag:f:коня, слона или ладью|?', text: 'Коня, слона или ладью?', ms: 1500 },
];
const overlay = { ...buildClipIndex(overlayEntries), voiceKey: 'giselle-mm1', blocked: ['line:v3.self.develop/f#5'] };

describe('unit keys of the overlay', () => {
  it('keys the quiz options sentence as a frag with «?»', () => {
    expect(lessonQuizKey('Коня, слона или ладью?')).toBe('frag:f:коня, слона или ладью|?');
  });

  it('compares texts exactly, up to spaces and Unicode form', () => {
    expect(normUnitText('  Давай   сходим конём ')).toBe('Давай сходим конём');
    expect(normUnitText('Ещё «раз»!')).toBe('Ещё «раз»!');
  });

  it('text-indexes line units by pool variant and text; other kinds have no text key', () => {
    expect(unitTextKey('line:v3.lead.advice@n#12', 'Давай сходим конём')).toBe('line:v3.lead.advice@n|Давай сходим конём');
    expect(unitTextKey('frag:f:коня|?', 'Коня?')).toBeNull();
    expect(unitTextKey('slot:ins:n:f6', 'конём на эф шесть')).toBeNull();
  });
});

describe('mergeClipIndexes', () => {
  it('concatenates without duplicates and builds new objects every time', () => {
    const a = mergeClipIndexes(base, overlay);
    const b = mergeClipIndexes(base, overlay);
    expect(a.keys['line:v3.idea.mate#1']).toEqual(['c0000000000002', 'c00000000000a2']);
    expect(a.pools['v3.idea.mate']).toEqual(['c0000000000002', 'c00000000000a2']);
    expect(Object.keys(a.units)).toHaveLength(5);
    expect(a.units).not.toBe(b.units);
    expect(a.keys).not.toBe(b.keys);
    expect(a.pools).not.toBe(b.pools);
    expect(a.textIndex).not.toBe(b.textIndex);
    expect(a.keys['line:v3.idea.mate#1']).not.toBe(base.keys['line:v3.idea.mate#1']);
    // the inputs are untouched
    expect(base.keys['line:v3.idea.mate#1']).toEqual(['c0000000000002']);
  });

  it('carries the overlay`s blocked keys and ignores an overlay of another voice', () => {
    expect(mergeClipIndexes(base, overlay).blocked.has('line:v3.self.develop/f#5')).toBe(true);
    const other = mergeClipIndexes({ ...base, voiceKey: 'giselle-mm1' }, { ...overlay, voiceKey: 'other-voice' });
    expect(Object.keys(other.units)).toHaveLength(2);
    expect(other.blocked.size).toBe(0);
  });

  it('copies the fallbacks and the static library`s keys into new objects too (the inputs are never shared)', () => {
    const withFallbacks = { ...base, fallbacks: { 'teach.x': 'teach.y' } };
    const a = mergeClipIndexes(withFallbacks, overlay);
    expect(a.fallbacks).toEqual({ 'teach.x': 'teach.y' });
    expect(a.fallbacks).not.toBe(withFallbacks.fallbacks);
    const alone = mergeClipIndexes(base, null);
    expect(alone.keys).not.toBe(base.keys);
    expect(alone.keys['line:v3.lead.advice@n#1']).not.toBe(base.keys['line:v3.lead.advice@n#1']);
    expect(alone.pools).not.toBe(base.pools);
    alone.keys['line:v3.lead.advice@n#1']?.push('c0000000000099');
    expect(base.keys['line:v3.lead.advice@n#1']).toEqual(['c0000000000001']);
  });

  it('honours `alsoKeys`: one take of a text shared by piece variants serves each key, and each variant`s text index', () => {
    const shared = buildClipIndex([
      { id: 'c00000000000c1', key: 'line:v3.aim.safe@n#2', alsoKeys: ['line:v3.aim.safe@b#2'], text: 'Спрячем его подальше', ms: 900, pools: ['v3.aim.safe@n', 'v3.aim.safe@b'] },
    ]);
    const merged = mergeClipIndexes(base, { ...shared, voiceKey: 'giselle-mm1' });
    expect(takesForUnit(merged, 'line:v3.aim.safe@b#2', 'Спрячем его подальше')).toEqual(['c00000000000c1']);
    expect(takesForUnit(merged, 'line:v3.aim.safe@b#7', 'Спрячем его подальше')).toEqual(['c00000000000c1']);
    expect(takesForUnit(merged, 'line:v3.aim.safe@r#2', 'Спрячем его подальше')).toEqual([]);
  });

  it('takes blocked keys from either layer (a Set or a list)', () => {
    const merged = mergeClipIndexes({ ...base, blocked: new Set(['line:v3.a#1']) }, { ...overlay, blocked: ['line:v3.b#2'] });
    expect([...merged.blocked].sort()).toEqual(['line:v3.a#1', 'line:v3.b#2']);
  });

  it('works with either side missing', () => {
    expect(Object.keys(mergeClipIndexes(null, overlay).units)).toHaveLength(3);
    expect(Object.keys(mergeClipIndexes(base, undefined).units)).toHaveLength(2);
    expect(mergeClipIndexes(null, null).textIndex).toEqual({});
  });
});

describe('takesForUnit', () => {
  const merged = mergeClipIndexes(base, overlay);

  it('finds takes by the exact key whose text is exactly the expansion', () => {
    expect(takesForUnit(merged, 'line:v3.lead.advice@n#1', 'Давай сходим конём')).toEqual(['c0000000000001']);
    expect(takesForUnit(merged, 'line:v3.idea.mate#1', '— и это мат!')).toEqual(['c0000000000002', 'c00000000000a2']);
    expect(takesForUnit(merged, 'frag:f:коня, слона или ладью|?', 'Коня, слона или ладью?')).toEqual(['c00000000000a3']);
  });

  it('never plays a stale take: a key whose recorded text differs is no recording of this text', () => {
    expect(takesForUnit(merged, 'line:v3.lead.advice@n#1', 'Давай сходим конём вперёд')).toEqual([]);
    expect(takesForUnit(base, 'line:v3.lead.advice@n#1', 'Давай сходим конём вперёд')).toEqual([]);
  });

  it('falls back to the text index when the wording number shifted (merged index only)', () => {
    expect(takesForUnit(merged, 'line:v3.aim.develop#3', 'Нашим фигурам пора в игру')).toEqual(['c00000000000a1']);
    expect(takesForUnit(merged, 'line:v3.aim.develop#3', 'Нашим фигурам пора в бой')).toEqual([]);
    // another pool variant with the same text is not this unit
    expect(takesForUnit(merged, 'line:v3.aim.other#1', 'Нашим фигурам пора в игру')).toEqual([]);
  });
});
