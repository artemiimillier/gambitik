/**
 * `voice:plan`: the recipes' packing (pure, no call) and the `pilot` job list — its price under the hard cap, its
 * probes, and that the committed `jobs.pilot.json` is exactly what the committed script and demo give.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLIP_CATALOG, CLIP_TAP_LINES, catalogFallbacks } from '../../packages/core/src/coach/clips/index.ts';
import { DEFAULT_SCRIPT, jobsFileOf, readDemo } from './cliCatalog.ts';
import { codePoints, jobMilli } from './cost.ts';
import { demoEvents } from './harvest.ts';
import { isDiscard, parseJobsFile } from './jobs.ts';
import type { GenJob, JobsFile, UnitPiece } from './jobs.ts';
import {
  MAX_SLOTS_PER_JOB,
  MAX_SLOT_JOB_CHARS,
  PILOT_HARD_CAP_CREDITS,
  PILOT_TARGET_CREDITS,
  TAG_TAIL,
  TAG_WHOLE,
  dedupeTakes,
  jobsReport,
  packCampaign,
  packSlots,
  packWhole,
  planPilot,
} from './planJobs.ts';
import type { Recording } from './planJobs.ts';
import type { ScriptFile, ScriptUnit } from './script.ts';

const script = JSON.parse(readFileSync(DEFAULT_SCRIPT, 'utf8')) as ScriptFile;
const demo = readDemo(script.demo as string);
const committedPilot = JSON.parse(readFileSync(jobsFileOf('pilot'), 'utf8')) as JobsFile;

function unit(over: Partial<ScriptUnit> & Pick<ScriptUnit, 'key' | 'text'>): ScriptUnit {
  return { kind: 'line', recipe: 'whole', demand: 0, priority: 0, takes: 1, batch: 'test', ...over };
}
const rec = (u: ScriptUnit): Recording => ({ unit: u, tier: 'starter' });
const units = (j: GenJob): UnitPiece[] => j.pieces.filter((p): p is UnitPiece => !isDiscard(p));

describe('whole lines', () => {
  it('fill the price bucket the first line opened, ≤ 3 per job, a question last and alone of its kind', () => {
    const lines = [
      unit({ key: 'line:a#1', text: 'Смотри, тут подарок!' }),
      unit({ key: 'line:b#1', text: 'Найдёшь ход сам?' }),
      unit({ key: 'line:c#1', text: 'Поищешь?' }),
      unit({ key: 'line:d#1', text: 'Ого!' }),
      unit({ key: 'line:e#1', text: 'Соперник свернул с нашей дороги, но план тот же.' }),
    ];
    const jobs = packWhole(lines.map(rec));
    for (const j of jobs) {
      expect(units(j).length).toBeLessThanOrEqual(3);
      const qs = j.prompt.split(TAG_WHOLE).filter((t) => t.endsWith('?'));
      expect(qs.length).toBeLessThanOrEqual(1);
      if (qs.length === 1) expect(j.prompt.endsWith('?')).toBe(true);
    }
    expect(jobs.flatMap(units).map((p) => p.key).sort()).toEqual(lines.map((l) => l.key).sort());
    // packing never costs a bucket more than the lines alone would
    const alone = lines.reduce((n, l) => n + jobMilli(l.text), 0);
    expect(jobs.reduce((n, j) => n + jobMilli(j.prompt), 0)).toBeLessThanOrEqual(alone);
  });

  it('move units: ≤ 15 and ≤ 450 characters a job, each said with a final fall', () => {
    const slots = Array.from({ length: 40 }, (_, i) => unit({ key: `slot:sq:${'abcdefgh'[i % 8]}${1 + Math.floor(i / 8)}`, text: `на ${i}`, kind: 'slot', recipe: 'slot-batch' }));
    const jobs = packSlots(slots.map(rec));
    for (const j of jobs) {
      expect(units(j).length).toBeLessThanOrEqual(MAX_SLOTS_PER_JOB);
      expect(codePoints(j.prompt)).toBeLessThanOrEqual(MAX_SLOT_JOB_CHARS);
      expect(j.prompt.split(TAG_WHOLE).every((t) => t.endsWith('.'))).toBe(true);
    }
    expect(jobs.flatMap(units)).toHaveLength(40);
  });
});

describe('heads and tails', () => {
  const head = unit({ key: 'line:teach.head.advice#1', text: 'Мой совет —', line: 'teach.head.advice', recipe: 'head', pool: 'teach.head.advice' });
  const nomHead = unit({ key: 'line:teach.head.arrow#1', text: 'Смотри на зелёную стрелку:', line: 'teach.head.arrow', recipe: 'head' });
  const tail = unit({ key: 'line:reason.center#1', text: '— так мы давим на центр.', line: 'reason.centerPawn', recipe: 'tail' });
  const ins = unit({ key: 'slot:ins:n:f3', text: 'конём на эф три', kind: 'slot', recipe: 'slot-batch', batch: 'slot.move' });
  const nom = unit({ key: 'slot:nom:p:e4', text: 'пешка на е четыре', kind: 'slot', recipe: 'slot-batch', batch: 'slot.move' });

  it('a head carries a real move of its form, cut at the natural pause', () => {
    const jobs = packCampaign([head, nomHead, ins, nom].map(rec));
    const a = jobs.find((j) => j.pieces.some((p) => !isDiscard(p) && p.key === head.key)) as GenJob;
    expect(a.prompt).toBe('Мой совет — конём на эф три.');
    expect(a.split).toEqual({ mode: 'longest', minSilenceMs: 150 });
    expect(units(a).map((p) => p.key)).toEqual([head.key, ins.key]);
    const b = jobs.find((j) => j.pieces.some((p) => !isDiscard(p) && p.key === nomHead.key)) as GenJob;
    expect(b.prompt).toBe('Смотри на зелёную стрелку: пешка на е четыре.');
    // both moves went into the heads: nothing is recorded twice
    expect(jobs.flatMap(units).map((p) => p.key).sort()).toEqual([head.key, nomHead.key, ins.key, nom.key].sort());
  });

  it('a tail follows a move and a short pause tag; without a move to carry, a thrown-away carrier', () => {
    const jobs = packCampaign([tail].map(rec));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.prompt).toBe(`Конём на эф три${TAG_TAIL}— так мы давим на центр.`);
    expect(jobs[0]?.pieces[0] && isDiscard(jobs[0].pieces[0])).toBe(true);
    expect(jobs[0]?.split).toEqual({ mode: 'longest', minSilenceMs: 250 });
  });

  it('the same prompt twice becomes take 1 and take 2', () => {
    const j: GenJob = { prompt: 'Ого!', take: 1, recipe: 'single', pieces: [{ key: 'line:bark.cheer#1', text: 'Ого!' }] };
    expect(dedupeTakes([{ ...j }, { ...j }]).map((x) => x.take)).toEqual([1, 2]);
  });
});

describe('the `pilot` tier (SPEC §9, hard cap 15)', () => {
  const pilot = planPilot(script, demo);

  it('costs ≤ 13.5 credits at the SPEC price, ≤ 15 with the re-render reserve, every prompt valid', () => {
    expect(pilot.report.milli).toBeLessThanOrEqual(PILOT_TARGET_CREDITS * 1000);
    expect(pilot.report.milliWithReserve).toBeLessThanOrEqual(PILOT_HARD_CAP_CREDITS * 1000);
    expect(() => parseJobsFile({ v: 1, voiceKey: 'giselle-mm1', campaign: 'pilot', jobs: pilot.jobs })).not.toThrow();
    expect(pilot.missing).toEqual([]);
  });

  it('has the probes: two whole reference turns, five lines alone, the pronunciation job, the split sample', () => {
    const batch = (b: string): GenJob[] => pilot.jobs.filter((j) => j.batch === b);
    expect(batch('pilot.P1')).toHaveLength(2);
    expect(pilot.references).toHaveLength(2);
    for (const r of pilot.references) expect(r.parts).toHaveLength(3);
    expect(batch('pilot.P2')).toHaveLength(5);
    expect(batch('pilot.P2').every((j) => j.recipe === 'single')).toBe(true);
    const p3 = batch('pilot.P3');
    expect(p3).toHaveLength(1);
    expect(units(p3[0] as GenJob)).toHaveLength(12);
    expect(p3[0]?.prompt).toContain('́');
    expect(pilot.jobs.flatMap(units).filter((p) => /^slot:(sq|xsq|head):/.test(p.key)).length).toBeGreaterThanOrEqual(12);
  });

  it('pays only for lines the runtime can play: a builder of the demo, its generic walk, a bark, or a tap of the web', () => {
    // what the real builders emitted in the demo game (clip twins), what the planner may walk to from there (L3
    // siblings, the generic line's parents — a «think» one only to `generic.<kind>.think` and the root), the barks of
    // their poses, and what the web says on a tap (clipAsk / clipSettings / the dock: CLIP_TAP_LINES)
    const fallbacks = catalogFallbacks(CLIP_CATALOG);
    const reachable = new Set<string>(CLIP_TAP_LINES.map((t) => t.line));
    const withSiblings = (line: string): void => {
      for (let cur: string | undefined = line, n = 0; cur && n < 6; cur = fallbacks[cur], n++) reachable.add(cur);
    };
    for (const ev of demoEvents(demo)) {
      const clip = ev.clip;
      if (!clip) continue;
      for (const sentence of clip.sentences) for (const it of sentence.items) if ('line' in it) withSiblings(it.line);
      if (clip.bark) reachable.add(`bark.${clip.bark}`);
      const parts = clip.generic.split('.');
      const parents = parts[parts.length - 1] === 'think' && parts.length > 2 ? [clip.generic, `generic.${parts[1]}.think`, 'generic'] : parts.map((_, i) => parts.slice(0, i + 1).join('.')).slice(1);
      for (const g of parents) withSiblings(g);
    }
    for (const t of CLIP_TAP_LINES) withSiblings(t.line);
    const lineOf = (key: string): string | null => {
      const m = /^line:(.+?)(?:@[pnbrqk])?(?:\/[mf])?#\d+$/u.exec(key);
      return m ? (m[1] as string) : null;
    };
    const paid = [...new Set(committedPilot.jobs.flatMap(units).map((p) => lineOf(p.key)).filter((l): l is string => l !== null))];
    expect(paid.length).toBeGreaterThan(40);
    expect(paid.filter((l) => !reachable.has(l))).toEqual([]);
    // lines nothing says (ask.noAdvice, ask.why.none) are not in the catalogue
    for (const dead of ['ask.noAdvice', 'ask.why.none']) expect(CLIP_CATALOG.some((l) => l.id === dead), dead).toBe(false);
    // …and the «Спроси» answers the web really says are recorded
    for (const a of ['ask.why.think', 'ask.opp.notYet', 'ask.opp.none']) expect(paid, a).toContain(a);
  });

  it('is the committed jobs.pilot.json exactly (run `pnpm voice:plan --tier pilot` after a script change)', () => {
    expect(committedPilot.campaign).toBe('pilot');
    expect(committedPilot.jobs).toEqual(pilot.jobs);
    expect(jobsReport(committedPilot.jobs).milli).toBe(pilot.report.milli);
  });
});
