/**
 * `voice:coverage` (free; docs/voice-clips/SPEC.md §4.3, §7.8, §11): how much of what Гамбитик says a library voices —
 * the real manifest, or the library a jobs file WILL produce (ids computed exactly as `process` names the takes).
 *
 *  - demo:     every utterance of the demo game must resolve at L1–L2 (no dropped sentence, no generic line);
 *  - tiers:    on harvested games (the held-out quarter, or the committed sample): «Учитель» turns voiced without the
 *              generic line (Starter ≥ 97 %), every move a «Учитель» turn names voiced (whole unit or split form), the
 *              split share reported against the SPEC's 15 % (see `GATES.splitShareMax`);
 *  - liveliness (§7.8, reported; gated for the full library): any take ≤ 1.5 plays per game (barks ≤ 2), distinct ÷
 *              plays ≥ 0.8, neighbouring utterances share ≤ 1 take (slots aside), no fixed take again within 3 events.
 */
import {
  CLIP_CATALOG,
  buildClipIndex,
  catalogFallbacks,
  clipInputOf,
  createClipRecency,
  planClips,
} from '../../packages/core/src/coach/clips/index.ts';
import type { ClipIndex, ClipIndexEntry, ClipPlan, PlanContext } from '../../packages/core/src/coach/clips/index.ts';
import { VOICE_KEY } from './config.ts';
import { codePoints } from './cost.ts';
import { demoEvents, eventDemand, isHoldout, planContextOf } from './harvest.ts';
import type { Harvest, HarvestCoachEvent, HarvestGame, HarvestGameConfig } from './harvest.ts';
import { clipId } from './ids.ts';
import { isDiscard } from './jobs.ts';
import type { GenJob, JobsFile } from './jobs.ts';
import type { Manifest } from './manifest.ts';
import { MS_PER_CHAR } from './planJobs.ts';
import type { DemoLike } from './planJobs.ts';

// ───────────────────────── libraries ─────────────────────────

/** The library `process` would publish from these jobs (every unit taken as recorded; durations estimated). */
export function libraryFromJobs(jobs: readonly (GenJob | JobsFile)[]): ClipIndex {
  const entries: ClipIndexEntry[] = [];
  const list = jobs.flatMap((j) => ('jobs' in j ? j.jobs : [j]));
  for (const job of list) {
    job.pieces.forEach((piece, cut) => {
      if (isDiscard(piece)) return;
      const audible = Math.max(1, codePoints(piece.text)) * MS_PER_CHAR;
      const pools = piece.pools ?? (piece.pool ? [piece.pool] : []);
      entries.push({
        id: clipId(VOICE_KEY, job.prompt, cut, job.take),
        key: piece.key,
        text: piece.text,
        take: job.take,
        ms: audible + 90,
        on: 30,
        off: audible + 30,
        ...(pools.length > 0 ? { pools } : {}),
        ...(piece.mood ? { mood: piece.mood } : {}),
        ...(piece.kind === 'bark' ? { interj: true } : {}),
      });
    });
  }
  return buildClipIndex(entries, catalogFallbacks(CLIP_CATALOG));
}

/** The planner's view of a published manifest. */
export function libraryFromManifest(manifest: Pick<Manifest, 'units' | 'pools' | 'keys'> & { fallbacks?: Record<string, string> }): ClipIndex {
  return { units: manifest.units, pools: manifest.pools, keys: manifest.keys, fallbacks: manifest.fallbacks ?? catalogFallbacks(CLIP_CATALOG) };
}

/**
 * Takes recorded for words the script no longer says under their key (a catalogue wording was edited after the take
 * was paid for): they must not be played — the planner would say the old words. References (`ref:`) aside.
 */
export function staleTakes(units: Readonly<Record<string, { key?: string; text: string }>>, script: { units: readonly { key: string; text: string }[] }): string[] {
  const now = new Map(script.units.map((u) => [u.key, u.text.normalize('NFC').trim()]));
  const out: string[] = [];
  for (const [id, u] of Object.entries(units)) {
    if (!u.key || u.key.startsWith('ref:')) continue;
    const want = now.get(u.key);
    if (want !== undefined && want !== u.text.normalize('NFC').trim()) out.push(id);
  }
  return out.sort();
}

/** The library without these takes (stale or rejected ones). */
export function withoutTakes(index: ClipIndex, ids: readonly string[]): ClipIndex {
  if (ids.length === 0) return index;
  const drop = new Set(ids);
  const filter = (m: Record<string, string[]>): Record<string, string[]> => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.filter((id) => !drop.has(id))]));
  return {
    units: Object.fromEntries(Object.entries(index.units).filter(([id]) => !drop.has(id))),
    pools: filter(index.pools),
    keys: filter(index.keys),
    ...(index.fallbacks ? { fallbacks: index.fallbacks } : {}),
  };
}

// ───────────────────────── one event ─────────────────────────

export function planEvent(ev: HarvestCoachEvent, game: Pick<HarvestGameConfig, 'tc' | 'name'>, index: ClipIndex, extra: Partial<PlanContext> = {}): ClipPlan {
  const input = clipInputOf(ev, game.name ? { name: game.name } : {});
  return planClips(input, index, planContextOf(ev, game, extra));
}

/** L1–L2 and nothing dropped or replaced by a generic line. */
export function fullyVoiced(plan: ClipPlan): boolean {
  return plan.clips.length > 0 && plan.level <= 2 && plan.stats.generic === 0 && !plan.mismatch;
}

// ───────────────────────── the demo ─────────────────────────

export interface DemoCoverage {
  events: number;
  ok: number;
  failures: { id: string; kind: string; level: number; heard: string; misses: string[] }[];
}

export function demoCoverage(demo: DemoLike, index: ClipIndex): DemoCoverage {
  const game = { tc: demo.timeControlId as HarvestGameConfig['tc'], name: '' };
  const out: DemoCoverage = { events: 0, ok: 0, failures: [] };
  for (const ev of demoEvents(demo)) {
    out.events++;
    const plan = planEvent(ev, game, index);
    // (and with every sentence a shorter real take could let through)
    const wide = planEvent(ev, game, index, { caps: { maxSentences: planContextOf(ev, game).caps?.maxSentences ?? 2, maxMs: Number.MAX_SAFE_INTEGER } });
    if (fullyVoiced(plan) && fullyVoiced(wide)) out.ok++;
    else {
      const bad = fullyVoiced(plan) ? wide : plan;
      out.failures.push({ id: ev.id, kind: ev.kind, level: bad.level, heard: bad.heard, misses: bad.misses.map((m) => `L${m.level} ${m.key}`) });
    }
  }
  return out;
}

// ───────────────────────── harvested games ─────────────────────────

export interface KindCoverage {
  events: number;
  voiced: number;
  generic: number;
  dropped: number;
  mismatch: number;
  levels: Record<string, number>;
}

export interface CoverageReport {
  games: number;
  events: number;
  byKind: Record<string, KindCoverage>;
  /** «Учитель» turns (teachTurn events of teacher games): share voiced without the generic line */
  teacher: { events: number; noGeneric: number; share: number; fully: number; fullyShare: number };
  /** every move a «Учитель» turn would name (probe demand) and how it was voiced — the Starter gates */
  moves: MoveCoverage;
  /** the same over every event (hints, explanations … speak through the text compiler until Full) */
  movesAll: MoveCoverage;
  /** the units whose absence made events fall (most frequent first) */
  misses: { key: string; count: number; level: number }[];
  liveliness: Liveliness;
}

export interface MoveCoverage {
  mentions: number;
  whole: number;
  split: number;
  missing: number;
  voicedShare: number;
  splitShare: number;
}

export interface Liveliness {
  /** the most plays of one take in one game (barks and slots aside) */
  maxPlaysPerGame: number;
  maxBarkPlaysPerGame: number;
  /** takes played more than 1.5 × per game on average over the games that heard them */
  overplayed: { id: string; text: string; perGame: number }[];
  /** distinct takes ÷ plays, mean over games */
  distinctRatio: number;
  /** pairs of neighbouring utterances sharing more than one take (slots aside), per game */
  neighbourShares: number;
  /** a fixed take heard again within 3 events, per game */
  repeatsWithin3: number;
}

export const GATES = {
  /** SPEC §4.3: Starter ≥ 97 % of «Учитель» utterances voiced without L5 */
  teacherNoGeneric: 0.97,
  movesVoiced: 1,
  splitShareMax: 0.15,
  maxPlaysPerGame: 1.5,
  maxBarkPlaysPerGame: 2,
  distinctRatio: 0.8,
} as const;

function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Coverage of harvested games against a library. `games`: which games count ('holdout' = the quarter the ranking never
 * saw, 'all'). Each game is planned in order with a fresh recency memory and a seeded random source, as the layer
 * would play it — so the liveliness numbers are those of a real game.
 */
export function coverageOf(h: Harvest, index: ClipIndex, opts: { games?: 'holdout' | 'all'; only?: (g: HarvestGame) => boolean } = {}): CoverageReport {
  const which = opts.games ?? 'holdout';
  const report: CoverageReport = {
    games: 0,
    events: 0,
    byKind: {},
    teacher: { events: 0, noGeneric: 0, share: 1, fully: 0, fullyShare: 1 },
    moves: { mentions: 0, whole: 0, split: 0, missing: 0, voicedShare: 1, splitShare: 0 },
    movesAll: { mentions: 0, whole: 0, split: 0, missing: 0, voicedShare: 1, splitShare: 0 },
    misses: [],
    liveliness: { maxPlaysPerGame: 0, maxBarkPlaysPerGame: 0, overplayed: [], distinctRatio: 1, neighbourShares: 0, repeatsWithin3: 0 },
  };
  const missCount = new Map<string, { count: number; level: number }>();
  const perGamePlays = new Map<string, { games: number; plays: number }>();
  let ratioSum = 0;
  let ratioGames = 0;
  for (const g of h.games) {
    if (which === 'holdout' && !isHoldout(g)) continue;
    if (opts.only && !opts.only(g)) continue;
    report.games++;
    const recency = createClipRecency();
    const rng = mulberry(g.seed);
    const plays = new Map<string, number>();
    let prevBark = false;
    let prevIds: Set<string> | null = null;
    const recent: Set<string>[] = [];
    let total = 0;
    for (const e of h.events.get(g.game) ?? []) {
      const ev = e.event;
      report.events++;
      const plan = planEvent(ev, g, index, { rng, jitter: false, recency, prevBark });
      prevBark = plan.bark;
      recency.note(plan.clips.map((c) => c.id));
      const k = report.byKind[ev.kind] ?? (report.byKind[ev.kind] = { events: 0, voiced: 0, generic: 0, dropped: 0, mismatch: 0, levels: {} });
      k.events++;
      if (plan.clips.length > 0) k.voiced++;
      if (plan.stats.generic > 0) k.generic++;
      if (plan.stats.dropped > 0) k.dropped++;
      if (plan.mismatch) k.mismatch++;
      k.levels[String(plan.level)] = (k.levels[String(plan.level)] ?? 0) + 1;
      if (ev.kind === 'teachTurn' && g.coachStyle === 'teacher') {
        report.teacher.events++;
        if (plan.clips.length > 0 && plan.stats.generic === 0) report.teacher.noGeneric++;
        if (fullyVoiced(plan)) report.teacher.fully++;
      }
      // moves: what the full library would name here, against what this one names
      const wanted = eventDemand(ev, g).items.filter((i) => i.kind === 'slot').length;
      const named = plan.stats.slots;
      for (const m of ev.kind === 'teachTurn' && g.coachStyle === 'teacher' ? [report.moves, report.movesAll] : [report.movesAll]) {
        m.mentions += wanted;
        m.split += Math.min(plan.stats.split, wanted);
        m.whole += Math.min(named - plan.stats.split, wanted);
        m.missing += Math.max(0, wanted - named);
      }
      for (const m of plan.misses) {
        const c = missCount.get(m.key) ?? { count: 0, level: m.level };
        c.count++;
        c.level = Math.max(c.level, m.level);
        missCount.set(m.key, c);
      }
      // liveliness: fixed takes (slots are the move itself, barks counted apart)
      const fixed = new Set<string>();
      for (const c of plan.clips) {
        total++;
        plays.set(c.id, (plays.get(c.id) ?? 0) + 1);
        if (c.role !== 'slot' && c.role !== 'split' && c.role !== 'bark') fixed.add(c.id);
      }
      if (prevIds) {
        let shared = 0;
        for (const id of fixed) if (prevIds.has(id)) shared++;
        if (shared > 1) report.liveliness.neighbourShares++;
      }
      for (const past of recent) for (const id of fixed) if (past.has(id)) report.liveliness.repeatsWithin3++;
      recent.push(fixed);
      if (recent.length > 3) recent.shift();
      prevIds = fixed;
    }
    if (total > 0) {
      ratioSum += plays.size / total;
      ratioGames++;
    }
    for (const [id, n] of plays) {
      const bark = index.units[id]?.interj === true;
      const slot = (index.units[id]?.key ?? '').startsWith('slot:');
      if (slot) continue;
      if (bark) report.liveliness.maxBarkPlaysPerGame = Math.max(report.liveliness.maxBarkPlaysPerGame, n);
      else report.liveliness.maxPlaysPerGame = Math.max(report.liveliness.maxPlaysPerGame, n);
      const p = perGamePlays.get(id) ?? { games: 0, plays: 0 };
      p.games++;
      p.plays += n;
      perGamePlays.set(id, p);
    }
  }
  report.teacher.share = report.teacher.events > 0 ? report.teacher.noGeneric / report.teacher.events : 1;
  report.teacher.fullyShare = report.teacher.events > 0 ? report.teacher.fully / report.teacher.events : 1;
  for (const m of [report.moves, report.movesAll]) {
    const voiced = m.whole + m.split;
    m.voicedShare = m.mentions > 0 ? voiced / m.mentions : 1;
    m.splitShare = voiced > 0 ? m.split / voiced : 0;
  }
  report.misses = [...missCount].map(([key, v]) => ({ key, count: v.count, level: v.level })).sort((a, b) => b.count - a.count).slice(0, 40);
  report.liveliness.distinctRatio = ratioGames > 0 ? ratioSum / ratioGames : 1;
  report.liveliness.neighbourShares = report.games > 0 ? report.liveliness.neighbourShares / report.games : 0;
  report.liveliness.repeatsWithin3 = report.games > 0 ? report.liveliness.repeatsWithin3 / report.games : 0;
  report.liveliness.overplayed = [...perGamePlays]
    .map(([id, p]) => ({ id, text: index.units[id]?.text ?? '', perGame: p.plays / Math.max(1, report.games), bark: index.units[id]?.interj === true }))
    .filter((x) => x.perGame > (x.bark ? GATES.maxBarkPlaysPerGame : GATES.maxPlaysPerGame))
    .sort((a, b) => b.perGame - a.perGame)
    .slice(0, 20)
    .map(({ id, text, perGame }) => ({ id, text, perGame: Math.round(perGame * 100) / 100 }));
  return report;
}

/** What fails the tier gates of SPEC §4.3 ([] = pass). */
export function tierGateProblems(r: CoverageReport): string[] {
  const out: string[] = [];
  if (r.teacher.share < GATES.teacherNoGeneric) out.push(`«Учитель» без общей фразы ${(r.teacher.share * 100).toFixed(1)} % < ${GATES.teacherNoGeneric * 100} %`);
  if (r.moves.voicedShare < GATES.movesVoiced) out.push(`ходы озвучены ${(r.moves.voicedShare * 100).toFixed(1)} % < 100 %`);
  if (r.moves.splitShare > GATES.splitShareMax) out.push(`ходы по частям ${(r.moves.splitShare * 100).toFixed(1)} % > ${GATES.splitShareMax * 100} %`);
  return out;
}

/** What fails the liveliness gates of SPEC §7.8 ([] = pass). */
export function livelinessProblems(l: Liveliness): string[] {
  const out: string[] = [];
  if (l.overplayed.length > 0) out.push(`записи чаще 1,5 раза за партию: ${l.overplayed.slice(0, 5).map((o) => `«${o.text}» ${o.perGame}`).join(', ')}`);
  if (l.distinctRatio < GATES.distinctRatio) out.push(`разных записей на прослушивание ${l.distinctRatio.toFixed(2)} < ${GATES.distinctRatio}`);
  return out;
}

// ───────────────────────── the review page's composed lines ─────────────────────────

type GapKind = '.' | '!' | '?' | '—' | ':' | ';' | 'split' | 'bark';

/** The gap-table kind of a planned gap (the review renderer takes kinds, the planner gives ms). */
export function gapKindOf(ms: number, role: string, prevRole: string | null, blitz: boolean): GapKind {
  if (prevRole === 'bark') return 'bark';
  if (role === 'split' && prevRole === 'split') return 'split';
  const base = blitz ? ms / 0.75 : ms;
  const table: [GapKind, number][] = [['?', 500], ['.', 450], ['—', 280], [';', 260], ['split', 250], [':', 240]];
  let best: GapKind = '—';
  let d = Infinity;
  for (const [k, v] of table) {
    if (Math.abs(v - base) < d) {
      d = Math.abs(v - base);
      best = k;
    }
  }
  return best;
}

/** Up to `max` demo utterances composed from a library, for `voice:review --composed` (runtime gap table). */
export function composedDemo(demo: DemoLike, index: ClipIndex, max = 30): { lines: { name: string; blitz: boolean; items: ({ id: string } | { gap: GapKind })[] }[] } {
  const game = { tc: demo.timeControlId as HarvestGameConfig['tc'], name: '' };
  const blitz = game.tc === 'blitz5';
  const lines: { name: string; blitz: boolean; items: ({ id: string } | { gap: GapKind })[] }[] = [];
  for (const ev of demoEvents(demo)) {
    if (lines.length >= max) break;
    const plan = planEvent(ev, game, index);
    if (plan.clips.length === 0) continue;
    const items: ({ id: string } | { gap: GapKind })[] = [];
    let prevRole: string | null = null;
    for (const c of plan.clips) {
      if (prevRole !== null) items.push({ gap: gapKindOf(c.gapBeforeMs, c.role, prevRole, blitz) });
      items.push({ id: c.id });
      prevRole = c.role;
    }
    lines.push({ name: `${ev.id} ${ev.kind}: ${plan.heard}`.slice(0, 160), blitz, items });
  }
  return { lines };
}
