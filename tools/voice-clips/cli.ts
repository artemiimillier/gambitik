/**
 * node tools/voice-clips/cli.ts <command> [flags]      (pnpm voice:<command> from the repository root)
 *
 *   cost      --jobs <file>                                  free: what a jobs file would cost, what the ledger already has
 *   generate  --jobs <file> --budget N --spend [--max-jobs N] [--accept-audit] [--campaign C] [--overlay DIR|off]
 *             [--resume-server-jobs]
 *                                                            PAID — only with the parent's explicit OK
 *   process   [--force] [--job <id>…] [--qa static|overlay]  free: masters → library MP3s + manifest
 *   verify    [--no-asr] [--reasr] [--unit <id>…] [--qa …]   free: gates + whisper.cpp check
 *   review    [--composed <file>]                            free: test-results/voice-review/index.html
 *   ledger                                                   free: what the ledger says per campaign
 *   whisper   [--check]                                      free: is ASR ready (and does the model checksum match)
 *   harvest   --clip --games N [--from N] [--blitz]          free: engine games with the builders in clip mode, the demo game
 *   script    [--demo <seed>]                                free: catalogue + harvest ⇒ units with tier / recipe / lint
 *   plan      --tier pilot|starter|full [--no-write]         free: the exact jobs of a tier, their price and coverage
 *   coverage  [--tier T | --manifest file] [--gate]          free: demo L1–L2, «Учитель» coverage, liveliness (./cliCatalog.ts)
 *   demo-game [--demo <seed>] [--out file.mp3] [--planned]   free: the demo game as one listening MP3 + transcript (./demoGame.ts)
 *
 * Common paths can be overridden (--ledger, --masters, --units, --review-file, --library, --work, --report, --out,
 * --model); none may point into the child's data/ folder. Tools never play audio.
 *
 * «Дозапись голоса»: `--overlay <dir>` works on the recorded overlay (./overlay.ts: the folder outside every checkout):
 * its ledger, masters, unit store, verdicts and library become the path defaults, `process` / `verify` publish with the
 * overlay's rule (`--qa overlay`), and `generate` records into it (the parent's prefetch, intent lines). Every `generate`
 * also holds the machine-wide lock of the overlay folder (`--overlay`, else VOICE_OVERLAY_DIR from the environment or
 * from this checkout's `.env` — the server's own line, read alone —, else the default
 * ~/Library/Application Support/Gambitik/voice-overlay; `--overlay off` = none) and refuses while the server has a job
 * in flight there (`--resume-server-jobs`: brings those jobs home first, free). A run into the overlay skips every job
 * with a unit that is already recorded or in a job since its plan was made (dedup by unit, ./dedup.ts). `process` / `verify --overlay` hold the overlay's publish lock (they wait while the server publishes).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, displayPath, errorMessage, parseCli, parsePositiveInt, UsageError } from '../lib/cli.ts';
import { safeLocalPath, SmokeGuardError } from '../voice-smoke/guard.ts';
import {
  DEFAULT_LEDGER,
  DEFAULT_LIBRARY,
  GLOBAL_LOCK_WAIT_MS,
  DEFAULT_MASTERS,
  DEFAULT_REPORT,
  DEFAULT_REVIEW,
  DEFAULT_REVIEW_PAGE_DIR,
  DEFAULT_UNITS,
  DEFAULT_WHISPER_MODEL,
  DEFAULT_WORK,
  PUBLISH_LOCK_WAIT_MS,
  WHISPER_BIN,
  WHISPER_MODEL,
} from './config.ts';
import { checkWhisperModel, whisperProblem } from './asr.ts';
import { ffmpegAvailable } from './audio.ts';
import { codePoints, fmtCredits, jobMilli } from './cost.ts';
import { coverageSnapshots, coveredWhy, generateCoverage, twinKeysOf } from './dedup.ts';
import { SPEND_RULE, SpendRefused, downloadMaster, runGenerate, todoJobs } from './generate.ts';
import { realRunCli } from './higgsfield.ts';
import { isDiscard, JobsFileError, parseJobsFile, readJobsFile } from './jobs.ts';
import { LedgerLocked, spentMilli } from './ledger.ts';
import { ONDEMAND_TAKE_BASE, localDay, readOnDemandLedger, spentByDay, unitAttempts } from './ondemand.ts';
import { lockPublish, overlayPaths, resolveOverlayDir } from './overlay.ts';
import type { QaRule } from './overlay.ts';
import { runProcess } from './process.ts';
import { runReview } from './review.ts';
import { runVerify } from './verify.ts';
import { cmdCoverage, cmdHarvest, cmdPlan, cmdScript, DEFAULT_SCRIPT, jobsFileOf, readDemo, readScript } from './cliCatalog.ts';
import { libraryFromJobs, libraryFromManifest, staleTakes, withoutTakes } from './coverage.ts';
import { DEFAULT_DEMO_GAME_OUT, demoGameScript, levelRu, writeDemoGame, writePlannedTranscript } from './demoGame.ts';
import type { DemoGameFile } from './demoGame.ts';
import { readCurrentManifest, readStore } from './manifest.ts';
import { LIBRARY_MAX_BUDGET, libraryJobsFile, libraryUnits, planLibrary, readUsage, weighUnits } from './library.ts';
import { childFinish, runLibrary, stopFileOf, stopRequested } from './libraryRun.ts';

const TAG = '[voice]';
const HELP = `Usage: node tools/voice-clips/cli.ts <cost|generate|process|verify|review|ledger|whisper|harvest|script|plan|coverage|demo-game|library-plan|library-run> [flags]
  library-plan [--overlay DIR] [--ref DIR] [--out DIR]    free: the whole library minus what is recorded, packed (./library.ts)
  library-run  --budget N --spend [--dry-run] [--portion N] [--in-flight N] [--max-jobs N] [--accept-audit] [--overlay DIR] [--ref DIR] [--out DIR]
               PAID — records the plan portion by portion into the overlay, checks and publishes it (./libraryRun.ts)
  generate is PAID: it needs --spend and --budget N. ${SPEND_RULE}
  --overlay <dir>  work on the recorded overlay («Дозапись голоса»): its ledger / masters / units / library, the overlay QA rule
  generate --overlay off  no machine-wide lock (the server's recorder may run at the same time)
  generate --resume-server-jobs  the server's jobs still in flight in the overlay are waited for and downloaded first (free)`;

const COMMON = {
  ledger: { type: 'string' },
  masters: { type: 'string' },
  units: { type: 'string' },
  'review-file': { type: 'string' },
  library: { type: 'string' },
  work: { type: 'string' },
  overlay: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

function safe(value: string | undefined, fallback: string, flag: string): string {
  return safeLocalPath(REPO_ROOT, value ?? fallback, flag);
}

type PathArgs = { ledger?: string; masters?: string; units?: string; 'review-file'?: string; library?: string; work?: string; overlay?: string };

/** The overlay a command works on: only an explicit `--overlay <dir>` (the free commands never pick the default). */
function explicitOverlay(args: PathArgs): string | null {
  return args.overlay === undefined ? null : resolveOverlayDir(args.overlay);
}

function paths(args: PathArgs) {
  const ov = explicitOverlay(args);
  const d = ov === null ? null : overlayPaths(ov);
  return {
    ledgerFile: safe(args.ledger, d?.ledgerFile ?? DEFAULT_LEDGER, '--ledger'),
    mastersDir: safe(args.masters, d?.mastersDir ?? DEFAULT_MASTERS, '--masters'),
    storeFile: safe(args.units, d?.storeFile ?? DEFAULT_UNITS, '--units'),
    reviewFile: safe(args['review-file'], d?.reviewFile ?? DEFAULT_REVIEW, '--review-file'),
    libraryRoot: safe(args.library, d?.libraryRoot ?? DEFAULT_LIBRARY, '--library'),
    work: safe(args.work, DEFAULT_WORK, '--work'),
    reportFile: d?.reportFile ?? null,
    verifyReportFile: d?.verifyReportFile ?? null,
    overlay: ov,
  };
}

/** `--qa static|overlay` (default: overlay with `--overlay <dir>`, else static). */
function qaRule(value: string | undefined, overlay: string | null): QaRule {
  if (value === undefined) return overlay === null ? 'static' : 'overlay';
  if (value !== 'static' && value !== 'overlay') throw new UsageError(`--qa expects static or overlay, got "${value}"`);
  return value;
}

function parseBudget(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--budget expects a positive number of credits, got "${value}"`);
  return n;
}

async function cmdCost(argv: string[]): Promise<void> {
  const args = parseCli(argv, { ...COMMON, jobs: { type: 'string' } });
  if (args.jobs === undefined) throw new UsageError('нужен --jobs <файл заданий>');
  const p = paths(args);
  const file = readJobsFile(safe(args.jobs, args.jobs, '--jobs'));
  const onDemand = readOnDemandLedger(p.ledgerFile);
  const view = onDemand.ledger;
  const todo = todoJobs(file, view, new Set(onDemand.unresolved.map((i) => i.key)));
  const chars = file.jobs.reduce((n, j) => n + codePoints(j.prompt), 0);
  const all = file.jobs.reduce((n, j) => n + jobMilli(j.prompt), 0);
  const left = todo.reduce((n, j) => n + jobMilli(j.prompt), 0);
  const units = file.jobs.reduce((n, j) => n + j.pieces.filter((pc) => !isDiscard(pc)).length, 0);
  console.log(`${TAG} кампания «${file.campaign}»: ${file.jobs.length} заданий, ${units} записей, ${chars} символов, ${fmtCredits(all)} кр. по цене SPEC`);
  console.log(`${TAG} уже в журнале: ${fmtCredits(spentMilli(view, file.campaign))} кр.; осталось сделать ${todo.length} заданий на ${fmtCredits(left)} кр.`);
  console.log(`${TAG} (бесплатно: ничего не вызывалось)`);
}

async function cmdGenerate(argv: string[]): Promise<void> {
  const args = parseCli(argv, {
    ...COMMON,
    jobs: { type: 'string' },
    budget: { type: 'string' },
    spend: { type: 'boolean' },
    'max-jobs': { type: 'string' },
    'accept-audit': { type: 'boolean' },
    campaign: { type: 'string' },
    'resume-server-jobs': { type: 'boolean' },
  });
  // Refuse before reading anything else: without both flags nothing happens at all.
  if (args.spend !== true || args.budget === undefined) throw new SpendRefused(`нужны оба флага: --spend и --budget N. ${SPEND_RULE}`);
  if (args.jobs === undefined) throw new UsageError('нужен --jobs <файл заданий>');
  // the machine-wide lock and the server's jobs live in the overlay folder: the explicit one, else VOICE_OVERLAY_DIR,
  // else the default (never under vitest); an explicit `--overlay <dir>` also records INTO it (the parent's prefetch)
  const machineOverlay = resolveOverlayDir(args.overlay);
  const p = paths(args);
  // a run into the overlay ledger keeps its masters in the overlay too, never in this checkout
  const intoOverlay = machineOverlay !== null && path.resolve(p.ledgerFile) === path.resolve(overlayPaths(machineOverlay).ledgerFile);
  const mastersDir = args.masters === undefined && intoOverlay ? overlayPaths(machineOverlay).mastersDir : p.mastersDir;
  const maxJobs = args['max-jobs'] === '0' ? 0 : parsePositiveInt(args['max-jobs'], '--max-jobs');
  const file = readJobsFile(safe(args.jobs, args.jobs, '--jobs'));
  const jobs = args.campaign === undefined ? file : parseJobsFile({ ...file, campaign: args.campaign });
  console.log(`${TAG} ${SPEND_RULE}`);
  if (machineOverlay === null) console.log(`${TAG} общий замок выключен (--overlay off / VOICE_OVERLAY_DIR=off): сервер «Дозаписи голоса» может записывать одновременно`);
  else console.log(`${TAG} общий замок и задания сервера: ${displayPath(machineOverlay)}${intoOverlay ? ` — запись в оверлей (кампания «${jobs.campaign}»)` : ''}`);
  const summary = await runGenerate(
    {
      spend: true,
      budget: parseBudget(args.budget),
      jobs,
      ...(maxJobs !== undefined ? { maxJobs } : {}),
      ...(args['accept-audit'] === true ? { acceptAudit: true } : {}),
      ledgerFile: p.ledgerFile,
      mastersDir,
      overlayDir: machineOverlay,
      lockWaitMs: GLOBAL_LOCK_WAIT_MS,
      // by unit, whichever ledger it writes: the server records catalogue sentences under the static library's keys too
      ...generateCoverage({ overlayDir: machineOverlay, intoOverlay, staticLibrary: DEFAULT_LIBRARY, toolsLedger: DEFAULT_LEDGER }),
      ...(args['resume-server-jobs'] === true ? { resumeServerJobs: true } : {}),
    },
    {
      runCli: realRunCli,
      download: downloadMaster,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
      now: () => new Date(),
      log: (line) => console.log(`${TAG} ${line}`),
    },
  );
  console.log(`${TAG} кампания «${summary.campaign}»: создано ${summary.created}, взято готовых ${summary.adopted}, продолжено ${summary.resumed}; списано ${summary.charged}, неудачных ${summary.failed}, скачано ${summary.downloaded}`);
  if (summary.skipped > 0) console.log(`${TAG} пропущено заданий: ${summary.skipped} — часть их фраз уже записана или в работе; соберите план заново`);
  console.log(`${TAG} потрачено по журналу ${fmtCredits(summary.spentMilli)} из ${fmtCredits(summary.budgetMilli)} кр.; баланс ${fmtCredits(summary.balanceBeforeMilli)} → ${summary.balanceAfterMilli === null ? '?' : fmtCredits(summary.balanceAfterMilli)}`);
  console.log(`${TAG} остановка: ${summary.stop}; осталось заданий: ${summary.todoLeft}; журнал: ${displayPath(p.ledgerFile)}`);
  if (summary.audit) {
    const a = summary.audit;
    console.log(`${TAG} сверка баланса: списано ${fmtCredits(a.deltaMilli ?? 0)} кр., по журналу ${fmtCredits(a.minMilli ?? 0)}–${fmtCredits(a.maxMilli ?? 0)} — ${a.ok ? 'сходится' : 'НЕ СХОДИТСЯ: следующие запуски остановлены до --accept-audit'}`);
  }
  if ((summary.stop !== 'done' && summary.stop !== 'budget' && summary.stop !== 'max-jobs') || summary.audit?.ok === false) process.exitCode = 1;
}

async function requireFfmpeg(): Promise<void> {
  if (!(await ffmpegAvailable())) throw new Error('нужен ffmpeg с libmp3lame, loudnorm и atempo (brew install ffmpeg)');
}

/**
 * Runs `work` under the overlay's publish lock (`--overlay`): the server's finish rewrites the same unit store and
 * manifest, so the parent's command waits for it (the server's own `process` / `verify` children find the lock held by
 * their parent and go on). Without an overlay nothing is shared: no lock.
 */
async function withPublishLock<T>(overlay: string | null, work: () => Promise<T>): Promise<T> {
  if (overlay === null) return work();
  const release = await lockPublish(overlay, { waitMs: PUBLISH_LOCK_WAIT_MS, onWait: () => console.log(`${TAG} сервер публикует новые фразы — жду, пока он закончит…`) });
  try {
    return await work();
  } finally {
    release();
  }
}

async function cmdProcess(argv: string[]): Promise<void> {
  const args = parseCli(argv, { ...COMMON, force: { type: 'boolean' }, job: { type: 'string', multiple: true }, report: { type: 'string' }, qa: { type: 'string' } });
  const p = paths(args);
  const qa = qaRule(args.qa, p.overlay);
  await requireFfmpeg();
  const reportFile = safe(args.report, p.reportFile ?? DEFAULT_REPORT, '--report');
  const report = await withPublishLock(p.overlay, () => runProcess({
    ledgerFile: p.ledgerFile,
    mastersDir: p.mastersDir,
    storeFile: p.storeFile,
    reviewFile: p.reviewFile,
    libraryRoot: p.libraryRoot,
    work: p.work,
    reportFile,
    qa,
    ...(args.force === true ? { force: true } : {}),
    ...(args.job !== undefined ? { only: args.job } : {}),
    log: (line) => console.log(`${TAG} ${line}`),
  }));
  console.log(`${TAG} обработано заданий ${report.processedJobs} (пропущено готовых ${report.skippedJobs}), записей ${report.units}`);
  console.log(`${TAG} в очередь заново: ${report.requeue.length}; переписать из-за темпа: ${report.rerender.length}; послушать: ${report.needsEar.length}; нет мастера: ${report.missingMasters.length}`);
  if (report.publish) console.log(`${TAG} манифест ${report.publish.changed ? 'обновлён' : 'без изменений'}: ${displayPath(report.publish.file)} (версия ${report.publish.libraryVersion}, записей ${report.publish.units}, ${(report.publish.bytes / 1e6).toFixed(1)} МБ)`);
  for (const w of report.publish?.warnings ?? []) console.log(`${TAG} внимание: ${w}`);
  console.log(`${TAG} отчёт: ${displayPath(reportFile)}`);
}

async function cmdVerify(argv: string[]): Promise<void> {
  const args = parseCli(argv, { ...COMMON, 'no-asr': { type: 'boolean' }, reasr: { type: 'boolean' }, unit: { type: 'string', multiple: true }, model: { type: 'string' }, report: { type: 'string' }, qa: { type: 'string' } });
  const p = paths(args);
  const qa = qaRule(args.qa, p.overlay);
  await requireFfmpeg();
  const reportFile = safe(args.report, p.verifyReportFile ?? path.join(DEFAULT_REVIEW_PAGE_DIR, 'verify.json'), '--report');
  const report = await withPublishLock(p.overlay, () => runVerify({
    storeFile: p.storeFile,
    reviewFile: p.reviewFile,
    libraryRoot: p.libraryRoot,
    work: p.work,
    reportFile,
    qa,
    ledgerFile: p.ledgerFile,
    whisper: args['no-asr'] === true ? null : { bin: WHISPER_BIN, model: args.model ?? DEFAULT_WHISPER_MODEL },
    ...(args.reasr === true ? { reasr: true } : {}),
    ...(args.unit !== undefined ? { only: args.unit } : {}),
    log: (line) => console.log(`${TAG} ${line}`),
  }));
  console.log(`${TAG} проверено ${report.units}: прошли ${report.passed}, послушать ${report.needsEar.length} (ASR ${report.asr === 'on' ? 'включён' : 'выключен'})`);
  for (const u of report.needsEar.slice(0, 20)) console.log(`${TAG}   ${u.id} «${u.text}»: ${u.flags.join(', ')}${u.heard ? ` — слышно «${u.heard}»` : ''}`);
  console.log(`${TAG} отчёт: ${displayPath(reportFile)}`);
}

async function cmdReview(argv: string[]): Promise<void> {
  const args = parseCli(argv, { ...COMMON, composed: { type: 'string' }, out: { type: 'string' } });
  await requireFfmpeg();
  const p = paths(args);
  const result = await runReview({
    storeFile: p.storeFile,
    reviewFile: p.reviewFile,
    libraryRoot: p.libraryRoot,
    outDir: safe(args.out, p.overlay === null ? DEFAULT_REVIEW_PAGE_DIR : path.join(DEFAULT_REVIEW_PAGE_DIR, 'overlay'), '--out'),
    work: p.work,
    ...(args.composed !== undefined ? { composedFile: safe(args.composed, args.composed, '--composed') } : {}),
  });
  console.log(`${TAG} страница: ${displayPath(result.page)} — записей ${result.units}, собранных фраз ${result.composed} (звук только по кнопке ▶)`);
  for (const s of result.skipped) console.log(`${TAG}   пропущено: ${s}`);
}

async function cmdDemoGame(argv: string[]): Promise<void> {
  const args = parseCli(argv, { ...COMMON, demo: { type: 'string' }, out: { type: 'string' }, planned: { type: 'boolean' }, script: { type: 'string' } });
  const p = paths(args);
  const script = readScript(safe(args.script, DEFAULT_SCRIPT, '--script'));
  const seed = args.demo ?? script.demo;
  if (!seed) throw new UsageError('нет демо-партии: --demo <seed>');
  const demo = readDemo(seed) as DemoGameFile;
  const out = safe(args.out, DEFAULT_DEMO_GAME_OUT, '--out');
  if (!/\.mp3$/i.test(out)) throw new UsageError('--out: нужен путь к .mp3 (расшифровка ляжет рядом, .txt)');
  if (args.planned === true) {
    const game = demoGameScript(demo, libraryFromJobs([readJobsFile(jobsFileOf('pilot'))]));
    const txt = writePlannedTranscript(game, out);
    console.log(`${TAG} план демо-партии ${seed} по заданиям пилота (записи не нужны, MP3 нет): ${displayPath(txt)} — фраз ${game.utterances.length}`);
    return;
  }
  await requireFfmpeg();
  const manifest = readCurrentManifest(p.libraryRoot);
  const store = readStore(p.storeFile);
  if (manifest === null || Object.keys(store.units).length === 0) {
    throw new UsageError('записей ещё нет (сначала «Озвучка»: voice:generate → voice:process); план без записей: --planned');
  }
  const stale = staleTakes(manifest.units, script);
  const game = demoGameScript(demo, withoutTakes(libraryFromManifest(manifest), stale));
  const result = await writeDemoGame(game, store, p.libraryRoot, out, p.work);
  const levels = new Map<string, number>();
  for (const u of game.utterances) levels.set(levelRu(u.plan), (levels.get(levelRu(u.plan)) ?? 0) + 1);
  console.log(`${TAG} демо-партия ${seed}: ${result.mp3 ? displayPath(result.mp3) : 'MP3 не записан — ни одна фраза не озвучена'} (${(result.totalMs / 60000).toFixed(1)} мин, фраз ${result.voiced} из ${result.utterances}; ${[...levels].map(([k, n]) => `${k} ${n}`).join(', ')})`);
  console.log(`${TAG} расшифровка: ${displayPath(result.txt)} (звук только в файле, ничего не проигрывалось)`);
  if (stale.length > 0) console.log(`${TAG} устаревшие записи не использованы: ${stale.length}`);
  for (const m of result.missing) console.log(`${TAG}   не вошла фраза ${m} (нет файла записи)`);
  if (result.mp3 === null || result.missing.length > 0) process.exitCode = 1;
}

async function cmdLedger(argv: string[]): Promise<void> {
  const args = parseCli(argv, COMMON);
  const p = paths(args);
  const onDemand = readOnDemandLedger(p.ledgerFile);
  const view = onDemand.ledger;
  const campaigns = new Map<string, { jobs: number; pending: number; failed: number; masters: number }>();
  for (const job of view.jobs.values()) {
    const c = campaigns.get(job.campaign) ?? { jobs: 0, pending: 0, failed: 0, masters: 0 };
    c.jobs++;
    if (job.state === 'pending') c.pending++;
    if (job.state === 'failed') c.failed++;
    if (job.master !== undefined) c.masters++;
    campaigns.set(job.campaign, c);
  }
  if (campaigns.size === 0) console.log(`${TAG} журнал пуст: ${displayPath(p.ledgerFile)}`);
  for (const [name, c] of campaigns) {
    console.log(`${TAG} «${name}»: заданий ${c.jobs}, ждут ${c.pending}, неудачных ${c.failed}, мастеров ${c.masters}, потрачено ${fmtCredits(spentMilli(view, name))} кр.`);
  }
  if (view.broken > 0) console.log(`${TAG} повреждённых строк: ${view.broken}`);
  // the overlay ledger: intents nobody resolved yet count at full price (they may have been debited)
  if (onDemand.unresolved.length > 0) {
    const milli = onDemand.unresolved.reduce((n, i) => n + i.milli, 0);
    console.log(`${TAG} неясных заданий (intent без created/absent): ${onDemand.unresolved.length} на ${fmtCredits(milli)} кр. — считаются потраченными, пока сервер или следующий запуск не посмотрит список Higgsfield`);
  }
  if (p.overlay !== null || onDemand.unresolved.length > 0 || [...view.jobs.values()].some((j) => j.job.take >= ONDEMAND_TAKE_BASE)) {
    const today = localDay(new Date());
    for (const campaign of new Set([...view.jobs.values()].map((j) => j.campaign).concat(onDemand.unresolved.map((i) => i.campaign)))) {
      const spent = spentByDay(onDemand, undefined, campaign);
      console.log(`${TAG} «${campaign}» сегодня (${today}): ${fmtCredits(spent.days[today] ?? 0)} кр., всего ${fmtCredits(spent.totalMilli)} кр. (с ждущими и неясными по полной цене)`);
    }
  }
}

async function cmdWhisper(argv: string[]): Promise<void> {
  const args = parseCli(argv, { check: { type: 'boolean' }, model: { type: 'string' }, help: { type: 'boolean', short: 'h' } });
  const model = args.model ?? DEFAULT_WHISPER_MODEL;
  const problem = await whisperProblem({ bin: WHISPER_BIN, model });
  console.log(`${TAG} whisper: ${problem ?? `готов (${model.replace(os.homedir(), '~')})`}`);
  if (problem === null && args.check === true) {
    const sum = await checkWhisperModel(model);
    console.log(`${TAG} sha256 ${sum.ok ? 'совпадает с опубликованным' : `НЕ совпадает (${sum.sha256}, ждали ${WHISPER_MODEL.sha256})`}`);
    if (!sum.ok) process.exitCode = 1;
  }
  if (problem !== null) {
    console.log(`${TAG} установка: brew install whisper-cpp; модель ${WHISPER_MODEL.file} (${Math.round(WHISPER_MODEL.bytes / 1048576)} МБ) из ${WHISPER_MODEL.url} в ${path.dirname(DEFAULT_WHISPER_MODEL).replace(os.homedir(), '~')}`);
    process.exitCode = 1;
  }
}

/** the plan, the progress and the finish reports of the library run — not in test-results/ (Playwright empties it) */
const LIBRARY_OUT = 'tools/voice-clips/.library';
/** the free reference run the order comes from: pnpm teach:report --games 60 --voice k3c --seed 7 --out <it> */
const LIBRARY_REF = 'tools/voice-clips/.library/voice-ref';
const LIBRARY_SCRIPT = 'tools/voice-clips/script.giselle-mm1.json';

/** The machine's overlay for the library: `--overlay DIR`, else VOICE_OVERLAY_DIR, else the default; never `off`. */
function libraryOverlay(flag: string | undefined): string {
  const dir = resolveOverlayDir(flag);
  if (dir === null) throw new UsageError('библиотека записывается в оверлей: --overlay off не подходит');
  return dir;
}

async function cmdLibraryPlan(argv: string[]): Promise<void> {
  const args = parseCli(argv, { overlay: { type: 'string' }, ref: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean', short: 'h' } });
  const overlayDir = libraryOverlay(args.overlay);
  const outDir = safe(args.out, LIBRARY_OUT, '--out');
  const usage = readUsage({ refDir: safe(args.ref, LIBRARY_REF, '--ref'), scriptFile: safe(undefined, LIBRARY_SCRIPT, '--script') });
  for (const note of usage.notes) console.log(`${TAG} ${note}`);
  const units = weighUnits(libraryUnits(), usage);
  const tools = { ledgerFile: DEFAULT_LEDGER, storeFile: DEFAULT_UNITS, reviewFile: DEFAULT_REVIEW };
  const snap = coverageSnapshots({ overlayDir, staticLibrary: DEFAULT_LIBRARY, tools })();
  const view = readOnDemandLedger(overlayPaths(overlayDir).ledgerFile);
  const plan = planLibrary({
    units,
    covered: (u) => coveredWhy(u, view, snap, { mode: 'held', tools: true }),
    attempts: (u) => {
      const unit = { key: u.key, text: u.text, twins: twinKeysOf(u) };
      return unitAttempts(view, unit) + unitAttempts(snap.toolsView, unit);
    },
  });
  const file = path.join(outDir, 'library.jobs.json');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(libraryJobsFile(plan.jobs), null, 1)}\n`);
  const bandName = ['обычные и для мальчика — звучали в партиях', 'обычные и для мальчика — не звучали', 'для девочки — звучали', 'для девочки — не звучали'];
  console.log(`${TAG} библиотека: ${plan.total} фраз (уроки ${units.filter((u) => u.source === 'lesson').length}, вопросы-варианты ${units.filter((u) => u.source === 'quiz').length}, каталог и меню ${units.filter((u) => u.source === 'catalog').length}); частоты по ${usage.games} партиям`);
  console.log(`${TAG} уже есть или в работе: ${Object.entries(plan.covered).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`);
  console.log(`${TAG} записать: ${plan.planned} фраз${plan.retakes > 0 ? ` (повторов ${plan.retakes})` : ''} в ${plan.jobs.length} заданиях — ${fmtCredits(plan.milli)} кр. по цене SPEC (0,15 за начатые 50 знаков)`);
  plan.bands.forEach((b, i) => {
    if (b.units > 0) console.log(`${TAG}   ${i + 1}. ${bandName[i]}: ${b.units} фраз, ${b.jobs} заданий, ${fmtCredits(b.milli)} кр.`);
  });
  for (const [source, v] of Object.entries(plan.bySource)) console.log(`${TAG}   ${source}: ${v.units} фраз ≈ ${fmtCredits(v.milli)} кр.`);
  console.log(`${TAG} план: ${displayPath(file)} (бесплатно: ничего не вызывалось; кампания «library», не больше ${LIBRARY_MAX_BUDGET} кр.)`);
}

async function cmdLibraryRun(argv: string[]): Promise<void> {
  const args = parseCli(argv, {
    budget: { type: 'string' },
    spend: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    portion: { type: 'string' },
    'in-flight': { type: 'string' },
    'max-jobs': { type: 'string' },
    'accept-audit': { type: 'boolean' },
    overlay: { type: 'string' },
    ref: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  const dryRun = args['dry-run'] === true;
  // Refuse before reading anything else: a paid run needs both flags
  if (!dryRun && (args.spend !== true || args.budget === undefined)) throw new SpendRefused(`нужны оба флага: --spend и --budget N (или --dry-run). ${SPEND_RULE}`);
  const overlayDir = libraryOverlay(args.overlay);
  const outDir = safe(args.out, LIBRARY_OUT, '--out');
  const portion = parsePositiveInt(args.portion, '--portion') ?? 40;
  const inFlight = parsePositiveInt(args['in-flight'], '--in-flight') ?? 2;
  if (inFlight > 4) throw new UsageError('--in-flight: не больше 4');
  const maxJobs = parsePositiveInt(args['max-jobs'], '--max-jobs');
  const usage = readUsage({ refDir: safe(args.ref, LIBRARY_REF, '--ref'), scriptFile: safe(undefined, LIBRARY_SCRIPT, '--script') });
  for (const note of usage.notes) console.log(`${TAG} ${note}`);
  if (!dryRun) {
    await requireFfmpeg();
    const whisper = await whisperProblem({ bin: WHISPER_BIN, model: DEFAULT_WHISPER_MODEL });
    if (whisper !== null) throw new Error(`whisper не готов (${whisper}) — без проверки записи не публикуются; pnpm voice:whisper`);
    console.log(`${TAG} ${SPEND_RULE}`);
    console.log(`${TAG} остановить аккуратно: Ctrl-C или файл ${displayPath(stopFileOf(outDir))} (задания в работе будут доведены)`);
    if (stopRequested(outDir)) throw new UsageError(`есть файл остановки ${displayPath(stopFileOf(outDir))} — удалите его, чтобы начать`);
  }
  let stop = false;
  const onSignal = (): void => {
    if (stop) process.exit(130);
    stop = true;
    console.log(`${TAG} останавливаюсь после заданий в работе (ещё раз Ctrl-C — сразу)`);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // local time: a person reads this log
  const at = () => new Date().toTimeString().slice(0, 8);
  const summary = await runLibrary(
    {
      budget: parseBudget(args.budget),
      spend: args.spend === true,
      dryRun,
      portion,
      inFlight,
      ...(maxJobs !== undefined ? { maxJobs } : {}),
      overlayDir,
      staticLibrary: DEFAULT_LIBRARY,
      tools: { ledgerFile: DEFAULT_LEDGER, storeFile: DEFAULT_UNITS, reviewFile: DEFAULT_REVIEW },
      usage,
      outDir,
      ...(args['accept-audit'] === true ? { acceptAudit: true } : {}),
      lockWaitMs: GLOBAL_LOCK_WAIT_MS,
    },
    {
      runCli: realRunCli,
      download: downloadMaster,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
      now: () => new Date(),
      log: (line) => console.log(`${TAG} ${at()} ${line}`),
      finish: childFinish({ repoRoot: REPO_ROOT, overlayDir, reportDir: outDir }),
      shouldStop: () => stop || stopRequested(outDir),
    },
  );
  const f = summary.finish;
  console.log(`${TAG} итог: остановка «${summary.stop}»${summary.message ? ` — ${summary.message}` : ''}`);
  if (!dryRun) {
    console.log(`${TAG} заданий создано ${summary.created}, взято готовых ${summary.adopted}, продолжено ${summary.resumed}; записано ${summary.charged}, неудачных ${summary.failed}, пропущено ${summary.skipped}`);
    console.log(`${TAG} проверено ${f.verified}: опубликовано ${f.published}, послушать ${f.needsEar}, не разрезалось ${f.requeued}; ошибок проверки ${f.errors}`);
    console.log(`${TAG} кампания «library» потратила ${fmtCredits(summary.spentMilli)} кр.${summary.balanceMilli !== null ? `; на счёте ${fmtCredits(summary.balanceMilli)}` : ''}`);
    console.log(`${TAG} осталось: ${summary.left.units} фраз, ${summary.left.jobs} заданий, ${fmtCredits(summary.left.milli)} кр.`);
  }
  const fine = summary.stop === 'done' || summary.stop === 'dry-run' || summary.stop === 'max-jobs' || summary.stop === 'budget' || summary.stop === 'interrupted';
  if (!fine) process.exitCode = 1;
}

const COMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
  cost: cmdCost,
  generate: cmdGenerate,
  process: cmdProcess,
  verify: cmdVerify,
  review: cmdReview,
  ledger: cmdLedger,
  whisper: cmdWhisper,
  harvest: cmdHarvest,
  script: cmdScript,
  plan: cmdPlan,
  coverage: cmdCoverage,
  'demo-game': cmdDemoGame,
  'library-plan': cmdLibraryPlan,
  'library-run': cmdLibraryRun,
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === '--help' || command === '-h' || rest.includes('--help') || rest.includes('-h')) {
    console.log(HELP);
    return;
  }
  const run = COMMANDS[command];
  if (run === undefined) throw new UsageError(`unknown command «${command}»`);
  await run(rest);
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) console.error(`${TAG} usage error: ${err.message}\n${HELP}`);
  else if (err instanceof SpendRefused) console.error(`${TAG} отказ (ничего не потрачено): ${err.message}`);
  else if (err instanceof SmokeGuardError || err instanceof JobsFileError || err instanceof LedgerLocked) console.error(`${TAG} отказ: ${err.message}`);
  else console.error(`${TAG} FAILED: ${errorMessage(err)}`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
});
