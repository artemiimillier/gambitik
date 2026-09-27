/**
 * The catalogue-dependent commands of `tools/voice-clips/cli.ts` (all free, silent, no network except the local
 * Stockfish child processes of `harvest`):
 *
 *   harvest  --clip --games N [--from N] [--blitz] [--workers N] [--out file] [--analyse] [--demo <seed>]
 *   script   [--stats file] [--demo <seed>] [--out file] [--budget N]
 *   plan     --tier pilot|starter|full [--script file] [--demo <seed>] [--harvest file] [--no-write]
 *   coverage [--tier pilot|starter|full | --manifest file] [--harvest file] [--games holdout|all] [--gate]
 *
 * Outputs: `.harvest/` (gitignored), `harvest-stats.<voice>.json`, `harvest-sample.<voice>.jsonl.gz`,
 * `script.<voice>.json`, `jobs.<tier>.json`, `composed.pilot.json` (all in tools/voice-clips/, committed) and the demo
 * replay `apps/web/public/voice/demo/<seed>.json`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, displayPath, parseCli, parsePositiveInt, repoPath, UsageError } from '../lib/cli.ts';
import { safeLocalPath } from '../voice-smoke/guard.ts';
import { DEFAULT_LIBRARY, TOOL_DIR, VOICE_KEY } from './config.ts';
import { fmtCredits } from './cost.ts';
import {
  composedDemo,
  coverageOf,
  demoCoverage,
  libraryFromJobs,
  libraryFromManifest,
  livelinessProblems,
  staleTakes,
  tierGateProblems,
  withoutTakes,
} from './coverage.ts';
import type { CoverageReport } from './coverage.ts';
import { demoFactsOf, demoFileOf, harvestStats, isHoldout, pickDemo, readHarvest, runHarvest, writeHarvest } from './harvest.ts';
import type { Harvest, HarvestGame, HarvestStats } from './harvest.ts';
import { parseJobsFile } from './jobs.ts';
import type { JobsFile } from './jobs.ts';
import { readCurrentManifest, writeJsonAtomic } from './manifest.ts';
import { PILOT_HARD_CAP_CREDITS, PILOT_TARGET_CREDITS, planPilot, tierJobs } from './planJobs.ts';
import type { DemoLike, JobsReport } from './planJobs.ts';
import { TIERS, buildScript, scriptUnits } from './script.ts';
import type { ScriptFile, Tier } from './script.ts';

const TAG = '[voice]';

export const HARVEST_DIR = path.join(TOOL_DIR, '.harvest');
export const DEFAULT_HARVEST = path.join(HARVEST_DIR, `harvest.${VOICE_KEY}.jsonl.gz`);
export const DEFAULT_STATS = path.join(TOOL_DIR, `harvest-stats.${VOICE_KEY}.json`);
export const DEFAULT_SAMPLE = path.join(TOOL_DIR, `harvest-sample.${VOICE_KEY}.jsonl.gz`);
export const DEFAULT_SCRIPT = path.join(TOOL_DIR, `script.${VOICE_KEY}.json`);
export const DEMO_DIR = repoPath('apps', 'web', 'public', 'voice', 'demo');
export const COMPOSED_PILOT = path.join(TOOL_DIR, 'composed.pilot.json');
export const SAMPLE_GAMES = 24;

export function jobsFileOf(tier: Tier): string {
  return path.join(TOOL_DIR, `jobs.${tier}.json`);
}

export function demoFileOfSeed(seed: string): string {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(seed)) throw new UsageError(`bad demo seed «${seed}»`);
  return path.join(DEMO_DIR, `${seed}.json`);
}

function safe(value: string | undefined, fallback: string, flag: string): string {
  return safeLocalPath(REPO_ROOT, value ?? fallback, flag);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** JSON with one entry of `listKey` per line (a readable, diff-friendly file for the script and the jobs). */
export function jsonWithLines(obj: object, listKey: string): string {
  const { [listKey]: list, ...rest } = obj as Record<string, unknown>;
  const restText = JSON.stringify(rest, null, 1);
  const head = restText === '{}' ? '{' : `${restText.replace(/\n\}$/u, '')},`;
  const items = (Array.isArray(list) ? list : []).map((x) => ` ${JSON.stringify(x)}`).join(',\n');
  return `${head}\n "${listKey}": [\n${items}\n ]\n}\n`;
}

export function writeLinesAtomic(file: string, obj: object, listKey: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, jsonWithLines(obj, listKey), 'utf8');
  renameSync(tmp, file);
}

export interface StatsFile {
  v: 1;
  voiceKey: string;
  games: number;
  holdoutGames: number;
  demo: { seed: string; facts: ReturnType<typeof demoFactsOf> } | null;
  /** the ranking half (every game that is not held out) */
  train: HarvestStats;
  /** the held-out quarter: counts only (its coverage is measured by `plan` / `coverage`) */
  holdout: Pick<HarvestStats, 'games' | 'teacherGames' | 'blitzGames' | 'events' | 'byKind'>;
}

/** The committed sample: the demo game + held-out games of every style and time control, in index order. */
export function sampleGames(h: Harvest, demoSeed: string | null, n = SAMPLE_GAMES): Set<string> {
  const out = new Set<string>();
  if (demoSeed) out.add(demoSeed);
  const groups = new Map<string, HarvestGame[]>();
  for (const g of h.games) {
    if (!isHoldout(g) || out.has(g.game)) continue;
    const k = `${g.coachStyle}/${g.tc}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(g);
  }
  const keys = [...groups.keys()].sort();
  for (let round = 0; out.size < n; round++) {
    let added = false;
    for (const k of keys) {
      const g = groups.get(k)?.[round];
      if (g && out.size < n) {
        out.add(g.game);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

// ───────────────────────── harvest ─────────────────────────

export async function cmdHarvest(argv: string[]): Promise<void> {
  const args = parseCli(argv, {
    clip: { type: 'boolean' },
    games: { type: 'string' },
    from: { type: 'string' },
    blitz: { type: 'boolean' },
    workers: { type: 'string' },
    out: { type: 'string' },
    analyse: { type: 'boolean' },
    demo: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (args.clip !== true) throw new UsageError('нужен --clip (строители в режиме «Записей» — единственный режим)');
  const out = safe(args.out, DEFAULT_HARVEST, '--out');
  if (args.analyse !== true) {
    const games = parsePositiveInt(args.games, '--games');
    if (games === undefined) throw new UsageError('нужен --games N');
    const workers = parsePositiveInt(args.workers, '--workers') ?? Math.max(1, Math.min(16, os.cpus().length - 2));
    const from = args.from === undefined ? 0 : Number(args.from);
    if (!Number.isInteger(from) || from < 0) throw new UsageError('--from expects a game index ≥ 0');
    console.log(`${TAG} партии ${from}…${from + games - 1}: ${workers} процессов со Stockfish (бесплатно, без звука, без сети)`);
    const t0 = Date.now();
    const h = await runHarvest({ games, from, workers, ...(args.blitz === true ? { blitz: true } : {}), outFile: out, work: path.join(os.tmpdir(), 'gambit-voice-harvest'), log: (l) => console.log(`${TAG} ${l}`) });
    console.log(`${TAG} сыграно за ${Math.round((Date.now() - t0) / 1000)} с; в файле ${h.games.length} партий, ошибок ${h.errors.length}: ${displayPath(out)}`);
  }
  if (!existsSync(out)) throw new UsageError(`нет урожая ${displayPath(out)} — сначала сыграйте партии (--games N)`);
  const h = readHarvest(out);
  // (an experiment with its own --out keeps its stats, sample and demo next to it: the committed ones stay untouched)
  const own = out !== DEFAULT_HARVEST;
  const files = own ? { stats: path.join(path.dirname(out), 'harvest-stats.json'), sample: path.join(path.dirname(out), 'harvest-sample.jsonl.gz'), demoDir: path.join(path.dirname(out), 'demo') } : {};
  const summary = writeHarvestOutputs(h, args.demo ?? null, files);
  console.log(`${TAG} партий ${summary.games} (отложено для проверки ${summary.holdoutGames}); событий в ранжировании ${summary.train.events}`);
  for (const [kind, k] of Object.entries(summary.train.byKind)) console.log(`${TAG}   ${kind}: ${k.events}${k.generic ? `, общей фразой ${k.generic}` : ''}`);
  if (summary.demo) {
    const f = summary.demo.facts;
    console.log(`${TAG} демо-партия ${summary.demo.seed}: ходов учителя ${f.teachTurns}, подарков ${f.treasure}, показов ${f.reveal}, опасностей ${f.danger}, похвал ${f.praise}, «вернём ход» ${f.takebackOffer}, полуходов ${f.plies}`);
    console.log(`${TAG}   ${displayPath(files.demoDir ? path.join(files.demoDir, `${summary.demo.seed}.json`) : demoFileOfSeed(summary.demo.seed))} — ?clipsDemo=${summary.demo.seed}`);
  } else console.log(`${TAG} подходящей демо-партии нет (SPEC §9): сыграйте ещё (--from ${h.games.reduce((m, g) => Math.max(m, g.index + 1), 0)} --games 100 --blitz)`);
  console.log(`${TAG} статистика: ${displayPath(files.stats ?? DEFAULT_STATS)}; образец для тестов: ${displayPath(files.sample ?? DEFAULT_SAMPLE)}`);
}

/** Stats (ranking half), the demo file and the committed sample of a harvest. */
export function writeHarvestOutputs(h: Harvest, forcedDemo: string | null, files: { stats?: string; sample?: string; demoDir?: string } = {}): StatsFile {
  let demo: StatsFile['demo'] = null;
  if (forcedDemo) {
    const g = h.games.find((x) => x.game === forcedDemo);
    if (!g) throw new UsageError(`в урожае нет партии ${forcedDemo}`);
    demo = { seed: g.game, facts: demoFactsOf(g, h.events.get(g.game) ?? []) };
  } else {
    const best = pickDemo(h);
    if (best) demo = { seed: best.game.game, facts: best.facts };
  }
  if (demo) {
    const g = h.games.find((x) => x.game === demo?.seed) as HarvestGame;
    const file = files.demoDir ? path.join(files.demoDir, `${demo.seed}.json`) : demoFileOfSeed(demo.seed);
    mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, demoFileOf(g, h.events.get(g.game) ?? []), false);
  }
  const train = harvestStats(h, 'train');
  const holdout = harvestStats(h, 'holdout');
  const stats: StatsFile = {
    v: 1,
    voiceKey: VOICE_KEY,
    games: h.games.length,
    holdoutGames: holdout.games,
    demo,
    train,
    holdout: { games: holdout.games, teacherGames: holdout.teacherGames, blitzGames: holdout.blitzGames, events: holdout.events, byKind: holdout.byKind },
  };
  writeJsonAtomic(files.stats ?? DEFAULT_STATS, stats);
  writeHarvest(files.sample ?? DEFAULT_SAMPLE, h, sampleGames(h, demo?.seed ?? null));
  return stats;
}

// ───────────────────────── script ─────────────────────────

export function readDemo(seed: string): DemoLike {
  const file = demoFileOfSeed(seed);
  if (!existsSync(file)) throw new UsageError(`нет демо-партии ${displayPath(file)} — сначала voice:harvest`);
  return readJson<DemoLike>(file);
}

/** The script from the committed stats and the demo (the `pilot` tier's units are chosen from the demo first). */
export function scriptFrom(stats: StatsFile, demo: DemoLike | null, budget?: number): ScriptFile {
  const pilotKeys = demo ? planPilot({ units: scriptUnits(stats.train) }, demo).keys : new Set<string>();
  return buildScript(stats.train, { pilotKeys, demo: demo?.seed ?? null, ...(budget !== undefined ? { starterPrice: budget } : {}) });
}

export async function cmdScript(argv: string[]): Promise<void> {
  const args = parseCli(argv, { stats: { type: 'string' }, demo: { type: 'string' }, out: { type: 'string' }, budget: { type: 'string' }, help: { type: 'boolean', short: 'h' } });
  const statsFile = safe(args.stats, DEFAULT_STATS, '--stats');
  if (!existsSync(statsFile)) throw new UsageError(`нет статистики ${displayPath(statsFile)} — сначала voice:harvest`);
  const stats = readJson<StatsFile>(statsFile);
  const seed = args.demo ?? stats.demo?.seed ?? null;
  const demo = seed ? readDemo(seed) : null;
  const budget = args.budget === undefined ? undefined : Number(args.budget);
  if (budget !== undefined && !(budget > 0)) throw new UsageError('--budget expects credits > 0');
  const script = scriptFrom(stats, demo, budget);
  const out = safe(args.out, DEFAULT_SCRIPT, '--out');
  writeLinesAtomic(out, script, 'units');
  const bad = script.units.filter((u) => u.lint);
  console.log(`${TAG} записей в сценарии ${script.units.length} (игр в ранжировании ${script.harvest.games}); демо ${script.demo ?? '—'}`);
  for (const t of TIERS) console.log(`${TAG}   ${t}: ${script.summary[t].units} записей ≈ ${script.summary[t].estCredits} кр. (оценка до упаковки)`);
  console.log(`${TAG} стартовый набор подобран под ${script.budget.starter} кр. после пилота: упакованный — ${script.budget.starterPrice} кр. по цене SPEC`);
  console.log(`${TAG} проверка каталога (мальчик, без клеток, длина, фигуры): ${script.lint.length === 0 ? 'чисто' : `${script.lint.length} замечаний`}`);
  for (const i of script.lint.slice(0, 20)) console.log(`${TAG}   ${i.line} ${i.rule}: «${i.text}»${i.detail ? ` — ${i.detail}` : ''}`);
  if (bad.length > 0) console.log(`${TAG} не будут записаны (${bad.length}): ${bad.slice(0, 8).map((u) => `«${u.text}» (${u.lint?.join('; ')})`).join(', ')}`);
  console.log(`${TAG} сценарий: ${displayPath(out)}`);
  if (script.lint.length > 0) process.exitCode = 1;
}

// ───────────────────────── plan ─────────────────────────

function parseTier(value: string | undefined): Tier {
  if (value === 'pilot' || value === 'starter' || value === 'full') return value;
  throw new UsageError('нужен --tier pilot|starter|full');
}

export function readScript(file: string): ScriptFile {
  if (!existsSync(file)) throw new UsageError(`нет сценария ${displayPath(file)} — сначала voice:script`);
  return readJson<ScriptFile>(file);
}

/** The jobs of every tier up to `tier` (pilot ⊂ starter ⊂ full are separate campaigns; together they are the library). */
export function cumulativeJobs(script: ScriptFile, tier: Tier, demo: DemoLike | null): Record<Tier, JobsFile | null> {
  const out: Record<Tier, JobsFile | null> = { pilot: null, starter: null, full: null };
  for (const t of TIERS) {
    if (TIERS.indexOf(t) > TIERS.indexOf(tier)) break;
    if (t === 'pilot' && !demo) continue;
    out[t] = tierJobs(script, t, demo).file;
  }
  return out;
}

function printReport(label: string, r: JobsReport): void {
  console.log(`${TAG} ${label}: заданий ${r.jobs}, записей ${r.units}, символов ${r.chars}; цена по SPEC ${fmtCredits(r.milli)} кр. (с запасом 10 % на переписывание ${fmtCredits(r.milliWithReserve)}); ≈ ${r.minutes} мин звука, ≈ ${r.mb} МБ`);
  for (const [k, v] of Object.entries(r.byRecipe)) console.log(`${TAG}   ${k}: ${v.jobs} заданий, ${v.units} записей, ${fmtCredits(v.milli)} кр.`);
}

function printCoverage(label: string, c: CoverageReport, prev: CoverageReport | null): void {
  const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;
  const gain = prev ? ` (+${((c.teacher.share - prev.teacher.share) * 100).toFixed(1)} п.)` : '';
  console.log(`${TAG} ${label}: партий ${c.games}, событий ${c.events}; «Учитель» без общей фразы ${pct(c.teacher.share)}${gain}, полностью ${pct(c.teacher.fullyShare)}; ходы «Учителя» озвучены ${pct(c.moves.voicedShare)}, по частям ${pct(c.moves.splitShare)} (все события: ${pct(c.movesAll.voicedShare)} / ${pct(c.movesAll.splitShare)})`);
  const l = c.liveliness;
  console.log(`${TAG}   живость: максимум одной записи за партию ${l.maxPlaysPerGame} (крики ${l.maxBarkPlaysPerGame}), разных/всех ${l.distinctRatio.toFixed(2)}, соседние фразы с общими записями ${l.neighbourShares.toFixed(2)}/партию, повтор в пределах 3 фраз ${l.repeatsWithin3.toFixed(2)}/партию`);
}

export async function cmdPlan(argv: string[]): Promise<void> {
  const args = parseCli(argv, {
    tier: { type: 'string' },
    script: { type: 'string' },
    demo: { type: 'string' },
    harvest: { type: 'string' },
    'no-write': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  const tier = parseTier(args.tier);
  const script = readScript(safe(args.script, DEFAULT_SCRIPT, '--script'));
  const seed = args.demo ?? script.demo;
  const demo = seed ? readDemo(seed) : null;
  const all = cumulativeJobs(script, tier, demo);
  const own = all[tier];
  if (!own) throw new UsageError('для пилота нужна демо-партия (voice:harvest)');
  parseJobsFile(own);
  const plan = tierJobs(script, tier, demo);
  printReport(`«${tier}»`, plan.report);
  if (tier === 'pilot' && plan.pilot) {
    const p = plan.pilot;
    console.log(`${TAG} пилот по демо-партии ${seed}: сверх основы вошли ${p.extras.length} дополнений (${p.extras.slice(0, 12).join(', ')}${p.extras.length > 12 ? ' …' : ''})`);
    if (p.missing.length > 0) console.log(`${TAG} НЕТ в каталоге (демо упадёт ниже L2): ${p.missing.join(', ')}`);
    const index = libraryFromJobs([own]);
    const d = demoCoverage(demo as DemoLike, index);
    console.log(`${TAG} демо-партия из пилотной библиотеки: ${d.ok} из ${d.events} фраз на уровнях L1–L2`);
    for (const f of d.failures.slice(0, 10)) console.log(`${TAG}   ${f.id} ${f.kind} L${f.level} «${f.heard}» — ${f.misses.join(', ')}`);
    const within = plan.report.milli <= PILOT_TARGET_CREDITS * 1000 && plan.report.milliWithReserve <= PILOT_HARD_CAP_CREDITS * 1000;
    console.log(`${TAG} ожидается ${fmtCredits(plan.report.milli)} кр. при цели ≤ ${PILOT_TARGET_CREDITS} и жёстком потолке ${PILOT_HARD_CAP_CREDITS}: ${within ? 'в пределах' : 'ПРЕВЫШЕНИЕ'}`);
    if (!within || d.failures.length > 0) process.exitCode = 1;
    if (args['no-write'] !== true) {
      const composed = composedDemo(demo as DemoLike, index);
      for (const r of p.references) {
        const whole = index.keys[r.key]?.[0];
        const ids = r.parts.map((k) => index.keys[k]?.[0]);
        if (!whole || ids.some((x) => !x)) continue;
        const headGap = /:$/u.test(script.units.find((u) => u.key === r.parts[0])?.text ?? '') ? ':' : '—';
        composed.lines.unshift(
          { name: `P1 целиком: ${r.text}`, blitz: false, items: [{ id: whole }] },
          { name: `P1 собрано: ${r.text}`, blitz: false, items: [{ id: ids[0] as string }, { gap: headGap }, { id: ids[1] as string }, { gap: '—' }, { id: ids[2] as string }] },
        );
      }
      writeJsonAtomic(COMPOSED_PILOT, composed);
      console.log(`${TAG} для страницы прослушивания: pnpm voice:review --composed ${displayPath(COMPOSED_PILOT)}`);
    }
  }
  // holdout coverage of the library up to this tier, and the gain over the tier below
  const harvestFile = args.harvest ? safe(args.harvest, args.harvest, '--harvest') : existsSync(path.join(HARVEST_DIR, `harvest.${VOICE_KEY}.jsonl.gz`)) ? path.join(HARVEST_DIR, `harvest.${VOICE_KEY}.jsonl.gz`) : DEFAULT_SAMPLE;
  if (existsSync(harvestFile)) {
    const h = readHarvest(harvestFile);
    const lib = libraryFromJobs(TIERS.map((t) => all[t]).filter((x): x is JobsFile => x !== null));
    const below = TIERS.slice(0, TIERS.indexOf(tier))
      .map((t) => all[t])
      .filter((x): x is JobsFile => x !== null);
    const cov = coverageOf(h, lib, { games: 'holdout' });
    const prev = below.length > 0 ? coverageOf(h, libraryFromJobs(below), { games: 'holdout' }) : null;
    printCoverage(`покрытие отложенных партий (${displayPath(harvestFile)}), библиотека до «${tier}» включительно`, cov, prev);
    if (tier !== 'pilot') for (const p of tierGateProblems(cov)) console.log(`${TAG}   не прошло: ${p}`);
  }
  if (args['no-write'] !== true) {
    writeLinesAtomic(jobsFileOf(tier), own, 'jobs');
    console.log(`${TAG} файл заданий: ${displayPath(jobsFileOf(tier))} — pnpm voice:cost --jobs ${displayPath(jobsFileOf(tier))}`);
  }
  console.log(`${TAG} (бесплатно: ничего не вызывалось и ничего не потрачено)`);
}

// ───────────────────────── coverage ─────────────────────────

export async function cmdCoverage(argv: string[]): Promise<void> {
  const args = parseCli(argv, {
    tier: { type: 'string' },
    manifest: { type: 'string' },
    script: { type: 'string' },
    harvest: { type: 'string' },
    games: { type: 'string' },
    demo: { type: 'string' },
    gate: { type: 'boolean' },
    library: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  let index;
  let label: string;
  let seed = args.demo ?? null;
  let failed = false;
  if (args.tier !== undefined) {
    const tier = parseTier(args.tier);
    const script = readScript(safe(args.script, DEFAULT_SCRIPT, '--script'));
    seed ??= script.demo;
    const all = cumulativeJobs(script, tier, seed ? readDemo(seed) : null);
    index = libraryFromJobs(TIERS.map((t) => all[t]).filter((x): x is JobsFile => x !== null));
    label = `библиотека, которую дадут задания до «${tier}»`;
  } else {
    const manifest = args.manifest ? readJson<Parameters<typeof libraryFromManifest>[0]>(safe(args.manifest, args.manifest, '--manifest')) : readCurrentManifest(safe(args.library, DEFAULT_LIBRARY, '--library'));
    if (!manifest) throw new UsageError('библиотеки ещё нет (apps/web/public/voice/index.json): укажите --tier, чтобы посчитать по заданиям');
    index = libraryFromManifest(manifest);
    label = `записанная библиотека (${Object.keys(manifest.units).length} записей)`;
    const scriptFile = safe(args.script, DEFAULT_SCRIPT, '--script');
    if (existsSync(scriptFile)) {
      const stale = staleTakes(manifest.units, readScript(scriptFile));
      if (stale.length > 0) {
        console.log(`${TAG} устарели (текст в каталоге с тех пор изменился — переписать): ${stale.slice(0, 12).map((id) => `${id} «${manifest.units[id]?.text ?? ''}»`).join(', ')}${stale.length > 12 ? ' …' : ''}`);
        index = withoutTakes(index, stale);
        failed = true;
      }
    }
    if (!seed && existsSync(DEFAULT_STATS)) seed = readJson<StatsFile>(DEFAULT_STATS).demo?.seed ?? null;
  }
  if (seed) {
    const d = demoCoverage(readDemo(seed), index);
    console.log(`${TAG} ${label}: демо-партия ${seed} — ${d.ok} из ${d.events} фраз на L1–L2`);
    for (const f of d.failures.slice(0, 15)) console.log(`${TAG}   ${f.id} ${f.kind} L${f.level} «${f.heard}» — ${f.misses.join(', ')}`);
    if (d.failures.length > 0) failed = true;
  }
  const harvestFile = args.harvest ? safe(args.harvest, args.harvest, '--harvest') : existsSync(DEFAULT_HARVEST) ? DEFAULT_HARVEST : DEFAULT_SAMPLE;
  if (existsSync(harvestFile)) {
    const games = args.games === 'all' ? 'all' : 'holdout';
    const c = coverageOf(readHarvest(harvestFile), index, { games });
    printCoverage(`${label}, партии ${games === 'all' ? 'все' : 'отложенные'} (${displayPath(harvestFile)})`, c, null);
    for (const [kind, k] of Object.entries(c.byKind)) console.log(`${TAG}   ${kind}: ${k.events} событий, озвучено ${k.voiced}, общей фразой ${k.generic}, с выпавшей фразой ${k.dropped}`);
    const problems = [...tierGateProblems(c), ...livelinessProblems(c.liveliness)];
    for (const p of problems) console.log(`${TAG}   не прошло: ${p}`);
    if (c.misses.length > 0) console.log(`${TAG} чего не хватает чаще всего: ${c.misses.slice(0, 15).map((m) => `${m.key} ×${m.count}`).join(', ')}`);
    if (problems.length > 0) failed = true;
  }
  if (args.gate === true && failed) process.exitCode = 1;
}

/** For the tests: the tiers' libraries straight from a script and a demo (no files written). */
export function tierLibrary(script: ScriptFile, tier: Tier, demo: DemoLike | null): ReturnType<typeof libraryFromJobs> {
  const all = cumulativeJobs(script, tier, demo);
  return libraryFromJobs(TIERS.map((t) => all[t]).filter((x): x is JobsFile => x !== null));
}
