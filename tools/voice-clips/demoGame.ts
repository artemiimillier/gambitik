/**
 * `voice:demo-game` (free, silent): the whole demo game as ONE listening file —
 * every utterance of `apps/web/public/voice/demo/<seed>.json` in order, planned by the runtime planner against the
 * recorded library (the published manifest minus stale takes; take variety across the game through the planner's
 * recency, as in the app) and rendered offline by the review renderer (`renderComposed`: onset → offset, 5 ms fades,
 * the runtime gap table of SPEC §5.3, ×0.75 in 5-minute games), with ≈ 1.5 s of silence between moves
 * → `docs/voice-samples/clips-pilot/demo-game.mp3` + `demo-game.txt` (move numbers, time stamps, what each phrase
 * became). The file is written, never played.
 *
 * `--planned` needs no recording: the transcript of what the `pilot` jobs WILL let Гамбитик say (no MP3).
 * Differences from the in-app replay, on purpose: every phrase is heard to its end (in the app a child's move during a
 * phrase ends it gently), and the thinking time of the moves is not waited out.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { createClipRecency } from '../../packages/core/src/coach/clips/index.ts';
import type { ClipIndex, ClipPlan } from '../../packages/core/src/coach/clips/index.ts';
import { repoPath } from '../lib/cli.ts';
import { SAMPLE_RATE, VOICE_KEY } from './config.ts';
import type { GapKind } from './config.ts';
import { writeMp3 } from './audio.ts';
import { gapKindOf, planEvent } from './coverage.ts';
import type { HarvestCoachEvent, HarvestGameConfig } from './harvest.ts';
import { msToSamples } from './dsp.ts';
import type { UnitStore } from './manifest.ts';
import type { DemoLike } from './planJobs.ts';
import { mulberry32, renderComposed } from './review.ts';
import type { ComposedLine } from './review.ts';

export const DEFAULT_DEMO_GAME_OUT = repoPath('docs', 'voice-samples', 'clips-pilot', 'demo-game.mp3');
/** silence between the phrases of two different moves (≈ 1.5 s) */
export const BETWEEN_MOVES_MS = 1500;
/** silence between two phrases said after the same move (the controller's queue hands over at once; a breath) */
export const BETWEEN_UTTERANCES_MS = 600;
/** silence before the first phrase */
export const LEAD_IN_MS = 300;
export const DEMO_GAME_KBPS = 64;

export interface DemoGameFile extends DemoLike {
  title?: string;
}

export interface DemoMove {
  /** 1-based half-move */
  ply: number;
  by: 'child' | 'bot';
  san: string;
  /** «1. e4» / «1… a6» */
  label: string;
}

export interface DemoUtterance {
  id: string;
  kind: string;
  /** the half-move this phrase follows (0 = before the first move) */
  ply: number;
  text: string;
  plan: ClipPlan;
  line: ComposedLine;
}

export interface DemoGameScript {
  seed: string;
  title: string;
  blitz: boolean;
  moves: DemoMove[];
  utterances: DemoUtterance[];
}

export function moveLabel(ply: number, san: string): string {
  const n = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${n}. ${san}` : `${n}… ${san}`;
}

/** The moves of the demo in SAN (numbered from White's first move; a game starting with Black is numbered «1… »). */
export function demoMoves(demo: DemoGameFile): DemoMove[] {
  const chess = new Chess(demo.startFen);
  const offset = chess.turn() === 'b' ? 1 : 0;
  return demo.plies.map((p, i) => {
    const move = chess.move({ from: p.uci.slice(0, 2), to: p.uci.slice(2, 4), ...(p.uci.length > 4 ? { promotion: p.uci[4] } : {}) });
    return { ply: i + 1, by: p.by, san: move.san, label: moveLabel(i + 1 + offset, move.san) };
  });
}

/** A plan's clips as a composed line of the review renderer (ids and gap-table kinds). */
export function composedLineOf(plan: ClipPlan, blitz: boolean, name: string): ComposedLine {
  const items: ({ id: string } | { gap: GapKind })[] = [];
  let prevRole: string | null = null;
  for (const c of plan.clips) {
    if (prevRole !== null) items.push({ gap: gapKindOf(c.gapBeforeMs, c.role, prevRole, blitz) });
    items.push({ id: c.id });
    prevRole = c.role;
  }
  return { name, blitz, items };
}

/**
 * Every utterance of the demo, in order, planned against `index` exactly as the app plans it in this game (its time
 * control's caps, the SAN guard, no bark in 5-minute games) — with the recency memory of one game, so a pool said
 * twice rotates its takes like in the app. Deterministic for a given `rngSeed`.
 */
export function demoGameScript(demo: DemoGameFile, index: ClipIndex, opts: { rngSeed?: number } = {}): DemoGameScript {
  const game = { tc: demo.timeControlId as HarvestGameConfig['tc'], name: '' };
  const blitz = game.tc === 'blitz5';
  const recency = createClipRecency();
  const rng = mulberry32(opts.rngSeed ?? 1);
  const said: { event: HarvestCoachEvent; ply: number }[] = [
    ...(demo.intro ?? []).map((s) => ({ event: s.event, ply: 0 })),
    ...demo.plies.flatMap((p, i) => (p.after ?? []).map((s) => ({ event: s.event, ply: i + 1 }))),
  ];
  const utterances = said.map(({ event, ply }): DemoUtterance => {
    const plan = planEvent(event, game, index, { recency, rng });
    recency.note(plan.clips.map((c) => c.id));
    return { id: event.id, kind: event.kind, ply, text: event.text, plan, line: composedLineOf(plan, blitz, `${event.id} ${event.kind}`) };
  });
  return { seed: demo.seed, title: demo.title ?? demo.seed, blitz, moves: demoMoves(demo), utterances };
}

export interface TimedUtterance {
  id: string;
  atMs: number;
  ms: number;
}

export interface DemoGameAudio {
  pcm: Float32Array;
  timeline: TimedUtterance[];
  /** utterances left out: `<event id>: <missing take id>` */
  missing: string[];
}

/** The whole game as one PCM track (32 kHz mono): lead-in, every voiced utterance, 1.5 s between moves. */
export async function renderDemoGame(
  script: DemoGameScript,
  store: UnitStore,
  libraryRoot: string,
  opts: { betweenMovesMs?: number; betweenUtterancesMs?: number; leadInMs?: number } = {},
): Promise<DemoGameAudio> {
  const parts: Float32Array[] = [];
  const timeline: TimedUtterance[] = [];
  const missing: string[] = [];
  let at = msToSamples(opts.leadInMs ?? LEAD_IN_MS, SAMPLE_RATE);
  parts.push(new Float32Array(at));
  let prevPly: number | null = null;
  for (const [i, u] of script.utterances.entries()) {
    if (u.line.items.length === 0) continue;
    const rendered = await renderComposed(u.line, store, libraryRoot, i + 1);
    if ('missing' in rendered) {
      missing.push(`${u.id}: ${rendered.missing}`);
      continue;
    }
    if (prevPly !== null) {
      const gap = new Float32Array(msToSamples(u.ply === prevPly ? (opts.betweenUtterancesMs ?? BETWEEN_UTTERANCES_MS) : (opts.betweenMovesMs ?? BETWEEN_MOVES_MS), SAMPLE_RATE));
      parts.push(gap);
      at += gap.length;
    }
    timeline.push({ id: u.id, atMs: Math.round((at * 1000) / SAMPLE_RATE), ms: Math.round((rendered.pcm.length * 1000) / SAMPLE_RATE) });
    parts.push(rendered.pcm);
    at += rendered.pcm.length;
    prevPly = u.ply;
  }
  const tail = new Float32Array(msToSamples(500, SAMPLE_RATE));
  parts.push(tail);
  const pcm = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    pcm.set(p, offset);
    offset += p.length;
  }
  return { pcm, timeline, missing };
}

const KIND_RU: Record<string, string> = {
  greeting: 'приветствие',
  gameStart: 'начало партии',
  teachTurn: 'учитель',
  takebackOffer: 'вернуть ход?',
  encourage: 'поддержка',
  praise: 'похвала',
  gameEnd: 'конец партии',
  treasure: 'подарок',
  danger: 'опасность',
  hint: 'подсказка',
};

/** What a phrase became — the same words as the in-app demo log. */
export function levelRu(plan: ClipPlan): string {
  if (plan.clips.length === 0) return 'молчит';
  if (plan.stats.generic > 0 || plan.level >= 5) return 'общая фраза';
  return plan.level === 1 ? 'как написано' : plan.level === 2 ? 'ход по частям' : plan.level === 3 ? 'без хвоста' : 'фраза выпала';
}

export function clockRu(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

/**
 * The transcript next to the MP3: every move numbered, under it what Гамбитик says (with the time stamp in the file
 * when there is one), what each phrase became, and — when the planner changed the words — the builder's text.
 */
export function demoTranscript(script: DemoGameScript, audio: { timeline: TimedUtterance[]; totalMs: number; file: string } | null, missing: readonly string[] = []): string {
  const at = new Map((audio?.timeline ?? []).map((t) => [t.id, t]));
  const counts = new Map<string, number>();
  for (const u of script.utterances) counts.set(levelRu(u.plan), (counts.get(levelRu(u.plan)) ?? 0) + 1);
  const out: string[] = [];
  out.push(`Гамбитик — демо-партия ${script.seed}: ${script.title}`);
  out.push(`Голос ${VOICE_KEY} (Giselle). Каждая фраза собрана из записей так же, как в приложении: те же паузы между кусочками${script.blitz ? ' (в 5 минутах — ×0,75)' : ''}; между ходами ≈ ${(BETWEEN_MOVES_MS / 1000).toLocaleString('ru-RU')} с.`);
  if (audio === null) {
    out.push('ПЛАН: записей ещё нет — так демо-партия прозвучит из пилотных записей. Файл demo-game.mp3 появится после озвучки: pnpm voice:demo-game.');
  } else {
    out.push(`Файл: ${audio.file} · ${clockRu(audio.totalMs)} · фраз ${audio.timeline.length} из ${script.utterances.length}.`);
  }
  out.push(`Фразы: ${[...counts.entries()].map(([k, n]) => `${k} — ${n}`).join(', ')}.`);
  out.push('В приложении ход ребёнка во время фразы мягко её заканчивает; здесь каждая фраза звучит до конца.');
  if (missing.length > 0) out.push(`Не вошли (нет записи): ${missing.join('; ')}.`);
  out.push('');
  const say = (u: DemoUtterance): void => {
    const t = at.get(u.id);
    const stamp = t ? clockRu(t.atMs) : '   —   '; // as wide as «00:00.0»
    const heard = u.plan.heard !== '' ? u.plan.heard : '(молчит)';
    out.push(`${stamp}   Гамбитик · ${KIND_RU[u.kind] ?? u.kind} · ${levelRu(u.plan)}: «${heard}»`);
    if (u.plan.heard !== '' && u.plan.heard.replace(/\s+/g, ' ').trim() !== u.text.replace(/\s+/g, ' ').trim()) out.push(`${' '.repeat(12)}(в тексте: «${u.text}»)`);
  };
  const byPly = new Map<number, DemoUtterance[]>();
  for (const u of script.utterances) byPly.set(u.ply, [...(byPly.get(u.ply) ?? []), u]);
  const before = byPly.get(0) ?? [];
  if (before.length > 0) {
    out.push('До первого хода');
    before.forEach(say);
    out.push('');
  }
  for (const m of script.moves) {
    out.push(`${' '.repeat(12)}${m.label}   (${m.by === 'child' ? 'ребёнок' : 'соперник'})`);
    const after = byPly.get(m.ply) ?? [];
    after.forEach(say);
    if (after.length > 0) out.push('');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

export interface DemoGameResult {
  mp3: string | null;
  txt: string;
  totalMs: number;
  utterances: number;
  voiced: number;
  missing: string[];
}

/** Renders and writes both files (the MP3 only when at least one utterance is voiced). */
export async function writeDemoGame(script: DemoGameScript, store: UnitStore, libraryRoot: string, out: string, work: string): Promise<DemoGameResult> {
  const txt = out.replace(/\.mp3$/i, '') + '.txt';
  mkdirSync(path.dirname(out), { recursive: true });
  const audio = await renderDemoGame(script, store, libraryRoot);
  const totalMs = Math.round((audio.pcm.length * 1000) / SAMPLE_RATE);
  const voiced = audio.timeline.length;
  if (voiced > 0) await writeMp3(audio.pcm, out, DEMO_GAME_KBPS, work);
  writeFileSync(txt, demoTranscript(script, voiced > 0 ? { timeline: audio.timeline, totalMs, file: path.basename(out) } : null, audio.missing), 'utf8');
  return { mp3: voiced > 0 ? out : null, txt, totalMs, utterances: script.utterances.length, voiced, missing: audio.missing };
}

/** `--planned`: the transcript alone, from a library that does not exist yet. */
export function writePlannedTranscript(script: DemoGameScript, out: string): string {
  const txt = out.replace(/\.mp3$/i, '') + '.txt';
  mkdirSync(path.dirname(txt), { recursive: true });
  writeFileSync(txt, demoTranscript(script, null), 'utf8');
  return txt;
}
