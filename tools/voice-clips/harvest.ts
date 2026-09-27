/**
 * `voice:harvest --clip --games N [--blitz]` (free, silent; docs/voice-clips/SPEC.md §9, §10): engine games played with
 * the real builders in clip mode, recorded event by event, so the catalogue can be ranked and planned by what
 * Гамбитик really says — and one seeded 5-minute «Учитель» game chosen as the demo replay.
 *
 *  - `runHarvest` spawns `harvestWorker.ts` processes (each with its own Stockfish child processes) and merges their
 *    JSON lines in game order into one file (`.harvest/`, gitignored — a small sample is committed for the tests);
 *  - `eventDemand` plans an event against a PROBE library that has every catalogue pool, every move slot and every
 *    compiled fragment exactly once, so the planner itself says which pools / slots / fragments are heard (after the
 *    caps of a 5-minute game, the SAN guard and the generic fallback) — the harvest's demand;
 *  - `pickDemo` / `demoFileOf`: the demo game of SPEC §9 in the replay format of docs/voice-clips/demo-format.md.
 *
 * Holdout (SPEC §4, §11): a quarter of the games (index pairs 2–3, 10–11, …) is held out — the tiers are ranked on the
 * others and their coverage is measured on these.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  CLIP_CATALOG,
  allMoveSlotKeys,
  allSplitSlotKeys,
  canonicalSlotText,
  catalogFallbacks,
  catalogUnits,
  clipCapsFor,
  clipInputOf,
  hash13,
  planClips,
  slotGuardOf,
} from '../../packages/core/src/coach/clips/index.ts';
import type { ClipIndex, ClipPlan, ClipUnitMeta, PlanContext } from '../../packages/core/src/coach/clips/index.ts';
import { getStrategy } from '../../packages/content/src/index.ts';
import type { CoachEvent, Talkativeness, TimeControlId } from '../../packages/shared/src/index.ts';
import { REPO_ROOT } from '../lib/cli.ts';
import { VOICE_KEY } from './config.ts';

// ───────────────────────── records ─────────────────────────

/** A coach event as the harvest keeps it (the live model's brief and the judgement are left out). */
export type HarvestCoachEvent = Pick<CoachEvent, 'id' | 'kind' | 'priority' | 'text' | 'bubbleText' | 'pose' | 'pauseClock'> &
  Partial<Pick<CoachEvent, 'teach' | 'clip' | 'board' | 'hintLevel' | 'motif'>>;

export interface HarvestPly {
  by: 'child' | 'bot';
  uci: string;
  san: string;
  /** wall time of that side's turn (ms) */
  thinkMs: number;
}

export interface HarvestGameConfig {
  /** `g<index>` */
  game: string;
  index: number;
  seed: number;
  coachStyle: 'teacher' | 'helper';
  stage: number;
  childColor: 'w' | 'b';
  tc: TimeControlId;
  persona: string;
  /** the child's name ('' = none; clips never say it) */
  name: string;
  address: 'm' | 'f';
  talk: Talkativeness;
  hour: number;
  gamesPlayed: number;
}

export interface HarvestGame extends HarvestGameConfig {
  t: 'game';
  strategyId: string | null;
  plies: HarvestPly[];
  result: string;
  termination: string;
  clockMs: number | null;
  events: number;
}

export interface HarvestEvent {
  t: 'ev';
  game: string;
  /** order within the game */
  n: number;
  /** plies on the board when it was said (0 = before the first move) */
  afterPly: number;
  /** what said it: 'teachTurn.turn', 'praise.teacher', 'takebackOffer.teacher', 'gameEnd' … */
  family: string;
  event: HarvestCoachEvent;
}

export interface HarvestError {
  t: 'error';
  game: string;
  error: string;
}

export type HarvestLine = HarvestGame | HarvestEvent | HarvestError;

export interface Harvest {
  games: HarvestGame[];
  /** events per game id, in order */
  events: Map<string, HarvestEvent[]>;
  errors: HarvestError[];
}

// ───────────────────────── the games (a fixed mix, seeded by the index alone) ─────────────────────────

const PERSONAS = ['petya', 'sonya', 'grisha', 'sasha', 'vika', 'lyova'] as const;
const NAMES: readonly (readonly [string, 'm' | 'f'])[] = [
  ['Миша', 'm'],
  ['Маша', 'f'],
  ['Тигр', 'm'],
  ['', 'f'],
  ['', 'm'],
];

function mixRng(seed: number): () => number {
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
 * Game `index` of the harvest: ≈ ¾ «Учитель» (stages 1–4), ≈ ¼ «Подсказчик» (stage 5); half of the games are 5-minute
 * ones (the child's usual time control), a quarter 10-minute, a quarter untimed (`blitz`: every game 5 minutes); colours
 * alternate; talkativeness mostly «Обычно» (15 % «Тихо» — the short style —, 15 % «Болтливо»).
 */
export function gameConfigOf(index: number, opts: { blitz?: boolean } = {}): HarvestGameConfig {
  const r = mixRng(index * 7919 + 17);
  const teacher = r() < 0.75;
  const tcRoll = r();
  const tc: TimeControlId = opts.blitz ? 'blitz5' : tcRoll < 0.5 ? 'blitz5' : tcRoll < 0.75 ? 'rapid10' : 'training';
  const talkRoll = r();
  const [name, address] = NAMES[Math.floor(r() * NAMES.length)] as readonly [string, 'm' | 'f'];
  return {
    game: `g${index}`,
    index,
    seed: index * 1000 + 7,
    coachStyle: teacher ? 'teacher' : 'helper',
    stage: teacher ? 1 + Math.floor(r() * 4) : 5,
    childColor: index % 2 === 0 ? 'w' : 'b',
    tc,
    persona: PERSONAS[Math.floor(r() * PERSONAS.length)] as string,
    name,
    address,
    talk: talkRoll < 0.7 ? 'normal' : talkRoll < 0.85 ? 'quiet' : 'chatty',
    hour: [9, 15, 20, 23][Math.floor(r() * 4)] as number,
    gamesPlayed: r() < 0.08 ? 0 : 5 + Math.floor(r() * 40),
  };
}

/** Held out of the ranking, used to measure coverage (SPEC §11: rank on ¾, test on ¼; both colours: pairs 2–3, 10–11 …). */
export function isHoldout(game: Pick<HarvestGameConfig, 'index'>): boolean {
  return Math.floor(game.index / 2) % 4 === 1;
}

export function toHarvestEvent(ev: CoachEvent, id: string): HarvestCoachEvent {
  return {
    id,
    kind: ev.kind,
    priority: ev.priority,
    text: ev.text,
    bubbleText: ev.bubbleText,
    pose: ev.pose,
    pauseClock: ev.pauseClock,
    ...(ev.teach ? { teach: ev.teach } : {}),
    ...(ev.clip ? { clip: ev.clip } : {}),
    ...(ev.board ? { board: ev.board } : {}),
    ...(ev.hintLevel !== undefined ? { hintLevel: ev.hintLevel } : {}),
    ...(ev.motif !== undefined ? { motif: ev.motif } : {}),
  };
}

// ───────────────────────── reading and writing harvest files ─────────────────────────

export function parseHarvestLines(text: string): Harvest {
  const games: HarvestGame[] = [];
  const events = new Map<string, HarvestEvent[]>();
  const errors: HarvestError[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    let rec: HarvestLine;
    try {
      rec = JSON.parse(line) as HarvestLine;
    } catch {
      continue;
    }
    if (rec.t === 'game') games.push(rec);
    else if (rec.t === 'ev') {
      const list = events.get(rec.game) ?? [];
      list.push(rec);
      events.set(rec.game, list);
    } else if (rec.t === 'error') errors.push(rec);
  }
  games.sort((a, b) => a.index - b.index);
  for (const list of events.values()) list.sort((a, b) => a.n - b.n);
  // a game without its closing record (a worker died) is not used
  const done = new Set(games.map((g) => g.game));
  for (const id of [...events.keys()]) if (!done.has(id)) events.delete(id);
  return { games, events, errors };
}

/** A harvest file: JSON lines, gzip when the name ends in `.gz`. */
export function readHarvest(file: string): Harvest {
  const buf = readFileSync(file);
  return parseHarvestLines((file.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8'));
}

export function harvestText(h: Harvest, gameIds?: ReadonlySet<string>): string {
  const lines: string[] = [];
  for (const g of h.games) {
    if (gameIds && !gameIds.has(g.game)) continue;
    lines.push(JSON.stringify(g));
    for (const e of h.events.get(g.game) ?? []) lines.push(JSON.stringify(e));
  }
  return `${lines.join('\n')}\n`;
}

export function writeHarvest(file: string, h: Harvest, gameIds?: ReadonlySet<string>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const text = harvestText(h, gameIds);
  writeFileSync(file, file.endsWith('.gz') ? gzipSync(Buffer.from(text, 'utf8'), { level: 9 }) : text);
}

export function mergeHarvests(parts: readonly Harvest[]): Harvest {
  const games = new Map<string, HarvestGame>();
  const events = new Map<string, HarvestEvent[]>();
  const errors: HarvestError[] = [];
  for (const h of parts) {
    for (const g of h.games) {
      games.set(g.game, g);
      events.set(g.game, h.events.get(g.game) ?? []);
    }
    errors.push(...h.errors);
  }
  return { games: [...games.values()].sort((a, b) => a.index - b.index), events, errors };
}

// ───────────────────────── running the workers ─────────────────────────

export interface HarvestRunOptions {
  games: number;
  /** first game index (to extend an existing harvest) */
  from?: number;
  workers: number;
  blitz?: boolean;
  outFile: string;
  /** base folder for the workers' temporary files */
  work: string;
  log?: (line: string) => void;
}

/** Plays the games in parallel worker processes and writes the merged harvest. Free: no network, no audio. */
export async function runHarvest(opts: HarvestRunOptions): Promise<Harvest> {
  const log = opts.log ?? (() => {});
  const from = opts.from ?? 0;
  const indices = Array.from({ length: opts.games }, (_, i) => from + i);
  const workers = Math.max(1, Math.min(opts.workers, indices.length));
  mkdirSync(opts.work, { recursive: true });
  const tmp = mkdtempSync(path.join(opts.work, 'harvest-'));
  const script = path.join(REPO_ROOT, 'tools', 'voice-clips', 'harvestWorker.ts');
  let done = 0;
  try {
    const files = await Promise.all(
      Array.from({ length: workers }, (_, w) => {
        const mine = indices.filter((_, i) => i % workers === w);
        const file = path.join(tmp, `w${w}.jsonl`);
        return new Promise<string>((resolve, reject) => {
          const args = [script, '--out', file, '--games', mine.join(','), ...(opts.blitz ? ['--blitz'] : [])];
          const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
          let err = '';
          child.stdout.on('data', (buf: Buffer) => {
            for (const line of buf.toString('utf8').split('\n')) {
              if (line.startsWith('done ')) {
                done++;
                if (done % 10 === 0 || done === indices.length) log(`сыграно ${done} из ${indices.length}`);
              }
            }
          });
          child.stderr.on('data', (buf: Buffer) => {
            err += buf.toString('utf8');
          });
          child.on('error', reject);
          child.on('close', (code) => (code === 0 ? resolve(file) : reject(new Error(`worker ${w} exited ${code}: ${err.slice(-800)}`))));
        });
      }),
    );
    const merged = mergeHarvests(files.filter((f) => existsSync(f)).map((f) => readHarvest(f)));
    const previous = existsSync(opts.outFile) && from > 0 ? readHarvest(opts.outFile) : null;
    const all = previous ? mergeHarvests([previous, merged]) : merged;
    writeHarvest(opts.outFile, all);
    return all;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ───────────────────────── demand: what the planner would voice ─────────────────────────

export type DemandItem = { kind: 'pool'; key: string } | { kind: 'slot'; key: string } | { kind: 'frag'; key: string; text: string };

interface ProbeMeta {
  kind: DemandItem['kind'];
  key: string;
}

const PROBE_MS_PER_CHAR = 70;

function timing(chars: number): Pick<ClipUnitMeta, 'ms' | 'on' | 'off'> {
  const audible = Math.max(1, chars) * PROBE_MS_PER_CHAR;
  return { ms: audible + 100, on: 30, off: audible + 30 };
}

let probeMemo: { index: ClipIndex; meta: Map<string, ProbeMeta> } | null = null;

/**
 * A library that has everything exactly once: every catalogue pool (one take with that pool only), every move slot
 * and split unit, and — made up on demand — every compiled fragment. Planned against it, an utterance resolves at L1
 * wherever the catalogue can say it, and the take ids name the exact pools / keys the planner asked for.
 */
export function probeIndex(): { index: ClipIndex; meta: Map<string, ProbeMeta> } {
  if (probeMemo) return probeMemo;
  const meta = new Map<string, ProbeMeta>();
  const units: Record<string, ClipUnitMeta> = {};
  const pools: Record<string, string[]> = {};
  const probeId = (key: string): string => `c${hash13(`probe\n${key}`)}`;
  for (const line of CLIP_CATALOG) {
    for (const u of catalogUnits(line)) {
      for (const pool of u.pools) {
        if (pools[pool] || u.text === null) continue;
        const id = probeId(`pool:${pool}`);
        units[id] = { text: u.text, ...timing([...u.text].length), ...(line.role === 'bark' ? { interj: true } : {}) };
        meta.set(id, { kind: 'pool', key: pool });
        pools[pool] = [id];
      }
    }
  }
  const staticKeys: Record<string, string[]> = {};
  for (const key of [...allMoveSlotKeys(), ...allSplitSlotKeys()]) {
    const unit = `slot:${key}`;
    const id = probeId(unit);
    const text = canonicalSlotText(key);
    units[id] = { text, ...timing([...text].length) };
    meta.set(id, { kind: 'slot', key });
    staticKeys[unit] = [id];
  }
  const keys = new Proxy(staticKeys, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      const hit = target[prop];
      if (hit) return hit;
      if (!prop.startsWith('frag:')) return undefined;
      const id = probeId(prop);
      const norm = prop.slice('frag:f:'.length).replace(/\|.*$/u, '');
      // (no text: the planner then hears the fragment exactly as written)
      units[id] = { text: '', ...timing([...norm].length) };
      meta.set(id, { kind: 'frag', key: prop.slice('frag:'.length) });
      target[prop] = [id];
      return target[prop];
    },
  });
  probeMemo = { index: { units, pools, keys, fallbacks: catalogFallbacks(CLIP_CATALOG) }, meta };
  return probeMemo;
}

/** The planner context of an event as the game's clip layer builds it (no bark, no jitter, a fixed take choice). */
export function planContextOf(ev: HarvestCoachEvent, game: Pick<HarvestGameConfig, 'tc'>, extra: Partial<PlanContext> = {}): PlanContext {
  const blitz = game.tc === 'blitz5';
  const ctx: PlanContext = {
    rng: () => 0,
    jitter: false,
    blitz,
    priority: ev.priority,
    prevBark: true,
    caps: clipCapsFor({ kind: ev.kind, ...(ev.teach?.style ? { style: ev.teach.style } : {}), blitz }),
    ...extra,
  };
  const allowed = slotGuardOf(ev);
  if (allowed !== undefined && ctx.allowedSans === undefined) ctx.allowedSans = allowed;
  return ctx;
}

export interface EventDemand {
  items: DemandItem[];
  plan: ClipPlan;
}

/**
 * What the planner would voice for this event if everything the catalogue can say were recorded. `superset`: no cap at
 * all — every sentence of the utterance, also those the caps drop: the planner resolves (and reports a missing one as
 * L4) before it applies the caps, so a library that must voice an event at L1–L2 needs all of them.
 */
export function eventDemand(ev: HarvestCoachEvent, game: Pick<HarvestGameConfig, 'tc' | 'name'>, opts: { superset?: boolean } = {}): EventDemand {
  const probe = probeIndex();
  const input = clipInputOf(ev, game.name ? { name: game.name } : {});
  const ctx = planContextOf(ev, game);
  if (opts.superset) ctx.caps = { maxSentences: 99, maxMs: Number.MAX_SAFE_INTEGER };
  const plan = planClips(input, probe.index, ctx);
  const items: DemandItem[] = [];
  for (const c of plan.clips) {
    const m = probe.meta.get(c.id);
    if (!m) continue;
    if (m.kind === 'frag') items.push({ kind: 'frag', key: m.key, text: c.text });
    else items.push({ kind: m.kind, key: m.key });
  }
  return { items, plan };
}

// ───────────────────────── stats (committed: what the script ranks by) ─────────────────────────

export interface DemandCount {
  /** plays in the counted games */
  plays: number;
  /** games it was heard in */
  games: number;
}

export interface HarvestStats {
  v: 1;
  voiceKey: string;
  /** which games were counted: 'train' (ranking), 'holdout' (measuring) or 'all' */
  split: 'train' | 'holdout' | 'all';
  games: number;
  teacherGames: number;
  blitzGames: number;
  events: number;
  byKind: Record<string, { events: number; generic: number; mismatch: number; levels: Record<string, number> }>;
  pools: Record<string, DemandCount>;
  slots: Record<string, DemandCount>;
  frags: Record<string, DemandCount & { text: string }>;
}

function bump(map: Record<string, DemandCount>, key: string, game: string, seen: Set<string>): DemandCount {
  const c = map[key] ?? (map[key] = { plays: 0, games: 0 });
  c.plays++;
  const mark = `${key}\n${game}`;
  if (!seen.has(mark)) {
    seen.add(mark);
    c.games++;
  }
  return c;
}

export function harvestStats(h: Harvest, split: HarvestStats['split'] = 'all'): HarvestStats {
  const stats: HarvestStats = { v: 1, voiceKey: VOICE_KEY, split, games: 0, teacherGames: 0, blitzGames: 0, events: 0, byKind: {}, pools: {}, slots: {}, frags: {} };
  const seen = new Set<string>();
  for (const g of h.games) {
    if (split === 'train' && isHoldout(g)) continue;
    if (split === 'holdout' && !isHoldout(g)) continue;
    stats.games++;
    if (g.coachStyle === 'teacher') stats.teacherGames++;
    if (g.tc === 'blitz5') stats.blitzGames++;
    for (const e of h.events.get(g.game) ?? []) {
      stats.events++;
      const d = eventDemand(e.event, g);
      const k = stats.byKind[e.event.kind] ?? (stats.byKind[e.event.kind] = { events: 0, generic: 0, mismatch: 0, levels: {} });
      k.events++;
      if (d.plan.stats.generic > 0) k.generic++;
      if (d.plan.mismatch) k.mismatch++;
      k.levels[String(d.plan.level)] = (k.levels[String(d.plan.level)] ?? 0) + 1;
      for (const it of d.items) {
        if (it.kind === 'pool') bump(stats.pools, it.key, g.game, seen);
        else if (it.kind === 'slot') bump(stats.slots, it.key, g.game, seen);
        else {
          const c = bump(stats.frags, it.key, g.game, seen) as DemandCount & { text?: string };
          c.text ??= it.text;
        }
      }
    }
  }
  const sortRec = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k] as T]));
  stats.pools = sortRec(stats.pools);
  stats.slots = sortRec(stats.slots);
  stats.frags = sortRec(stats.frags) as HarvestStats['frags'];
  stats.byKind = sortRec(stats.byKind);
  return stats;
}

// ───────────────────────── the demo game (SPEC §9) ─────────────────────────

const lineIdsOf = (ev: HarvestCoachEvent): string[] => (ev.clip?.sentences ?? []).flatMap((s) => s.items.flatMap((it) => ('line' in it ? [it.line] : [])));

export interface DemoFacts {
  game: string;
  teachTurns: number;
  treasure: number;
  reveal: number;
  danger: number;
  praise: number;
  takebackOffer: number;
  strategyIntro: boolean;
  gameEnd: boolean;
  bridge: number;
  /** events the catalogue cannot voice at all (a bridge sentence that falls to the generic line) */
  unvoiceable: number;
  plies: number;
  childWon: boolean;
  address: 'm' | 'f';
  /** SPEC §9: a seeded 5-minute «Учитель» game, the child White, ≥ 15 teacher turns, a treasure, a danger, a praise, a take-back offer, a strategy intro and a game end */
  eligible: boolean;
}

export function demoFactsOf(g: HarvestGame, events: readonly HarvestEvent[]): DemoFacts {
  const ev = events.map((e) => e.event);
  const facts: DemoFacts = {
    game: g.game,
    teachTurns: events.filter((e) => e.event.kind === 'teachTurn' && e.event.teach?.moment === 'turn').length,
    treasure: ev.filter((e) => e.kind === 'teachTurn' && e.teach?.reveal === 'later').length,
    reveal: ev.filter((e) => e.kind === 'teachTurn' && e.teach?.moment === 'reveal').length,
    danger: ev.filter((e) => lineIdsOf(e).some((l) => l.startsWith('danger.'))).length,
    praise: ev.filter((e) => e.kind === 'praise').length,
    takebackOffer: ev.filter((e) => e.kind === 'takebackOffer').length,
    strategyIntro: ev.some((e) => e.kind === 'gameStart' && lineIdsOf(e).some((l) => l.startsWith('strategy.'))),
    gameEnd: ev.some((e) => e.kind === 'gameEnd'),
    bridge: ev.filter((e) => !e.clip).length,
    unvoiceable: ev.filter((e) => {
      const d = eventDemand(e, g);
      return d.plan.level > 2 || d.plan.stats.generic > 0;
    }).length,
    plies: g.plies.length,
    childWon: (g.result === '1-0' && g.childColor === 'w') || (g.result === '0-1' && g.childColor === 'b'),
    address: g.address,
    eligible: false,
  };
  facts.eligible =
    g.tc === 'blitz5' &&
    g.coachStyle === 'teacher' &&
    g.childColor === 'w' &&
    facts.teachTurns >= 15 &&
    facts.treasure >= 1 &&
    facts.danger >= 1 &&
    facts.praise >= 1 &&
    facts.takebackOffer >= 1 &&
    facts.strategyIntro &&
    facts.gameEnd &&
    facts.unvoiceable === 0;
  return facts;
}

/**
 * A higher score = a better demo: every family once or more, no bridge events (their fragments would cost extra), the
 * default talkativeness, a boy (Гамбитик's own child audience; the gendered forms heard first), a real
 * finish, and short enough to watch — and to record — in one sitting.
 */
export function demoScore(f: DemoFacts, g: Pick<HarvestGame, 'talk' | 'termination'>): number {
  let s = 0;
  s += Math.min(f.treasure, 3) * 3 + Math.min(f.reveal, 2) * 2 + Math.min(f.danger, 3) * 2 + Math.min(f.praise, 2) * 3 + Math.min(f.takebackOffer, 2) * 3;
  s -= f.bridge * 4;
  s += g.talk === 'normal' ? 5 : 0;
  s += f.address === 'm' ? 6 : 0;
  s += f.childWon ? 4 : 0;
  s += g.termination === 'checkmate' ? 3 : 0;
  s -= Math.max(0, f.plies - 60) * 0.3;
  s -= Math.max(0, f.teachTurns - 30) * 0.5;
  return s;
}

/** The best eligible demo game (null when none is eligible). */
export function pickDemo(h: Harvest): { game: HarvestGame; facts: DemoFacts } | null {
  let best: { game: HarvestGame; facts: DemoFacts; score: number } | null = null;
  for (const g of h.games) {
    const facts = demoFactsOf(g, h.events.get(g.game) ?? []);
    if (!facts.eligible) continue;
    const score = demoScore(facts, g);
    if (!best || score > best.score) best = { game: g, facts, score };
  }
  return best ? { game: best.game, facts: best.facts } : null;
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** The demo replay file (docs/voice-clips/demo-format.md) of a harvested game. */
export function demoFileOf(g: HarvestGame, events: readonly HarvestEvent[]): Record<string, unknown> {
  const says = (list: readonly HarvestEvent[]) => list.map((e) => ({ event: e.event }));
  const tcTitle = g.tc === 'blitz5' ? '5 минут' : g.tc === 'rapid10' ? '10 минут' : 'без часов';
  const strategy = g.strategyId ? (getStrategy(g.strategyId)?.titleRu ?? g.strategyId) : null;
  return {
    v: 1,
    seed: g.game,
    title: `«${g.coachStyle === 'teacher' ? 'Учитель' : 'Подсказчик'}», ${tcTitle}, ${g.childColor === 'w' ? 'белые' : 'чёрные'}${strategy ? `, ${strategy}` : ''}`,
    voiceKey: VOICE_KEY,
    timeControlId: g.tc,
    coachStyle: g.coachStyle,
    childColor: g.childColor,
    startFen: START_FEN,
    ...(g.clockMs !== null ? { clockMs: g.clockMs } : {}),
    intro: says(events.filter((e) => e.afterPly === 0)),
    plies: g.plies.map((p, i) => {
      const after = events.filter((e) => e.afterPly === i + 1);
      return { by: p.by, uci: p.uci, thinkMs: p.thinkMs, ...(after.length > 0 ? { after: says(after) } : {}) };
    }),
  };
}

/** Every harvested event of a demo file, in the order the replay says them. */
export function demoEvents(demo: { intro?: { event: HarvestCoachEvent }[]; plies: { after?: { event: HarvestCoachEvent }[] }[] }): HarvestCoachEvent[] {
  return [...(demo.intro ?? []).map((s) => s.event), ...demo.plies.flatMap((p) => (p.after ?? []).map((s) => s.event))];
}
