/**
 * «Дозапись голоса»: the recorder on temp folders with a fake Higgsfield account (testkit.ts) — the gates and their
 * order, dedup by unit, the queue's priority, the caps (a property test with random sequences, restarts and two
 * instances on one overlay: spend never exceeds a cap, no unit is paid twice), resume of every ledger state, the
 * breaker, a failed check's one paid take 2, what a paid job says about its units (a `cont` lead said alone, a take not
 * yet verified, a finish stuck after its retries, twins, a key that names new words) and the gates checked again right
 * before the paid create. Nothing here can spend, play or reach the network.
 */
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClipGenLine, ClipGenRequest, ClipGenSentence } from '@gambit/shared';
import { mergeClipIndexes, parseLineUnitKey, planClips, resolveClipGenLine, takesForLine } from '@gambit/core';
import type { ClipIndexLayer } from '@gambit/core';
import { MAX_PAID_ATTEMPTS, ONDEMAND_CAMPAIGN, PREFETCH_CAMPAIGN, appendLedger, clipId, keyOfJob, localDay, readOnDemandLedger, spentByDay, unitAttempts, VOICE_KEY } from './bridge.ts';
import type { GenJob, LedgerLine, OnDemandLine, OnDemandView, RunCli } from './bridge.ts';
import { ClipGenSettingsStore } from './budget.ts';
import { overlayPaths, readOverlayState } from './overlay.ts';
import { buildJob, renderSentence } from './render.ts';
import { ClipGenService, PRIORITY } from './service.ts';
import type { FinishInput } from './runner.ts';
import { rig, tempDir, writeLibrary } from './testkit.ts';
import type { OverlayTake, Rig } from './testkit.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

// ── sentences (ids) ──
const LEAD_N = { pool: 'v3.lead.advice', n: 1, piece: 'n' } as const; // «Давай сходим конём»
const LEAD_B = { pool: 'v3.lead.advice', n: 1, piece: 'b' } as const;
const MATE = { pool: 'v3.idea.mate', n: 1 } as const; // «— и это мат!»
const MATE4 = { pool: 'v3.idea.mate', n: 4 } as const; // «— ставим мат!»
const CASTLE = { pool: 'v3.whole.castle', n: 16 } as const; // «Время для рокировки!»
const CASTLE2 = { pool: 'v3.whole.castle', n: 2 } as const;
const CASTLE5 = { pool: 'v3.whole.castle', n: 5 } as const;
const CENTER = { pool: 'v3.self.center', n: 1 } as const; // «Пора заняться центром. Каким ходом?»
const QUIZ: ClipGenSentence = { quiz: { kind: 'whichPiece', options: [{ piece: 'n' }, { piece: 'b' }, { piece: 'r' }] } };

const req = (...sentences: ClipGenSentence[]): ClipGenRequest => ({ sentences });
const whole = (say: { pool: string; n: number }): ClipGenSentence => ({ parts: [say] });

function unitsOf(s: ClipGenSentence) {
  const r = renderSentence(s);
  if (!r.ok) throw new Error(r.code);
  return r.units;
}

function view(r: Rig): OnDemandView {
  return readOnDemandLedger(overlayPaths(r.overlayDir).ledger);
}

function append(r: Rig, line: OnDemandLine): void {
  mkdirSync(r.overlayDir, { recursive: true });
  appendLedger(overlayPaths(r.overlayDir).ledger, line as LedgerLine);
}

function jobFor(...sentences: ClipGenSentence[]): GenJob {
  const built = buildJob(sentences.flatMap(unitsOf), 101);
  if (!built) throw new Error('no job');
  return built.job;
}

/** A recorder that is enabled and switched on by the parent, on a fake account. */
function ready(o: Parameters<typeof rig>[1] = {}): { r: Rig; svc: ClipGenService } {
  const r = rig(cleanups, o);
  r.enable();
  return { r, svc: r.make() };
}

describe('the gates (their order, and health codes only)', () => {
  it('off, then every owner-side refusal in order, then the parent, then ready', () => {
    const r = rig(cleanups);
    expect(r.make({ clipGen: { enabled: false } }).health()).toEqual({ state: 'off', overlay: true });
    expect(r.make({ clipGen: { dataDirPin: null } }).health()).toMatchObject({ state: 'paused', reason: 'data-dir', until: null });
    expect(r.make({ clipGen: { dataDirPin: r.overlayDir } }).health()).toMatchObject({ reason: 'data-dir' });
    // the temp roots are only emptied together with a fake runner: without it a temp DATA_DIR refuses
    expect(r.make({ tempRoots: undefined }).health()).toMatchObject({ reason: 'temp-data' });
    expect(r.make({ runCli: undefined }).health()).toMatchObject({ reason: 'temp-data' });
    // the flag on without a usable overlay: paused with its own code (the owner sees why), never off in silence
    expect(r.make({ clipGen: { overlayDir: null } }).health()).toEqual({ state: 'paused', reason: 'no-overlay', until: null, overlay: false });
    expect(r.make({ clipGen: { overlayDir: join(r.config.repoRoot, 'voice-overlay') } }).health()).toEqual({ state: 'paused', reason: 'no-overlay', until: null, overlay: false });
    expect(r.make({ clipGen: { budgetMilli: 0 } }).health()).toMatchObject({ reason: 'no-budget' });
    expect(r.make().health()).toMatchObject({ state: 'paused', reason: 'parent-off' });
    r.enable();
    expect(r.make().health()).toEqual({ state: 'ready', overlay: true });
    // no CLI (the service built by hand on a DATA_DIR that is not temp): 'no-cli' before the parent's switch
    const svc = new ClipGenService({ ...direct(r), runCli: null });
    expect(svc.health()).toMatchObject({ reason: 'no-cli' });
    expect(r.hf.calls).toEqual([]);
  });

  it("the parent's switch is ON when the parent never chose (parents turn nothing on); an explicit off still stops", () => {
    const r = rig(cleanups, { parentStored: false });
    const svc = r.make();
    expect(svc.settings()).toEqual({ enabled: true, dailyCapMilli: 10_000 });
    expect(svc.health()).toEqual({ state: 'ready', overlay: true });
    svc.setSettings({ enabled: false, dailyCapMilli: 10_000 });
    expect(r.make().health()).toMatchObject({ state: 'paused', reason: 'parent-off' });
    expect(r.hf.calls).toEqual([]);
  });

  it('refused, a request queues nothing and calls nothing', async () => {
    const r = rig(cleanups);
    const svc = r.make();
    const res = svc.request(req(whole(CASTLE)));
    expect(res).toMatchObject({ results: [{ outcome: 'paused', keys: ['line:v3.whole.castle#16'] }], health: { reason: 'parent-off' }, queue: 0 });
    await svc.runQueue();
    expect(r.hf.calls).toEqual([]);
    expect(view(r).ledger.lines).toEqual([]);
  });

  it('ffmpeg / whisper missing: nothing is recorded (no-tools)', async () => {
    const r = rig(cleanups);
    r.enable();
    const svc = r.make({ toolsProblem: async () => 'ffmpeg not found' });
    svc.request(req(whole(CASTLE)));
    await svc.runQueue();
    expect(svc.health()).toMatchObject({ reason: 'no-tools' });
    expect(r.hf.calls).toEqual([]);
  });
});

/** The options of a service built by hand (for gates the factory cannot reach under vitest). */
function direct(r: Rig): ConstructorParameters<typeof ClipGenService>[0] {
  return {
    config: r.config,
    dataDirIsTemp: false,
    overlay: overlayPaths(r.overlayDir),
    settings: new ClipGenSettingsStore(r.db, r.config.clipGen.dailyMaxMilli),
    nickname: () => null,
    staticLibraryDir: null,
    toolsLedgerFile: null,
    runCli: r.hf.runCli,
    download: () => Promise.reject(new Error('no network')),
    finish: (input) => r.finisher.finish(input),
    protocol: r.hf.protocol(),
    toolsProblem: async () => null,
    now: () => r.clock.now,
    sleep: async () => undefined,
    random: () => 0.5,
    log: () => undefined,
    timers: false,
  };
}

describe('one recording, end to end', () => {
  it('renders, packs, prices, creates, waits, downloads, finishes and publishes — then the phrase is voiced', async () => {
    const { r, svc } = ready();
    const res = svc.request({ sentences: [{ parts: [LEAD_N, MATE] }, whole(CASTLE)], kind: 'teachTurn' });
    expect(res.results).toEqual([
      { outcome: 'queued', keys: ['line:v3.lead.advice@n#1', 'line:v3.idea.mate#1'] },
      { outcome: 'queued', keys: ['line:v3.whole.castle#16'] },
    ]);
    await svc.runQueue();
    // one pack job: the model checked once, the server's own price, then the job
    expect(r.hf.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual(['model get', 'generate cost', 'generate wait']);
    expect(r.hf.calls[2]).toEqual(['generate', 'wait', 'job0001', '--json', '--quiet', '--timeout', '3m', '--interval', '1s']);
    expect(r.hf.creates).toHaveLength(1);
    expect(r.hf.creates[0]).toMatchObject({ prompt: 'Давай сходим конём<#0.6#>— и это мат!<#0.6#>Время для рокировки!', take: 101, recipe: 'pack' });
    const v = view(r);
    expect([...v.ledger.jobs.values()]).toEqual([expect.objectContaining({ jobId: 'job0001', campaign: ONDEMAND_CAMPAIGN, state: 'charged', master: 'job0001.mp3', milli: 300 })]);
    expect(v.unresolved).toEqual([]);
    expect(r.finisher.calls).toHaveLength(1);
    expect(readOverlayState(overlayPaths(r.overlayDir).state).finished).toEqual({ job0001: { at: expect.any(String), failed: [] } });
    // the same utterance again: voiced, nothing more is paid
    expect(svc.request({ sentences: [{ parts: [LEAD_N, MATE] }, whole(CASTLE)] }).results.map((x) => x.outcome)).toEqual(['voiced', 'voiced']);
    await svc.runQueue();
    expect(r.hf.creates).toHaveLength(1);
    const status = svc.status();
    expect(status).toMatchObject({ enabled: true, queue: 0, busy: false, overlay: { units: 3 }, spent: { today: localDay(new Date(r.clock.now)), todayMilli: 300, totalMilli: 300, prefetchMilli: 0 }, caps: { dailyMilli: 10_000, dailyMaxMilli: 10_000, totalMilli: 20_000 }, givenUp: 0 });
  });

  it('refuses invalid ids per sentence and still records the valid ones', async () => {
    const { r, svc } = ready();
    const res = svc.request(req({ parts: [MATE] }, whole({ pool: 'v3.nope', n: 1 }), whole(CASTLE)));
    expect(res.results.map((x) => x.outcome)).toEqual(['invalid', 'invalid', 'queued']);
    await svc.runQueue();
    expect(r.hf.creates.map((j) => j.prompt)).toEqual(['Время для рокировки!']);
  });
});

describe('dedup by unit (S2)', () => {
  it('a unit recorded already (static library, overlay, the text index) is voiced; a `cont` lead cannot serve a lead said alone', async () => {
    const { r } = ready();
    const staticDir = tempDir('gambit-cg-static-', cleanups);
    writeLibrary(staticDir, [{ id: 'c0000000000001', key: 'line:v3.whole.castle#16', text: 'Время для рокировки!' }]);
    // the overlay holds «Давай сходим конём» under an OLD wording number (the writers inserted one): the text index finds it
    writeLibrary(r.overlayDir, [
      { id: 'c0000000000002', key: 'line:v3.lead.advice@n#9', text: 'Давай сходим конём', ctx: 'cont' },
      { id: 'c0000000000003', key: 'line:v3.idea.mate#1', text: '— и это мат!' },
    ]);
    const s = r.make({ staticLibraryDir: staticDir });
    const res = s.request(req(whole(CASTLE), { parts: [LEAD_N, MATE] }, { parts: [LEAD_N] }));
    expect(res.results.map((x) => x.outcome)).toEqual(['voiced', 'voiced', 'queued']);
    await s.runQueue();
    // only the lead said alone is recorded, with its «.»
    expect(r.hf.creates.map((j) => j.prompt)).toEqual(['Давай сходим конём.']);
  });

  it('a stale take (another text under the same key) is not a recording of it', async () => {
    const { r } = ready();
    writeLibrary(r.overlayDir, [{ id: 'c0000000000004', key: 'line:v3.whole.castle#16', text: 'Время для рокировки.' }]);
    const svc = r.make();
    expect(svc.request(req(whole(CASTLE))).results[0]?.outcome).toBe('queued');
  });

  it('queued or being recorded: never queued twice; a shared unit is recorded once', async () => {
    const { r, svc } = ready();
    // the same tail in two sentences and in a second request: one unit, one job
    const first = svc.request(req({ parts: [LEAD_N, MATE] }, { parts: [LEAD_B, MATE] }));
    const again = svc.request(req({ parts: [LEAD_B, MATE] }));
    expect(first.results.map((x) => x.outcome)).toEqual(['queued', 'queued']);
    expect(again.results.map((x) => x.outcome)).toEqual(['queued']);
    await svc.runQueue();
    expect(r.hf.creates.map((j) => j.prompt)).toEqual(['Давай сходим конём<#0.6#>— и это мат!<#0.6#>Давай сходим слоном']);
    // the lead of the second sentence is recorded without its tail (already in this pack), so it has no end mark
    expect(r.hf.creates[0]?.pieces.map((p) => ('key' in p ? p.key : '-'))).toEqual(['line:v3.lead.advice@n#1', 'line:v3.idea.mate#1', 'line:v3.lead.advice@b#1']);
  });

  it("a job of another instance (or the owner's prefetch) still pending in the ledger covers its units: recording", () => {
    const { r, svc } = ready();
    const job = jobFor(whole(CASTLE));
    append(r, { ev: 'created', at: new Date(r.clock.now).toISOString(), run: 'other', campaign: PREFETCH_CAMPAIGN, key: keyOfJob(job), jobId: 'jX', milli: 150, job });
    expect(svc.request(req(whole(CASTLE))).results[0]?.outcome).toBe('recording');
    // an unresolved intent too
    const job2 = jobFor(whole(CASTLE2));
    append(r, { ev: 'intent', at: new Date(r.clock.now).toISOString(), run: 'other', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(job2), milli: 150, job: job2 });
    expect(svc.request(req(whole(CASTLE2))).results[0]?.outcome).toBe('recording');
  });

  it("paid attempts used up, the owner's reject and the overlay's blocked[] are given up", () => {
    const { r } = ready();
    const at = new Date(r.clock.now).toISOString();
    for (const [i, take] of [101, 102].entries()) {
      const job = { ...jobFor(whole(CASTLE)), take };
      append(r, { ev: 'created', at, run: 'x', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(job), jobId: `j${i}`, milli: 150, job });
      append(r, { ev: 'charged', at, key: keyOfJob(job), jobId: `j${i}`, campaign: ONDEMAND_CAMPAIGN, milli: 150, status: 'completed', resultUrl: 'https://x.test/a.mp3' });
    }
    // the tools blocked castle#2 after its paid attempt (its take was rejected, say)
    const job2 = jobFor(whole(CASTLE2));
    append(r, { ev: 'created', at, run: 'x', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(job2), jobId: 'j2', milli: 150, job: job2 });
    append(r, { ev: 'charged', at, key: keyOfJob(job2), jobId: 'j2', campaign: ONDEMAND_CAMPAIGN, milli: 150, status: 'completed', resultUrl: 'https://x.test/b.mp3' });
    writeFileSync(overlayPaths(r.overlayDir).state, JSON.stringify({ v: 1, failingTrips: 0, lastTripAt: null, finished: { j0: { at, failed: ['line:v3.whole.castle#16'] }, j1: { at, failed: ['line:v3.whole.castle#16'] }, j2: { at, failed: ['line:v3.whole.castle#2'] } } }));
    writeLibrary(r.overlayDir, [], { blocked: ['line:v3.whole.castle#2'] });
    const svc = r.make();
    expect(unitAttempts(view(r), 'line:v3.whole.castle#16')).toBe(MAX_PAID_ATTEMPTS);
    expect(svc.request(req(whole(CASTLE), whole(CASTLE2), whole(CASTLE5))).results.map((x) => x.outcome)).toEqual(['given-up', 'given-up', 'queued']);
    expect(svc.status().givenUp).toBe(2);
  });

  it('attempts and blocked[] are about WORDS: a key whose number now names new words is recorded (never «given-up»)', async () => {
    const { r } = ready();
    const at = new Date(r.clock.now).toISOString();
    const KEY = 'line:v3.whole.castle#1';
    const [now] = unitsOf(whole({ pool: 'v3.whole.castle', n: 1 }));
    const OLD = 'Старая фраза про рокировку.';
    expect(now?.text).not.toBe(OLD);
    // two paid attempts at the OLD words of this number (the writers inserted a wording since), both failed, blocked
    for (const [i, take] of [101, 102].entries()) {
      const job: GenJob = { prompt: OLD, take, recipe: 'single', pieces: [{ key: KEY, text: OLD }] };
      append(r, { ev: 'created', at, run: 'x', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(job), jobId: `old${i}`, milli: 150, job });
      append(r, { ev: 'charged', at, key: keyOfJob(job), jobId: `old${i}`, campaign: ONDEMAND_CAMPAIGN, milli: 150, status: 'completed', resultUrl: 'https://x.test/o.mp3' });
    }
    writeFileSync(overlayPaths(r.overlayDir).state, JSON.stringify({ v: 1, failingTrips: 0, lastTripAt: null, finished: { old0: { at, failed: [KEY] }, old1: { at, failed: [KEY] } } }));
    writeLibrary(r.overlayDir, [], { blocked: [KEY] });
    const svc = r.make();
    expect(svc.request(req(whole({ pool: 'v3.whole.castle', n: 1 }))).results[0]?.outcome).toBe('queued');
    await svc.runQueue();
    expect(r.hf.creates.map((j) => [j.prompt, j.take])).toEqual([[now?.text, 101]]);
    // the old words themselves stay given up
    expect(unitAttempts(view(r), { key: KEY, text: OLD })).toBe(2);
    expect(unitAttempts(view(r), { key: KEY, text: now?.text as string })).toBe(1);
  });
});

describe('what a paid job says about its units', () => {
  it('a lead published only `ctx: cont` in a finished pack is recorded alone when it is said alone (never «recording» for good)', async () => {
    const r = rig(cleanups);
    r.enable();
    // the finish publishes the lead of the pack with a rising end: `cont`, usable only before its tail (said alone, with
    // its «.», it falls)
    const published: OverlayTake[] = [];
    const svc = r.make({
      finish: async (input) => {
        const pack = input.units.length > 1;
        for (const u of input.units) published.push({ id: u.id, key: u.key, text: u.text, ...(pack && u.key.startsWith('line:v3.lead.') ? { ctx: 'cont' as const } : {}) });
        writeLibrary(r.overlayDir, published);
        return { published: input.units.map((u) => u.id) };
      },
    });
    svc.request(req({ parts: [LEAD_N, MATE] }));
    await svc.runQueue();
    expect(readOverlayState(overlayPaths(r.overlayDir).state).finished).toEqual({ job0001: { at: expect.any(String), failed: [] } });
    expect(svc.request(req({ parts: [LEAD_N, MATE] })).results[0]?.outcome).toBe('voiced');
    // said alone: the cont take cannot serve it, the finished job does not cover it — one falling take alone («.»)
    expect(svc.request(req({ parts: [LEAD_N] })).results[0]?.outcome).toBe('queued');
    await svc.runQueue();
    expect(r.hf.creates.map((j) => [j.prompt, j.take])).toEqual([
      ['Давай сходим конём<#0.6#>— и это мат!', 101],
      ['Давай сходим конём.', 102],
    ]);
    // a fresh instance agrees (the notes, not memory)
    expect(r.make().request(req({ parts: [LEAD_N] })).results[0]?.outcome).toBe('voiced');
  });

  it("a take processed but not yet verified is still being checked: 'recording', never a paid take 2", async () => {
    const { r, svc } = ready();
    const at = new Date(r.clock.now).toISOString();
    // the owner's prefetch: charged, processed (qa 'auto'), verify not run yet
    const job = jobFor(whole(CASTLE));
    append(r, { ev: 'created', at, run: 'owner', campaign: PREFETCH_CAMPAIGN, key: keyOfJob(job), jobId: 'pf1', milli: 150, job });
    append(r, { ev: 'charged', at, key: keyOfJob(job), jobId: 'pf1', campaign: PREFETCH_CAMPAIGN, milli: 150, status: 'completed', resultUrl: 'https://x.test/p.mp3' });
    const id = clipId(VOICE_KEY, job.prompt, 0, job.take);
    const store = (unit: Record<string, unknown>) => writeFileSync(overlayPaths(r.overlayDir).units, JSON.stringify({ v: 1, voiceKey: VOICE_KEY, units: { [id]: { id, key: 'line:v3.whole.castle#16', text: 'Время для рокировки!', jobId: 'pf1', flags: [], ...unit } } }));
    store({ qa: 'auto' });
    expect(svc.request(req(whole(CASTLE))).results[0]?.outcome).toBe('recording');
    // verify ran while the recogniser was broken: still unknown
    store({ qa: 'needsEar', flags: ['asr-error'] });
    expect(svc.request(req(whole(CASTLE))).results[0]?.outcome).toBe('recording');
    await svc.runQueue();
    expect(r.hf.creates).toEqual([]);
    // really transcribed and turned down: now its one paid take 2 may go
    store({ qa: 'needsEar', flags: ['asr:0.61'], asr: { heard: 'x', score: 0.61, ok: false, missing: [], model: 'm', at } });
    expect(svc.request(req(whole(CASTLE))).results[0]?.outcome).toBe('queued');
    await svc.runQueue();
    expect(r.hf.creates.map((j) => [j.prompt, j.take])).toEqual([['Время для рокировки!', 102]]);
  });

  it("a server finish that processed the take but failed before its note: 'recording' until the retry, not a second job", async () => {
    const { r } = ready();
    let calls = 0;
    const svc = r.make({
      finish: async (input) => {
        calls += 1;
        // `process` wrote the unit store (qa 'auto'), then `verify` timed out
        const u = input.units[0]!;
        writeFileSync(overlayPaths(r.overlayDir).units, JSON.stringify({ v: 1, voiceKey: VOICE_KEY, units: { [u.id]: { id: u.id, key: u.key, text: u.text, jobId: input.jobId, flags: [], qa: 'auto' } } }));
        if (calls === 1) throw new Error('voice:verify timed out');
        writeLibrary(r.overlayDir, [{ id: u.id, key: u.key, text: u.text }]);
        return { published: [u.id] };
      },
    });
    svc.request(req(whole(CASTLE)));
    await svc.runQueue();
    r.clock.now += 5_000;
    expect(svc.request(req(whole(CASTLE))).results[0]?.outcome).toBe('recording');
    await svc.runQueue();
    expect(r.hf.creates).toHaveLength(1);
    r.clock.now += 31_000;
    await svc.runQueue();
    expect(calls).toBe(2);
    expect(svc.request(req(whole(CASTLE))).results[0]?.outcome).toBe('voiced');
    expect(r.hf.creates).toHaveLength(1);
  });

  it('a finish that fails every retry: noted stuck — «paused», not «recording»; the card counts it; the next start finishes it', async () => {
    const { r } = ready();
    let broken = true;
    const finish = async (input: FinishInput) => {
      if (broken) throw new Error('voice:process timed out');
      return r.finisher.finish(input);
    };
    const svc = r.make({ finish });
    svc.request(req(whole(CASTLE)));
    for (let i = 0; i < 4; i++) {
      await svc.runQueue();
      r.clock.now += 31_000;
    }
    expect(readOverlayState(overlayPaths(r.overlayDir).state).stuck).toEqual({ job0001: { at: expect.any(String), step: 'finish' } });
    r.clock.now += 16 * 60_000; // past the breaker's pause
    expect(svc.request(req(whole(CASTLE))).results[0]?.outcome).toBe('paused');
    expect(svc.status()).toMatchObject({ stuck: 1, queue: 0 });
    await svc.runQueue();
    expect(r.hf.creates).toHaveLength(1);
    // the owner restarts the server once the tools work again: resumed, finished, voiced — nothing paid again
    broken = false;
    const again = r.make({ finish });
    again.start();
    await again.runQueue();
    expect(again.request(req(whole(CASTLE))).results[0]?.outcome).toBe('voiced');
    expect(again.status().stuck).toBe(0);
    expect(readOverlayState(overlayPaths(r.overlayDir).state).stuck).toEqual({});
    expect(r.hf.creates).toHaveLength(1);
  });

  it('twins — the same words under another piece’s key — are one unit while the first job is still pending', async () => {
    const { r, svc } = ready();
    const ESCAPE_N = { pool: 'v3.idea.escape', n: 1, piece: 'n' } as const;
    const ESCAPE_B = { pool: 'v3.idea.escape', n: 1, piece: 'b' } as const;
    const [, tailN] = unitsOf({ parts: [LEAD_N, ESCAPE_N] });
    const [, tailB] = unitsOf({ parts: [LEAD_B, ESCAPE_B] });
    expect(tailN?.key).not.toBe(tailB?.key);
    expect(tailN?.text).toBe(tailB?.text);
    // the first job's wait times out: it stays pending in the ledger
    r.hf.waitPlan = () => 'pending';
    svc.request(req({ parts: [LEAD_N, ESCAPE_N] }));
    await svc.runQueue();
    expect(svc.request(req({ parts: [LEAD_B, ESCAPE_B] })).results[0]?.outcome).toBe('queued');
    await svc.runQueue();
    expect(r.hf.creates.map((j) => j.prompt)).toEqual([`Давай сходим конём<#0.6#>${tailN?.text}`, 'Давай сходим слоном']);
    // both twins in ONE request: packed once
    const other = ready();
    other.svc.request(req({ parts: [LEAD_N, ESCAPE_N] }, { parts: [LEAD_B, ESCAPE_B] }));
    await other.svc.runQueue();
    expect(other.r.hf.creates.map((j) => j.prompt)).toEqual([`Давай сходим конём<#0.6#>${tailN?.text}<#0.6#>Давай сходим слоном`]);
  });

  it('the parent switches recording off (or the server shuts down) while the price is asked: no job is created', async () => {
    for (const stop of ['parent', 'shutdown'] as const) {
      const r = rig(cleanups);
      r.enable();
      let svc: ClipGenService | null = null;
      const runCli: RunCli = async (args) => {
        if (args[0] === 'generate' && args[1] === 'cost') {
          if (stop === 'parent') svc?.setSettings({ enabled: false, dailyCapMilli: 10_000 });
          else void svc?.dispose();
        }
        return r.hf.runCli(args);
      };
      svc = r.make({ runCli });
      svc.request(req(whole(CASTLE)));
      await svc.runQueue();
      expect(r.hf.calls.map((c) => `${c[0]} ${c[1]}`), stop).toEqual(['model get', 'generate cost']);
      expect(r.hf.creates, stop).toEqual([]);
      expect(view(r).unresolved, stop).toEqual([]);
      expect(view(r).ledger.lines, stop).toEqual([]);
    }
  });
});

describe('the queue', () => {
  it('the stage 1–2 options sentence first, then the lesson turn, then reactions; a piece variant a little later', async () => {
    const { r, svc } = ready();
    // hold the machine-wide lock (the owner's tool is recording): everything waits in the queue
    const lock = join(r.overlayDir, 'higgsfield.lock');
    writeFileSync(lock, '1');
    svc.request({ sentences: [whole(CASTLE)], kind: 'praise' });
    await svc.runQueue();
    expect(svc.health()).toMatchObject({ state: 'paused', reason: 'tool-busy' });
    // a timed pause keeps new requests queued
    expect(svc.request({ sentences: [{ parts: [LEAD_N] }], kind: 'teachTurn' }).results[0]?.outcome).toBe('queued');
    svc.request({ sentences: [whole(CASTLE2)], kind: 'teachTurn' });
    svc.request({ sentences: [QUIZ], kind: 'teachTurn' });
    expect(svc.queueLength()).toBe(4);
    const { rmSync } = await import('node:fs');
    rmSync(lock);
    r.clock.now += 31_000;
    await svc.runQueue();
    expect(r.hf.creates.map((j) => j.prompt)).toEqual(['Конём, слоном или ладьёй?', 'Скорее в домик: рокировка!', 'Давай сходим конём.', 'Время для рокировки!']);
    expect(PRIORITY.quiz).toBeGreaterThan(PRIORITY.teach);
  });

  it('a new-recording item expires after 15 minutes', async () => {
    const { r, svc } = ready();
    writeFileSync(join(r.overlayDir, 'higgsfield.lock'), '1');
    svc.request(req(whole(CASTLE)));
    await svc.runQueue();
    r.clock.now += 16 * 60_000;
    expect(svc.status().queue).toBe(1);
    svc.request(req(whole(CASTLE2)));
    expect(svc.queueLength()).toBe(1);
  });
});

describe('the caps', () => {
  it('a request that would cross the daily cap is refused as budget; the next day it is recorded', async () => {
    const r = rig(cleanups);
    r.enable({ dailyCapMilli: 300 });
    const svc = r.make();
    svc.request(req(whole(CASTLE)));
    svc.request(req(whole(CASTLE2)));
    expect(svc.request(req(whole(CASTLE5))).results[0]?.outcome).toBe('budget');
    await svc.runQueue();
    expect(r.hf.creates).toHaveLength(2);
    expect(svc.health()).toMatchObject({ state: 'paused', reason: 'day-cap', until: new Date(new Date(r.clock.now).setHours(24, 0, 0, 0)).getTime() });
    r.clock.now += 24 * 60 * 60_000;
    expect(svc.health().state).toBe('ready');
    svc.request(req(whole(CASTLE5)));
    await svc.runQueue();
    expect(r.hf.creates).toHaveLength(3);
  });

  it("the parent's cap can only be lower than CLIP_GEN_DAILY_MAX; the total budget stops everything", async () => {
    const r = rig(cleanups, { clipGen: { dailyMaxMilli: 3_000, budgetMilli: 450 } });
    r.enable({ dailyCapMilli: 10_000 });
    const svc = r.make();
    expect(svc.status().caps).toEqual({ dailyMilli: 3_000, dailyMaxMilli: 3_000, totalMilli: 450 });
    for (const s of [CASTLE, CASTLE2, CASTLE5]) svc.request(req(whole(s)));
    await svc.runQueue();
    expect(svc.health()).toMatchObject({ state: 'paused', reason: 'total-cap', until: null });
    expect(svc.request(req(whole(CENTER))).results[0]?.outcome).toBe('budget');
    expect(spentByDay(view(r), undefined, ONDEMAND_CAMPAIGN).totalMilli).toBeLessThanOrEqual(450);
  });

  it("pending jobs and unresolved intents count at full price (S1); the owner's prefetch is not the child's", () => {
    const r = rig(cleanups, { clipGen: { budgetMilli: 1_000 } });
    r.enable();
    const at = new Date(r.clock.now).toISOString();
    const a = jobFor(whole(CASTLE));
    const b = jobFor(whole(CASTLE2));
    const c = jobFor(whole(CASTLE5));
    append(r, { ev: 'intent', at, run: 'x', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(a), milli: 450, job: a });
    append(r, { ev: 'created', at, run: 'x', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(b), jobId: 'jb', milli: 450, job: b });
    append(r, { ev: 'created', at, run: 'x', campaign: PREFETCH_CAMPAIGN, key: keyOfJob(c), jobId: 'jc', milli: 150, job: c });
    const svc = r.make();
    expect(svc.status().spent).toMatchObject({ todayMilli: 900, totalMilli: 900, prefetchMilli: 150 });
    expect(svc.request(req(whole(CENTER))).results[0]?.outcome).toBe('budget');
  });
});

describe('resume from the overlay ledger', () => {
  function seeded(lines: (job: GenJob, at: string) => OnDemandLine[], o: { campaign?: string } = {}): { r: Rig; job: GenJob } {
    const r = rig(cleanups);
    r.enable();
    const job = jobFor(whole(CASTLE));
    const at = new Date(r.clock.now - 60_000).toISOString();
    for (const line of lines(job, at)) append(r, o.campaign ? ({ ...line, campaign: o.campaign } as OnDemandLine) : line);
    return { r, job };
  }
  const created = (job: GenJob, at: string, jobId = 'job0001'): OnDemandLine => ({ ev: 'created', at, run: 'old', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(job), jobId, milli: 150, job });
  const charged = (job: GenJob, at: string, jobId = 'job0001'): OnDemandLine => ({ ev: 'charged', at, key: keyOfJob(job), jobId, campaign: ONDEMAND_CAMPAIGN, milli: 150, status: 'completed', resultUrl: 'https://cdn.example.test/old.mp3' });

  it('an intent whose job was made: adopted, waited for, downloaded, finished — never created again', async () => {
    const { r, job } = seeded((j, at) => [{ ev: 'intent', at, run: 'old', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(j), milli: 150, job: j }]);
    r.hf.jobs.set('job0001', { id: 'job0001', prompt: job.prompt, status: 'completed' });
    const svc = r.make();
    svc.start();
    await svc.runQueue();
    expect(r.hf.creates).toEqual([]);
    expect([...view(r).ledger.jobs.values()]).toEqual([expect.objectContaining({ jobId: 'job0001', state: 'charged', adopted: true, master: 'job0001.mp3' })]);
    expect(r.finisher.calls.map((c) => c.jobId)).toEqual(['job0001']);
    expect(svc.request(req(whole(CASTLE))).results[0]?.outcome).toBe('voiced');
  });

  it('an intent whose job was never made: absent — the unit is free again', async () => {
    const { r } = seeded((j, at) => [{ ev: 'intent', at, run: 'old', campaign: ONDEMAND_CAMPAIGN, key: keyOfJob(j), milli: 150, job: j }]);
    const svc = r.make();
    expect(svc.status().spent.totalMilli).toBe(150);
    svc.start();
    await svc.runQueue();
    expect(view(r).unresolved).toEqual([]);
    expect(svc.status().spent.totalMilli).toBe(0);
    expect(r.hf.calls).toEqual([]);
    expect(svc.request(req(whole(CASTLE))).results[0]?.outcome).toBe('queued');
  });

  it('a pending job is waited for (never re-created); a charged one downloaded; a downloaded one finished', async () => {
    for (const [lines, expectCalls] of [
      [(j: GenJob, at: string) => [created(j, at)], ['generate wait']],
      [(j: GenJob, at: string) => [created(j, at), charged(j, at)], []],
      [(j: GenJob, at: string) => [created(j, at), charged(j, at), { ev: 'downloaded', at, key: keyOfJob(j), jobId: 'job0001', master: 'job0001.mp3', bytes: 512, sha256: 'f'.repeat(64) } as OnDemandLine], []],
    ] as const) {
      const { r, job } = seeded(lines);
      r.hf.jobs.set('job0001', { id: 'job0001', prompt: job.prompt, status: 'completed' });
      const svc = r.make();
      svc.start();
      await svc.runQueue();
      expect(r.hf.creates).toEqual([]);
      expect(r.hf.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual(expectCalls);
      expect(view(r).ledger.jobs.get('job0001')).toMatchObject({ state: 'charged', master: 'job0001.mp3' });
      expect(r.finisher.calls.map((c) => c.jobId)).toEqual(['job0001']);
      expect(r.finisher.calls[0]?.units).toEqual([{ id: clipId(VOICE_KEY, job.prompt, 0, 101), key: 'line:v3.whole.castle#16', text: 'Время для рокировки!' }]);
    }
  });

  it("a finished or failed job, and the owner's prefetch, are left alone", async () => {
    for (const { lines, campaign } of [
      { lines: (j: GenJob, at: string) => [created(j, at), { ev: 'failed', at, key: keyOfJob(j), jobId: 'job0001', campaign: ONDEMAND_CAMPAIGN, status: 'failed' } as OnDemandLine], campaign: undefined },
      { lines: (j: GenJob, at: string) => [created(j, at)], campaign: PREFETCH_CAMPAIGN },
    ]) {
      const { r } = seeded(lines, campaign ? { campaign } : {});
      const svc = r.make();
      svc.start();
      await svc.runQueue();
      expect(r.hf.calls).toEqual([]);
      expect(r.finisher.calls).toEqual([]);
    }
    const { r } = seeded((j, at) => [created(j, at), charged(j, at)]);
    writeFileSync(overlayPaths(r.overlayDir).state, JSON.stringify({ v: 1, failingTrips: 0, lastTripAt: null, finished: { job0001: { at: 'x', failed: [] } } }));
    appendFileSync(overlayPaths(r.overlayDir).ledger, `${JSON.stringify({ ev: 'downloaded', at: 'x', key: 'k', jobId: 'job0001', master: 'job0001.mp3', bytes: 1, sha256: 'f' })}\n`);
    const svc = r.make();
    svc.start();
    await svc.runQueue();
    expect(r.finisher.calls).toEqual([]);
  });

  it('a paid job is brought home even without ffmpeg / whisper; only its finish waits for them', async () => {
    const r = rig(cleanups);
    r.enable();
    const job = jobFor(whole(CASTLE));
    append(r, created(job, new Date(r.clock.now).toISOString()));
    r.hf.jobs.set('job0001', { id: 'job0001', prompt: job.prompt, status: 'completed' });
    let tools: string | null = 'whisper-cli not found';
    const svc = r.make({ toolsProblem: async () => tools });
    svc.start();
    await svc.runQueue();
    expect(view(r).ledger.jobs.get('job0001')).toMatchObject({ state: 'charged', master: 'job0001.mp3' });
    expect(r.finisher.calls).toEqual([]);
    expect(svc.health()).toMatchObject({ reason: 'no-tools' });
    // new recordings wait too
    expect(svc.request(req(whole(CASTLE2))).results[0]?.outcome).toBe('paused');
    tools = null;
    r.clock.now += 10 * 60_000 + 1;
    await svc.runQueue();
    expect(r.finisher.calls.map((c) => c.jobId)).toEqual(['job0001']);
    expect(svc.health().state).toBe('ready');
  });

  it("nothing resumes while a gate is closed (the parent's switch off): no CLI call at all", async () => {
    const r = rig(cleanups);
    const job = jobFor(whole(CASTLE));
    append(r, created(job, new Date(r.clock.now).toISOString()));
    const svc = r.make();
    svc.start();
    await svc.runQueue();
    expect(r.hf.calls).toEqual([]);
    expect(svc.queueLength()).toBe(1);
    r.enable();
    svc.setSettings({ enabled: true, dailyCapMilli: 10_000 });
    await svc.runQueue();
    expect(r.hf.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual(['generate wait']);
  });
});

describe('the breaker', () => {
  it('rate, login, no-credits and an unknown create result pause for their time, then the job goes through', async () => {
    for (const [plan, reason, ms] of [
      ['rate', 'rate', 60_000],
      ['login', 'login', 30 * 60_000],
      ['no-credits', 'no-credits', 60 * 60_000],
    ] as const) {
      const { r, svc } = ready();
      let first = true;
      r.hf.createPlan = () => (first ? ((first = false), plan) : 'ok');
      svc.request(req(whole(CASTLE)));
      await svc.runQueue();
      expect(svc.health()).toMatchObject({ state: 'paused', reason, until: r.clock.now + ms });
      r.clock.now += ms + 1;
      expect(svc.health().state).toBe('ready');
      // a pause longer than an item's 15 minutes drops it: the next occurrence of the phrase asks again
      svc.request(req(whole(CASTLE)));
      await svc.runQueue();
      expect(r.hf.creates).toHaveLength(1);
    }
  });

  it('an ambiguous create: the intent counts in full, covers its unit, and is adopted later', async () => {
    const { r, svc } = ready();
    r.hf.createPlan = () => 'crash-made';
    svc.request(req(whole(CASTLE)));
    await svc.runQueue();
    expect(svc.health()).toMatchObject({ reason: 'unresolved' });
    expect(svc.status().spent.totalMilli).toBe(150);
    expect(svc.request(req(whole(CASTLE))).results[0]?.outcome).toBe('recording');
    r.hf.createPlan = () => 'ok';
    r.clock.now += 61_000;
    await svc.runQueue();
    expect(view(r).unresolved).toEqual([]);
    expect([...view(r).ledger.jobs.values()]).toEqual([expect.objectContaining({ state: 'charged', adopted: true })]);
    expect(r.hf.creates).toHaveLength(1);
  });

  it('a changed price or model, a duplicate and a failed audit stop until a restart', async () => {
    const price = ready();
    const cost = price.r.hf.runCli;
    const svc1 = price.r.make({ runCli: async (args) => (args[1] === 'cost' ? { code: 0, stdout: '{"credits": 0.3}', stderr: '' } : cost(args)) });
    svc1.request(req(whole(CASTLE)));
    await svc1.runQueue();
    expect(svc1.health()).toMatchObject({ reason: 'price', until: null });
    expect(price.r.hf.creates).toEqual([]);

    const model = ready();
    const svc2 = model.r.make({ runCli: async (args) => (args[0] === 'model' ? { code: 0, stdout: '{"params": []}', stderr: '' } : model.r.hf.runCli(args)) });
    svc2.request(req(whole(CASTLE)));
    await svc2.runQueue();
    expect(svc2.health()).toMatchObject({ reason: 'model', until: null });

    const dup = ready();
    const proto = dup.r.hf.protocol();
    const svc3 = dup.r.make({ protocol: { ...proto, createJob: async () => ({ ok: false, reason: 'duplicate', message: 'two jobs' }) } });
    svc3.request(req(whole(CASTLE)));
    await svc3.runQueue();
    expect(svc3.health()).toMatchObject({ reason: 'duplicate', until: null });

    const audit = ready();
    append(audit.r, { ev: 'audit', at: 'x', run: 'owner', ok: false, deltaMilli: 900, minMilli: 0, maxMilli: 450 });
    audit.svc.request(req(whole(CASTLE)));
    await audit.svc.runQueue();
    expect(audit.svc.health()).toMatchObject({ reason: 'audit', until: null });
    expect(audit.r.hf.creates).toEqual([]);
  });

  it('three failures trip `failing` for 15 min; the third trip lasts until a restart, and restarts remember it', async () => {
    const { r, svc } = ready();
    r.hf.createPlan = () => 'error';
    const trip = async (s: ClipGenService): Promise<void> => {
      for (let i = 0; i < 3; i++) {
        s.request(req(whole([CASTLE, CASTLE2, CASTLE5][i]!)));
        s.request(req(whole(CENTER)));
        await s.runQueue();
        r.clock.now += 31_000;
        await s.runQueue();
      }
    };
    await trip(svc);
    expect(svc.health()).toMatchObject({ reason: 'failing', until: expect.any(Number) });
    expect(readOverlayState(overlayPaths(r.overlayDir).state)).toMatchObject({ failingTrips: 1 });
    r.clock.now += 16 * 60_000;
    await trip(svc);
    expect(svc.health()).toMatchObject({ reason: 'failing', until: expect.any(Number) });
    r.clock.now += 16 * 60_000;
    // a restart does not reset the count
    const again = r.make();
    await trip(again);
    expect(again.health()).toMatchObject({ reason: 'failing', until: null });
    expect(readOverlayState(overlayPaths(r.overlayDir).state)).toMatchObject({ failingTrips: 3 });
  });
});

describe('a failed check (D6)', () => {
  it('gets one paid take 2 alone; failing again, the unit is given up', async () => {
    const { r, svc } = ready();
    r.pass = (u) => u.key !== 'line:v3.idea.mate#1';
    svc.request(req({ parts: [LEAD_N, MATE] }));
    await svc.runQueue();
    expect(r.hf.creates.map((j) => [j.prompt, j.take])).toEqual([
      ['Давай сходим конём<#0.6#>— и это мат!', 101],
      ['— и это мат!', 102],
    ]);
    expect(unitAttempts(view(r), 'line:v3.idea.mate#1')).toBe(2);
    expect(svc.request(req({ parts: [LEAD_N, MATE] })).results[0]?.outcome).toBe('given-up');
    expect(svc.status().givenUp).toBe(1);
    await svc.runQueue();
    expect(r.hf.creates).toHaveLength(2);
    // the owner's «redo» on its take allows one more
    const takeId = clipId(VOICE_KEY, '— и это мат!', 0, 102);
    writeFileSync(overlayPaths(r.overlayDir).units, JSON.stringify({ v: 1, voiceKey: VOICE_KEY, units: { [takeId]: { id: takeId, key: 'line:v3.idea.mate#1', text: '— и это мат!', qa: 'needsEar' } } }));
    writeFileSync(overlayPaths(r.overlayDir).review, JSON.stringify({ [takeId]: { verdict: 'redo' } }));
    r.pass = () => true;
    expect(svc.request(req({ parts: [LEAD_N, MATE] })).results[0]?.outcome).toBe('queued');
    await svc.runQueue();
    expect(r.hf.creates.map((j) => j.take)).toEqual([101, 102, 103]);
  });
});

// ───────────────────────── the property test ─────────────────────────

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL: ClipGenSentence[] = [
  { parts: [LEAD_N] },
  { parts: [LEAD_N, MATE] },
  { parts: [LEAD_B, MATE] },
  { parts: [LEAD_N, MATE4] },
  whole(CASTLE),
  whole(CASTLE2),
  whole(CASTLE5),
  whole(CENTER),
  { parts: [{ pool: 'v3.self.center', n: 3, g: 'f' }] },
  QUIZ,
];

describe('the caps and the attempts hold under random sequences, restarts and two instances (S1, S2, S6)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}`, async () => {
      const rand = prng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
      const DAILY = 900;
      const TOTAL = 1_500;
      const r = rig(cleanups, { clipGen: { budgetMilli: TOTAL, dailyMaxMilli: 5_000 } });
      r.enable({ dailyCapMilli: DAILY });
      r.hf.createPlan = () => pick(['ok', 'ok', 'ok', 'ok', 'ok', 'crash-made', 'crash-none', 'rate', 'error'] as const);
      r.hf.waitPlan = () => pick(['completed', 'completed', 'completed', 'failed', 'pending'] as const);
      r.hf.downloadPlan = () => rand() < 0.9;
      r.pass = () => rand() < 0.75;
      const instances = [r.make(), r.make()];
      for (const s of instances) s.start();

      const check = (): void => {
        const v = view(r);
        const spend = spentByDay(v, undefined, ONDEMAND_CAMPAIGN);
        expect(spend.totalMilli).toBeLessThanOrEqual(TOTAL);
        for (const [day, milli] of Object.entries(spend.days)) expect(milli, day).toBeLessThanOrEqual(DAILY);
        // every paid attempt at a unit is its first, or a take 2 after a check that failed it — never a second live one
        const notes = readOverlayState(overlayPaths(r.overlayDir).state);
        const live = new Map<string, number>();
        const bump = (job: GenJob, failedHere: (key: string) => boolean): void => {
          for (const p of job.pieces) {
            if ('discard' in p || failedHere(p.key)) continue;
            const id = `${p.key}|${p.text}`;
            live.set(id, (live.get(id) ?? 0) + 1);
          }
        };
        for (const job of v.ledger.jobs.values()) {
          if (job.state === 'failed') continue;
          bump(job.job, (key) => notes.finished[job.jobId]?.failed.includes(key) === true);
        }
        for (const intent of v.unresolved) bump(intent.job, () => false);
        for (const [id, n] of live) expect(n, id).toBeLessThanOrEqual(1);
        for (const job of v.ledger.jobs.values()) for (const p of job.job.pieces) if (!('discard' in p)) expect(unitAttempts(v, p.key), p.key).toBeLessThanOrEqual(MAX_PAID_ATTEMPTS);
      };

      for (let step = 0; step < 200; step++) {
        const roll = rand();
        const i = Math.floor(rand() * instances.length);
        const svc = instances[i] as ClipGenService;
        if (roll < 0.45) {
          const n = 1 + Math.floor(rand() * 3);
          svc.request({ sentences: Array.from({ length: n }, () => pick(POOL)), kind: pick(['teachTurn', 'teachReaction', 'praise'] as const) });
        } else if (roll < 0.75) {
          await svc.runQueue();
        } else if (roll < 0.9) {
          r.clock.now += pick([5_000, 31_000, 61_000, 16 * 60_000, 6 * 60 * 60_000]);
        } else {
          // a restart (the process died): a new instance resumes from the overlay
          await svc.dispose();
          instances[i] = r.make();
          instances[i]!.start();
        }
        check();
      }
      for (const s of instances) await s.runQueue();
      check();
      // something was actually recorded (the test exercises the paid path)
      expect(r.hf.creates.length).toBeGreaterThan(0);
    });
  }
});

// ───────────────────────── whole catalogue sentences of the older events (greeting, answers, replies…) ─────────────────────────

/** The committed starter library (apps/web/public/voice): read only. */
const PILOT_VOICE = fileURLToPath(new URL('../../../../apps/web/public/voice/', import.meta.url));
const line = (l: ClipGenLine): ClipGenSentence => ({ line: l });

describe('whole catalogue sentences (the older events): one budget, the same dedup, the starter library', () => {
  it('a greeting records in one pack job, is published under the starter set keys and pools, and is voiced from then on', async () => {
    const { r, svc } = ready();
    const res = svc.request({ sentences: [line({ id: 'greet.hello.day', n: 1 }), line({ id: 'greet.win', n: 2 })], kind: 'greeting' });
    expect(res.results).toEqual([
      { outcome: 'queued', keys: ['line:greet.hello.day#1'] },
      { outcome: 'queued', keys: ['line:greet.win#2'] },
    ]);
    await svc.runQueue();
    expect(r.hf.creates).toHaveLength(1);
    expect(r.hf.creates[0]).toMatchObject({ prompt: 'Добрый день!<#0.6#>Помню твою прошлую победу. Поехали дальше?', take: 101, recipe: 'pack', tier: 'ondemand' });
    expect(r.hf.creates[0]?.pieces).toEqual([
      expect.objectContaining({ key: 'line:greet.hello.day#1', text: 'Добрый день!', role: 'whole', pool: 'greet.hello.day' }),
      expect.objectContaining({ key: 'line:greet.win#2', role: 'whole', pool: 'greet.win', pools: ['greet.win', 'greet.win/m', 'greet.win/f'] }),
    ]);
    expect(r.finisher.published.map((t) => t.key)).toEqual(['line:greet.hello.day#1', 'line:greet.win#2']);
    // the same greeting again: voiced, nothing more is paid; the spend is the same one budget as the lessons'
    expect(svc.request({ sentences: [line({ id: 'greet.hello.day', n: 1 }), line({ id: 'greet.win', n: 2 })], kind: 'greeting' }).results.map((x) => x.outcome)).toEqual(['voiced', 'voiced']);
    await svc.runQueue();
    expect(r.hf.creates).toHaveLength(1);
    expect(svc.status()).toMatchObject({ spent: { todayMilli: 300, totalMilli: 300 }, recorded: 2 });
  });

  it("a wording the starter library already has is 'voiced' and never paid — every recordable starter line", async () => {
    const { r } = ready();
    const svc = r.make({ staticLibraryDir: PILOT_VOICE });
    const index = JSON.parse(readFileSync(join(PILOT_VOICE, 'index.json'), 'utf8')) as { default: string; voices: Record<string, string> };
    const manifest = JSON.parse(readFileSync(join(PILOT_VOICE, index.voices[index.default] as string), 'utf8')) as { keys: Record<string, string[]> };
    const pilot: ClipGenLine[] = [];
    for (const key of Object.keys(manifest.keys)) {
      const k = parseLineUnitKey(key);
      const l: ClipGenLine | null = k ? { id: k.pool, n: k.n, ...(k.piece ? { piece: k.piece } : {}), ...(k.g ? { g: k.g } : {}) } : null;
      if (l !== null && resolveClipGenLine(l).ok) pilot.push(l);
    }
    expect(pilot.length).toBeGreaterThan(20);
    expect(pilot).toContainEqual({ id: 'greet.hello.evening', n: 1 });
    for (const l of pilot) expect(svc.request({ sentences: [line(l)], kind: 'greeting' }).results[0]?.outcome, JSON.stringify(l)).toBe('voiced');
    // a wording the starter set does not have is recorded next to them
    expect(svc.request({ sentences: [line({ id: 'greet.hello.evening', n: 2 })], kind: 'greeting' }).results[0]?.outcome).toBe('queued');
    await svc.runQueue();
    expect(r.hf.creates.map((j) => j.prompt)).toEqual(['Вечер добрый!']);
  });

  it('the same words on two catalogue lines are one unit: bought once, voiced under every key', async () => {
    const { r, svc } = ready();
    const ask = (id: string, n: number) => svc.request({ sentences: [line({ id, n })], kind: 'greeting' }).results[0]?.outcome;
    // «Привет!» of the day, evening and night greetings, the opener and the game's hello; «Поторопись!» of the teacher
    // and of the game; «Ход конём!» of the praise and of a poke
    const same: [string, number][] = [
      ['greet.hello.day', 5],
      ['greet.hello.evening', 5],
      ['greet.hello.night', 3],
      ['start.open.greet', 14],
      ['hello.game', 1],
      ['teach.hurry', 1],
      ['shell.hurry', 1],
      ['poke', 2],
      ['praise.generic', 7],
    ];
    expect(same.map(([id, n]) => ask(id, n))).toEqual(['queued', 'queued', 'queued', 'queued', 'queued', 'queued', 'queued', 'queued', 'queued']);
    await svc.runQueue();
    expect(r.hf.creates.map((j) => j.prompt).sort()).toEqual(['Поторопись!', 'Привет!', 'Ход конём!']);
    // published once, found under every key (the overlay's manifest folds the twins in; the fake finish does not)
    expect(same.map(([id, n]) => ask(id, n))).toEqual(same.map(() => 'voiced'));
    await svc.runQueue();
    expect(r.hf.creates).toHaveLength(3);
  });

  it('refused ids are invalid, cost nothing and do not hold back the valid ones', async () => {
    const { r, svc } = ready();
    const res = svc.request(
      req(
        line({ id: 'teach.head.advice', n: 1 }),
        line({ id: 'bark.cheer', n: 1 }),
        line({ id: 'generic.greeting', n: 1 }),
        line({ id: 'v3.whole.castle', n: 16 }),
        line({ id: 'greet.win', n: 1 }),
        line({ id: 'greet.hello.day', n: 3 }),
      ),
    );
    expect(res.results.map((x) => x.outcome)).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'queued']);
    await svc.runQueue();
    expect(r.hf.creates.map((j) => j.prompt)).toEqual(['Здравствуй!']);
  });

  it("the child's nickname is never recorded, even as an ordinary word of a wording", async () => {
    const { r, svc } = ready();
    // the rig's child is called «Тигр»; no wording says it, so a greeting records; a wording WITH it would be refused
    expect(svc.request(req(line({ id: 'greet.none', n: 3 }))).results[0]?.outcome).toBe('queued');
    const named = new ClipGenService({ ...direct(r), nickname: () => 'Доска' });
    expect(named.request(req(line({ id: 'greet.none', n: 3 }))).results[0]?.outcome).toBe('invalid');
  });

  it('a lesson unit and a catalogue sentence share the queue, the dedup and the caps', async () => {
    const { r, svc } = ready();
    // one price block a day: the lesson phrase and the greeting fit one pack job, nothing more
    svc.setSettings({ enabled: true, dailyCapMilli: 150 });
    expect(svc.request({ sentences: [whole(CASTLE), line({ id: 'greet.hello.day', n: 1 })], kind: 'teachTurn' }).results.map((x) => x.outcome)).toEqual(['queued', 'queued']);
    // queued already: a second ask is 'queued'; the day's cap counts what waits, whatever kind it is
    expect(svc.request(req(line({ id: 'greet.hello.day', n: 1 }))).results[0]?.outcome).toBe('queued');
    expect(svc.request(req(line({ id: 'greet.hello.day', n: 2 }))).results[0]?.outcome).toBe('budget');
    await svc.runQueue();
    expect(r.hf.creates.map((j) => j.prompt)).toEqual(['Время для рокировки!<#0.6#>Добрый день!']);
  });

  it('a greeting is as urgent as a lesson turn; among equals the newest request goes first (its bubble may still be up)', async () => {
    const { r, svc } = ready();
    const lock = join(r.overlayDir, 'higgsfield.lock');
    writeFileSync(lock, '1');
    svc.request({ sentences: [line({ id: 'thought.easy', n: 1 })], kind: 'praise' });
    await svc.runQueue();
    svc.request({ sentences: [line({ id: 'greet.hello.day', n: 1 })], kind: 'greeting' });
    svc.request({ sentences: [line({ id: 'greet.hello.day', n: 2 })], kind: 'greeting' });
    svc.request({ sentences: [whole(CASTLE)], kind: 'teachTurn' });
    const { rmSync } = await import('node:fs');
    rmSync(lock);
    r.clock.now += 31_000;
    await svc.runQueue();
    expect(r.hf.creates.map((j) => j.prompt)).toEqual(['Время для рокировки!', 'Привет-привет, добрый день!', 'Добрый день!', 'Легко? Тогда в следующий раз позовём соперника посильнее!']);
  });

  it("a published greeting joins the starter set's pools: the web's planner voices the bubble's wording from the merged library", async () => {
    const { r, svc } = ready();
    svc.request({ sentences: [line({ id: 'greet.win', n: 2 })], kind: 'greeting' });
    await svc.runQueue();
    const ov = JSON.parse(readFileSync(join(r.overlayDir, 'index.json'), 'utf8')) as { voices: Record<string, string> };
    const published = JSON.parse(readFileSync(join(r.overlayDir, ov.voices[VOICE_KEY] as string), 'utf8')) as ClipIndexLayer;
    // (the fake finish publishes keys only; the tools' manifest adds the pools the piece carries — as the end-to-end test shows)
    const merged = mergeClipIndexes(null, { ...published, pools: { 'greet.win/f': Object.values(published.keys).flat() } });
    const plan = planClips({ sentences: [{ items: [{ line: 'greet.win', g: 'f' }], prio: 100, end: '?' }], generic: 'generic.greeting' }, merged, { rng: () => 0.99, jitter: false, wordings: [2] });
    expect(plan.heard).toBe('Помню твою прошлую победу. Поехали дальше?');
    expect(plan.lineMissing).toBeUndefined();
  });
});

// ───────────────────────── the checkout's own takes and attempts (the tools store and ledger of the starter set) ─────────────────────────

/**
 * A small synthetic tools ledger (fake job ids and URLs): one paid starter-set job for a sentence the test below does not
 * touch. The real tools ledger is local and git-ignored, so the test never depends on it. The service reads the unit
 * store next to the ledger: the checkout's committed store is copied beside it.
 */
function syntheticToolsLedger(): string {
  const dir = tempDir('gambit-cg-tools-', cleanups);
  copyFileSync(TOOLS_STORE, join(dir, `units.${VOICE_KEY}.json`));
  const file = join(dir, `ledger.${VOICE_KEY}.jsonl`);
  const job = jobFor(line({ id: 'greet.hello.evening', n: 2 }));
  const key = keyOfJob(job);
  appendLedger(file, { ev: 'created', at: '2026-09-24T09:00:00.000Z', run: 'pilot', campaign: 'pilot', key, jobId: 'fake-job-1', milli: 150, job });
  appendLedger(file, { ev: 'charged', at: '2026-09-24T09:00:05.000Z', key, jobId: 'fake-job-1', campaign: 'pilot', milli: 150, status: 'completed', resultUrl: 'https://cdn.example.test/fake-job-1.mp3' });
  return file;
}
/** The checkout's committed unit store of the starter set. Read only. */
const TOOLS_STORE = fileURLToPath(new URL('../../../../tools/voice-clips/units.giselle-mm1.json', import.meta.url));

describe("the starter set's takes still waiting for the owner's ear, and the starter set's paid attempts", () => {
  it('a recordable starter-set sentence already recorded and confirmed by the recogniser, not yet heard by the owner (needsEar), is never bought again', async () => {
    const { r } = ready();
    const svc = r.make({ staticLibraryDir: PILOT_VOICE, toolsLedgerFile: syntheticToolsLedger() });
    const store = JSON.parse(readFileSync(TOOLS_STORE, 'utf8')) as { units: Record<string, { key: string; text: string; qa: string; asr?: { ok: boolean } }> };
    const index = JSON.parse(readFileSync(join(PILOT_VOICE, 'index.json'), 'utf8')) as { default: string; voices: Record<string, string> };
    const manifest = JSON.parse(readFileSync(join(PILOT_VOICE, index.voices[index.default] as string), 'utf8')) as ClipIndexLayer;
    const published = mergeClipIndexes(manifest, null);
    const waiting: { l: ClipGenLine; voiced: boolean }[] = [];
    for (const u of Object.values(store.units)) {
      if (u.qa !== 'needsEar' || u.asr?.ok !== true) continue;
      const k = parseLineUnitKey(u.key);
      const l: ClipGenLine | null = k ? { id: k.pool, n: k.n, ...(k.piece ? { piece: k.piece } : {}), ...(k.g ? { g: k.g } : {}) } : null;
      const resolved = l === null ? null : resolveClipGenLine(l);
      if (l !== null && resolved?.ok === true && resolved.unit.text === u.text) waiting.push({ l, voiced: takesForLine(published, u.key, u.text).length > 0 });
    }
    // (e.g. «Мат — красиво!», «Пешка шагнула вперёд.», …; the owner's review may publish some later)
    expect(waiting.length).toBeGreaterThan(0);
    // the owner's `voice:review` decides about them: no voice yet («не озвучено»), nothing paid
    for (const { l, voiced } of waiting) expect(svc.request({ sentences: [line(l)], kind: 'praise' }).results[0]?.outcome, JSON.stringify(l)).toBe(voiced ? 'voiced' : 'paused');
    await svc.runQueue();
    expect(r.hf.creates).toEqual([]);
    // a sentence the starter set never recorded is still recorded
    expect(svc.request({ sentences: [line({ id: 'praise.mate', n: 2 })], kind: 'praise' }).results[0]?.outcome).toBe('queued');
    await svc.runQueue();
    expect(r.hf.creates.map((j) => j.prompt)).toEqual(['Мат, и король пойман!']);
  });

  it('a take of the checkout\'s store waiting for the ear covers its words under a twin key too; a rejected one does not', async () => {
    const { r } = ready();
    const dir = tempDir('gambit-cg-tools-', cleanups);
    const ledger = join(dir, `ledger.${VOICE_KEY}.jsonl`);
    const take = (id: string, key: string, text: string) => ({ id, key, text, take: 1, ms: 900, on: 30, off: 860, file: `${id.slice(1, 3)}/${id}.mp3`, qa: 'needsEar', flags: ['tempo:5.8'], asr: { heard: text, score: 1, ok: true, missing: [], model: 'm', at: '2026-09-24T10:00:00Z' }, jobId: 'j', jobKey: 'k', cut: 0, bytes: 1, processedAt: '2026-09-24T10:00:00Z' });
    writeFileSync(
      join(dir, `units.${VOICE_KEY}.json`),
      JSON.stringify({ v: 1, voiceKey: VOICE_KEY, units: { c0000000000001: take('c0000000000001', 'line:hello.game#1', 'Привет!'), c0000000000002: take('c0000000000002', 'line:greet.hello.day#1', 'Добрый день!') } }),
    );
    writeFileSync(join(dir, `review.${VOICE_KEY}.json`), JSON.stringify({ c0000000000002: { verdict: 'reject' } }));
    const svc = r.make({ toolsLedgerFile: ledger });
    // «Привет!» of the day greeting is the game's hello's words: waiting for the owner too
    expect(svc.request({ sentences: [line({ id: 'greet.hello.day', n: 5 }), line({ id: 'greet.hello.day', n: 1 })], kind: 'greeting' }).results.map((x) => x.outcome)).toEqual(['paused', 'queued']);
    await svc.runQueue();
    expect(r.hf.creates.map((j) => j.prompt)).toEqual(['Добрый день!']);
  });

  it("the tools ledger's paid jobs count towards the 2 paid attempts of a unit, machine-wide", async () => {
    const { r } = ready();
    const dir = tempDir('gambit-cg-tools-', cleanups);
    const ledger = join(dir, `ledger.${VOICE_KEY}.jsonl`);
    const paid = (sentence: ClipGenSentence, jobId: string): void => {
      const job = jobFor(sentence);
      const key = keyOfJob(job);
      appendLedger(ledger, { ev: 'created', at: '2026-09-24T09:00:00.000Z', run: 'pilot', campaign: 'pilot', key, jobId, milli: 150, job });
      appendLedger(ledger, { ev: 'charged', at: '2026-09-24T09:00:05.000Z', key, jobId, campaign: 'pilot', milli: 150, status: 'completed', resultUrl: `https://cdn.example.test/${jobId}.mp3` });
    };
    // «Добрый день!» was bought twice by a static campaign (both takes turned down), «Вечер добрый!» once
    paid(line({ id: 'greet.hello.day', n: 1 }), 'tools-1');
    paid(line({ id: 'greet.hello.day', n: 1 }), 'tools-2');
    paid(line({ id: 'greet.hello.evening', n: 2 }), 'tools-3');
    const svc = r.make({ toolsLedgerFile: ledger });
    expect(svc.request({ sentences: [line({ id: 'greet.hello.day', n: 1 }), line({ id: 'greet.hello.evening', n: 2 })], kind: 'greeting' }).results.map((x) => x.outcome)).toEqual(['given-up', 'queued']);
    await svc.runQueue();
    // its one attempt left: take 2 of the on-demand numbering
    expect(r.hf.creates.map((j) => [j.prompt, j.take])).toEqual([['Вечер добрый!', 102]]);
  });
});
