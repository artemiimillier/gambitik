/**
 * `voice:demo-game`: the demo game planned like the app (every utterance, in order, its move) and rendered into one
 * track with the review renderer, 1.5 s between moves — real ffmpeg on tones in $TMPDIR (skipped without ffmpeg);
 * nothing is played, nothing is spent.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeToPcm, encodeMp3, ffmpegAvailable } from './audio.ts';
import { DEFAULT_SCRIPT, jobsFileOf, readDemo } from './cliCatalog.ts';
import { VOICE_KEY } from './config.ts';
import { libraryFromJobs } from './coverage.ts';
import {
  BETWEEN_MOVES_MS,
  BETWEEN_UTTERANCES_MS,
  LEAD_IN_MS,
  clockRu,
  composedLineOf,
  demoGameScript,
  demoMoves,
  demoTranscript,
  levelRu,
  moveLabel,
  renderDemoGame,
  writeDemoGame,
  writePlannedTranscript,
} from './demoGame.ts';
import type { DemoGameFile } from './demoGame.ts';
import { clipFile } from './ids.ts';
import { readJobsFile } from './jobs.ts';
import type { UnitRecord, UnitStore } from './manifest.ts';
import type { ScriptFile } from './script.ts';
import { RATE, concat, silence, tone } from './testkit.ts';

const hasFfmpeg = await ffmpegAvailable();
const script = JSON.parse(readFileSync(DEFAULT_SCRIPT, 'utf8')) as ScriptFile;
const demo = readDemo(script.demo as string) as DemoGameFile;
const pilot = libraryFromJobs([readJobsFile(jobsFileOf('pilot'))]);

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-demo-game-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('the demo planned like the app', () => {
  const planned = demoGameScript(demo, pilot);

  it('numbers the moves in SAN from the start position (promotion and mate included)', () => {
    expect(moveLabel(1, 'e4')).toBe('1. e4');
    expect(moveLabel(2, 'a6')).toBe('1… a6');
    const moves = demoMoves(demo);
    expect(moves).toHaveLength(demo.plies.length);
    expect(moves.slice(0, 2).map((m) => m.label)).toEqual(['1. e4', '1… a6']);
    expect(moves.find((m) => m.san.includes('=Q'))?.label).toBe('17. fxg8=Q+');
    expect(moves.at(-1)).toMatchObject({ by: 'child', label: '18. Qf7#' });
  });

  it('keeps every utterance in order with its move: the intro before the first move, the rest after theirs', () => {
    const ids = [...(demo.intro ?? []).map((s) => s.event.id), ...demo.plies.flatMap((p) => (p.after ?? []).map((s) => s.event.id))];
    expect(planned.utterances.map((u) => u.id)).toEqual(ids);
    expect(planned.utterances.filter((u) => u.ply === 0)).toHaveLength(demo.intro?.length ?? 0);
    for (const u of planned.utterances.filter((x) => x.ply > 0)) {
      expect(demo.plies[u.ply - 1]?.after?.some((s) => s.event.id === u.id)).toBe(true);
    }
  });

  it('the `pilot` library voices all of it at L1–L2 (the `pilot` gate), and the render is deterministic', () => {
    expect(planned.utterances.length).toBeGreaterThanOrEqual(15);
    for (const u of planned.utterances) {
      expect(u.plan.level, `${u.id} «${u.plan.heard}»`).toBeLessThanOrEqual(2);
      expect(u.plan.stats.generic).toBe(0);
      expect(['как написано', 'ход по частям']).toContain(levelRu(u.plan));
      expect(u.line.items.filter((it) => 'id' in it)).toHaveLength(u.plan.clips.length);
    }
    expect(demoGameScript(demo, pilot).utterances.map((u) => u.line)).toEqual(planned.utterances.map((u) => u.line));
    expect(planned.blitz).toBe(true);
  });

  it('turns a plan into the renderer line: ids with gap-table kinds between them', () => {
    const u = planned.utterances.find((x) => x.plan.clips.length >= 3);
    expect(u).toBeDefined();
    if (!u) return;
    const line = composedLineOf(u.plan, true, 'x');
    expect(line.items.length).toBe(u.plan.clips.length * 2 - 1);
    line.items.forEach((it, i) => expect(i % 2 === 0 ? 'id' in it : 'gap' in it).toBe(true));
  });

  it('the planned transcript says it is a plan, numbers every move and quotes every phrase', () => {
    const txt = demoTranscript(planned, null);
    expect(txt).toContain('ПЛАН: записей ещё нет');
    expect(txt).toContain('До первого хода');
    expect(txt).toMatch(/1\. e4 {3}\(ребёнок\)/);
    expect(txt).toMatch(/1… a6 {3}\(соперник\)/);
    expect(txt).toContain('18. Qf7#');
    for (const u of planned.utterances) expect(txt).toContain(`«${u.plan.heard}»`);
    // the greeting comes before the first move, the game end after the last one
    expect(txt.indexOf('приветствие')).toBeLessThan(txt.indexOf('1. e4'));
    expect(txt.lastIndexOf('конец партии')).toBeGreaterThan(txt.indexOf('18. Qf7#'));
    expect(clockRu(83_450)).toBe('01:23.5');
    const dir = tempDir();
    const file = writePlannedTranscript(planned, path.join(dir, 'clips-pilot', 'demo-game.mp3'));
    expect(file).toBe(path.join(dir, 'clips-pilot', 'demo-game.txt'));
    expect(readFileSync(file, 'utf8')).toBe(txt);
  });
});

describe.skipIf(!hasFfmpeg)('one listening file (real ffmpeg on tones, silent)', () => {
  // the intro (3 phrases before the first move) and the phrases after moves 1… a6 and 2… b6
  const tiny: DemoGameFile = { ...demo, plies: demo.plies.slice(0, 4) };
  const planned = demoGameScript(tiny, pilot);

  async function libraryFor(dir: string, ids: readonly string[]) {
    const libraryRoot = path.join(dir, 'public', 'voice');
    const units: Record<string, UnitRecord> = {};
    for (const [i, id] of ids.entries()) {
      const file = path.join(libraryRoot, VOICE_KEY, clipFile(id));
      await encodeMp3(concat(silence(30), tone(200 + 10 * i, 300, 0.3), silence(60)), file, { work: dir });
      const ms = Math.round(((await decodeToPcm(file)).length * 1000) / RATE);
      units[id] = { id, key: `line:x${i}#1`, text: `кусочек ${i}`, take: 1, ms, on: 30, off: ms - 60, file: clipFile(id), qa: 'auto', jobId: 'j', jobKey: 'k', cut: 0, bytes: 1, flags: [], processedAt: 't' };
    }
    const store: UnitStore = { v: 1, voiceKey: VOICE_KEY, units };
    return { libraryRoot, store };
  }

  it('lead-in, 0.6 s between phrases of one move, 1.5 s between moves; a missing take drops only its phrase', async () => {
    expect(planned.utterances.map((u) => u.ply)).toEqual([0, 0, 0, 2, 4]);
    const dir = tempDir();
    const ids = [...new Set(planned.utterances.flatMap((u) => u.plan.clips.map((c) => c.id)))];
    const { libraryRoot, store } = await libraryFor(dir, ids);
    const audio = await renderDemoGame(planned, store, libraryRoot);
    expect(audio.missing).toEqual([]);
    const t = audio.timeline;
    expect(t.map((x) => x.id)).toEqual(planned.utterances.map((u) => u.id));
    expect(t[0]?.atMs).toBe(LEAD_IN_MS);
    const pause = (i: number) => (t[i]?.atMs ?? 0) - ((t[i - 1]?.atMs ?? 0) + (t[i - 1]?.ms ?? 0));
    expect(Math.abs(pause(1) - BETWEEN_UTTERANCES_MS)).toBeLessThanOrEqual(2);
    expect(Math.abs(pause(2) - BETWEEN_UTTERANCES_MS)).toBeLessThanOrEqual(2);
    expect(Math.abs(pause(3) - BETWEEN_MOVES_MS)).toBeLessThanOrEqual(2);
    expect(Math.abs(pause(4) - BETWEEN_MOVES_MS)).toBeLessThanOrEqual(2);
    const lastEnd = (t.at(-1)?.atMs ?? 0) + (t.at(-1)?.ms ?? 0);
    expect(Math.abs((audio.pcm.length * 1000) / RATE - (lastEnd + 500))).toBeLessThanOrEqual(2);

    const lost = planned.utterances[3]?.plan.clips[0]?.id as string;
    const { [lost]: _gone, ...rest } = store.units;
    const partial = await renderDemoGame(planned, { ...store, units: rest }, libraryRoot);
    expect(partial.missing).toEqual([`${planned.utterances[3]?.id}: ${lost}`]);
    expect(partial.timeline.map((x) => x.id)).not.toContain(planned.utterances[3]?.id);
  }, 60_000);

  it('writes demo-game.mp3 and the transcript with time stamps next to it', async () => {
    const dir = tempDir();
    const ids = [...new Set(planned.utterances.flatMap((u) => u.plan.clips.map((c) => c.id)))];
    const { libraryRoot, store } = await libraryFor(dir, ids);
    const out = path.join(dir, 'docs', 'voice-samples', 'clips-pilot', 'demo-game.mp3');
    const result = await writeDemoGame(planned, store, libraryRoot, out, dir);
    expect(result).toMatchObject({ mp3: out, utterances: 5, voiced: 5, missing: [] });
    expect(existsSync(out)).toBe(true);
    expect(Math.abs((await decodeToPcm(out)).length / RATE - result.totalMs / 1000)).toBeLessThan(0.1);
    const txt = readFileSync(result.txt, 'utf8');
    expect(txt).toContain('Файл: demo-game.mp3');
    expect(txt).not.toContain('ПЛАН');
    expect(txt).toMatch(/^00:00\.3 {3}Гамбитик · приветствие/m);
    expect(txt).toMatch(/2… b6 {3}\(соперник\)/);

    // nothing voiced (an empty store): no MP3, only the transcript saying what is missing
    const none = await writeDemoGame(planned, { ...store, units: {} }, libraryRoot, path.join(dir, 'empty', 'demo-game.mp3'), dir);
    expect(none.mp3).toBeNull();
    expect(existsSync(path.join(dir, 'empty', 'demo-game.mp3'))).toBe(false);
    expect(readFileSync(none.txt, 'utf8')).toContain('Не вошли (нет записи)');
  }, 60_000);
});
