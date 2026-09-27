/**
 * `pnpm teach:report` — the free, silent 50-game report of «Учитель» (docs/TEACHING.md §7).
 *
 *   pnpm teach:report [--games 50] [--workers 5] [--audit] [--transcripts] [--out docs/teaching/report] [--seed N]
 *   pnpm teach:report --analyse [--transcripts] [--out …]      (no games: the report of an existing games.jsonl.gz)
 *   pnpm teach:report --voice lazy|k<K>[c] [--voice-pricing pack|unit] [--daily-cap N] [--games-per-day N]
 *                     [--voice-shared] [--prefetch N --prefetch-from DIR] --out …          (the voice simulation)
 *   pnpm teach:report --prefetch-plan N --prefetch-from DIR --stage S --gender m|f --overlay DIR [--plan-out FILE]
 *                                                                   (the prefetch jobs file; free, no games)
 *
 * Plays the games with the real Stockfish 19 (Node child processes) through the lesson director, one child per worker
 * process, then writes under --out: games.jsonl.gz (every utterance), report.md + report.json, transcripts/<game>.md.
 * With --transcripts it also writes the sample transcripts to docs/teaching/transcripts/. Exit code 1 when a hard
 * gate fails. Never touches data/, reads no keys, opens no port, plays no sound, calls no network.
 *
 * «Дозапись голоса»: `--voice` also simulates the on-demand recording (./voice.ts; nothing is generated) and writes
 * voice.md + voice.json: the pack recipe's prices (`--voice-pricing unit` = each unit alone), a daily cap per child
 * (`--daily-cap N` credits, `--games-per-day N`, default 3), the share of sentences that name a piece (K8);
 * `--voice-shared` plays in rounds (game 1 of every child, then game 2, …) with one cache for all children, merged
 * between rounds; `--prefetch N --prefetch-from DIR` pre-records N credits per child before its first game, chosen from
 * the reference run DIR/games.jsonl.gz (play it with another --seed and the same --voice). Without `--voice` the games,
 * the log and the report are exactly the report's.
 *
 * `--prefetch-plan N` plays nothing: from the reference run DIR/games.jsonl.gz it writes the jobs file of the best units
 * per credit for one child (`--stage`, `--gender`), packed by the D5 recipe (campaign `prefetch`, take 101), leaving out
 * what the static library, the overlay and its ledger (`--overlay DIR`, required: a plan that ignored the server's
 * recordings would pay for them again) already hold. Recording it is a PAID step for the parent (the command is printed;
 * agents never run it); that run checks every unit again right before each create (tools/voice-clips/dedup.ts).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mergeClipIndexes, takesForUnit } from '../../packages/core/src/coach/clips/keys.ts';
import type { ClipIndexLayer } from '../../packages/core/src/coach/clips/keys.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { REPO_ROOT, UsageError, errorMessage, parseCli, parsePositiveInt } from '../lib/cli.ts';
import { DEFAULT_LIBRARY } from '../voice-clips/config.ts';
import { fmtCredits } from '../voice-clips/cost.ts';
import { isDiscard } from '../voice-clips/jobs.ts';
import { readCurrentManifest, writeJsonAtomic } from '../voice-clips/manifest.ts';
import { readOnDemandLedger } from '../voice-clips/ondemand.ts';
import { overlayPaths, resolveOverlayDir } from '../voice-clips/overlay.ts';
import { DEFAULT_GAMES, DEFAULT_OUT, DEFAULT_SEED, DEFAULT_VOICE_MONEY, MAX_WORKERS, TRANSCRIPTS_DIR, childPlans, parseVoiceMoney, parseVoiceSpec, voiceSpecName, workerChildren } from './config.ts';
import type { ChildPlan, RunLine, VoiceMoney, VoiceSpec } from './config.ts';
import { prefetchCost, prefetchJobsFile, prefetchPlan, voiceMarkdown, voiceReport } from './voice.ts';
import type { Covered, VoiceReport } from './voice.ts';
import { buildReport, gatesFailed, parseJsonLines, parseRun, reportMarkdown } from './report.ts';
import type { Report, Run } from './report.ts';
import { beforeAfterMarkdown, chooseBeforeAfter, chooseSampleGames, sampleIndexMarkdown, transcriptMarkdown } from './transcript.ts';

const HELP = `pnpm teach:report — the 50-game silent report of «Учитель» (free: local Stockfish, no server, no sound)

  --games N        games to play (default ${DEFAULT_GAMES} = 5 children × 10)
  --workers N      worker processes, one child each (default ${MAX_WORKERS}, max ${MAX_WORKERS})
  --audit          check quiz answers, praise and «лучше всего» with a deeper Stockfish (depth 18, MultiPV 5)
  --transcripts    also write the sample transcripts to ${TRANSCRIPTS_DIR}/
  --out DIR        output folder (default ${DEFAULT_OUT}; never inside data/)
  --seed N         run seed (default ${DEFAULT_SEED})
  --analyse        do not play: rebuild the report from DIR/games.jsonl.gz

«Дозапись голоса» — the voice simulation (free: nothing is generated, only counted; writes voice.md / voice.json):
  --voice P        lazy (the book's default policy, record on first use) | k<K> («recorded first», policy P(K)); suffix c:
                   grow cheaply (no piece placeholder, short first)
  --voice-pricing  pack (default: the server's recipe, one request per utterance) | unit (each unit alone)
  --daily-cap N    credits per child per day (a job that does not fit pauses recording until the next day)
  --games-per-day N  games a child plays per day (default ${DEFAULT_VOICE_MONEY.gamesPerDay})
  --voice-shared   one cache for all children (rounds: game 1 of every child, then game 2, …)
  --prefetch N     pre-record N credits per child before its first game …
  --prefetch-from DIR  … chosen from the reference run DIR/games.jsonl.gz (another --seed, the same --voice)

The prefetch jobs file (free; plays nothing):
  --prefetch-plan N --prefetch-from DIR --stage S --gender m|f --overlay DIR [--plan-out FILE]
`;

/** A folder given on the command line, resolved against the repository root; refused inside data/. */
export function safeOutDir(value: string): string {
  const abs = path.resolve(REPO_ROOT, value);
  const rel = path.relative(path.join(REPO_ROOT, 'data'), abs);
  if (!(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) throw new UsageError(`--out ${value} is inside data/ — the child's real data is never touched`);
  return abs;
}

function log(line: string): void {
  process.stdout.write(`[teach] ${line}\n`);
}

interface VoiceOpts {
  spec: VoiceSpec;
  shared: boolean;
  money: VoiceMoney;
  /** unit keys to pre-record per child ("1".."5") */
  seedUnits: Record<string, string[]> | null;
}

function spawnWorker(args: string[], w: number, onDone: () => void): Promise<void> {
  const workerJs = fileURLToPath(new URL('./worker.ts', import.meta.url));
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [workerJs, ...args], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith('done ')) onDone();
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${w} exited with ${code}: ${err.trim().split('\n').slice(-5).join(' | ')}`))));
  });
}

async function play(opts: { games: number; workers: number; seed: number; audit: boolean; out: string; voice: VoiceOpts | null }): Promise<RunLine[]> {
  const plans = childPlans(opts.games);
  const groups = workerChildren(plans, opts.workers);
  const work = mkdtempSync(path.join(opts.out, '.work-'));
  const total = plans.reduce((n, p) => n + p.games, 0);
  let done = 0;
  const t0 = Date.now();
  const tick = (): void => {
    done++;
    log(`${done}/${total} (${Math.round((Date.now() - t0) / 1000)} s)`);
  };
  const voice = opts.voice;
  log(`${total} games, ${groups.length} workers, seed ${opts.seed}${opts.audit ? ', audit on' : ''}${voice ? `, voice ${voiceSpecName(voice.spec)}${voice.shared ? ' (shared cache)' : ''}${voice.seedUnits ? ' + prefetch' : ''}` : ''}`);
  const common = (): string[] => [
    '--seed',
    String(opts.seed),
    ...(opts.audit ? ['--audit'] : []),
    ...(voice ? ['--voice', voiceSpecName(voice.spec), '--voice-pricing', voice.money.pricing, '--games-per-day', String(voice.money.gamesPerDay)] : []),
    ...(voice && voice.money.dailyCapMilli !== null ? ['--daily-cap', String(voice.money.dailyCapMilli / 1000)] : []),
    ...(voice?.seedUnits ? ['--voice-seed', seedFile] : []),
  ];
  const seedFile = path.join(work, 'voice-seed.json');
  if (voice?.seedUnits) writeFileSync(seedFile, JSON.stringify(voice.seedUnits));
  try {
    const files: string[] = [];
    if (voice?.shared) {
      // rounds: game r of every child, then one cache for all (the union of what every child heard)
      const stateDir = path.join(work, 'state');
      const rounds = Math.max(...plans.map((p) => p.games));
      for (let r = 1; r <= rounds; r++) {
        const now: ChildPlan[][] = groups.map((g) => g.filter((p) => p.games >= r)).filter((g) => g.length > 0);
        await Promise.all(
          now.map((group, w) => {
            const file = path.join(work, `r${r}w${w}.jsonl`);
            files.push(file);
            return spawnWorker(['--out', file, '--children', group.map((p) => `${p.child}:1`).join(','), '--first', String(r), '--state-dir', stateDir, ...common()], w, tick);
          }),
        );
        const states = readdirSync(stateDir).filter((f) => /^c\d+\.json$/.test(f));
        const union = new Set<string>();
        for (const f of states) for (const k of (JSON.parse(readFileSync(path.join(stateDir, f), 'utf8')) as { voiced?: string[] }).voiced ?? []) union.add(k);
        for (const f of states) {
          const o = JSON.parse(readFileSync(path.join(stateDir, f), 'utf8')) as Record<string, unknown>;
          writeFileSync(path.join(stateDir, f), JSON.stringify({ ...o, voiced: [...union].sort() }));
        }
        log(`round ${r}: shared cache ${union.size} units`);
      }
    } else {
      await Promise.all(
        groups.map((group, w) => {
          const file = path.join(work, `w${w}.jsonl`);
          files.push(file);
          return spawnWorker(['--out', file, '--children', group.map((p) => `${p.child}:${p.games}`).join(','), ...common()], w, tick);
        }),
      );
    }
    const lines: RunLine[] = [];
    for (const f of files) lines.push(...parseJsonLines(readFileSync(f, 'utf8')));
    return lines;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Games first by child then game number, each game's events before its game line (a stable file for diffs). */
export function orderLines(lines: readonly RunLine[]): RunLine[] {
  const run = parseRun(lines);
  const out: RunLine[] = [];
  for (const g of run.games) {
    out.push(...(run.events.get(g.game) ?? []));
    out.push(g);
  }
  out.push(...run.errors);
  return out;
}

function writeTranscripts(run: Run, dir: string): number {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (/^c\d+g\d+\.md$/.test(f)) rmSync(path.join(dir, f));
  for (const g of run.games) writeFileSync(path.join(dir, `${g.game}.md`), transcriptMarkdown(g, run.events.get(g.game) ?? []));
  return run.games.length;
}

function writeSamples(run: Run, seed: number): string[] {
  const dir = path.join(REPO_ROOT, TRANSCRIPTS_DIR);
  mkdirSync(dir, { recursive: true });
  const picks = chooseSampleGames(run);
  const written: string[] = [];
  for (const p of picks) {
    writeFileSync(path.join(dir, p.file), transcriptMarkdown(p.game, run.events.get(p.game.game) ?? [], { title: p.title, note: p.note }));
    written.push(p.file);
  }
  writeFileSync(path.join(dir, 'before-after.md'), beforeAfterMarkdown(chooseBeforeAfter(picks, run), picks));
  writeFileSync(path.join(dir, 'README.md'), sampleIndexMarkdown(picks, { seed, games: run.games.length }));
  written.push('before-after.md', 'README.md');
  return written;
}

function summary(r: Report): void {
  const t = r.totals;
  log(`${r.games} games: ${Object.entries(t.results).map(([k, n]) => `${k} ${n}`).join(', ')}; ${t.utterances} utterances (${t.utterancesPerGame.toFixed(1)}/game), ${t.wordsPerGame.toFixed(0)} words/game`);
  for (const g of r.gates) log(`${g.pass ? 'ok  ' : g.hard ? 'FAIL' : 'warn'} ${g.id}: ${g.value} (${g.limit})`);
}

/** Reads a reference run (DIR/games.jsonl.gz). */
function readRefRun(dir: string, flag: string): Run {
  const refFile = path.join(safeOutDir(dir), 'games.jsonl.gz');
  if (!existsSync(refFile)) throw new UsageError(`${flag}: ${refFile} does not exist`);
  return parseRun(parseJsonLines(gunzipSync(readFileSync(refFile)).toString('utf8')));
}

/** The simulated server's money rules from the CLI (voice simulation only). */
function voiceMoneyOf(v: { 'voice-pricing'?: string | undefined; 'daily-cap'?: string | undefined; 'games-per-day'?: string | undefined }): VoiceMoney {
  try {
    return parseVoiceMoney({ pricing: v['voice-pricing'], dailyCap: v['daily-cap'], gamesPerDay: v['games-per-day'] });
  } catch (e) {
    throw new UsageError(errorMessage(e));
  }
}

/** The voice simulation options: the policy, the money rules, the shared cache, the prefetch plan per child. */
function voiceOpts(
  v: {
    voice?: string | undefined;
    'voice-shared'?: boolean | undefined;
    prefetch?: string | undefined;
    'prefetch-from'?: string | undefined;
    'voice-pricing'?: string | undefined;
    'daily-cap'?: string | undefined;
    'games-per-day'?: string | undefined;
  },
  games: number,
): { opts: VoiceOpts; prefetch: VoiceReport['prefetch'] } | null {
  if (v.voice === undefined) {
    if (v['voice-shared'] || v.prefetch !== undefined || v['voice-pricing'] !== undefined || v['daily-cap'] !== undefined || v['games-per-day'] !== undefined) {
      throw new UsageError('--voice-shared / --prefetch / --voice-pricing / --daily-cap / --games-per-day need --voice');
    }
    return null;
  }
  const spec = parseVoiceSpec(v.voice);
  if (!spec) throw new UsageError(`--voice expects lazy or k<K>[c], got "${v.voice}"`);
  const money = voiceMoneyOf(v);
  // a daily cap belongs to one child's Mac: the shared cache of all children has no such day
  if (money.dailyCapMilli !== null && v['voice-shared']) throw new UsageError('--daily-cap is per child: it cannot be combined with --voice-shared');
  let seedUnits: Record<string, string[]> | null = null;
  let prefetch: VoiceReport['prefetch'] = null;
  if (v.prefetch !== undefined) {
    const budget = Number(v.prefetch);
    if (!Number.isFinite(budget) || budget <= 0) throw new UsageError(`--prefetch expects credits > 0, got "${v.prefetch}"`);
    if (!v['prefetch-from']) throw new UsageError('--prefetch needs --prefetch-from DIR (a reference run with another --seed)');
    const ref = readRefRun(v['prefetch-from'], '--prefetch-from');
    seedUnits = {};
    prefetch = { budget, perChild: {} };
    for (const p of childPlans(games)) {
      const plan = prefetchPlan(ref, { stage: p.stage, g: p.address, budget });
      seedUnits[String(p.child)] = plan.map((u) => u.key);
      prefetch.perChild[String(p.child)] = { units: plan.length, credits: prefetchCost(plan).milli / 1000 };
    }
  }
  return { opts: { spec, shared: v['voice-shared'] === true, money, seedUnits }, prefetch };
}

/**
 * What is already recorded or on its way — never bought again: takes of the static library (and the overlay's) whose
 * text is exactly the unit's, the overlay's blocked keys, and every unit of an overlay job that did not fail.
 */
function coveredBy(libraries: readonly string[], overlay: string | null): { covered: Covered; note: string[] } {
  const layers: ClipIndexLayer[] = [];
  const note: string[] = [];
  for (const root of [...libraries, ...(overlay ? [overlayPaths(overlay).libraryRoot] : [])]) {
    const m = readCurrentManifest(root);
    if (m) layers.push(m);
    note.push(`${path.relative(REPO_ROOT, root) || root}: ${m ? `${Object.keys(m.units).length} записей` : 'нет библиотеки'}`);
  }
  const index = layers.reduce<ReturnType<typeof mergeClipIndexes> | null>((acc, l) => mergeClipIndexes(acc, l), null) ?? mergeClipIndexes(null, null);
  const inFlight = new Set<string>();
  if (overlay) {
    const view = readOnDemandLedger(overlayPaths(overlay).ledgerFile);
    for (const job of view.ledger.jobs.values()) if (job.state !== 'failed') for (const p of job.job.pieces) if (!isDiscard(p)) inFlight.add(p.key);
    for (const i of view.unresolved) for (const p of i.job.pieces) if (!isDiscard(p)) inFlight.add(p.key);
    note.push(`журнал оверлея: ${inFlight.size} единиц в заданиях`);
  }
  return { covered: (key, text) => inFlight.has(key) || index.blocked.has(key) || takesForUnit(index, key, text).length > 0, note };
}

/** `--prefetch-plan N`: the prefetch jobs file for one child, from a reference run (free; plays nothing). */
function prefetchPlanMain(v: {
  'prefetch-plan'?: string | undefined;
  'prefetch-from'?: string | undefined;
  stage?: string | undefined;
  gender?: string | undefined;
  'plan-out'?: string | undefined;
  overlay?: string | undefined;
}): number {
  const budget = Number(v['prefetch-plan']);
  if (!Number.isFinite(budget) || budget <= 0) throw new UsageError(`--prefetch-plan expects credits > 0, got "${v['prefetch-plan']}"`);
  if (!v['prefetch-from']) throw new UsageError('--prefetch-plan needs --prefetch-from DIR (a reference run: pnpm teach:report --voice k3c --seed 7 --out DIR)');
  const stage = parsePositiveInt(v.stage, '--stage');
  if (stage === undefined || stage > 5) throw new UsageError('--prefetch-plan needs --stage 1..5 (the child\'s stage)');
  const g = v.gender;
  if (g !== 'm' && g !== 'f') throw new UsageError('--prefetch-plan needs --gender m|f (how Гамбитик addresses the child)');
  // the overlay is required: its ledger and manifest say what the server recorded on demand (a plan without them
  // would buy those phrases again); `off` is refused too
  if (v.overlay === undefined) throw new UsageError('--prefetch-plan needs --overlay DIR (the recorded overlay: what the server already recorded is left out)');
  const overlay = resolveOverlayDir(v.overlay);
  if (overlay === null) throw new UsageError('--prefetch-plan needs --overlay DIR, not off (the prefetch is recorded into it)');
  const ref = readRefRun(v['prefetch-from'], '--prefetch-from');
  const { covered, note } = coveredBy([DEFAULT_LIBRARY], overlay);
  const plan = prefetchPlan(ref, { stage, g, budget, covered });
  const cost = prefetchCost(plan);
  const file = prefetchJobsFile(plan, { stage, g });
  const out = safeOutDir(v['plan-out'] ?? path.join('test-results', 'voice-prefetch', `prefetch.s${stage}${g}.jobs.json`));
  writeJsonAtomic(out, file);
  const ov = overlay;
  log(`уже записано или в работе: ${note.join('; ')}`);
  log(`план заранее для ступени ${stage} (${g === 'f' ? 'девочка' : 'мальчик'}): ${plan.length} единиц в ${cost.jobs} заданиях, ${fmtCredits(cost.milli)} кр. по цене SPEC (по одному заданию на единицу было бы ${fmtCredits(cost.unpackedMilli)})`);
  log(`файл заданий: ${path.relative(REPO_ROOT, out)} (бесплатно: ничего не вызывалось)`);
  log('записать — ПЛАТНО, только сам владелец или агент с его «да» в чате:');
  log(`  pnpm voice:cost --jobs ${path.relative(REPO_ROOT, out)} --overlay ${ov}`);
  log(`  pnpm voice:generate --jobs ${path.relative(REPO_ROOT, out)} --overlay ${ov} --budget ${fmtCredits(cost.milli)} --spend`);
  log(`  pnpm voice:process --overlay ${ov} && pnpm voice:verify --overlay ${ov} && pnpm voice:review --overlay ${ov}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const v = parseCli(argv, {
    games: { type: 'string' },
    workers: { type: 'string' },
    audit: { type: 'boolean' },
    transcripts: { type: 'boolean' },
    out: { type: 'string' },
    seed: { type: 'string' },
    analyse: { type: 'boolean' },
    voice: { type: 'string' },
    'voice-shared': { type: 'boolean' },
    'voice-pricing': { type: 'string' },
    'daily-cap': { type: 'string' },
    'games-per-day': { type: 'string' },
    prefetch: { type: 'string' },
    'prefetch-from': { type: 'string' },
    'prefetch-plan': { type: 'string' },
    stage: { type: 'string' },
    gender: { type: 'string' },
    'plan-out': { type: 'string' },
    overlay: { type: 'string' },
    help: { type: 'boolean' },
  });
  if (v.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (v['prefetch-plan'] !== undefined) return prefetchPlanMain(v);
  if (v.stage !== undefined || v.gender !== undefined || v['plan-out'] !== undefined || v.overlay !== undefined) throw new UsageError('--stage / --gender / --plan-out / --overlay belong to --prefetch-plan');
  const games = parsePositiveInt(v.games, '--games') ?? DEFAULT_GAMES;
  const workers = Math.min(MAX_WORKERS, parsePositiveInt(v.workers, '--workers') ?? MAX_WORKERS);
  const seed = v.seed !== undefined ? Number(v.seed) >>> 0 : DEFAULT_SEED;
  if (v.seed !== undefined && !Number.isFinite(Number(v.seed))) throw new UsageError(`--seed expects a number, got "${v.seed}"`);
  const out = safeOutDir(v.out ?? DEFAULT_OUT);
  mkdirSync(out, { recursive: true });
  const runFile = path.join(out, 'games.jsonl.gz');
  const voice = voiceOpts(v, games);
  if (voice) {
    const setup = { spec: voiceSpecName(voice.opts.spec), shared: voice.opts.shared, money: voice.opts.money, prefetch: voice.prefetch, seedUnits: voice.opts.seedUnits };
    writeFileSync(path.join(out, 'voice-setup.json'), `${JSON.stringify(setup, null, 1)}\n`);
  }
  if (!v.analyse) {
    const lines = orderLines(await play({ games, workers, seed, audit: v.audit === true, out, voice: voice?.opts ?? null }));
    writeFileSync(runFile, gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')));
    log(`wrote ${path.relative(REPO_ROOT, runFile)}`);
  } else if (!existsSync(runFile)) throw new UsageError(`--analyse: ${runFile} does not exist`);
  const run = parseRun(parseJsonLines(gunzipSync(readFileSync(runFile)).toString('utf8')));
  const report = buildReport(run);
  const args = `pnpm teach:report ${argv.join(' ')}`.trim();
  writeFileSync(path.join(out, 'report.md'), reportMarkdown(report, { seed, args }));
  writeFileSync(path.join(out, 'report.json'), `${JSON.stringify({ seed, args, ...report }, null, 1)}\n`);
  const n = writeTranscripts(run, path.join(out, 'transcripts'));
  log(`wrote report.md, report.json and ${n} transcripts in ${path.relative(REPO_ROOT, out) || '.'}`);
  if (voice) {
    const vr = voiceReport(run, { policy: voiceSpecName(voice.opts.spec), shared: voice.opts.shared, money: voice.opts.money, prefetch: voice.prefetch, ...(voice.opts.seedUnits ? { seedUnits: voice.opts.seedUnits } : {}) });
    writeFileSync(path.join(out, 'voice.md'), voiceMarkdown(vr));
    writeFileSync(path.join(out, 'voice.json'), `${JSON.stringify(vr, null, 1)}\n`);
    log(
      `voice ${vr.policy}${vr.shared ? ' shared' : ''} (${vr.money.pricing}${vr.money.dailyCapMilli !== null ? `, cap ${vr.money.dailyCapMilli / 1000}/day, ${vr.money.gamesPerDay} games/day` : ''}): ${vr.totals.newUnits} units in ${vr.totals.jobs} jobs, ${vr.totals.newCredits} cr on demand (+${vr.totals.prefetchCredits} prefetch), ${vr.totals.perChildMean} cr per child; sentences voiced ${vr.totals.sentencesPct.toFixed(1)} %, naming a piece ${vr.totals.piecePct.toFixed(1)} %`,
    );
  }
  if (v.transcripts) log(`sample transcripts: ${writeSamples(run, seed).map((f) => path.join(TRANSCRIPTS_DIR, f)).join(', ')}`);
  summary(report);
  const failed = gatesFailed(report);
  if (failed.length > 0) log(`${failed.length} gate(s) failed: ${failed.map((g) => g.id).join(', ')}`);
  return failed.length > 0 ? 1 : 0;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`teach:report: ${errorMessage(e)}\n${e instanceof UsageError ? HELP : ''}`);
      process.exit(e instanceof UsageError ? 2 : 1);
    },
  );
}
