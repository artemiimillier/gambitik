/**
 * «Дозапись голоса» end to end, free and silent: a real lesson utterance of the core engine → POST
 * /api/voice/clips/request with its `saySentences` ids → the server renders, packs and records it through the REAL
 * tools protocol (intent → create → `generate get` confirm → created → wait → charged → download) against a FAKE
 * Higgsfield account (a job-set envelope from `create`, a completed job with a result URL from `wait`) and a fake CDN
 * that serves a synthetic master made by ffmpeg (one tone per part, 800 ms tag silences) → the REAL finish steps
 * (`process` + `verify` under the overlay QA rule, in-process with a fake recogniser: whisper cannot hear a tone) →
 * the overlay served over HTTP → merged by core → `planLessonClips` voices the whole utterance, exactly the bubble.
 * Then: the same request pays nothing, a lead said alone is served by the lead's falling take, and a cap stops a new
 * one before any CLI call. Then the same for the home screen's greeting (an older event with a clip twin): the web's
 * planner asks for the bubble's own wordings (`lineMissing`), the server records them as whole catalogue sentences under
 * the starter set's keys and pools, and `planClips` voices exactly the bubble. Nothing is played; skipped without ffmpeg; no
 * network (the CDN is a fake fetch).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { AnalysisResult, ClipGenRequestResult, ClipGenSentence, ClipGenStatus, CoachEvent, EngineLine, StudentProfile } from '@gambit/shared';
import { getStrategy } from '@gambit/content';
import {
  LESSON_GAPS_MS,
  PACK_TAG,
  buildGreeting,
  clipInputOf,
  createLessonBook,
  initialTeachMemory,
  lessonGameStart,
  lessonSentencesOf,
  lessonTurn,
  mergeClipIndexes,
  planClips,
  planLessonClips,
  requestSentenceOf,
  twinWordingsOf,
} from '@gambit/core';
import type { ClipIndexLayer, TeachContext, TeachMemory } from '@gambit/core';
import { createTestServer } from '../testing/fixtures.ts';
import type { TestServer } from '../testing/fixtures.ts';
import { VOICE_KEY, WHISPER_BIN, ffmpegAvailable, jobMilli, runProcess, runVerify } from './bridge.ts';
import type { CliResult, RunCli } from './bridge.ts';
import { overlayPaths } from './overlay.ts';
import { publishedOf } from './runner.ts';
import type { FinishFn } from './runner.ts';

const hasFfmpeg = await ffmpegAvailable();

const cleanups: (() => void)[] = [];
const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.cleanup();
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ───────────────────────── a real lesson utterance (the core engine, the writers' library) ─────────────────────────

function fenOf(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

/** The child's move first, two other legal moves clearly worse. */
function scripted(fen: string, next: string): AnalysisResult {
  const others = new Chess(fen)
    .moves()
    .filter((m) => m !== next)
    .slice(0, 2);
  const lines: EngineLine[] = [next, ...others].map((san, i) => {
    const m = new Chess(fen).move(san);
    return { multipv: i + 1, depth: 16, pvUci: [`${m.from}${m.to}${m.promotion ?? ''}`], cp: i === 0 ? 40 : -70 - 10 * i, mate: null };
  });
  return { fen, lines, bestmove: lines[0]?.pvUci[0] ?? '', depth: 16, timeMs: 300 };
}

const PROFILE: StudentProfile = {
  nickname: 'Миша',
  address: 'm',
  stage: 1,
  totals: { games: 5, wins: 2, losses: 2, draws: 1, puzzlesAttempted: 20, puzzlesSolved: 12, minutesPlayed: 90 },
  puzzleRating: { rating: 650, rd: 200, vol: 0.06, attempts: 20, solved: 12, lastSeen: null },
  themeSkills: {},
  recentAccuracy: [60, 70],
  weaknesses: [],
  strengths: [],
  bestWin: null,
  updatedAt: '2026-09-21T10:00:00.000Z',
};

/** The static library the app ships (apps/web/public/voice): the starter set's manifest, as the web's clip library loads it. */
function pilotLibrary(): ClipIndexLayer {
  const root = new URL('../../../web/public/voice/', import.meta.url);
  const index = JSON.parse(readFileSync(new URL('index.json', root), 'utf8')) as { default: string; voices: Record<string, string> };
  const manifest = JSON.parse(readFileSync(new URL(index.voices[index.default] as string, root), 'utf8')) as ClipIndexLayer;
  return { units: manifest.units, keys: manifest.keys, pools: manifest.pools, fallbacks: manifest.fallbacks ?? {}, voiceKey: manifest.voiceKey, blocked: manifest.blocked ?? [] };
}

/** The teacher's utterances of a scripted Italian at stage 1 (a boy): game start and every turn. */
function lessonEvents(): CoachEvent[] {
  const moves = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O', 'Re1', 'a6'];
  const book = createLessonBook({ seed: 7 });
  const card = getStrategy('italian') ?? null;
  const start = lessonGameStart({ profile: PROFILE, childColor: 'w', tc: 'training', coachStyle: 'teacher', strategy: null, strategyCard: card, historySan: [], fen: fenOf([]) }, initialTeachMemory(), book);
  const out: CoachEvent[] = [...start.events];
  let memory: TeachMemory = start.memory;
  for (let k = 0; k < moves.length; k += 2) {
    const sans = moves.slice(0, k);
    const fen = fenOf(sans);
    const before = k > 0 ? fenOf(sans.slice(0, -1)) : null;
    const last = before !== null ? new Chess(before).move(sans[k - 1] as string) : null;
    const ctx: TeachContext = {
      fen,
      ply: k + 1,
      childColor: 'w',
      profile: PROFILE,
      analysis: scripted(fen, moves[k] as string),
      lastBotMove: last && before ? { uci: `${last.from}${last.to}${last.promotion ?? ''}`, san: last.san, fenBefore: before } : null,
      historySan: sans,
      strategyCard: card,
      tc: 'training',
      threat: null,
      memory,
      lessonHistory: book.history(),
    };
    const r = lessonTurn(ctx, book);
    memory = r.memory;
    if (r.result.event) out.push(r.result.event);
  }
  return out.filter((ev) => ev.text.trim() !== '' && (ev.saySentences?.length ?? 0) > 0);
}

// ───────────────────────── a fake Higgsfield account and CDN ─────────────────────────

const CDN = 'https://cdn.example.test/';
const RATE = 32_000;

function silence(ms: number): Float32Array {
  return new Float32Array(Math.round((ms * RATE) / 1000));
}

/** A sine with 10 ms raised-cosine edges: pitch ≈ a voice (and below 190 Hz: a lead that falls). */
function tone(hz: number, ms: number): Float32Array {
  const n = Math.round((ms * RATE) / 1000);
  const edge = Math.round(0.01 * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = i < edge ? 0.5 - 0.5 * Math.cos((Math.PI * i) / edge) : i > n - edge ? 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / edge) : 1;
    out[i] = 0.1 * env * Math.sin((2 * Math.PI * hz * i) / RATE);
  }
  return out;
}

/**
 * The master Higgsfield would return for a prompt: every tag-separated part a tone of ≈ 4 syllables a second (the
 * tempo and ms-per-character gates pass), the `<#0.6#>` tags as 800 ms silences — MP3-encoded by ffmpeg.
 */
function masterOf(prompt: string): Buffer {
  const parts = prompt.split(PACK_TAG);
  const chunks: Float32Array[] = [silence(150)];
  parts.forEach((part, i) => {
    if (i > 0) chunks.push(silence(800));
    const syllables = (part.match(/[аеёиоуыэюя]/giu) ?? []).length;
    chunks.push(tone(180, Math.max(400, Math.round((syllables / 4) * 1000))));
  });
  chunks.push(silence(250));
  const pcm = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    pcm.set(c, at);
    at += c.length;
  }
  const out = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'], {
    input: Buffer.from(pcm.buffer),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.status !== 0) throw new Error(`ffmpeg: ${out.stderr.toString()}`);
  return out.stdout;
}

interface CloudJob {
  id: string;
  prompt: string;
  voiceId: string;
  variant: string;
  status: 'queued' | 'completed';
  createdAt: string;
}

/**
 * The provider as it really answers: `create` prints a job-set envelope (no prompt, the job id only in `job_ids`), so
 * the tools confirm the id with a free `generate get`; `wait` completes the job with a CDN URL. Every call is logged.
 */
class FakeCloud {
  readonly calls: string[][] = [];
  /** prompts of every paid create */
  readonly creates: string[] = [];
  readonly jobs = new Map<string, CloudJob>();

  private json(data: unknown): CliResult {
    return { code: 0, stdout: JSON.stringify(data), stderr: '' };
  }

  private view(job: CloudJob): Record<string, unknown> {
    return { id: job.id, status: job.status, params: { prompt: job.prompt, voice_id: job.voiceId, variant: job.variant }, result_url: job.status === 'completed' ? `${CDN}${job.id}.mp3` : null, created_at: job.createdAt };
  }

  readonly runCli: RunCli = async (args) => {
    this.calls.push([...args]);
    const flag = (name: string): string => args[args.indexOf(name) + 1] ?? '';
    const [a, b] = args;
    if (a === 'model' && b === 'get') {
      return this.json({ params: [{ name: 'prompt', required: true }, { name: 'variant', enum: ['minimax'] }, { name: 'voice_id' }, { name: 'voice_type', enum: ['preset'] }] });
    }
    if (a === 'generate' && b === 'cost') return this.json({ credits: jobMilli(flag('--prompt')) / 1000 });
    if (a === 'generate' && b === 'create') {
      const id = `4c1e6f0a-0000-4000-8000-${String(this.jobs.size + 1).padStart(12, '0')}`;
      this.jobs.set(id, { id, prompt: flag('--prompt'), voiceId: flag('--voice_id'), variant: flag('--variant'), status: 'queued', createdAt: new Date().toISOString() });
      this.creates.push(flag('--prompt'));
      return this.json({ job_set_id: `set-${this.jobs.size}`, job_ids: [id] });
    }
    const job = this.jobs.get(args[2] ?? '');
    if (a === 'generate' && b === 'get') return job ? this.json(this.view(job)) : { code: 1, stdout: '', stderr: 'HTTP 404 job not found' };
    if (a === 'generate' && b === 'wait') {
      if (!job) return { code: 1, stdout: '', stderr: 'HTTP 404 job not found' };
      job.status = 'completed';
      return this.json(this.view(job));
    }
    if (a === 'generate' && b === 'list') return this.json({ items: [...this.jobs.values()].map((j) => this.view(j)) });
    return { code: 2, stdout: '', stderr: `fake higgsfield: unexpected call ${args.slice(0, 2).join(' ')}` };
  };

  /** The fake CDN (the server's own downloader fetches through it): the master of a completed job. */
  readonly fetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const job = url.startsWith(CDN) ? this.jobs.get(basename(url, '.mp3')) : undefined;
    if (!job || job.status !== 'completed') return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(masterOf(job.prompt)), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
}

/**
 * The finish the server runs as two children (`voice:process --overlay` then `voice:verify --unit …`), here the same
 * tool functions in-process with the same paths and the overlay rule; the recogniser hears exactly each unit's words.
 */
function inProcessFinish(overlayDir: string, work: string, heardFiles: string[]): FinishFn {
  const ov = overlayPaths(overlayDir);
  return async (input) => {
    const common = { storeFile: ov.units, reviewFile: ov.review, libraryRoot: ov.dir, work };
    await runProcess({ ...common, ledgerFile: ov.ledger, mastersDir: ov.masters, reportFile: ov.processReport, qa: 'overlay', only: [input.jobId] });
    const words = new Map(input.units.map((u) => [u.id, u.text]));
    await runVerify({
      ...common,
      reportFile: ov.verifyReport,
      qa: 'overlay',
      ledgerFile: ov.ledger,
      whisper: { bin: WHISPER_BIN, model: join(work, 'no-model.bin') },
      transcribeFn: async (file) => {
        heardFiles.push(file);
        return words.get(basename(file, '.mp3')) ?? '';
      },
      only: input.units.map((u) => u.id),
    });
    return publishedOf(overlayDir, input.units);
  };
}

interface LedgerRow {
  ev: string;
  key: string;
  jobId?: string;
  milli?: number;
  via?: string;
  createShape?: string;
  job?: { prompt: string; take: number; recipe: string; pieces: { key: string; text: string; role?: string }[] };
}

function ledgerRows(file: string): LedgerRow[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as LedgerRow);
}

// ───────────────────────── the run ─────────────────────────

describe.skipIf(!hasFfmpeg)('«Дозапись голоса» end to end (fake account, fake CDN, real protocol and finish, silent)', () => {
  it('a silent utterance is recorded once, served, merged and voiced whole; the same request pays nothing; a cap stops a new one', async () => {
    const events = lessonEvents();
    // an utterance of 2+ sentences with a lead + its tail: the richest shape (a pack, a seam gap, a sentence gap)
    const event = events.find((ev) => (ev.saySentences ?? []).length >= 2 && (ev.saySentences ?? []).some((s) => s.parts.length === 2));
    expect(event, events.map((ev) => ev.text).join('\n')).toBeDefined();
    const utterance = event as CoachEvent;
    const other = events.find((ev) => ev !== utterance && ev.text !== utterance.text && (ev.saySentences ?? []).every((s) => !s.quiz)) as CoachEvent;
    expect(other).toBeDefined();

    // nothing is recorded yet: the planner is silent and lists every sentence as missing
    expect(planLessonClips(utterance, mergeClipIndexes(null, null)).lessonMissing).toEqual(lessonSentencesOf(utterance).map((_, i) => i));
    const idsOf = (ev: CoachEvent, missing: readonly number[]): ClipGenSentence[] =>
      missing.map((i) => requestSentenceOf(ev, lessonSentencesOf(ev)[i] as NonNullable<ReturnType<typeof lessonSentencesOf>[number]>) as ClipGenSentence);
    const body = { sentences: idsOf(utterance, lessonSentencesOf(utterance).map((_, i) => i)), kind: utterance.kind };
    expect(body.sentences.every((s) => s !== null)).toBe(true);

    const dataDir = tempDir('gambit-e2e-data-');
    const overlayDir = tempDir('gambit-e2e-overlay-');
    const work = tempDir('gambit-e2e-work-');
    const cloud = new FakeCloud();
    const heard: string[] = [];
    const server = await createTestServer(
      { dataDir, clipGen: { enabled: true, budgetMilli: 10_000, dailyMaxMilli: 6_000, dataDirPin: dataDir, bin: null, overlayDir, overlayProblem: null } },
      {
        fetchImpl: cloud.fetch,
        clipGen: {
          runCli: cloud.runCli,
          finish: inProcessFinish(overlayDir, work, heard),
          toolsProblem: async () => null,
          tempRoots: [],
          staticLibraryDir: null,
          toolsLedgerFile: null,
          timers: false,
          sleep: async () => undefined,
        },
      },
    );
    servers.push(server);
    const settings = await server.request('/api/voice/clips/settings', { method: 'PUT', json: { enabled: true, dailyCapMilli: 6_000 } });
    expect(settings.status).toBe(200);
    expect(((await settings.json()) as ClipGenStatus).health).toEqual({ state: 'ready', overlay: true });

    // ── the first request: every sentence queued, recorded strictly through the protocol ──
    const first = await server.request('/api/voice/clips/request', { method: 'POST', json: body });
    expect(first.status).toBe(202);
    const firstResult = (await first.json()) as ClipGenRequestResult;
    expect(firstResult.results.map((r) => r.outcome)).toEqual(body.sentences.map(() => 'queued'));
    await server.ctx.clipGen.idle();

    const ov = overlayPaths(overlayDir);
    const rows = ledgerRows(ov.ledger);
    const created = rows.filter((r) => r.ev === 'created');
    expect(created.length).toBeGreaterThan(0);
    expect(cloud.creates).toEqual(created.map((r) => r.job?.prompt));
    for (const job of created) {
      // one job's lines, in order: the intent is written (fsync) before the paid call, the id confirmed by a free get
      expect(rows.filter((r) => r.key === job.key).map((r) => r.ev)).toEqual(['intent', 'created', 'charged', 'downloaded']);
      expect(job).toMatchObject({ via: 'get', createShape: '{job_set_id:str,job_ids:[str]}', milli: jobMilli(job.job?.prompt ?? '') });
      expect(job.job?.take).toBe(101);
      if ((job.job?.pieces.length ?? 0) > 1) expect(job.job).toMatchObject({ recipe: 'pack' });
    }
    // every create came after the model check and the server's own (free) price, never `job_set_id` as a job
    const order = cloud.calls.map((c) => c.slice(0, 2).join(' '));
    expect(order.indexOf('model get')).toBeLessThan(order.indexOf('generate cost'));
    expect(order.indexOf('generate cost')).toBeLessThan(order.indexOf('generate create'));
    expect(cloud.calls.filter((c) => c[1] === 'wait').every((c) => c.includes('--interval') && c[c.indexOf('--interval') + 1] === '1s')).toBe(true);

    // the budget is the ledger: charged jobs at their SPEC price
    const spentMilli = created.reduce((n, r) => n + (r.milli ?? 0), 0);
    const status = (await (await server.request('/api/voice/clips/status')).json()) as ClipGenStatus;
    const units = created.flatMap((r) => r.job?.pieces ?? []);
    expect(status).toMatchObject({ health: { state: 'ready', overlay: true }, queue: 0, busy: false, givenUp: 0, spent: { todayMilli: spentMilli, totalMilli: spentMilli, prefetchMilli: 0 } });
    expect(status.overlay).toMatchObject({ units: units.length });
    expect(status.overlay?.version).toBeGreaterThan(0);
    // the recogniser checked every take (only ASR-confirmed takes are published), each lead fell (no `cont`)
    expect(heard).toHaveLength(units.length);
    const state = JSON.parse(readFileSync(ov.state, 'utf8')) as { finished: Record<string, { failed: string[] }> };
    for (const job of created) expect(state.finished[job.jobId as string]?.failed).toEqual([]);

    // ── the overlay over HTTP, as the web loads it ──
    const index = (await (await server.request('/api/voice/clips/overlay/index.json')).json()) as { default: string; voices: Record<string, string> };
    expect(index.default).toBe(VOICE_KEY);
    const manifestPath = index.voices[VOICE_KEY] as string;
    expect(manifestPath).toMatch(new RegExp(`^${VOICE_KEY}/manifest\\.[0-9a-f]+\\.json$`));
    const manifestRes = await server.request(`/api/voice/clips/overlay/${manifestPath}`);
    // content-addressed (`manifest.<hash>.json`): the browser may keep it; only the index is never cached
    expect(manifestRes.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const manifest = (await manifestRes.json()) as ClipIndexLayer & { voiceKey: string; libraryVersion: number; units: Record<string, { key: string; text: string; file: string; qa: string; ctx?: string }> };
    expect(manifest.libraryVersion).toBe(status.overlay?.version);
    expect(Object.values(manifest.units).map((u) => u.key).sort()).toEqual(units.map((u) => u.key).sort());
    for (const [id, unit] of Object.entries(manifest.units)) {
      expect(unit.qa).toBe('asr');
      expect(unit.ctx).toBeUndefined();
      const mp3 = await server.request(`/api/voice/clips/overlay/${VOICE_KEY}/${unit.file}`);
      expect(mp3.status, id).toBe(200);
      expect(mp3.headers.get('content-type')).toBe('audio/mpeg');
      const bytes = new Uint8Array(await mp3.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(1_000);
      expect((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && ((bytes[1] as number) & 0xe0) === 0xe0)).toBe(true);
    }

    // ── merged by core, planned by exact keys: the whole utterance, exactly the bubble ──
    const merged = mergeClipIndexes(null, { units: manifest.units, keys: manifest.keys, pools: manifest.pools, fallbacks: manifest.fallbacks ?? {}, voiceKey: manifest.voiceKey, blocked: manifest.blocked ?? [] });
    const plan = planLessonClips(utterance, merged, { jitter: false });
    expect(plan.src).toBe('lesson');
    expect(plan.heard).toBe(utterance.text);
    expect(plan.lessonMissing).toEqual([]);
    expect(plan.clips.map((c) => c.id).every((id) => Object.hasOwn(manifest.units, id))).toBe(true);
    // a falling lead → its «—» tail after the dash gap; sentences after the sentence / question gap
    const seam = plan.clips.find((c) => c.role === 'tail');
    expect(seam?.gapBeforeMs).toBe(LESSON_GAPS_MS.dash);
    for (const c of plan.clips.slice(1)) if (c.role !== 'tail') expect([LESSON_GAPS_MS.sentence, LESSON_GAPS_MS.question]).toContain(c.gapBeforeMs);

    // ── the same request again: everything is voiced, nothing is paid ──
    const callsBefore = cloud.calls.length;
    const linesBefore = rows.length;
    const again = (await (await server.request('/api/voice/clips/request', { method: 'POST', json: body })).json()) as ClipGenRequestResult;
    expect(again.results.map((r) => r.outcome)).toEqual(body.sentences.map(() => 'voiced'));
    // a lead said alone: its falling take serves it too (one key per lead)
    const pair = lessonSentencesOf(utterance).find((s) => s.parts.length === 2) as NonNullable<ReturnType<typeof lessonSentencesOf>[number]>;
    const leadAlone: ClipGenSentence = { parts: [(utterance.say ?? [])[pair.parts[0] as number] as NonNullable<CoachEvent['say']>[number]] };
    const alone = (await (await server.request('/api/voice/clips/request', { method: 'POST', json: { sentences: [leadAlone] } })).json()) as ClipGenRequestResult;
    expect(alone.results[0]?.outcome).toBe('voiced');
    await server.ctx.clipGen.idle();
    expect(cloud.calls.length).toBe(callsBefore);
    expect(ledgerRows(ov.ledger)).toHaveLength(linesBefore);

    // ── the parent lowers today's cap to what is spent: a new utterance is refused before any CLI call ──
    const lowered = (await (await server.request('/api/voice/clips/settings', { method: 'PUT', json: { enabled: true, dailyCapMilli: Math.max(150, spentMilli) } })).json()) as ClipGenStatus;
    expect(lowered.health).toMatchObject({ state: 'paused', reason: 'day-cap' });
    const missingOther = planLessonClips(other, merged).lessonMissing;
    expect(missingOther.length).toBeGreaterThan(0);
    const refused = (await (await server.request('/api/voice/clips/request', { method: 'POST', json: { sentences: idsOf(other, missingOther) } })).json()) as ClipGenRequestResult;
    // a sentence made only of units recorded above is already voiced; every other one is out of budget
    expect(refused.results.map((r) => r.outcome).every((o) => o === 'budget' || o === 'voiced')).toBe(true);
    expect(refused.results.some((r) => r.outcome === 'budget')).toBe(true);
    await server.ctx.clipGen.idle();
    expect(cloud.calls.length).toBe(callsBefore);
    expect(cloud.creates).toHaveLength(created.length);
    // the recorded phrases keep being served while recording pauses
    expect((await server.request(`/api/voice/clips/overlay/${manifestPath}`)).status).toBe(200);
  }, 120_000);

  it("the home screen's greeting (an older event, a clip twin): its wordings are recorded once, published under the starter set's keys and pools, and voiced", async () => {
    // a real greeting of the core builder: a girl who won her last game, in the afternoon
    const girl: StudentProfile = { ...PROFILE, nickname: 'Маша', address: 'f' };
    const pick = [0.5, 0.2];
    const event = buildGreeting({ profile: girl, hour: 14, lastGame: { id: 'g1', result: '1-0', childColor: 'w' } as NonNullable<Parameters<typeof buildGreeting>[0]['lastGame']> }, () => pick.shift() ?? 0.5);
    expect(event.clip?.sentences.map((x) => x.items)).toEqual([[{ line: 'greet.hello.day' }], [{ line: 'greet.win', g: 'f' }]]);
    // planned as the web's clip layer plans it (clipVoice `planFor`): the twin, the bubble's own wordings, over the
    // library the app really ships — the starter set's static manifest (85 takes: no «Добрый день!», no generic greeting)
    const name = { name: 'Маша' };
    const wordings = twinWordingsOf(event, name);
    const input = clipInputOf(event, name);
    const pilot = pilotLibrary();
    const before = planClips(input, mergeClipIndexes(pilot, null), { rng: () => 0.99, jitter: false, wordings });
    // the web asks for exactly the bubble's wordings, as ids (clipOnDemand `requestLines`)
    const missing = before.lineMissing ?? [];
    expect(missing).toEqual([
      { id: 'greet.hello.day', n: wordings[0] },
      { id: 'greet.win', n: wordings[1], g: 'f' },
    ]);

    const dataDir = tempDir('gambit-e2e-data-');
    const overlayDir = tempDir('gambit-e2e-overlay-');
    const work = tempDir('gambit-e2e-work-');
    const cloud = new FakeCloud();
    const heard: string[] = [];
    const server = await createTestServer(
      { dataDir, clipGen: { enabled: true, budgetMilli: 10_000, dailyMaxMilli: 6_000, dataDirPin: dataDir, bin: null, overlayDir, overlayProblem: null } },
      { fetchImpl: cloud.fetch, clipGen: { runCli: cloud.runCli, finish: inProcessFinish(overlayDir, work, heard), toolsProblem: async () => null, tempRoots: [], staticLibraryDir: null, toolsLedgerFile: null, timers: false, sleep: async () => undefined } },
    );
    servers.push(server);
    expect((await server.request('/api/voice/clips/settings', { method: 'PUT', json: { enabled: true, dailyCapMilli: 6_000 } })).status).toBe(200);
    // the greeting's own wordings, plus the plain «Помню твою прошлую победу…» that serves both genders' pools
    const lines = [...missing, { id: 'greet.win', n: 2 }].filter((l, i, all) => all.findIndex((x) => JSON.stringify(x) === JSON.stringify(l)) === i);
    const body = { sentences: lines.map((l) => ({ line: l })), kind: 'greeting' };
    const first = (await (await server.request('/api/voice/clips/request', { method: 'POST', json: body })).json()) as ClipGenRequestResult;
    expect(first.results.map((r) => r.outcome)).toEqual(lines.map(() => 'queued'));
    await server.ctx.clipGen.idle();

    const ov = overlayPaths(overlayDir);
    const created = ledgerRows(ov.ledger).filter((r) => r.ev === 'created');
    // as few pack jobs as the recipe allows (a question only last), every piece a whole sentence
    expect(created.length).toBeGreaterThan(0);
    expect(created.length).toBeLessThanOrEqual(lines.length);
    expect(created.flatMap((r) => r.job?.pieces ?? []).map((p) => p.role)).toEqual(lines.map(() => 'whole'));
    expect(heard).toHaveLength(lines.length);

    // the overlay over HTTP: the starter set's keys, and a plain wording in every pool it serves
    const index = (await (await server.request('/api/voice/clips/overlay/index.json')).json()) as { voices: Record<string, string> };
    const manifest = (await (await server.request(`/api/voice/clips/overlay/${index.voices[VOICE_KEY] as string}`)).json()) as ClipIndexLayer & { voiceKey: string; units: Record<string, { key: string; text: string; qa: string }> };
    const keys = Object.values(manifest.units).map((u) => u.key).sort();
    expect(keys).toEqual(lines.map((l) => `line:${l.id}${l.g ? `/${l.g}` : ''}#${l.n}`).sort());
    const plainId = Object.entries(manifest.units).find(([, u]) => u.key === 'line:greet.win#2')?.[0] as string;
    for (const pool of ['greet.win', 'greet.win/m', 'greet.win/f']) expect(manifest.pools[pool], pool).toContain(plainId);
    expect(manifest.fallbacks?.['greet.win']).toBe('greet.none');

    // every take is served as the web's library loads it
    for (const [id, unit] of Object.entries(manifest.units as Record<string, { file: string }>)) {
      const mp3 = await server.request(`/api/voice/clips/overlay/${VOICE_KEY}/${unit.file}`);
      expect(mp3.status, id).toBe(200);
      expect(mp3.headers.get('content-type')).toBe('audio/mpeg');
    }

    // merged by core over the starter set (clipLibrary: static + overlay), planned by the web's route: the bubble's own
    // wordings, exactly the bubble without the name, and nothing more to ask for
    const merged = mergeClipIndexes(pilot, { units: manifest.units, keys: manifest.keys, pools: manifest.pools, fallbacks: manifest.fallbacks ?? {}, voiceKey: manifest.voiceKey, blocked: manifest.blocked ?? [] });
    const plan = planClips(input, merged, { rng: () => 0.99, jitter: false, wordings });
    expect(plan.lineMissing).toBeUndefined();
    expect(plan.level).toBe(1);
    expect(plan.heard).toBe(event.text.replace(', Маша', ''));
    expect(plan.clips.every((c) => Object.hasOwn(manifest.units, c.id))).toBe(true);
    // a boy's greeting (the pool route, no wording known) finds the plain take recorded for her: one take, both pools
    expect(planClips({ sentences: [{ items: [{ line: 'greet.win', g: 'm' }], prio: 100, end: '?' }], generic: 'generic.greeting' }, merged, { rng: () => 0.99, jitter: false }).heard).toBe('Помню твою прошлую победу. Поехали дальше?');

    // the same request again pays nothing
    const callsBefore = cloud.calls.length;
    const again = (await (await server.request('/api/voice/clips/request', { method: 'POST', json: body })).json()) as ClipGenRequestResult;
    expect(again.results.map((r) => r.outcome)).toEqual(lines.map(() => 'voiced'));
    await server.ctx.clipGen.idle();
    expect(cloud.calls.length).toBe(callsBefore);
  }, 120_000);
});
