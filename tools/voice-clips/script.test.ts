/**
 * `voice:script`: the units, the lint of the voice rules, the tiers — and that the committed script is the one the
 * committed stats, demo and CURRENT catalogue give (a catalogue edit without `pnpm voice:script` fails here).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLIP_CATALOG, CLIP_TAP_LINES, allMoveSlotKeys, allSplitSlotKeys, catalogUnits, poolKeyOf } from '../../packages/core/src/coach/clips/index.ts';
import { DEFAULT_SCRIPT, DEFAULT_STATS, readDemo, scriptFrom } from './cliCatalog.ts';
import type { StatsFile } from './cliCatalog.ts';
import type { HarvestStats } from './harvest.ts';
import { STARTER_BUDGET, STARTER_GENERIC_WORDINGS, assignTiers, fragText, isGenericLine, poolTarget, scriptUnits, unitCredits, unitLint } from './script.ts';
import type { ScriptFile, ScriptUnit } from './script.ts';

const stats = JSON.parse(readFileSync(DEFAULT_STATS, 'utf8')) as StatsFile;
const committed = JSON.parse(readFileSync(DEFAULT_SCRIPT, 'utf8')) as ScriptFile;

function emptyStats(over: Partial<HarvestStats> = {}): HarvestStats {
  return { v: 1, voiceKey: 'giselle-mm1', split: 'train', games: 10, teacherGames: 10, blitzGames: 5, events: 0, byKind: {}, pools: {}, slots: {}, frags: {}, ...over };
}

describe('units', () => {
  it('every catalogue wording × variant, every move slot, the split set, the recordable fragments', () => {
    const units = scriptUnits(stats.train);
    const lines = CLIP_CATALOG.reduce((n, l) => n + catalogUnits(l).filter((u) => u.text !== null).length, 0);
    expect(units.filter((u) => u.kind === 'line' || u.kind === 'bark')).toHaveLength(lines);
    expect(units.filter((u) => u.batch === 'slot.move')).toHaveLength(allMoveSlotKeys().length);
    expect(units.filter((u) => u.batch === 'slot.split')).toHaveLength(allSplitSlotKeys().length);
    expect(new Set(units.map((u) => u.key)).size).toBe(units.length);
    // a fragment right before a square is never recorded (its sentence falls down the ladder)
    expect(units.some((u) => u.kind === 'frag' && u.key.endsWith('|'))).toBe(false);
    expect(units.find((u) => u.key === 'slot:ins:n:f3')?.text).toBe('конём на эф три');
    expect(units.find((u) => u.key === 'slot:head:ins:q')?.text).toBe('ферзём');
  });

  it('records a fragment with its own seam or sentence end', () => {
    expect(fragText('поторопись', '!')).toBe('Поторопись!');
    expect(fragText('я бы сыграл так', ':')).toBe('Я бы сыграл так:');
    expect(fragText('сильный ход', '—')).toBe('Сильный ход —');
  });
});

describe('lint', () => {
  const frag = (text: string): Pick<ScriptUnit, 'key' | 'kind' | 'text' | 'role'> => ({ key: 'frag:f:x|.', kind: 'frag', text, role: 'frag' });

  it('keeps squares in slot units only', () => {
    expect(unitLint(frag('Конь на эф шесть под боем!')).join()).toMatch(/square/);
    expect(unitLint(frag('Твой конь под боем!'))).toEqual([]);
    expect(unitLint({ key: 'slot:ins:n:f6', kind: 'slot', text: 'конём на эф шесть', role: 'slot' })).toEqual([]);
    expect(unitLint({ key: 'slot:ins:n:f6', kind: 'slot', text: 'конь на эф шесть', role: 'slot' }).join()).toMatch(/canonical/);
  });

  it('Гамбитик is a boy: a feminine self-reference is an error, the masculine one is fine', () => {
    expect(unitLint(frag('Я так рада!')).join()).toMatch(/selfFeminine/);
    expect(unitLint(frag('Я заметила этот ход.')).join()).toMatch(/selfFeminine/);
    expect(unitLint(frag('Я заметил этот ход.'))).toEqual([]);
    expect(unitLint(frag('Я вижу, ты нашла ход!'))).toEqual([]);
  });

  it('the catalogue itself is clean and every unit that would be recorded passes', () => {
    expect(committed.lint).toEqual([]);
    for (const u of committed.units) if (u.tier) expect(u.lint, u.key).toBeUndefined();
    expect(committed.units.filter((u) => u.lint && u.kind !== 'frag')).toEqual([]);
  });
});

describe('tiers', () => {
  it('pool targets follow SPEC §7.1', () => {
    expect(poolTarget(3.2)).toEqual({ wordings: 6, takes: 2 });
    expect(poolTarget(1.5)).toEqual({ wordings: 4, takes: 1 });
    expect(poolTarget(0.3)).toEqual({ wordings: 2, takes: 1 });
    expect(poolTarget(0.01)).toEqual({ wordings: 1, takes: 1 });
  });

  it('pilot units first, the split set always, every heard pool covered, hot pools twice, the rest full', () => {
    const s = emptyStats({
      pools: { 'teach.head.advice': { plays: 40, games: 10 }, 'reason.attack@n': { plays: 3, games: 3 } },
      slots: { 'ins:n:f3': { plays: 12, games: 8 }, 'nom:p:e4': { plays: 2, games: 2 } },
    });
    const units = scriptUnits(s);
    assignTiers(units, s, new Set(['line:teach.head.advice#1']), 30);
    const tier = (key: string): string | undefined => units.find((u) => u.key === key)?.tier;
    expect(tier('line:teach.head.advice#1')).toBe('pilot');
    expect(units.filter((u) => u.batch === 'slot.split').every((u) => u.tier === 'starter')).toBe(true);
    // the exact variant first: «— нападаешь на коня!», not a plain wording
    const attack = units.filter((u) => u.tier === 'starter' && u.pools?.includes('reason.attack@n'));
    expect(attack[0]?.pool).toBe('reason.attack@n');
    // 4 plays a game: 6 wordings of the head, two takes of the starter ones
    const heads = units.filter((u) => u.line === 'teach.head.advice' && u.tier);
    expect(heads).toHaveLength(6);
    expect(heads.filter((u) => u.tier === 'starter').every((u) => u.takes === 2)).toBe(true);
    // the heads carry moves for free: the heard moves are starter units
    expect(tier('slot:ins:n:f3')).toBe('starter');
    expect(tier('slot:nom:p:e4')).toBe('starter');
    expect(units.filter((u) => !u.lint).every((u) => u.tier !== undefined)).toBe(true);
  });

  it('puts the split set and one recording per heard pool first, whatever the budget; extras only within it', () => {
    const small = scriptUnits(stats.train);
    assignTiers(small, stats.train, new Set(), 20);
    const big = scriptUnits(stats.train);
    assignTiers(big, stats.train, new Set(), 120);
    const starter = (units: ScriptUnit[]): ScriptUnit[] => units.filter((u) => u.tier === 'starter');
    const heard = Object.keys(stats.train.pools);
    for (const units of [small, big]) {
      const covered = new Set(starter(units).flatMap((u) => u.pools ?? []));
      expect(heard.filter((p) => !covered.has(p) && units.some((u) => !u.lint && u.pools?.includes(p)))).toEqual([]);
    }
    expect(starter(big).length).toBeGreaterThan(starter(small).length);
    expect(starter(big).reduce((n, u) => n + unitCredits(u), 0)).toBeGreaterThan(starter(small).reduce((n, u) => n + unitCredits(u), 0));
  });
});

describe('what the harvest never hears is in the Starter anyway', () => {
  const early = (u: ScriptUnit): boolean => u.tier === 'pilot' || u.tier === 'starter';

  it('every tap line of the web (each piece it names) and ≥ 4 wordings of every generic line — whatever the budget', () => {
    for (const budget of [5, STARTER_BUDGET]) {
      const units = scriptUnits(stats.train);
      assignTiers(units, stats.train, new Set(), budget);
      for (const t of CLIP_TAP_LINES) {
        for (const piece of t.pieces ?? [undefined]) {
          const pool = poolKeyOf(t.line, piece);
          expect(units.filter((u) => early(u) && u.pools?.includes(pool)).length, `${pool} @ ${budget}`).toBeGreaterThanOrEqual(1);
        }
        if (!t.pieces) expect(units.filter((u) => early(u) && u.line === t.line).length, t.line).toBeGreaterThanOrEqual(Math.min(2, CLIP_CATALOG.find((l) => l.id === t.line)?.wordings.length ?? 0));
      }
      const generics = CLIP_CATALOG.filter((l) => isGenericLine(l.id));
      expect(generics.map((l) => l.id)).toContain('generic');
      for (const l of generics) expect(units.filter((u) => early(u) && u.line === l.id).length, `${l.id} @ ${budget}`).toBeGreaterThanOrEqual(Math.min(STARTER_GENERIC_WORDINGS, l.wordings.length));
    }
  });

  it('the committed script has them too (the web checks its own emitted ids against it: clipAsk.test.ts)', () => {
    for (const t of CLIP_TAP_LINES) for (const piece of t.pieces ?? [undefined]) expect(committed.units.some((u) => early(u) && u.pools?.includes(poolKeyOf(t.line, piece))), t.line).toBe(true);
    for (const l of CLIP_CATALOG.filter((x) => isGenericLine(x.id))) expect(committed.units.filter((u) => early(u) && u.line === l.id).length, l.id).toBeGreaterThanOrEqual(STARTER_GENERIC_WORDINGS);
  });
});

describe('the committed script', () => {
  it('is what the committed stats, the demo and the current catalogue give (run `pnpm voice:script` after a catalogue edit)', () => {
    const fresh = scriptFrom(stats, committed.demo ? readDemo(committed.demo) : null);
    expect(fresh.units.map((u) => `${u.key} ${u.tier ?? '-'} ${u.takes}`)).toEqual(committed.units.map((u) => `${u.key} ${u.tier ?? '-'} ${u.takes}`));
    expect(fresh.units.map((u) => u.text)).toEqual(committed.units.map((u) => u.text));
  });

  it('prices the starter within its budget (≈ 84 credits beyond the `pilot` tier)', () => {
    expect(committed.budget.starter).toBe(STARTER_BUDGET);
    expect(committed.budget.starterPrice).toBeLessThanOrEqual(STARTER_BUDGET);
    expect(committed.budget.starterPrice).toBeGreaterThan(STARTER_BUDGET - 3);
    expect(committed.demo).toBe(stats.demo?.seed);
  });
});
