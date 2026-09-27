/**
 * `voice:script` (free; docs/voice-clips/SPEC.md §4.3, §7, §10): the catalogue + the harvest ⇒ every unit the library
 * can record, with its recipe, priority, tier and batch, and the lint of the voice rules — before a single credit.
 *
 * Units: every wording × variant of every catalogue line (`catalogUnits`), every move slot and the split set, and the
 * compiled fragments of the families that still speak through the text compiler (the harvest's bridge demand).
 *
 * Tiers (the smallest that contains a unit):
 *  - `pilot`   — what the demo game says (SPEC §9), chosen by ./planJobs.ts from the demo file;
 *  - `starter` — «Учитель» first (SPEC §4.3), within ≈ 84 credits beyond the `pilot` tier: the split set, one recording for every
 *                pool the ranking harvest hears, more wordings and a second take for the frequent pools (SPEC §7.1),
 *                then whole move units by rank (see `assignTiers`);
 *  - `full`    — everything else that passes the lint.
 *
 * Lint (overriding the SPEC where it differs): Гамбитик is a BOY (masculine self-reference, a feminine
 * «я рада» is an error), no square outside slot units (opponent moves, dangers and treasures are piece-only), the
 * right piece word per variant, length caps, no Latin; a slot unit says exactly `canonicalSlotText(key)`.
 */
import {
  CLIP_CATALOG,
  CLIP_TAP_LINES,
  allMoveSlotKeys,
  allSplitSlotKeys,
  canonicalSlotText,
  catalogUnits,
  hasSpokenSquare,
  lintCatalog,
  lintText,
  parseSlotKey,
  poolKeyOf,
} from '../../packages/core/src/coach/clips/index.ts';
import type { ClipLintIssue, ClipLintRole } from '../../packages/core/src/coach/clips/index.ts';
import type { ClipCatalogLine } from '../../packages/shared/src/index.ts';
import { VOICE_KEY } from './config.ts';
import { codePoints } from './cost.ts';
import type { HarvestStats } from './harvest.ts';
import type { Recipe, UnitKind } from './jobs.ts';
import { tierJobs } from './planJobs.ts';

export type Tier = 'pilot' | 'starter' | 'full';
export const TIERS: readonly Tier[] = ['pilot', 'starter', 'full'];

export interface ScriptUnit {
  /** manifest unit key: `line:<pool>#<n>`, `slot:<slotKey>`, `frag:f:<norm>|<end>` */
  key: string;
  kind: UnitKind;
  /** exactly what is said (no tags) */
  text: string;
  recipe: Recipe;
  /** catalogue line (line / bark units) */
  line?: string;
  role?: ClipCatalogLine['role'] | 'slot' | 'frag';
  /** 1-based wording number of the line */
  wording?: number;
  /** the pool it is recorded under and every pool it joins (a plain wording of a `byPiece` line joins every piece) */
  pool?: string;
  pools?: string[];
  mood?: string;
  /** plays per game of everything it can voice, in the ranking half of the harvest */
  demand: number;
  /** ordering inside a tier (higher first) */
  priority: number;
  /** the smallest tier that records it; absent = never (a lint error) */
  tier?: Tier;
  /** recordings wanted (2 for the hottest pools: SPEC §7.1 «6 wordings × 2 takes») */
  takes: number;
  /** packing / reporting group */
  batch: string;
  /** a fragment's seam at its right edge ('.' '!' '?' '…' '—' ':' ';') */
  end?: string;
  lint?: string[];
}

export interface ScriptFile {
  v: 1;
  voiceKey: string;
  harvest: { games: number; teacherGames: number; split: HarvestStats['split'] };
  /** the demo game of the `pilot` tier (`apps/web/public/voice/demo/<seed>.json`) */
  demo: string | null;
  /** starter: the target (credits beyond the `pilot` tier); starterPrice: what the packed starter jobs cost; estimate: the greedy's budget */
  budget: { starter: number; starterPrice: number; estimate: number };
  units: ScriptUnit[];
  lint: ClipLintIssue[];
  summary: Record<Tier, { units: number; estCredits: number }>;
}

// ───────────────────────── estimates ─────────────────────────

/** ≈ credits per character when batched (0.15 per 50 characters, SPEC §4.3), with ≈ 10 % packing waste. */
export const CREDITS_PER_CHAR = 0.0033;
const TAG_CHARS = 7;
/** a move said with a head / tail in its job (a real unit when the campaign has one to carry, else a carrier) */
const MOVE_CHARS = 18;
const BUCKET = 0.15;

/** Characters one recording of the unit adds to its jobs (text + separator; heads / tails with their move). */
export function unitChars(u: Pick<ScriptUnit, 'text' | 'recipe'>): number {
  const n = codePoints(u.text);
  switch (u.recipe) {
    case 'head':
      return n + 1 + MOVE_CHARS + 1;
    case 'tail':
      return n + MOVE_CHARS + TAG_CHARS;
    case 'single':
      return Math.ceil(n / 50) * 50;
    default:
      return n + TAG_CHARS;
  }
}

/**
 * Estimated credits of the unit's recordings: a head or tail job is one call of its own (0.15 per started 50
 * characters, the move it carries included — that move unit is then recorded for free), everything else is packed.
 */
export function unitCredits(u: Pick<ScriptUnit, 'text' | 'recipe' | 'takes'>): number {
  const per = u.recipe === 'head' || u.recipe === 'tail' ? BUCKET * Math.ceil(unitChars(u) / 50) : unitChars(u) * CREDITS_PER_CHAR;
  return per * Math.max(1, u.takes);
}

// ───────────────────────── lint ─────────────────────────

const FRAG_ROLE: ClipLintRole = 'whole';

/** What is wrong with one unit (voice rules + the SPEC caps); [] = recordable. */
export function unitLint(u: Pick<ScriptUnit, 'key' | 'kind' | 'text' | 'role'>): string[] {
  const out: string[] = [];
  if (u.text.trim() === '') return ['empty'];
  if (/[<>#]/.test(u.text)) out.push('tag in text');
  if (u.kind === 'slot') {
    const key = u.key.slice('slot:'.length);
    if (!parseSlotKey(key)) out.push('bad slot key');
    else if (canonicalSlotText(key) !== u.text) out.push('slot text is not canonical');
    for (const i of lintText(u.text, 'slot')) if (i.rule !== 'square') out.push(`${i.rule}${i.detail ? `: ${i.detail}` : ''}`);
    return out;
  }
  if (u.kind === 'frag') {
    if (hasSpokenSquare(u.text)) out.push('square: squares are said only by slot units');
    for (const i of lintText(u.text, FRAG_ROLE)) if (i.rule !== 'end' && i.rule !== 'square') out.push(`${i.rule}${i.detail ? `: ${i.detail}` : ''}`);
  }
  return out;
}

// ───────────────────────── building the units ─────────────────────────

function batchOf(line: string): string {
  const parts = line.split('.');
  if (parts[0] === 'teach' && parts[1] === 'head') return 'teach.head';
  if (parts[0] === 'teach' && parts[1] === 'tail') return 'teach.tail';
  return parts[0] as string;
}

const RECIPE_OF_ROLE: Readonly<Record<ClipCatalogLine['role'], Recipe>> = { whole: 'whole', head: 'head', tail: 'tail', bark: 'bark' };

/** Every unit the catalogue, the move slots and the harvest's fragments give, with demand (plays per game). */
export function scriptUnits(stats: HarvestStats, catalog: readonly ClipCatalogLine[] = CLIP_CATALOG): ScriptUnit[] {
  const games = Math.max(1, stats.games);
  const rate = (c: { plays: number } | undefined): number => (c ? c.plays / games : 0);
  const units: ScriptUnit[] = [];
  for (const line of catalog) {
    for (const u of catalogUnits(line)) {
      if (u.text === null) continue;
      const demand = u.pools.reduce((s, p) => s + rate(stats.pools[p]), 0);
      units.push({
        key: u.unitKey,
        kind: line.role === 'bark' ? 'bark' : 'line',
        text: u.text,
        recipe: RECIPE_OF_ROLE[line.role],
        line: line.id,
        role: line.role,
        wording: u.wording,
        pool: u.pool,
        pools: u.pools,
        ...(u.mood ? { mood: u.mood } : {}),
        demand: round(demand, 4),
        priority: 0,
        takes: 1,
        batch: batchOf(line.id),
      });
    }
  }
  for (const key of allMoveSlotKeys()) {
    units.push({ key: `slot:${key}`, kind: 'slot', text: canonicalSlotText(key), recipe: 'slot-batch', role: 'slot', demand: round(rate(stats.slots[key]), 4), priority: 0, takes: 1, batch: 'slot.move' });
  }
  for (const key of allSplitSlotKeys()) {
    units.push({ key: `slot:${key}`, kind: 'slot', text: canonicalSlotText(key), recipe: 'slot-batch', role: 'slot', demand: round(rate(stats.slots[key]), 4), priority: 0, takes: 1, batch: 'slot.split' });
  }
  for (const [key, c] of Object.entries(stats.frags)) {
    const end = key.slice(key.lastIndexOf('|') + 1);
    // a fragment right before a square ('' end) is never recorded: its sentence falls down the ladder instead
    if (end === '') continue;
    const text = fragText(c.text, end);
    units.push({ key: `frag:${key}`, kind: 'frag', text, recipe: /[.!?…]/u.test(end) ? 'whole' : 'head', role: 'frag', demand: round(rate(c), 4), priority: 0, takes: 1, batch: 'frag', end });
  }
  for (const u of units) {
    const lint = unitLint(u);
    if (lint.length > 0) u.lint = lint;
  }
  return units;
}

/** The words of a compiled fragment as they are recorded: its text with its own seam / sentence end. */
export function fragText(text: string, end: string): string {
  const t = text.trim().replace(/[\s—–:;.!?…,-]+$/u, '');
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  if (end === '—') return `${cap} —`;
  return `${cap}${end}`;
}

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// ───────────────────────── tiers ─────────────────────────

/** SPEC §7.1: wordings a pool needs by plays per game. */
export function poolTarget(playsPerGame: number): { wordings: number; takes: number } {
  if (playsPerGame >= 3) return { wordings: 6, takes: 2 };
  if (playsPerGame >= 1) return { wordings: 4, takes: 1 };
  if (playsPerGame >= 0.25) return { wordings: 2, takes: 1 };
  return { wordings: 1, takes: 1 };
}

/**
 * Starter budget in credits, the `pilot` tier's units NOT included (SPEC §4.3: «Starter ≈ 84 more after the pilot»; pilot +
 * starter ≈ 97.5 of the ≈ 110 on the account, the rest for re-renders).
 */
export const STARTER_BUDGET = 84;
/** A compiled fragment joins the starter tier from this many plays per game. */
export const STARTER_FRAG_MIN = 0.3;
/** Wordings of every generic pool (ladder L5) in the starter tier (SPEC §4.3 family 8: «generic pools ≥ 4»). */
export const STARTER_GENERIC_WORDINGS = 4;
/** Wordings of a tap line's pool in the starter tier (a child taps «Спроси» / Гамбитик again and again); the poke more. */
export const STARTER_TAP_WORDINGS = 2;
export const STARTER_POKE_WORDINGS = 4;

/** A generic line of the ladder's L5: `generic` and `generic.<kind>[.<moment>][.<pose>]`. */
export function isGenericLine(line: string | undefined): boolean {
  return line === 'generic' || (line?.startsWith('generic.') ?? false);
}

/**
 * Assigns `tier`, `takes` and `priority` in place. `pilotKeys` = the units the `pilot` tier records (./planJobs.ts): they are
 * `pilot`; the starter set is then chosen within `budget`, in this order —
 *   1. the split set (ladder L2: every move can be said, whatever the harvest missed);
 *   1b. what the harvest can never hear — the lines the web says on a TAP (`CLIP_TAP_LINES`: «Спроси» answers, the
 *      opponent's move and threat, the thought replies, the poke, «Послушать»: 2 wordings of a plain line, the poke 4,
 *      each piece pool once) — and the generic lines of the ladder's L5 (≥ 4 wordings of every `generic…` pool);
 *   2. one recording for every pool the ranking half hears (the exact variant first, «Соперник вывел коня»);
 *   3. the teacher's bridge fragments heard ≥ 0.3× per game;
 *   4. more wordings for the frequent pools up to SPEC §7.1 (≥ 1×/game → 4, ≥ 3×/game → 6), the hottest first;
 *   5. the second take of every wording of the ≥ 3×/game pools;
 *   6. whole move units by rank: as many as the starter's heads and tails carry for free, then paid ones while the
 *      budget lasts (the rest of the moves speak through the split set).
 * Everything else that passes the lint is `full`.
 */
export function assignTiers(units: ScriptUnit[], stats: HarvestStats, pilotKeys: ReadonlySet<string>, budget = STARTER_BUDGET): void {
  const games = Math.max(1, stats.games);
  const poolRate = (p: string): number => (stats.pools[p]?.plays ?? 0) / games;
  const ok = units.filter((u) => !u.lint);
  for (const u of units) {
    delete u.tier;
    u.takes = 1;
  }
  let spent = 0;
  const take = (u: ScriptUnit, tier: Tier): void => {
    if (u.tier) return;
    u.tier = tier;
    if (tier === 'starter') spent += unitCredits(u);
  };
  for (const u of ok) if (pilotKeys.has(u.key)) take(u, 'pilot');

  // 1. the split set
  for (const u of ok) if (u.batch === 'slot.split') take(u, 'starter');

  const byPool = new Map<string, ScriptUnit[]>();
  for (const u of ok) for (const p of u.pools ?? []) (byPool.get(p) ?? byPool.set(p, []).get(p)!).push(u);
  /** `n` recordings in the pool (the exact variant first, then catalogue order), whatever the budget */
  const fill = (pool: string, n: number): void => {
    const all = byPool.get(pool) ?? [];
    let have = all.filter((u) => u.tier).length;
    for (const u of [...all].filter((x) => !x.tier).sort((a, b) => Number(b.pool === pool) - Number(a.pool === pool) || (a.wording ?? 0) - (b.wording ?? 0))) {
      if (have >= n) break;
      take(u, 'starter');
      have++;
    }
  };

  // 1b. the tap lines (never in the harvest) and the generic lines of L5
  for (const t of CLIP_TAP_LINES) {
    // (a piece pool: its own wording once — the plain wordings of the line join every piece pool anyway)
    const n = t.line === 'poke' ? STARTER_POKE_WORDINGS : t.pieces ? 1 : STARTER_TAP_WORDINGS;
    for (const piece of t.pieces ?? [undefined]) fill(poolKeyOf(t.line, piece), n);
  }
  for (const line of [...new Set(ok.filter((u) => isGenericLine(u.line)).map((u) => u.line as string))].sort()) fill(line, STARTER_GENERIC_WORDINGS);

  // 2. one recording for every heard pool
  const pools = Object.keys(stats.pools).filter((p) => poolRate(p) > 0);
  const covered = new Set<string>();
  for (const u of ok) if (u.tier && u.pools) for (const p of u.pools) covered.add(p);
  for (const p of [...pools].sort((a, b) => poolRate(b) - poolRate(a) || (a < b ? -1 : 1))) {
    if (covered.has(p)) continue;
    const cands = (byPool.get(p) ?? []).filter((u) => !u.tier);
    if (cands.length === 0) continue;
    const best = [...cands].sort((a, b) => Number(b.pool === p) - Number(a.pool === p) || (a.wording ?? 0) - (b.wording ?? 0))[0] as ScriptUnit;
    take(best, 'starter');
    for (const q of best.pools ?? []) covered.add(q);
  }

  // 3. bridge fragments heard often enough
  for (const u of ok) if (u.kind === 'frag' && u.demand >= STARTER_FRAG_MIN) take(u, 'starter');

  // 4. more wordings for the frequent pools, round by round, the hottest first
  const wanted = pools.map((p) => ({ pool: p, rate: poolRate(p) })).sort((a, b) => b.rate - a.rate || (a.pool < b.pool ? -1 : 1));
  const countIn = (p: string): number => (byPool.get(p) ?? []).filter((u) => u.tier).length;
  let progress = true;
  while (progress && spent < budget) {
    progress = false;
    for (const { pool, rate } of wanted) {
      if (countIn(pool) >= poolTarget(rate).wordings) continue;
      const next = (byPool.get(pool) ?? []).filter((u) => !u.tier).sort((a, b) => Number(b.pool === pool) - Number(a.pool === pool) || (a.wording ?? 0) - (b.wording ?? 0))[0];
      if (!next || spent + unitCredits(next) > budget) continue;
      take(next, 'starter');
      progress = true;
    }
  }

  // 5. second takes of the hottest pools' wordings
  for (const { pool, rate } of wanted) {
    if (poolTarget(rate).takes < 2) continue;
    for (const u of byPool.get(pool) ?? []) {
      if (u.tier !== 'starter' || u.takes > 1) continue;
      const extra = unitCredits({ ...u, takes: 1 });
      if (spent + extra > budget) break;
      u.takes = 2;
      spent += extra;
    }
  }

  // 6. whole move units by rank: the heads' and tails' free carriers first, then paid ones
  let carriers = ok.filter((u) => u.tier === 'starter' && (u.recipe === 'head' || u.recipe === 'tail')).reduce((n, u) => n + u.takes, 0);
  for (const u of ok.filter((x) => x.batch === 'slot.move' && !x.tier && x.demand > 0).sort((a, b) => b.demand - a.demand || (a.key < b.key ? -1 : 1))) {
    const castle = u.key.includes(':castle:');
    if (carriers > 0 && !castle) {
      carriers--;
      u.tier = 'starter';
      continue;
    }
    if (spent + unitCredits(u) > budget) break;
    take(u, 'starter');
  }
  for (const u of ok) if (!u.tier) u.tier = 'full';
  for (const u of units) u.priority = round(u.demand * 100 + (u.batch === 'slot.split' ? 5 : 0), 2);
}

export function scriptSummary(units: readonly ScriptUnit[]): ScriptFile['summary'] {
  const out = { pilot: { units: 0, estCredits: 0 }, starter: { units: 0, estCredits: 0 }, full: { units: 0, estCredits: 0 } };
  for (const u of units) {
    if (!u.tier) continue;
    out[u.tier].units++;
    out[u.tier].estCredits += unitCredits(u);
  }
  for (const t of TIERS) out[t].estCredits = round(out[t].estCredits, 2);
  return out;
}

/** The SPEC price (milli-credits) of the starter campaign these tiers give, packed exactly as `voice:plan` packs it. */
export function starterPriceMilli(units: readonly ScriptUnit[]): number {
  return tierJobs({ units } as ScriptFile, 'starter', null).report.milli;
}

/**
 * The script: every unit with its tier. The starter set is sized so that its packed SPEC price stays within
 * `starterPrice` credits (default `STARTER_BUDGET`): the greedy of `assignTiers` works on per-unit estimates, so the
 * estimate budget is searched until the real packing fits.
 */
export function buildScript(
  stats: HarvestStats,
  opts: { pilotKeys?: ReadonlySet<string>; demo?: string | null; starterPrice?: number; catalog?: readonly ClipCatalogLine[] } = {},
): ScriptFile {
  const catalog = opts.catalog ?? CLIP_CATALOG;
  const units = scriptUnits(stats, catalog);
  const pilotKeys = opts.pilotKeys ?? new Set<string>();
  const target = Math.round((opts.starterPrice ?? STARTER_BUDGET) * 1000);
  // (a canonical order in, the script's order out: the packing — and so the price — depends on the order)
  const canonical = (a: ScriptUnit, b: ScriptUnit): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const display = (a: ScriptUnit, b: ScriptUnit): number => TIERS.indexOf(a.tier ?? 'full') - TIERS.indexOf(b.tier ?? 'full') || b.priority - a.priority || canonical(a, b);
  const assign = (budget: number): number => {
    units.sort(canonical);
    assignTiers(units, stats, pilotKeys, budget);
    units.sort(display);
    return starterPriceMilli(units);
  };
  let lo = 0;
  let hi = (opts.starterPrice ?? STARTER_BUDGET) * 2;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (assign(mid) <= target) lo = mid;
    else hi = mid;
  }
  const price = assign(lo);
  return {
    v: 1,
    voiceKey: VOICE_KEY,
    harvest: { games: stats.games, teacherGames: stats.teacherGames, split: stats.split },
    demo: opts.demo ?? null,
    budget: { starter: opts.starterPrice ?? STARTER_BUDGET, starterPrice: price / 1000, estimate: Math.round(lo * 100) / 100 },
    units,
    lint: lintCatalog(catalog),
    summary: scriptSummary(units),
  };
}
