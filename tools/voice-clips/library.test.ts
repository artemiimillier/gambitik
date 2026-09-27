/**
 * The whole-library plan (./library.ts) — free and pure: every unit is exactly what the server of «Дозапись голоса»
 * would record for these ids (its own `unitFromPiece` re-renders each one), nothing is planned twice, the pack recipe
 * holds for every job and never costs more than recording each part alone, the boy's and the most used words come
 * first, covered units are left out and a failed one gets its take 2 alone.
 */
import { describe, expect, it } from 'vitest';
import { unitFromPiece } from '../../apps/server/src/voiceGen/render.ts';
import { lessonLine } from '../../packages/content/src/index.ts';
import { lineKeyTwins } from '../../packages/core/src/coach/clips/lines.ts';
import { PACK_TAG, packProblem } from '../../packages/core/src/coach/clips/tts.ts';
import { VOICE_NEUTRAL_POOL } from '../../packages/core/src/coach/lesson/book.ts';
import { jobMilli } from './cost.ts';
import { isDiscard, parseJobsFile } from './jobs.ts';
import type { UnitPiece } from './jobs.ts';
import {
  EMPTY_USAGE,
  LIBRARY_CAMPAIGN,
  LIBRARY_MAX_BUDGET,
  bandOf,
  catalogLibraryUnits,
  lessonLibraryUnits,
  libraryJobsFile,
  libraryUnits,
  packLibrary,
  planLibrary,
  quizLibraryUnits,
  weighUnits,
} from './library.ts';
import type { LibraryUnit, UsageStats } from './library.ts';
import { ONDEMAND_TAKE_BASE } from './ondemand.ts';

const ALL = libraryUnits();
/** planning the whole library takes seconds (more on a busy Mac) */
const WHOLE = { timeout: 120_000 };
const blocks = (t: string): number => Math.ceil([...t].length / 50);

describe('what the library holds', () => {
  it('every unit is what the server itself renders for its key (a take of the library IS the take the app asks for)', WHOLE, () => {
    const bad = ALL.filter((u) => {
      const r = unitFromPiece({ key: u.key, text: u.text });
      return r === null || r.key !== u.key || r.text !== u.text;
    });
    expect(bad.map((u) => `${u.key} «${u.text}»`).slice(0, 5)).toEqual([]);
  });

  it('no key twice, and never two units with the same words under twin keys', () => {
    expect(new Set(ALL.map((u) => u.key)).size).toBe(ALL.length);
    const byKey = new Map(ALL.map((u) => [u.key, u.text] as const));
    const dup = ALL.filter((u) => lineKeyTwins(u.key, u.text).some((k) => k !== u.key && byKey.get(k) === u.text));
    expect(dup.map((u) => u.key)).toEqual([]);
  });

  it('lesson parts: every recordable pool, never a quiz button or the silent bark; each piece variant of the subject', () => {
    const lesson = lessonLibraryUnits();
    expect(lesson.length).toBeGreaterThan(7000);
    expect(lesson.some((u) => VOICE_NEUTRAL_POOL((u.pool ?? '').split(/[@/]/u)[0]!))).toBe(false);
    // «{Конь} просится в бой» (a lead of the mover): all six pieces
    const subject = lesson.filter((u) => u.key.startsWith('line:v3.lead.subject@') && u.key.endsWith('#1'));
    expect(new Set(subject.map((u) => u.piece))).toEqual(new Set(['p', 'n', 'b', 'r', 'q', 'k']));
    // both genders of a gendered wording
    const gendered = lesson.filter((u) => u.g !== undefined);
    expect(gendered.filter((u) => u.g === 'm').length).toBe(gendered.filter((u) => u.g === 'f').length);
    // every pool of the content is there (except the button wordings and the silent bark)
    const pools = new Set(lesson.map((u) => (u.pool ?? '').split(/[@/]/u)[0]));
    expect(pools.has('v3.quiz.opt.capYes')).toBe(false);
    expect(lessonLine('v3.lead.subject')).toBeDefined();
    expect(pools.has('v3.lead.subject')).toBe(true);
  });

  it('options sentences: every order of every stage 1–2 quiz, each button wording, rendered from ids', () => {
    const frags = quizLibraryUnits();
    expect(frags.length).toBe(716);
    expect(frags.every((u) => u.key.startsWith('frag:') && u.text.endsWith('?') && u.kind === 'frag')).toBe(true);
    const texts = new Set(frags.map((u) => u.text));
    expect(texts.has('Коня, слона или ладью?')).toBe(true); // danger: acc
    expect(texts.has('Конём, слоном или ладьёй?')).toBe(true); // which piece: ins
    expect(texts.has('Да, бесплатно, будет размен или нет, будет хуже?')).toBe(true); // canCapture, the fixed order
    expect([...texts].some((t) => /короля/iu.test(t) && /^(?:Коня|Слона|Ладью|Пешку|Ферзя|Короля),/u.test(t) && !/королём/iu.test(t))).toBe(false); // the king is never a victim
  });

  it('catalogue sentences: whole lines only — never a generic stand-in, the preview, a head, a tail or a bark', () => {
    const cat = catalogLibraryUnits();
    expect(cat.length).toBeGreaterThan(600);
    expect(cat.every((u) => u.role === 'whole' && u.key.startsWith('line:') && !u.key.startsWith('line:v3.'))).toBe(true);
    expect(cat.some((u) => /^line:(?:generic|preview)[.#@/]/u.test(u.key))).toBe(false);
    expect(cat.some((u) => /\d/u.test(u.text))).toBe(false);
  });
});

const unit = (key: string, text: string, extra: Partial<LibraryUnit> = {}): LibraryUnit => ({ key, text, source: 'lesson', role: 'whole', kind: 'line', family: 'x', weight: 1, ...extra });

describe('packing (the «pack» recipe)', () => {
  const planned = packLibrary([...ALL].sort((a, b) => bandOf(a) - bandOf(b)));

  it('every job keeps the recipe: ≤ 4 parts, ≤ 240 characters, one question only last; each unit exactly once', WHOLE, () => {
    const seen = new Set<string>();
    for (const job of planned) {
      const parts = job.map((u, i) => (i === job.length - 1 && u.role === 'lead' ? `${u.text}.` : u.text));
      expect(job.length).toBeLessThanOrEqual(4);
      expect(packProblem(parts.map((p) => p.replace(/[«»„“”"]/gu, '')))).toBeNull();
      for (const u of job) {
        expect(seen.has(u.key)).toBe(false);
        seen.add(u.key);
      }
    }
    expect(seen.size).toBe(ALL.length);
  });

  it('an options sentence is always alone; a lead is never the last part without its end mark', WHOLE, () => {
    for (const job of planned) {
      if (job.some((u) => u.kind === 'frag')) expect(job.length).toBe(1);
    }
    const file = libraryJobsFile(planLibrary({ units: ALL, covered: () => null, attempts: () => 0 }).jobs);
    for (const job of file.jobs) {
      const last = job.pieces[job.pieces.length - 1] as UnitPiece;
      expect(last.role).not.toBe('lead');
      for (const p of job.pieces.slice(0, -1) as UnitPiece[]) if (p.role === 'lead' || p.role === 'leadAlone') expect(p.role).toBe('lead');
      if (job.pieces.length > 1) expect(job.split).toEqual({ mode: 'tags', minSilenceMs: 700 });
    }
  });

  it('a job never costs more than its parts recorded alone', WHOLE, () => {
    const file = libraryJobsFile(planLibrary({ units: ALL, covered: () => null, attempts: () => 0 }).jobs);
    for (const job of file.jobs) {
      const alone = job.pieces.reduce((n, p) => n + (isDiscard(p) ? 0 : blocks(job.prompt.split(PACK_TAG)[job.pieces.indexOf(p)]!)), 0);
      expect(blocks(job.prompt)).toBeLessThanOrEqual(alone);
    }
  });

  it('the whole library fits the budget cap (1700 credits) with room for the second takes', WHOLE, () => {
    const plan = planLibrary({ units: ALL, covered: () => null, attempts: () => 0 });
    expect(plan.milli).toBeLessThan(LIBRARY_MAX_BUDGET * 1000 * 0.93);
    expect(plan.jobs.length).toBeLessThan(3200);
    // …which is well below recording every unit alone
    const alone = ALL.reduce((n, u) => n + jobMilli(u.kind === 'frag' ? u.text : u.text), 0);
    expect(plan.milli).toBeLessThan(alone);
  });
});

describe('order and coverage', () => {
  it('the plain and the boy’s variants first, the most used first; the girl’s after them', WHOLE, () => {
    const usage: UsageStats = { ...EMPTY_USAGE, games: 10, pool: new Map([['v3.lead.subject', 3], ['v3.lead.subject@n', 3]]) };
    const units = weighUnits(ALL, usage);
    const plan = planLibrary({ units, covered: () => null, attempts: () => 0 });
    const firstPieces = plan.jobs[0]!.pieces as UnitPiece[];
    expect(firstPieces.every((p) => p.key.startsWith('line:v3.lead.subject@n'))).toBe(true);
    const girl = plan.jobs.findIndex((j) => (j.pieces as UnitPiece[]).some((p) => /\/f#/u.test(p.key)));
    const lastBoy = plan.jobs.map((j) => (j.pieces as UnitPiece[]).some((p) => /\/m#/u.test(p.key))).lastIndexOf(true);
    expect(girl).toBeGreaterThan(lastBoy);
  });

  it('covered units are left out by reason; a failed one gets its take 2 alone (take 101 + attempts)', () => {
    const units = [unit('line:v3.praise.a#1', 'Отлично!'), unit('line:v3.praise.a#2', 'Здорово!'), unit('line:v3.praise.a#3', 'Так держать!'), unit('line:v3.praise.a#4', 'Супер!')];
    const plan = planLibrary({
      units,
      covered: (u) => (u.key.endsWith('#1') ? 'уже записана' : u.key.endsWith('#2') ? 'уже в задании x («ondemand»)' : null),
      attempts: (u) => (u.key.endsWith('#3') ? 1 : 0),
    });
    expect(plan.covered).toEqual({ 'уже записана': 1, 'в задании': 1 });
    expect(plan.retakes).toBe(1);
    expect(plan.jobs.map((j) => [j.prompt, j.take])).toEqual([
      ['Так держать!', ONDEMAND_TAKE_BASE + 1],
      ['Супер!', ONDEMAND_TAKE_BASE],
    ]);
  });

  it('the jobs file is a valid jobs file of the campaign «library»', () => {
    const file = libraryJobsFile(planLibrary({ units: ALL.slice(0, 50), covered: () => null, attempts: () => 0 }).jobs);
    expect(file.campaign).toBe(LIBRARY_CAMPAIGN);
    expect(parseJobsFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
  });
});
