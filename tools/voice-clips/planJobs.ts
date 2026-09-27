/**
 * `voice:plan --tier pilot|starter|full` (free, a dry run; docs/voice-clips/SPEC.md §9, §10): the script's units of a
 * tier ⇒ the exact paid jobs (the jobs file ./jobs.ts validates and `voice:generate` records) + what they cost.
 *
 * Recipes (SPEC §5.3, §10, §10.1):
 *  - whole  — ≤ 3 lines per job separated by `<#0.6#>` (the tag gives ≈ 750 ms of silence and a final fall); a `?` line
 *             goes last in its job; packed to fill the 50-character price buckets;
 *  - bark   — ≤ 4 interjections per job, no tempo gate;
 *  - head   — the head and a move said after it, «Мой совет — конём на эф три.», cut at the natural pause
 *             (`longest`, ≥ 150 ms). The move is a REAL unit of the same campaign when one fits the head's form (it is
 *             then recorded in context for free), else a carrier that is thrown away;
 *  - tail   — a move, `<#0.3#>`, the tail: «Конём на эф три<#0.3#>— выводишь коня в игру.» (`longest`, ≥ 250 ms);
 *             the move again a real unit when one is left;
 *  - slot-batch — ≤ 15 move / square units, ≤ 450 characters, each «Конём на эф три.» between `<#0.6#>`;
 *  - single — one line alone (the `pilot` tier's references and packed-vs-single probes).
 *
 * The `pilot` tier (SPEC §9) is built from the demo game: every pool, move and tail of every sentence its utterances carry
 * (also the ones a 5-minute game's caps drop: the planner resolves every sentence before it caps, and a missing one
 * would count as L4), the split sample, the three probes (P1 two whole teacher turns, P2 five lines alone,
 * P3 pronunciation), then extras in a fixed order while the SPEC price stays ≤ 13.5 credits.
 */
import { Chess } from 'chess.js';
import { HEAD_SLOT_FORM, mateInOneThreat, parseSlotKey, poolKeyOf } from '../../packages/core/src/index.ts';
import type { ClipItem, PieceType } from '../../packages/shared/src/index.ts';
import { VOICE_KEY } from './config.ts';
import { codePoints, jobMilli } from './cost.ts';
import { demoEvents, eventDemand } from './harvest.ts';
import type { HarvestCoachEvent } from './harvest.ts';
import type { DiscardPiece, GenJob, JobsFile, Piece, SplitRule, UnitPiece } from './jobs.ts';
import type { ScriptFile, ScriptUnit, Tier } from './script.ts';

// ───────────────────────── constants ─────────────────────────

export const TAG_WHOLE = '<#0.6#>';
export const TAG_TAIL = '<#0.3#>';
export const HEAD_SPLIT: SplitRule = { mode: 'longest', minSilenceMs: 150 };
export const TAIL_SPLIT: SplitRule = { mode: 'longest', minSilenceMs: 250 };
export const MAX_WHOLE_PER_JOB = 3;
export const MAX_BARKS_PER_JOB = 4;
export const MAX_SLOTS_PER_JOB = 15;
export const MAX_SLOT_JOB_CHARS = 450;
/** The `pilot` tier's SPEC price may not exceed this (the hard cap is 15: the rest is the re-render reserve). */
export const PILOT_TARGET_CREDITS = 13.5;
export const PILOT_HARD_CAP_CREDITS = 15;
/** Re-render reserve used in the reports (SPEC §4.3 «+10 %»; P2 measures the real tempo reject rate). */
export const RERENDER_RESERVE = 0.1;
/** ≈ audible ms per character of Giselle at 4 syl/s (the planner's estimate; the tools measure the real takes). */
export const MS_PER_CHAR = 70;
/** MP3 CBR 48 kbps (SPEC §4.1) */
export const BYTES_PER_SECOND = 6000;

const DUMMY_CARRIER: Readonly<Record<'nom' | 'ins', string>> = { nom: 'конь на эф три', ins: 'конём на эф три' };

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function withEnd(text: string): string {
  return /[.!?…]$/u.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

// ───────────────────────── one recording of a unit ─────────────────────────

/** A unit as one recording in a campaign (a unit with `takes: 2` is packed twice). */
export interface Recording {
  unit: ScriptUnit;
  tier: Tier;
  /** the words sent for it (default: its text; the P3 probe adds stress marks) */
  say?: string;
  recipe?: GenJob['recipe'];
  batch?: string;
}

function pieceOf(r: Recording): UnitPiece {
  const u = r.unit;
  return {
    key: u.key,
    text: u.text,
    ...(u.pool ? { pool: u.pool } : {}),
    ...(u.pools && u.pools.length > 1 ? { pools: u.pools } : {}),
    ...(u.mood ? { mood: u.mood } : {}),
    tier: r.tier,
    kind: u.kind,
    ...(u.kind === 'bark' ? { tempo: false } : {}),
  };
}

function slotForm(key: string): 'nom' | 'cap' | 'ins' | null {
  const p = parseSlotKey(key.replace(/^slot:/, ''));
  if (!p) return null;
  if (p.kind === 'move') return p.form;
  if (p.kind === 'castle') return p.form;
  return null;
}

/** Can this move unit follow the head (its wordings are written for 'ins' or 'nom'; a capture fits both)? */
function carriesAfter(head: ScriptUnit, slot: ScriptUnit): boolean {
  const want = head.line ? (HEAD_SLOT_FORM[head.line] ?? 'nom') : 'nom';
  const form = slotForm(slot.key);
  return form === want || form === 'cap';
}

// ───────────────────────── packing ─────────────────────────

/** Whole lines into jobs of ≤ 3 filling the 50-character buckets; a question goes last, at most one per job. */
export function packWhole(recs: readonly Recording[], opts: { perJob?: number; recipe?: GenJob['recipe'] } = {}): GenJob[] {
  const perJob = opts.perJob ?? MAX_WHOLE_PER_JOB;
  const len = (r: Recording): number => codePoints(withEnd(r.say ?? r.unit.text));
  const left = [...recs].sort((a, b) => len(b) - len(a) || (a.unit.key < b.unit.key ? -1 : 1));
  const jobs: GenJob[] = [];
  const isQ = (r: Recording): boolean => /\?$/u.test(withEnd(r.say ?? r.unit.text));
  while (left.length > 0) {
    const first = left.shift() as Recording;
    const group = [first];
    let chars = len(first);
    // (a tag costs 7 characters: packing pays only where it fills the price bucket the first line already opened)
    const limit = Math.max(50, Math.ceil(chars / 50) * 50);
    for (let i = 0; i < left.length && group.length < perJob; i++) {
      const r = left[i] as Recording;
      if (isQ(r) && group.some(isQ)) continue;
      const add = len(r) + TAG_WHOLE.length;
      if (chars + add <= limit) {
        group.push(r);
        chars += add;
        left.splice(i, 1);
        i--;
      }
    }
    group.sort((a, b) => Number(isQ(a)) - Number(isQ(b)));
    const prompt = group.map((r) => withEnd(r.say ?? r.unit.text)).join(TAG_WHOLE);
    const tiers = new Set(group.map((r) => r.tier));
    jobs.push({
      prompt,
      take: 1,
      recipe: opts.recipe ?? (group.every((r) => r.unit.kind === 'bark') ? 'bark' : 'whole'),
      pieces: group.map(pieceOf),
      ...(tiers.size === 1 ? { tier: [...tiers][0] as string } : {}),
      batch: group[0]?.batch ?? group[0]?.unit.batch ?? 'whole',
    });
  }
  return jobs;
}

/** Move / square units, ≤ 15 per job and ≤ 450 characters, «Конём на эф три.» between pause tags. */
export function packSlots(recs: readonly Recording[]): GenJob[] {
  const jobs: GenJob[] = [];
  let group: Recording[] = [];
  let chars = 0;
  const flush = (): void => {
    if (group.length === 0) return;
    const tiers = new Set(group.map((r) => r.tier));
    jobs.push({
      prompt: group.map((r) => withEnd(cap(r.say ?? r.unit.text))).join(TAG_WHOLE),
      take: 1,
      recipe: 'slot-batch',
      pieces: group.map(pieceOf),
      ...(tiers.size === 1 ? { tier: [...tiers][0] as string } : {}),
      batch: group[0]?.batch ?? 'slot',
    });
    group = [];
    chars = 0;
  };
  for (const r of recs) {
    const add = codePoints(withEnd(r.say ?? r.unit.text)) + (group.length > 0 ? TAG_WHOLE.length : 0);
    if (group.length >= MAX_SLOTS_PER_JOB || chars + add > MAX_SLOT_JOB_CHARS) flush();
    group.push(r);
    chars += codePoints(withEnd(r.say ?? r.unit.text)) + (group.length > 1 ? TAG_WHOLE.length : 0);
  }
  flush();
  return jobs;
}

/**
 * Packs one campaign: heads and tails first (they take real move units of the campaign as carriers), then the moves
 * left in slot batches, then whole lines and barks. Deterministic: the same recordings give the same prompts.
 */
export function packCampaign(recs: readonly Recording[]): GenJob[] {
  const heads = recs.filter((r) => (r.recipe ?? r.unit.recipe) === 'head');
  const tails = recs.filter((r) => (r.recipe ?? r.unit.recipe) === 'tail');
  const slots = recs.filter((r) => (r.recipe ?? r.unit.recipe) === 'slot-batch');
  const wholes = recs.filter((r) => (r.recipe ?? r.unit.recipe) === 'whole');
  const barks = recs.filter((r) => (r.recipe ?? r.unit.recipe) === 'bark');
  const singles = recs.filter((r) => (r.recipe ?? r.unit.recipe) === 'single');
  // whole move units can carry heads / tails; the split set and castling carry nothing
  const movable = slots.filter((r) => r.unit.batch === 'slot.move' && parseSlotKey(r.unit.key.slice(5))?.kind === 'move');
  const used = new Set<Recording>();
  const jobs: GenJob[] = [];

  for (const h of heads) {
    const carrier = movable.find((s) => !used.has(s) && carriesAfter(h.unit, s.unit));
    if (carrier) used.add(carrier);
    const form = h.unit.line ? (HEAD_SLOT_FORM[h.unit.line] ?? 'nom') : 'nom';
    const moveText = carrier ? carrier.unit.text : DUMMY_CARRIER[form];
    const second: Piece = carrier ? pieceOf(carrier) : ({ discard: true, text: `${moveText}.` } satisfies DiscardPiece);
    jobs.push({
      prompt: `${h.say ?? h.unit.text} ${moveText}.`,
      take: 1,
      recipe: 'head',
      pieces: [pieceOf(h), second],
      split: HEAD_SPLIT,
      tier: h.tier,
      batch: h.batch ?? h.unit.batch,
    });
  }
  for (const t of tails) {
    const carrier = movable.find((s) => !used.has(s));
    if (carrier) used.add(carrier);
    const moveText = carrier ? carrier.unit.text : DUMMY_CARRIER.ins;
    const first: Piece = carrier ? pieceOf(carrier) : ({ discard: true, text: cap(moveText) } satisfies DiscardPiece);
    jobs.push({
      prompt: `${cap(moveText)}${TAG_TAIL}${t.say ?? t.unit.text}`,
      take: 1,
      recipe: 'tail',
      pieces: [first, pieceOf(t)],
      split: TAIL_SPLIT,
      tier: t.tier,
      batch: t.batch ?? t.unit.batch,
    });
  }
  jobs.push(...packSlots(slots.filter((s) => !used.has(s))));
  jobs.push(...packWhole(wholes));
  jobs.push(...packWhole(barks, { perJob: MAX_BARKS_PER_JOB, recipe: 'bark' }));
  for (const s of singles) {
    jobs.push({ prompt: withEnd(s.say ?? s.unit.text), take: 1, recipe: 'single', pieces: [pieceOf(s)], tier: s.tier, batch: s.batch ?? s.unit.batch });
  }
  return dedupeTakes(jobs);
}

/** Two jobs with the same prompt are two takes of it (`take` 1, 2 …): the job key must be unique. */
export function dedupeTakes(jobs: GenJob[]): GenJob[] {
  const seen = new Map<string, number>();
  for (const j of jobs) {
    const n = (seen.get(j.prompt) ?? 0) + 1;
    seen.set(j.prompt, n);
    j.take = n;
  }
  return jobs;
}

// ───────────────────────── reports ─────────────────────────

export interface JobsReport {
  jobs: number;
  units: number;
  chars: number;
  /** SPEC price (milli-credits): Σ 0.15 × ⌈chars / 50⌉ */
  milli: number;
  /** with the re-render reserve */
  milliWithReserve: number;
  minutes: number;
  mb: number;
  byRecipe: Record<string, { jobs: number; units: number; milli: number }>;
  byBatch: Record<string, { jobs: number; units: number; milli: number }>;
}

export function jobsReport(jobs: readonly GenJob[]): JobsReport {
  const r: JobsReport = { jobs: jobs.length, units: 0, chars: 0, milli: 0, milliWithReserve: 0, minutes: 0, mb: 0, byRecipe: {}, byBatch: {} };
  let audibleMs = 0;
  for (const j of jobs) {
    const units = j.pieces.filter((p): p is UnitPiece => !('discard' in p)).length;
    const milli = jobMilli(j.prompt);
    r.units += units;
    r.chars += codePoints(j.prompt);
    r.milli += milli;
    for (const p of j.pieces) if (!('discard' in p)) audibleMs += codePoints(p.text) * MS_PER_CHAR + 90;
    for (const [map, key] of [[r.byRecipe, j.recipe], [r.byBatch, j.batch ?? 'other']] as const) {
      const e = map[key] ?? (map[key] = { jobs: 0, units: 0, milli: 0 });
      e.jobs++;
      e.units += units;
      e.milli += milli;
    }
  }
  r.milliWithReserve = Math.round(r.milli * (1 + RERENDER_RESERVE));
  r.minutes = Math.round((audibleMs / 60000) * 10) / 10;
  r.mb = Math.round(((audibleMs / 1000) * BYTES_PER_SECOND) / 1e5) / 10;
  return r;
}

// ───────────────────────── the `pilot` tier (SPEC §9) ─────────────────────────

export interface DemoLike {
  seed: string;
  timeControlId: string;
  childColor: 'w' | 'b';
  startFen?: string;
  intro?: { event: HarvestCoachEvent }[];
  plies: { by: 'child' | 'bot'; uci: string; after?: { event: HarvestCoachEvent }[] }[];
}

/** Everything the demo's utterances can let through, with how often (pools, move slots, compiled fragments). */
export function demoDemand(demo: DemoLike): { pools: Map<string, number>; slots: Map<string, number>; frags: Map<string, number> } {
  const pools = new Map<string, number>();
  const slots = new Map<string, number>();
  const frags = new Map<string, number>();
  const game = { tc: demo.timeControlId as 'blitz5', name: '' };
  for (const ev of demoEvents(demo)) {
    for (const it of eventDemand(ev, game, { superset: true }).items) {
      const map = it.kind === 'pool' ? pools : it.kind === 'slot' ? slots : frags;
      map.set(it.key, (map.get(it.key) ?? 0) + 1);
    }
  }
  return { pools, slots, frags };
}

/**
 * «Что задумал соперник?» for each bot move of the demo, as apps/web/src/coach/clips/clipAsk.ts answers it when the
 * engine's threat is not known (a check first, the static mate-in-one, then his move): the pools.
 */
export function demoOpponentPools(demo: DemoLike): string[] {
  const out: string[] = [];
  const chess = new Chess(demo.startFen);
  const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
  for (const ply of demo.plies) {
    let mv;
    try {
      mv = chess.move({ from: ply.uci.slice(0, 2), to: ply.uci.slice(2, 4), ...(ply.uci[4] ? { promotion: ply.uci[4] } : {}) });
    } catch {
      break;
    }
    if (ply.by !== 'bot') continue;
    const item = ((): Extract<ClipItem, { line: string }> => {
      if (mv.san.endsWith('#') || mv.san.endsWith('+')) return { line: 'opp.check' };
      try {
        if (mateInOneThreat(chess.fen()) !== null) return { line: 'ask.opp.mate' };
      } catch {
        // no threat check
      }
      if (mv.captured) return { line: 'opp.took', piece: mv.captured as PieceType };
      if (mv.flags.includes('k') || mv.flags.includes('q')) return { line: 'opp.castled' };
      const child = mv.color === 'w' ? 'b' : 'w';
      let target: string | null = null;
      for (const row of chess.board()) {
        for (const cell of row) {
          if (!cell || cell.color !== child || cell.type === 'k' || cell.type === 'p') continue;
          if (chess.attackers(cell.square, mv.color).includes(mv.to) && (target === null || (VALUE[cell.type] ?? 0) > (VALUE[target] ?? 0))) target = cell.type;
        }
      }
      if (target) return { line: 'opp.attack', piece: target as PieceType };
      const home = mv.color === 'w' ? '1' : '8';
      if ((mv.piece === 'n' || mv.piece === 'b') && mv.from.endsWith(home)) return { line: 'opp.developed', piece: mv.piece as PieceType };
      if (mv.piece === 'p') return { line: 'opp.pawn' };
      return { line: 'opp.moved', piece: mv.piece as PieceType };
    })();
    const pool = poolKeyOf(item.line, item.piece);
    if (!out.includes(pool)) out.push(pool);
  }
  return out;
}

export interface PilotPlan {
  jobs: GenJob[];
  report: JobsReport;
  /** units (script keys) recorded by the demo part: `tier: 'pilot'` in the script */
  keys: Set<string>;
  /** the P1 references: their words, and the units that compose the same words */
  references: { key: string; text: string; parts: string[] }[];
  /** which optional extras made it under the target */
  extras: string[];
  missing: string[];
}

interface PilotChoice {
  unit: ScriptUnit;
  why: string;
}

/**
 * The `pilot` job list: the demo's own units (every pool once, its moves as whole units, the tails and heads), the
 * split sample (D6), the probes (P1–P3) and then extras (a second wording where the demo repeats a pool, generics, barks,
 * «Спроси» answers, the opponent's moves, dangers) while the SPEC price stays ≤ `target`.
 */
export function planPilot(script: Pick<ScriptFile, 'units'>, demo: DemoLike, opts: { target?: number } = {}): PilotPlan {
  const target = Math.round((opts.target ?? PILOT_TARGET_CREDITS) * 1000);
  const byKey = new Map(script.units.map((u) => [u.key, u]));
  const usable = script.units.filter((u) => !u.lint);
  const byPool = new Map<string, ScriptUnit[]>();
  for (const u of usable) for (const p of u.pools ?? []) (byPool.get(p) ?? byPool.set(p, []).get(p)!).push(u);
  // (the exact variant first — «Соперник вывел коня» —, then the plain wordings; catalogue order)
  const candidatesFor = (pool: string): ScriptUnit[] =>
    [...(byPool.get(pool) ?? [])].sort((a, b) => Number(b.pool === pool) - Number(a.pool === pool) || (a.line === b.line ? (a.wording ?? 0) - (b.wording ?? 0) : 0));
  const chosen = new Map<string, PilotChoice>();
  const missing: string[] = [];
  const add = (u: ScriptUnit | undefined, why: string): boolean => {
    if (!u || chosen.has(u.key)) return false;
    chosen.set(u.key, { unit: u, why });
    return true;
  };
  const inPool = (pool: string): number => [...chosen.values()].filter((c) => c.unit.pools?.includes(pool)).length;
  const nextFor = (pool: string): ScriptUnit | undefined => candidatesFor(pool).find((u) => !chosen.has(u.key));

  // D1–D5: every pool / move / fragment the demo can let through
  const demand = demoDemand(demo);
  for (const [pool] of [...demand.pools].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    if (inPool(pool) > 0) continue;
    if (!add(nextFor(pool), 'demo')) missing.push(`pool:${pool}`);
  }
  for (const [key] of demand.slots) if (!add(byKey.get(`slot:${key}`), 'demo')) missing.push(`slot:${key}`);
  for (const [key] of demand.frags) if (!add(byKey.get(`frag:${key}`), 'demo')) missing.push(`frag:${key}`);

  // D6: the split sample — the demo's first four non-capturing moves as «конём» + «на эф три», four more squares
  const moveKeys = [...demand.slots.keys()].filter((k) => parseSlotKey(k)?.kind === 'move');
  const split: string[] = [];
  for (const k of moveKeys) {
    const p = parseSlotKey(k);
    if (!p || p.kind !== 'move' || p.form === 'cap') continue;
    const head = `head:${p.form === 'ins' ? 'ins' : 'nom'}:${p.piece}`;
    if (split.length < 8 && !split.includes(head)) split.push(head, `sq:${p.square}`);
  }
  for (const k of moveKeys) {
    const p = parseSlotKey(k);
    if (split.length >= 12 || !p || p.kind !== 'move') continue;
    const sq = p.form === 'cap' ? `xsq:${p.square}` : `sq:${p.square}`;
    if (!split.includes(sq)) split.push(sq);
  }
  for (const k of split) add(byKey.get(`slot:${k}`), 'split');
  const keys = new Set(chosen.keys());

  // P1: two whole teacher turns (H·S·T) as single references, composed from the very units recorded above
  const references: PilotPlan['references'] = [];
  for (const ev of demoEvents(demo)) {
    if (references.length >= 2 || ev.kind !== 'teachTurn') continue;
    const s = ev.clip?.sentences[0];
    if (!s || s.items.length !== 3) continue;
    const parts: string[] = [];
    for (const it of s.items) {
      if ('slot' in it) {
        const d = eventDemand(ev, { tc: demo.timeControlId as 'blitz5', name: '' }, { superset: true }).items.find((x) => x.kind === 'slot');
        if (d) parts.push(`slot:${d.key}`);
      } else {
        const pool = poolKeyOf(it.line, it.piece, it.g);
        const unit = [...chosen.values()].find((c) => c.unit.pools?.includes(pool) && c.why === 'demo')?.unit;
        if (unit) parts.push(unit.key);
      }
    }
    if (parts.length !== 3) continue;
    const texts = parts.map((k) => byKey.get(k)?.text ?? '');
    const text = withEnd(`${texts[0]} ${texts[1]} ${texts[2]}`.replace(/\s+/g, ' ').replace(/^./u, (c) => c.toUpperCase()));
    if (references.some((r) => r.parts[0] === parts[0])) continue;
    references.push({ key: `ref:${ev.id}`, text, parts });
  }

  // P2: the five whole lines the demo says most, alone (packed vs single prosody, take variance, tempo rejects)
  const singles = [...chosen.values()]
    .filter((c) => c.why === 'demo' && c.unit.recipe === 'whole')
    .map((c) => ({ c, uses: Math.max(...(c.unit.pools ?? []).map((p) => demand.pools.get(p) ?? 0)) }))
    .sort((a, b) => b.uses - a.uses || (a.c.unit.key < b.c.unit.key ? -1 : 1))
    .slice(0, 5)
    .map((x) => x.c.unit);

  // P3: pronunciation — «е», «же», «аш», «а» as file names, «бьёт», «ладьёй», «ферзём», and stress marks (U+0301)
  const P3: { key: string; say: string }[] = [
    { key: 'slot:sq:e2', say: 'на е два' },
    { key: 'slot:sq:e2', say: 'на е́ два' },
    { key: 'slot:sq:g5', say: 'на же пять' },
    { key: 'slot:sq:g5', say: 'на же́ пять' },
    { key: 'slot:sq:h7', say: 'на аш семь' },
    { key: 'slot:sq:h7', say: 'на а́ш се́мь' },
    { key: 'slot:sq:a6', say: 'на а шесть' },
    { key: 'slot:sq:a6', say: 'на а́ ше́сть' },
    { key: 'slot:xsq:e6', say: 'бьёт на е шесть' },
    { key: 'slot:head:ins:r', say: 'ладьёй' },
    { key: 'slot:head:ins:q', say: 'ферзём' },
    { key: 'slot:head:ins:p', say: 'пешко́й' },
  ];

  const build = (extraUnits: readonly ScriptUnit[]): GenJob[] => {
    const recs: Recording[] = [];
    for (const c of chosen.values()) recs.push({ unit: c.unit, tier: 'pilot', batch: `pilot.${c.why === 'split' ? 'D6' : batchCode(c.unit)}` });
    for (const u of extraUnits) recs.push({ unit: u, tier: 'pilot', batch: `pilot.extra.${batchCode(u)}` });
    const jobs = packCampaign(recs);
    for (const r of references) {
      jobs.push({
        prompt: r.text,
        take: 1,
        recipe: 'single',
        pieces: [{ key: r.key, text: r.text.replace(/[.!?]$/u, ''), tier: 'pilot', kind: 'frag' }],
        tier: 'pilot',
        batch: 'pilot.P1',
      });
    }
    for (const u of singles) {
      jobs.push({ prompt: withEnd(u.text), take: 1, recipe: 'single', pieces: [pieceOf({ unit: u, tier: 'pilot' })], tier: 'pilot', batch: 'pilot.P2' });
    }
    const p3 = P3.map((p) => ({ unit: byKey.get(p.key) as ScriptUnit, say: p.say })).filter((p) => p.unit);
    jobs.push({
      prompt: p3.map((p) => withEnd(cap(p.say))).join(TAG_WHOLE),
      take: 1,
      recipe: 'slot-batch',
      pieces: p3.map((p) => pieceOf({ unit: p.unit, tier: 'pilot' })),
      tier: 'pilot',
      batch: 'pilot.P3',
    });
    return dedupeTakes(jobs);
  };

  // extras, in order, while the price stays under the target
  const extraOrder: { unit: ScriptUnit; why: string }[] = [];
  const pushPool = (pool: string, why: string, n = 1): void => {
    const have = new Set([...chosen.keys(), ...extraOrder.map((e) => e.unit.key)]);
    const cands = candidatesFor(pool).filter((u) => !have.has(u.key));
    for (const u of cands.slice(0, n)) extraOrder.push({ unit: u, why });
  };
  // a second wording wherever the demo repeats a pool (the replay must not say the same take twice)
  for (const [pool, n] of [...demand.pools].sort((a, b) => b[1] - a[1])) if (n >= 2) pushPool(pool, `2nd:${pool}`);
  pushPool('preview', 'preview');
  // (a danger / treasure turn's generic first: its L5 never walks up to «Смотри на стрелку…», plan.ts)
  for (const g of ['generic.teachTurn.turn.think', 'generic.teachTurn.turn', 'generic.teachTurn', 'generic.praise', 'generic.takebackOffer', 'generic.gameEnd', 'generic.teachTurn.reveal']) pushPool(g, g);
  // «Спроси» answers exactly as the web says them (apps/web/src/coach/clips/clipAsk.ts; CLIP_TAP_LINES): nothing to
  // explain, the opponent has not moved yet, «nothing dangerous» after his move, «Повтори» after the board changed
  for (const a of ['ask.why.think', 'ask.opp.notYet', 'ask.opp.none', 'ask.repeat.stale']) pushPool(a, a);
  for (const pose of ['talk', 'think', 'cheer', 'oops']) pushPool(`bark.${pose}`, `bark.${pose}`, 3);
  for (const p of demoOpponentPools(demo).slice(0, 8)) pushPool(p, p);
  for (const d of ['danger.hanging@r', 'danger.hanging@n', 'danger.threat', 'danger.mate']) pushPool(d, d);
  for (const [pool, n] of [...demand.pools].sort((a, b) => b[1] - a[1])) if (n >= 3) pushPool(pool, `3rd:${pool}`);

  let extras: ScriptUnit[] = [];
  const taken: string[] = [];
  let jobs = build(extras);
  for (const e of extraOrder) {
    const trial = build([...extras, e.unit]);
    if (jobsReport(trial).milli > target) continue;
    extras = [...extras, e.unit];
    taken.push(e.why);
    jobs = trial;
  }
  for (const u of extras) keys.add(u.key);
  for (const p of P3) if (byKey.has(p.key)) keys.add(p.key);
  return { jobs, report: jobsReport(jobs), keys, references, extras: taken, missing };
}

function batchCode(u: ScriptUnit): string {
  if (u.kind === 'slot') return u.batch === 'slot.split' ? 'split' : 'move';
  if (u.recipe === 'head') return 'head';
  if (u.recipe === 'tail') return 'tail';
  if (u.kind === 'bark') return 'bark';
  return 'whole';
}

// ───────────────────────── tiers ─────────────────────────

/**
 * The jobs of one tier's campaign: `pilot` from the demo; `starter` = the starter units the `pilot` tier does not record;
 * `full` = everything else. A unit with `takes: 2` is recorded twice (in different jobs).
 */
export function tierJobs(script: ScriptFile, tier: Tier, demo: DemoLike | null): { file: JobsFile; report: JobsReport; pilot?: PilotPlan } {
  if (tier === 'pilot') {
    if (!demo) throw new Error('the pilot needs the demo game (apps/web/public/voice/demo/<seed>.json)');
    const pilot = planPilot(script, demo);
    return { file: { v: 1, voiceKey: VOICE_KEY, campaign: 'pilot', jobs: pilot.jobs }, report: pilot.report, pilot };
  }
  const recs: Recording[] = [];
  for (const u of script.units) {
    if (u.tier !== tier) continue;
    for (let t = 0; t < Math.max(1, u.takes); t++) recs.push({ unit: u, tier, batch: `${tier}.${u.batch}` });
  }
  // the second take of a unit goes into a different job: pack the first takes, then the second ones
  const first = recs.filter((_, i, a) => a.findIndex((r) => r.unit === recs[i]?.unit) === i);
  const second = recs.filter((r) => !first.includes(r));
  const jobs = dedupeTakes([...packCampaign(first), ...packCampaign(second)]);
  return { file: { v: 1, voiceKey: VOICE_KEY, campaign: tier, jobs }, report: jobsReport(jobs) };
}
