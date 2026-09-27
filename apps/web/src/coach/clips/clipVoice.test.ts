/**
 * The «Записи» voice layer (docs/voice-clips/SPEC.md §5, §6, §11): the VoiceLayer contract, a twin and a compiled text
 * through plan → load → schedule, the missing-clip ladder as heard (a failed take is re-planned, never a hole; a
 * refused move is the generic line), the audio lock (never hangs, asks for a gesture), recency / stats / misses in
 * localStorage, and a black box of codes only. Fixture library, fake fetch, fake AudioContext: silent and free.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipUtterance, CoachEvent } from '@gambit/shared';
import type { ClipIndex } from '@gambit/core';
import { catalogIndex, fixtureIndex } from '../../../../../packages/core/src/coach/clips/fixtures.ts';
import type { FixtureOptions } from '../../../../../packages/core/src/coach/clips/fixtures.ts';
import { createMemoryStorage, makeEvent } from '../testUtils.ts';
import { DIAG_STRING_RE, configureVoiceDiagForTests, resetVoiceDiagForTests, voiceDiagRecent } from '../voiceDiag.ts';
import type { ClipPlanInfo } from '../voiceTypes.ts';
import { createClipAudio } from './clipAudio.ts';
import { CLIP_MISSES_STORAGE_KEY, CLIP_RECENCY_STORAGE_KEY } from './clipFlags.ts';
import { createClipLibrary } from './clipLibrary.ts';
import { readClipMisses, readClipStats, readRecency, recordedPercent } from './clipMemory.ts';
import { createClipVoice, isUnrecordedLesson } from './clipVoice.ts';
import type { ClipVoice } from './clipVoice.ts';
import { FAKE_BASE, FakeAudioContext, clipUrl, createFakeServer } from './testAudio.ts';
import type { FakeServer } from './testAudio.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

interface Rig {
  voice: ClipVoice;
  ctx: FakeAudioContext;
  server: FakeServer;
  storage: ReturnType<typeof createMemoryStorage>;
  plans: ClipPlanInfo[];
  speaking: boolean[];
  index: ReturnType<typeof fixtureIndex>;
}

function rig(opts: { fixture?: FixtureOptions; index?: ClipIndex; library?: boolean; ctxState?: 'running' | 'suspended'; resumeBlocked?: boolean; activated?: boolean; name?: string } = {}): Rig {
  const index = opts.index ?? fixtureIndex(opts.fixture);
  const server = createFakeServer(opts.library === false ? null : index);
  const ctx = new FakeAudioContext({ state: opts.ctxState ?? 'running', resumeBlocked: opts.resumeBlocked ?? false });
  const audio = createClipAudio({ createContext: () => ctx });
  const library = createClipLibrary({ baseUrl: FAKE_BASE, fetch: server.fetch, audio, idle: (cb) => cb() });
  const storage = createMemoryStorage();
  const voice = createClipVoice({
    audio,
    library,
    storage,
    rng: () => 0,
    childName: () => opts.name,
    hasUserActivation: () => opts.activated ?? true,
    gestureTarget: null,
  });
  const plans: ClipPlanInfo[] = [];
  const speaking: boolean[] = [];
  voice.onPlan((p) => plans.push(p));
  voice.onSpeakingChange((v) => speaking.push(v));
  return { voice, ctx, server, storage, plans, speaking, index };
}

const twin = (u: Partial<ClipUtterance> & Pick<ClipUtterance, 'sentences'>): ClipUtterance => ({ generic: 'generic.teachTurn.turn', ...u });

function adviceEvent(san: string, clip?: ClipUtterance, text = 'Мой совет — конь на эф три.'): CoachEvent {
  return makeEvent({
    kind: 'teachTurn',
    text,
    bubbleText: text,
    pose: 'think',
    pauseClock: true,
    teach: { moment: 'turn', style: 'full', ply: 1, advice: [{ uci: 'g1f3', san, source: 'engine', arrow: 'green' }] },
    ...(clip ? { clip } : {}),
  });
}

const HST = twin({
  sentences: [
    {
      items: [{ line: 'teach.head.advice' }, { slot: 'nom', san: 'Nf3', fen: START }, { line: 'reason.attack', piece: 'n' }],
      prio: 100,
      end: '!',
    },
  ],
});

/** plays the utterance to its end on fake time; resolves with the texts of the clips that were scheduled */
async function speakThrough(r: Rig, event: CoachEvent): Promise<void> {
  const done = r.voice.speakEvent(event);
  await vi.advanceTimersByTimeAsync(20_000);
  await done;
}

describe('clipVoice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
  });

  it('is a VoiceLayer of kind «clips»; init() loads the library, and REJECTS without one (the chain falls to silent)', async () => {
    const r = rig();
    expect(r.voice.kind).toBe('clips');
    await expect(r.voice.init()).resolves.toBeUndefined();
    expect(r.voice.libraryStatus()).toMatchObject({ voiceKey: 'giselle-mm1', libraryVersion: 3 });
    expect(voiceDiagRecent().some((e) => e.e === 'clip.init')).toBe(true);
    const none = rig({ library: false });
    await expect(none.voice.init()).rejects.toThrow();
    expect(voiceDiagRecent().some((e) => e.e === 'clip.init.fail')).toBe(true);
    expect(none.voice.libraryStatus()).toBeNull();
  });

  it('a clip twin: head · whole move · piece tail, scheduled with the planned gaps; audible start → resolve at the end', async () => {
    const r = rig();
    await r.voice.init();
    let resolved = false;
    const done = r.voice.speakEvent(adviceEvent('Nf3', HST)).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(r.speaking).toEqual([true]);
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0]).toMatchObject({ src: 'clip', level: 1, heard: 'Мой совет — конь на эф три — нападаешь на коня!', clips: 3 });
    const played = r.ctx.played;
    expect(played).toHaveLength(3);
    const gap = (i: number): number => ((played[i]?.started?.when ?? 0) - ((played[i - 1]?.started?.when ?? 0) + (played[i - 1]?.started?.duration ?? 0))) * 1000;
    expect(gap(1)).toBeGreaterThanOrEqual(250);
    expect(gap(1)).toBeLessThanOrEqual(310);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(resolved).toBe(true);
    expect(r.speaking).toEqual([true, false]);
    // heard → remembered (next time another take of each pool is preferred), across page loads
    expect(readRecency(r.storage)).toHaveLength(3);
    expect(r.storage.data.has(CLIP_RECENCY_STORAGE_KEY)).toBe(true);
  });

  it('a family without a twin: its text is compiled (the child\'s name stripped) and voiced from fragments', async () => {
    const r = rig({ name: 'Миша' });
    await r.voice.init();
    await speakThrough(r, makeEvent({ kind: 'encourage', text: 'Миша, смотри, тут подарок!', pose: 'cheer' }));
    // (a cheerful pose may get a bark in front: «Ого! Смотри, тут подарок!»)
    expect(r.plans[0]).toMatchObject({ src: 'text', level: 1 });
    expect(r.plans[0]?.heard).toMatch(/^(?:(?:Ого|Ух ты)! )?Смотри, тут подарок!$/);
    await speakThrough(r, adviceEvent('Nf3'));
    expect(r.plans[1]).toMatchObject({ src: 'text', heard: 'Мой совет — конь на эф три.' });
  });

  it('L5: what is not recorded is the moment\'s generic line (never a second voice); the miss is logged locally', async () => {
    const r = rig();
    await r.voice.init();
    await speakThrough(r, makeEvent({ kind: 'teachTurn', text: 'Этой фразы нет в библиотеке.', teach: { moment: 'turn', style: 'full', ply: 3, advice: [] } }));
    expect(r.plans[0]).toMatchObject({ src: 'generic', level: 5 });
    expect(['Смотри на зелёную стрелку!', 'Глянь на доску — там подсказка.']).toContain(r.plans[0]?.heard);
    const log = readClipMisses(r.storage);
    expect(Object.keys(log.counts).some((k) => k.startsWith('5|frag:f:'))).toBe(true);
    expect(r.storage.data.has(CLIP_MISSES_STORAGE_KEY)).toBe(true);
  });

  it('the SAN guard: a twin naming a move that was not advised is never voiced — generic line + clip.mismatch', async () => {
    const r = rig();
    await r.voice.init();
    await speakThrough(r, adviceEvent('e4', HST));
    expect(r.plans[0]).toMatchObject({ src: 'generic', level: 5 });
    expect(r.plans[0]?.heard).not.toContain('эф три');
    expect(voiceDiagRecent().some((e) => e.e === 'clip.mismatch')).toBe(true);
  });

  it('a take that fails to load is re-planned without it — another take, never a hole in the sentence', async () => {
    const r = rig({ fixture: { takes: 2 } });
    await r.voice.init();
    const first = r.index.keys['slot:nom:n:f3']?.[0] as string;
    const second = r.index.keys['slot:nom:n:f3']?.[1] as string;
    r.server.fail(clipUrl(first), 404);
    await speakThrough(r, adviceEvent('Nf3', HST));
    expect(r.plans[0]).toMatchObject({ src: 'clip', level: 1, clips: 3 });
    const requested = r.server.requests;
    expect(requested).toContain(clipUrl(first));
    expect(requested).toContain(clipUrl(second));
    expect(r.ctx.played).toHaveLength(3);
  });

  it('a missing whole move is the split form «конём» · «на эф шесть» (L2) — the move is still said', async () => {
    const r = rig();
    await r.voice.init();
    const u = twin({ sentences: [{ items: [{ line: 'teach.head.advice' }, { slot: 'ins', san: 'Nf6', fen: 'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1' }], prio: 100, end: '.' }] });
    await speakThrough(r, makeEvent({ kind: 'answer', clip: u, text: 'Мой совет — конём на эф шесть.' }));
    expect(r.plans[0]?.level).toBe(2);
    expect(r.plans[0]?.heard).toContain('на эф шесть');
  });

  it('a locked page: the phrase never hangs (silent timing), needsUserGesture turns on; a gesture brings the sound', async () => {
    const r = rig({ ctxState: 'suspended', resumeBlocked: true });
    await r.voice.init();
    const gestures: boolean[] = [];
    r.voice.onNeedsUserGestureChange((needs) => gestures.push(needs));
    const problems: string[] = [];
    r.voice.onHearingProblem((p) => problems.push(p));
    const done = r.voice.speakEvent(adviceEvent('Nf3', HST));
    await vi.advanceTimersByTimeAsync(15_000);
    await done;
    expect(r.ctx.played).toHaveLength(0);
    expect(r.voice.needsUserGesture).toBe(true);
    expect(gestures).toEqual([true]);
    // the child had touched the page before: «Не слышно? Нажми сюда» may be offered
    expect(problems).toEqual(['notPlaying']);
    // the click: resume + a silent frame inside the gesture
    r.ctx.resumeBlocked = false;
    r.voice.unlock();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.voice.needsUserGesture).toBe(false);
    expect(r.ctx.state).toBe('running');
    expect(r.ctx.silentFrames.length + r.ctx.sources.filter((s) => (s.buffer?.length ?? 0) === 1).length).toBeGreaterThan(0);
    await speakThrough(r, adviceEvent('Nf3', HST));
    expect(r.ctx.played).toHaveLength(3);
  });

  it('stop() ends the phrase at once; the gentle-stop helpers see the sentence being heard', async () => {
    const r = rig();
    await r.voice.init();
    const u = twin({
      sentences: [
        { items: [{ line: 'treasure.gift' }], prio: 100, end: '!' },
        { items: [{ line: 'ask.find', g: 'm' }], prio: 50, end: '?' },
      ],
    });
    expect(r.voice.msToSentenceEnd()).toBeNull();
    let finished = false;
    const done = r.voice.speakEvent(makeEvent({ kind: 'teachTurn', clip: u })).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(300);
    const left = r.voice.msToSentenceEnd();
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(2000);
    r.voice.stop();
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(finished).toBe(true);
    expect(r.speaking.at(-1)).toBe(false);
    expect(r.voice.msToSentenceEnd()).toBeNull();
  });

  it('endAfterSentence(): the question after the treasure is never heard', async () => {
    const r = rig();
    await r.voice.init();
    const u = twin({
      sentences: [
        { items: [{ line: 'treasure.gift' }], prio: 100, end: '!' },
        { items: [{ line: 'ask.find', g: 'm' }], prio: 50, end: '?' },
      ],
    });
    const done = r.voice.speakEvent(makeEvent({ kind: 'teachTurn', clip: u }));
    await vi.advanceTimersByTimeAsync(300);
    expect(r.voice.endAfterSentence()).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    const second = r.ctx.played[1];
    expect(second?.stoppedAt).not.toBeNull();
    expect(readRecency(r.storage)).toHaveLength(1);
  });

  it('replayLast(): the same takes again (free)', async () => {
    const r = rig();
    await r.voice.init();
    await speakThrough(r, adviceEvent('Nf3', HST));
    const ids = r.ctx.played.map((s) => s.buffer);
    const replay = r.voice.replayLast();
    await vi.advanceTimersByTimeAsync(10_000);
    await replay;
    expect(r.ctx.played.slice(3).map((s) => s.buffer)).toEqual(ids);
  });

  it('per-game stats: «прошлая партия: N % записями» is stored when the game ends', async () => {
    const r = rig();
    await r.voice.init();
    r.voice.setGame({ timeControlId: 'blitz5' });
    await speakThrough(r, adviceEvent('Nf3', HST));
    await speakThrough(r, makeEvent({ kind: 'teachTurn', text: 'Этого нет.' }));
    await speakThrough(r, adviceEvent('Nf3'));
    r.voice.setGame(null);
    const stats = readClipStats(r.storage);
    expect(stats).toMatchObject({ utterances: 3, recorded: 2, generic: 1, silent: 0, timeControlId: 'blitz5' });
    expect(recordedPercent(stats)).toBe(67);
  });

  it('the black box gets codes only — no Russian word ever leaves the page', async () => {
    const r = rig({ name: 'Миша' });
    await r.voice.init();
    await speakThrough(r, makeEvent({ kind: 'teachTurn', text: 'Миша, этого точно нет в библиотеке!' }));
    await speakThrough(r, adviceEvent('e4', HST));
    const entries = voiceDiagRecent().filter((e) => e.e.startsWith('clip.'));
    expect(entries.map((e) => e.e)).toEqual(expect.arrayContaining(['clip.plan', 'clip.miss', 'clip.mismatch', 'clip.end']));
    for (const entry of entries) {
      for (const value of Object.values(entry)) if (typeof value === 'string') expect(value).toMatch(DIAG_STRING_RE);
      expect(JSON.stringify(entry)).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('5-minute games: the gaps shrink ×0.75', async () => {
    const r = rig();
    await r.voice.init();
    const done = r.voice.speakEvent(adviceEvent('Nf3', HST), { blitz: true });
    await vi.advanceTimersByTimeAsync(100);
    const [a, b] = r.ctx.played;
    const gap = ((b?.started?.when ?? 0) - ((a?.started?.when ?? 0) + (a?.started?.duration ?? 0))) * 1000;
    expect(gap).toBeGreaterThanOrEqual(280 * 0.75 - 31);
    expect(gap).toBeLessThanOrEqual(280 * 0.75 + 31);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
  });
});

// ───────────────────────── the lesson model: no recording → no sound (docs/TEACHING.md §4.5) ─────────────────────────

/** the committed starter clip library (apps/web/public/voice/<voice>/manifest.<hash>.json), whatever its hash */
const MANIFESTS: Record<string, unknown> = import.meta.glob('../../../public/voice/*/manifest.*.json', { import: 'default', eager: true });

function pilotIndex(): ClipIndex {
  const manifest = Object.values(MANIFESTS)[0] as (ClipIndex & { fallbacks?: ClipIndex['fallbacks'] }) | undefined;
  if (!manifest) throw new Error('no committed clip manifest');
  return { units: manifest.units, pools: manifest.pools, keys: manifest.keys, fallbacks: manifest.fallbacks ?? {} };
}

function lessonEvent(patch: Partial<CoachEvent> = {}): CoachEvent {
  const text = 'Центр ещё свободен — займём его пешкой.';
  return makeEvent({
    kind: 'teachTurn',
    text,
    bubbleText: text,
    pose: 'think',
    pauseClock: true,
    teach: { moment: 'turn', style: 'full', ply: 3, advice: [{ uci: 'e2e4', san: 'e4', source: 'engine', arrow: 'green' }] },
    say: [
      { pool: 'v3.aim.center', n: 1 },
      { pool: 'v3.go.move', n: 2, piece: 'p' },
    ],
    ...patch,
  });
}

describe('clipVoice — lesson phrases (docs/TEACHING.md §4.5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
  });

  it('a lesson phrase without a twin plans NOTHING — with the whole catalogue recorded and with the committed starter library: no generic line, no sound', async () => {
    const pilot = pilotIndex();
    expect(Object.keys(pilot.units).length).toBeGreaterThan(50);
    for (const index of [catalogIndex(), pilot, fixtureIndex()]) {
      const r = rig({ index });
      await r.voice.init();
      r.voice.setGame({ timeControlId: 'rapid10' });
      await speakThrough(r, lessonEvent());
      // even words that ARE recorded somewhere are never compiled from a lesson phrase
      await speakThrough(r, lessonEvent({ text: 'Смотри на зелёную стрелку!', bubbleText: 'Смотри на зелёную стрелку!', say: [{ pool: 'v3.lead.reveal', n: 1 }] }));
      await speakThrough(r, lessonEvent({ kind: 'praise', text: 'Сам нашёл вилку!', bubbleText: 'Сам нашёл вилку!', pose: 'cheer', teach: undefined, say: [{ pool: 'v3.praise.tactic.fork', n: 1 }] }));
      expect(r.plans.map((p) => ({ src: p.src, level: p.level, clips: p.clips, heard: p.heard }))).toEqual([
        { src: 'none', level: 6, clips: 0, heard: '' },
        { src: 'none', level: 6, clips: 0, heard: '' },
        { src: 'none', level: 6, clips: 0, heard: '' },
      ]);
      expect(r.ctx.played).toHaveLength(0);
      // «прошлая партия»: they count as silent, never as recorded or generic
      r.voice.setGame(null);
      expect(readClipStats(r.storage)).toMatchObject({ utterances: 3, recorded: 0, generic: 0, silent: 3 });
    }
  });

  it('the silent phrase still keeps the bubble\'s reading time (the game\'s clock hold), and the next non-lesson phrase is voiced again', async () => {
    const r = rig();
    await r.voice.init();
    let done = false;
    const pending = r.voice.speakEvent(lessonEvent()).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(done).toBe(true);
    await speakThrough(r, adviceEvent('Nf3', HST));
    expect(r.plans[1]).toMatchObject({ src: 'clip', level: 1 });
    expect(r.ctx.played.length).toBeGreaterThan(0);
  });

  it('a lesson phrase WITH a twin: whatever the core plans for it, never the generic line (clipVoice.lesson.test.ts: the prompt-3 path)', async () => {
    const r = rig();
    await r.voice.init();
    const recorded = { ...adviceEvent('Nf3', HST), say: [{ pool: 'v3.lead.advice', n: 1 }] };
    const guarded = { ...adviceEvent('e4', HST), say: [{ pool: 'v3.lead.advice', n: 1 }] };
    await speakThrough(r, recorded);
    await speakThrough(r, guarded);
    expect(r.plans.map((p) => p.src)).not.toContain('generic');
    expect(r.plans.every((p) => p.src === 'clip' || p.src === 'none')).toBe(true);
    expect(r.plans[1]).toMatchObject({ src: 'none', clips: 0 });
  });

  it('isUnrecordedLesson: `say` without `clip` only', () => {
    expect(isUnrecordedLesson(lessonEvent())).toBe(true);
    expect(isUnrecordedLesson(adviceEvent('Nf3', HST))).toBe(false);
    expect(isUnrecordedLesson({ ...adviceEvent('Nf3', HST), say: [] })).toBe(false);
    expect(isUnrecordedLesson(makeEvent())).toBe(false);
  });
});
