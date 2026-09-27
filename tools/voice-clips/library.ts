/**
 * The WHOLE library recorded in advance (campaign `library`, capped by LIBRARY_MAX_BUDGET) — the free plan
 * of `pnpm voice:library-plan`; `voice:library-run` (./libraryRun.ts) records it. Node-only, reads files only.
 *
 * What is recorded — exactly what the server of «Дозапись голоса» would record on demand (apps/server/src/voiceGen/
 * render.ts), so a take of the library IS the take the app asks for:
 *  - every lesson-v3 part: each wording of every pool × the pieces its placeholders may name (core `subjectPieces`) ×
 *    the child's gender when it uses `{g:…}`; never a quiz-button wording (said only inside the options sentence) nor
 *    the silent bark; the same words for another piece are one unit (the twins, `lineKeyTwins`);
 *  - every stage 1–2 options sentence («Ладью, коня или слона?»): each order of the three buttons each quiz kind can
 *    show, with each button wording of stages 1–2 — rendered by core `expectedQuizText` from ids, as the server does;
 *  - every whole catalogue sentence the server records (`resolveClipGenLine`: greetings, the new-game wizard, answers,
 *    game start and end, take-back replies, the parent's gates …), one unit per words.
 * Minus what is covered (./dedup.ts `coveredWhy`, the server's rule in its order): published in the static library or
 * the overlay, blocked or rejected, held by a job of the overlay ledger or an unresolved intent, a `pilot` take waiting
 * for a listener's ear, out of paid attempts (both ledgers, ≤ 2).
 *
 * Order: the plain and the boy's variants first, the
 * girl's after them; inside, by the expected uses per game — the pool's uses in a reference run of `teach:report`
 * shared by its wordings, the harvest's demand of a catalogue sentence (script.giselle-mm1.json), an options sentence's
 * quiz kind shared by its orders —; what no game used comes after what one did.
 * Packing — the «pack» recipe of ONDEMAND.md (core `packProblem`): ≤ 4 parts joined by `<#0.6#>`, ≤ 240 characters,
 * one question at most and only last, split at tag silences ≥ 700 ms; a part joins a job only when that costs no more
 * than recording it alone (the price is 0.15 per started 50 characters), in blocks of the priority order, so the first
 * jobs hold the most wanted words. The options sentence is always a job of its own (docs/voice-clips/ONDEMAND.md). A lead is sent
 * without its end mark when a tag follows it (the tag makes the fall), as the last part of a job with «.» (`leadAlone`:
 * a falling take serves both uses). A unit whose paid take failed the check gets its take 2 alone, take 101 + attempts
 * (the server's own rule), only in the `retake` pass.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { LessonSay, PieceType, QuizKind } from '../../packages/shared/src/index.ts';
import { LESSON_LINES, lessonLine, wordingFitsStage } from '../../packages/content/src/index.ts';
import type { LessonLine } from '../../packages/content/src/index.ts';
import { catalogUnits, usesGender, usesPiece } from '../../packages/core/src/coach/clips/catalog.ts';
import { CLIP_CATALOG } from '../../packages/core/src/coach/clips/catalog.ru.ts';
import { lessonQuizKey, poolKeyOf } from '../../packages/core/src/coach/clips/keys.ts';
import { expectedPartText, expectedQuizText } from '../../packages/core/src/coach/clips/lessonPlan.ts';
import type { LessonQuizIds } from '../../packages/core/src/coach/clips/lessonPlan.ts';
import { isExcludedLine, lineKeyTwins, resolveClipGenLine } from '../../packages/core/src/coach/clips/lines.ts';
import { lintText } from '../../packages/core/src/coach/clips/lint.ts';
import { PACK_SPLIT, PACK_TAG, packProblem, ttsPartText } from '../../packages/core/src/coach/clips/tts.ts';
import { VOICE_NEUTRAL_POOL, lessonUnitKey } from '../../packages/core/src/coach/lesson/book.ts';
import { lintLessonText, subjectPieces } from '../../packages/core/src/coach/lesson/lint.ts';
import { YOUNG_CATEGORIES } from '../../packages/core/src/coach/lesson/truth.ts';
import { VOICE_KEY } from './config.ts';
import { jobMilli } from './cost.ts';
import { parseJobsFile } from './jobs.ts';
import type { GenJob, JobsFile, PartRole, UnitPiece } from './jobs.ts';
import { ONDEMAND_TAKE_BASE } from './ondemand.ts';

export const LIBRARY_CAMPAIGN = 'library';
/** the hard cap for the whole campaign — the run's `--budget` may not exceed it */
export const LIBRARY_MAX_BUDGET = 1700;
/** units packed together at most within one block of the priority order */
export const PACK_BLOCK_UNITS = 400;

export type LibrarySource = 'lesson' | 'quiz' | 'catalog';

/** One recordable unit of the library (a piece of a job: its manifest key and exact words). */
export interface LibraryUnit {
  /** `line:v3.lead.subject@n#4`, `frag:f:ладью, коня или слона|?`, `line:greet.hello.day#2` */
  key: string;
  /** the exact expansion (the manifest's `unit.text`, the stale-take guard) */
  text: string;
  source: LibrarySource;
  /** a lesson pool's role; a catalogue sentence is `whole`, an options sentence `frag` */
  role: 'whole' | 'lead' | 'tail' | 'frag';
  kind: 'line' | 'frag';
  /** the manifest pool key (`v3.lead.subject@n`, `greet.hello.day`) */
  pool?: string;
  /** every pool the take joins, when more than its own (a catalogue sentence) */
  pools?: string[];
  mood?: 'calm' | 'excited';
  piece?: PieceType;
  g?: 'm' | 'f';
  /** the family for the report (`lead`, `praise`, `quiz`, `greet` …) */
  family: string;
  /** expected uses per game (0 = no reference game used it) */
  weight: number;
}

// ───────────────────────── what the library holds ─────────────────────────

/** Lint rules that make a text unsayable by the TTS — the server's `HARD_LINT` (render.ts). */
const HARD_LESSON_LINT = new Set(['empty', 'latin', 'digit', 'placeholder', 'square', 'file']);
/** …and its `HARD_CLIP_LINT` for a whole catalogue sentence (plus a digit, refused there too). */
const HARD_CLIP_LINT = new Set(['empty', 'latin', 'placeholder', 'square', 'selfFeminine']);

const PIECES_ALL: readonly PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];

function familyOf(pool: string): string {
  const parts = pool.split('.');
  return parts[0] === 'v3' ? (parts[1] ?? 'v3') : (parts[0] ?? pool);
}

/** Every lesson-v3 part the server renders (`renderPart`), one per words (a twin with the same words is left out). */
export function lessonLibraryUnits(lines: readonly LessonLine[] = LESSON_LINES): LibraryUnit[] {
  const out: LibraryUnit[] = [];
  const textOf = new Map<string, string>();
  for (const line of lines) {
    if (VOICE_NEUTRAL_POOL(line.id)) continue;
    line.wordings.forEach((w, i) => {
      const pieces: (PieceType | undefined)[] = usesPiece(w.t) ? [...subjectPieces(line)] : [undefined];
      const genders: ('m' | 'f' | undefined)[] = usesGender(w.t) ? ['m', 'f'] : [undefined];
      for (const piece of pieces) {
        for (const g of genders) {
          const say: LessonSay = { pool: line.id, n: i + 1, ...(piece ? { piece } : {}), ...(g ? { g } : {}) };
          const text = expectedPartText(say);
          if (text === null) continue;
          if (lintLessonText(line, text, piece).some((issue) => HARD_LESSON_LINT.has(issue.rule))) continue;
          const key = lessonUnitKey(say);
          if (lineKeyTwins(key, text).some((twin) => textOf.get(twin) === text)) continue;
          textOf.set(key, text);
          out.push({
            key,
            text,
            source: 'lesson',
            role: line.role,
            kind: 'line',
            pool: poolKeyOf(line.id, piece, g),
            ...(w.mood !== undefined ? { mood: w.mood } : {}),
            ...(piece ? { piece } : {}),
            ...(g ? { g } : {}),
            family: familyOf(line.id),
            weight: 0,
          });
        }
      }
    });
  }
  return out;
}

/** Every order of the items (all permutations). */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((x, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

/** Every ordered choice of 3 distinct items. */
function orderedTriples<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (const a of items) for (const b of items) for (const c of items) if (a !== b && b !== c && a !== c) out.push([a, b, c]);
  return out;
}

/** The button wordings of an option pool a stage 1–2 child is shown. */
function youngWordings(pool: string): number[] {
  const line = lessonLine(pool);
  if (!line) return [];
  return line.wordings.flatMap((w, i) => (wordingFitsStage(line, w, 1) || wordingFitsStage(line, w, 2) ? [i + 1] : []));
}

/** Each order of `pools` × each young wording of each: the `say` options of the quizzes that show these buttons. */
function sayOptionSets(orders: readonly (readonly string[])[]): LessonQuizIds['options'][] {
  const out: LessonQuizIds['options'][] = [];
  for (const order of orders) {
    let sets: LessonQuizIds['options'][] = [[]];
    for (const pool of order) {
      const next: LessonQuizIds['options'][] = [];
      for (const set of sets) for (const n of youngWordings(pool)) next.push([...set, { say: { pool, n } }]);
      sets = next;
    }
    out.push(...sets);
  }
  return out;
}

/**
 * The stage 1–2 quizzes and the buttons each can show (core lesson/quiz.ts, truth.ts): «что соперник может съесть?»
 * three of the child's piece types but the king (the answer a piece, not a pawn — every triple holds one); «какой фигурой
 * лучше пойти?» any three types (the king moves too); «Шах! Как спасаемся?» the three ways in any order; «Выгодно ли
 * съесть?» its three answers in their fixed order; «что задумал соперник?» three of the five young categories (only
 * «напасть» and «съесть» are neighbours, and a triple of three is never two neighbours without a third answer).
 */
export function quizOptionSets(): { kind: QuizKind; options: LessonQuizIds['options'] }[] {
  const out: { kind: QuizKind; options: LessonQuizIds['options'] }[] = [];
  for (const t of orderedTriples<PieceType>(['n', 'b', 'r', 'p', 'q'])) out.push({ kind: 'danger', options: t.map((piece) => ({ piece })) });
  for (const t of orderedTriples<PieceType>(PIECES_ALL)) out.push({ kind: 'whichPiece', options: t.map((piece) => ({ piece })) });
  for (const options of sayOptionSets(permutations(['v3.quiz.opt.escKing', 'v3.quiz.opt.escBlock', 'v3.quiz.opt.escCapture']))) out.push({ kind: 'checkEscape', options });
  for (const options of sayOptionSets([['v3.quiz.opt.capYes', 'v3.quiz.opt.capTrade', 'v3.quiz.opt.capLose']])) out.push({ kind: 'canCapture', options });
  const young = orderedTriples(YOUNG_CATEGORIES.map((c) => `v3.quiz.cat.${c}`));
  for (const options of sayOptionSets(young)) out.push({ kind: 'oppIdea', options });
  return out;
}

/** Every stage 1–2 options sentence (`frag:` units), rendered from ids like the server's `quiz` request. */
export function quizLibraryUnits(): (LibraryUnit & { quizKind: QuizKind })[] {
  const out: (LibraryUnit & { quizKind: QuizKind })[] = [];
  const seen = new Set<string>();
  for (const q of quizOptionSets()) {
    const text = expectedQuizText({ kind: q.kind, options: q.options } as LessonQuizIds);
    if (text === null) continue;
    const key = lessonQuizKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, text, source: 'quiz', role: 'frag', kind: 'frag', family: 'quiz', weight: 0, quizKind: q.kind });
  }
  return out;
}

/**
 * Every whole catalogue sentence the server records on demand (`resolveClipGenLine`, the server's lint), one unit per
 * words: «Привет!» of the greeting and of the game's hello is one take (`lineKeyTwins`).
 */
export function catalogLibraryUnits(): LibraryUnit[] {
  const out: LibraryUnit[] = [];
  const textOf = new Map<string, string>();
  for (const line of CLIP_CATALOG) {
    if (line.role !== 'whole' || isExcludedLine(line.id)) continue;
    for (const u of catalogUnits(line)) {
      if (u.text === null) continue;
      const r = resolveClipGenLine({ id: line.id, n: u.wording, ...(u.piece ? { piece: u.piece } : {}), ...(u.g ? { g: u.g } : {}) });
      if (!r.ok) continue;
      const text = r.unit.text;
      if (/\d/u.test(text) || lintText(text, 'whole').some((issue) => HARD_CLIP_LINT.has(issue.rule))) continue;
      const key = r.unit.unitKey;
      if (textOf.has(key) || lineKeyTwins(key, text).some((twin) => textOf.get(twin) === text)) continue;
      textOf.set(key, text);
      out.push({
        key,
        text,
        source: 'catalog',
        role: 'whole',
        kind: 'line',
        pool: r.unit.pool,
        ...(r.unit.pools.length > 1 ? { pools: [...r.unit.pools] } : {}),
        ...(r.unit.mood !== undefined ? { mood: r.unit.mood } : {}),
        ...(r.unit.piece !== undefined ? { piece: r.unit.piece } : {}),
        ...(r.unit.g !== undefined ? { g: r.unit.g } : {}),
        family: familyOf(line.id),
        weight: 0,
      });
    }
  }
  return out;
}

/** The whole library: lesson parts, options sentences, catalogue sentences (a key never twice). */
export function libraryUnits(): (LibraryUnit & { quizKind?: QuizKind })[] {
  const seen = new Set<string>();
  const out: (LibraryUnit & { quizKind?: QuizKind })[] = [];
  for (const u of [...lessonLibraryUnits(), ...quizLibraryUnits(), ...catalogLibraryUnits()]) {
    if (seen.has(u.key)) continue;
    seen.add(u.key);
    out.push(u);
  }
  return out;
}

// ───────────────────────── how often a game says it ─────────────────────────

/** Uses per game from a reference run of `teach:report` (games.jsonl.gz) and the harvest's demand of catalogue lines. */
export interface UsageStats {
  games: number;
  /** `pool` and `pool@piece` → uses per game */
  pool: ReadonlyMap<string, number>;
  /** quiz kind → quizzes per stage 1–2 game that said their options */
  quizKind: ReadonlyMap<string, number>;
  /** catalogue unit key → the harvest's demand (uses per game) */
  demand: ReadonlyMap<string, number>;
}

export const EMPTY_USAGE: UsageStats = { games: 0, pool: new Map(), quizKind: new Map(), demand: new Map() };

interface RefRecord {
  t?: string;
  game?: string;
  stage?: number;
  say?: { pool?: string; piece?: string }[];
  quiz?: { kind?: string };
  vu?: { k?: string }[];
}

/**
 * Reads the reference run (`pnpm teach:report --games 60 --voice k3c --seed 7 --out DIR`, free) and the static script
 * (the harvest's demand per catalogue unit). Either may be missing: then its part of the order is left out.
 */
export function readUsage(o: { refDir: string | null; scriptFile: string | null }): UsageStats & { notes: string[] } {
  const notes: string[] = [];
  const pool = new Map<string, number>();
  const quizKind = new Map<string, number>();
  const demand = new Map<string, number>();
  let games = 0;
  const refFile = o.refDir === null ? null : path.join(o.refDir, 'games.jsonl.gz');
  if (refFile !== null && existsSync(refFile)) {
    const young = new Set<string>();
    const recs: RefRecord[] = [];
    for (const line of gunzipSync(readFileSync(refFile)).toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        recs.push(JSON.parse(line) as RefRecord);
      } catch {
        // a torn line of an interrupted run
      }
    }
    for (const r of recs) {
      if (r.t !== 'game') continue;
      games++;
      if ((r.stage ?? 9) <= 2 && r.game) young.add(r.game);
    }
    const add = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
    for (const r of recs) {
      if (r.t !== 'ev') continue;
      for (const s of r.say ?? []) {
        if (typeof s.pool !== 'string') continue;
        add(pool, s.pool);
        if (typeof s.piece === 'string') add(pool, `${s.pool}@${s.piece}`);
      }
      if (r.quiz?.kind && r.game && young.has(r.game) && (r.vu ?? []).some((u) => u.k?.startsWith('frag:'))) add(quizKind, r.quiz.kind);
    }
    if (games > 0) {
      for (const [k, v] of pool) pool.set(k, v / games);
      for (const [k, v] of quizKind) quizKind.set(k, v / Math.max(1, young.size));
    } else notes.push(`в ${refFile} нет партий — порядок без частот уроков`);
  } else if (o.refDir !== null) {
    notes.push(`нет ${refFile} — порядок без частот уроков (бесплатно: pnpm teach:report --games 60 --voice k3c --seed 7 --out ${o.refDir})`);
  }
  if (o.scriptFile !== null && existsSync(o.scriptFile)) {
    try {
      const script = JSON.parse(readFileSync(o.scriptFile, 'utf8')) as { units?: { key?: string; demand?: number }[] };
      for (const u of script.units ?? []) if (typeof u.key === 'string' && typeof u.demand === 'number') demand.set(u.key, u.demand);
    } catch {
      notes.push(`не читается ${o.scriptFile} — порядок без спроса каталога`);
    }
  }
  return { games, pool, quizKind, demand, notes };
}

/** Catalogue families of the coach outside the lesson: only «Подсказчик» says them (a teacher turn is the lesson's). */
const OLD_TEACHER_FAMILIES: ReadonlySet<string> = new Set(['teach', 'opp', 'danger', 'treasure', 'reveal', 'react', 'plan', 'topic', 'praise']);

/** Sets `weight`: a pool's uses shared by its wordings, a quiz kind's by its options sentences, a catalogue unit's demand. */
export function weighUnits<U extends LibraryUnit & { quizKind?: QuizKind }>(units: readonly U[], usage: UsageStats): U[] {
  const wordingsOf = new Map<string, number>();
  const fragsOf = new Map<string, number>();
  for (const u of units) if (u.source === 'quiz' && u.quizKind) fragsOf.set(u.quizKind, (fragsOf.get(u.quizKind) ?? 0) + 1);
  return units.map((u) => {
    let weight = 0;
    if (u.source === 'lesson') {
      const id = u.pool?.split(/[@/]/u)[0] ?? '';
      let n = wordingsOf.get(id);
      if (n === undefined) {
        n = Math.max(1, lessonLine(id)?.wordings.length ?? 1);
        wordingsOf.set(id, n);
      }
      const uses = u.piece !== undefined ? (usage.pool.get(`${id}@${u.piece}`) ?? 0) : (usage.pool.get(id) ?? 0);
      weight = uses / n;
    } else if (u.source === 'quiz' && u.quizKind) {
      // a non-reader must hear it: counted double (the prefetch's U1)
      weight = (2 * (usage.quizKind.get(u.quizKind) ?? 0)) / Math.max(1, fragsOf.get(u.quizKind) ?? 1);
    } else {
      const demand = usage.demand.get(u.key) ?? Math.max(0, ...lineKeyTwins(u.key, u.text).map((k) => usage.demand.get(k) ?? 0));
      // the harvest counts these teacher lines in every game; in the app only «Подсказчик» says them (≈ ¼ of the games)
      weight = OLD_TEACHER_FAMILIES.has(u.family) ? demand / 4 : demand;
    }
    return { ...u, weight };
  });
}

/** The recording order: the plain and the boy's variants first, then the girl's; inside, the most used first. */
export function bandOf(u: Pick<LibraryUnit, 'g' | 'weight'>): number {
  return (u.g === 'f' ? 2 : 0) + (u.weight > 0 ? 0 : 1);
}

export function byPriority(a: LibraryUnit, b: LibraryUnit): number {
  return bandOf(a) - bandOf(b) || b.weight - a.weight || a.key.localeCompare(b.key);
}

// ───────────────────────── packing ─────────────────────────

const blocks = (text: string): number => Math.ceil([...text].length / 50);
const isQuestion = (tts: string): boolean => /\?[!.…]*$/u.test(tts.trim());

/** How a unit is said inside its job: a lead is `lead` before a tag, `leadAlone` («.») as the job's last part. */
function roleIn(u: LibraryUnit, last: boolean): PartRole {
  if (u.role === 'lead') return last ? 'leadAlone' : 'lead';
  return u.role;
}

/** The parts of one job in an order the pack allows: leads first (a tag follows them), then statements, the question last. */
function arrange(units: readonly LibraryUnit[]): LibraryUnit[] {
  const q = (u: LibraryUnit): boolean => isQuestion(ttsPartText(u.text, roleIn(u, true)));
  return [...units.filter((u) => u.role === 'lead' && !q(u)), ...units.filter((u) => u.role !== 'lead' && !q(u)), ...units.filter(q)];
}

/** The TTS parts of an arranged job (its last lead said alone). */
function partsOf(units: readonly LibraryUnit[]): string[] {
  return units.map((u, i) => ttsPartText(u.text, roleIn(u, i === units.length - 1)));
}

function promptOf(units: readonly LibraryUnit[]): string {
  return partsOf(units).join(PACK_TAG);
}

/**
 * Packs units (in priority order) into jobs: blocks of `PACK_BLOCK_UNITS`; inside a block each unit goes into the job
 * where it adds the fewest 50-character price blocks — never more than it costs alone, the earliest such job on a tie —,
 * else it opens a job. Options sentences stay alone.
 */
export function packLibrary(units: readonly LibraryUnit[], o: { blockUnits?: number } = {}): LibraryUnit[][] {
  const size = Math.max(1, o.blockUnits ?? PACK_BLOCK_UNITS);
  const jobs: LibraryUnit[][] = [];
  for (let from = 0; from < units.length; from += size) {
    const bins: LibraryUnit[][] = [];
    for (const u of units.slice(from, from + size)) {
      if (u.kind === 'frag') {
        bins.push([u]);
        continue;
      }
      const own = blocks(ttsPartText(u.text, roleIn(u, true)));
      let best = -1;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (let i = 0; i < bins.length; i++) {
        const bin = bins[i]!;
        if (bin.length >= 4 || bin[0]!.kind === 'frag') continue;
        const next = arrange([...bin, u]);
        if (packProblem(partsOf(next)) !== null) continue;
        const delta = blocks(promptOf(next)) - blocks(promptOf(arrange(bin)));
        if (delta < bestDelta) {
          best = i;
          bestDelta = delta;
          if (delta === 0) break;
        }
      }
      if (best >= 0 && bestDelta <= own) bins[best]!.push(u);
      else bins.push([u]);
    }
    for (const bin of bins) jobs.push(arrange(bin));
  }
  return jobs;
}

/** The job of packed units: pieces in spoken order, the tag split for 2+ parts. */
export function libraryJob(units: readonly LibraryUnit[], take: number, batch: string): GenJob {
  const parts = partsOf(units);
  const pieces: UnitPiece[] = units.map((u, i) => ({
    key: u.key,
    text: u.text,
    kind: u.kind,
    tier: LIBRARY_CAMPAIGN,
    role: roleIn(u, i === units.length - 1),
    ...(u.pool !== undefined ? { pool: u.pool } : {}),
    ...(u.pools !== undefined && u.pools.length > 1 ? { pools: [...u.pools] } : {}),
    ...(u.mood !== undefined ? { mood: u.mood } : {}),
  }));
  return {
    prompt: parts.join(PACK_TAG),
    take,
    recipe: units.length === 1 ? 'single' : 'pack',
    pieces,
    ...(units.length > 1 ? { split: { mode: PACK_SPLIT.mode, minSilenceMs: PACK_SPLIT.minSilenceMs } } : {}),
    tier: LIBRARY_CAMPAIGN,
    batch,
    priority: Math.round(Math.max(0, ...units.map((u) => u.weight)) * 1000) / 1000,
  };
}

// ───────────────────────── the plan ─────────────────────────

export interface LibraryPlanInput {
  units: readonly LibraryUnit[];
  /** why a unit needs no new paid take (./dedup.ts `coveredWhy`); null = it does */
  covered: (u: LibraryUnit) => string | null;
  /** paid attempts so far (both ledgers); > 0 = a retake: alone, take 101 + attempts */
  attempts: (u: LibraryUnit) => number;
  blockUnits?: number;
}

export interface LibraryPlan {
  jobs: GenJob[];
  /** units in the library */
  total: number;
  /** covered units by reason */
  covered: Record<string, number>;
  /** units planned (first takes / retakes) */
  planned: number;
  retakes: number;
  milli: number;
  /** per band: units, jobs, milli (0 plain/boy used, 1 plain/boy unused, 2 girl used, 3 girl unused) */
  bands: { units: number; jobs: number; milli: number }[];
  bySource: Record<LibrarySource, { units: number; milli: number }>;
}

/** The short reason of a `coveredWhy` answer (its words before the details). */
export function reasonOf(why: string): string {
  if (why.startsWith('уже записана')) return 'уже записана';
  if (why.startsWith('уже в задании')) return 'в задании';
  if (why.startsWith('платные попытки')) return 'попытки исчерпаны';
  if (why.startsWith('ждёт ушей')) return 'ждёт прослушивания';
  if (why.startsWith('больше не записывается')) return 'blocked';
  if (why.startsWith('отклонена')) return 'отклонена';
  return why;
}

/** The jobs of the plan, in priority order: packed first takes; each retake alone. */
export function planLibrary(input: LibraryPlanInput): LibraryPlan {
  const covered: Record<string, number> = {};
  const fresh: LibraryUnit[] = [];
  const retake: { u: LibraryUnit; attempts: number }[] = [];
  for (const u of input.units) {
    const why = input.covered(u);
    if (why !== null) {
      const r = reasonOf(why);
      covered[r] = (covered[r] ?? 0) + 1;
      continue;
    }
    const attempts = input.attempts(u);
    if (attempts > 0) retake.push({ u, attempts });
    else fresh.push(u);
  }
  fresh.sort(byPriority);
  retake.sort((a, b) => byPriority(a.u, b.u));
  const bands = [0, 1, 2, 3].map(() => ({ units: 0, jobs: 0, milli: 0 }));
  const bySource: LibraryPlan['bySource'] = { lesson: { units: 0, milli: 0 }, quiz: { units: 0, milli: 0 }, catalog: { units: 0, milli: 0 } };
  const jobs: GenJob[] = [];
  const add = (units: readonly LibraryUnit[], take: number, batch: string): void => {
    const job = libraryJob(units, take, batch);
    const milli = jobMilli(job.prompt);
    const band = Math.min(...units.map(bandOf));
    bands[band]!.jobs++;
    bands[band]!.milli += milli;
    for (const u of units) {
      bands[bandOf(u)]!.units++;
      bySource[u.source].units++;
      bySource[u.source].milli += milli / units.length;
    }
    jobs.push(job);
  };
  for (const { u, attempts } of retake) add([u], ONDEMAND_TAKE_BASE + attempts, 'library.retake');
  for (const units of packLibrary(fresh, input.blockUnits === undefined ? {} : { blockUnits: input.blockUnits })) {
    add(units, ONDEMAND_TAKE_BASE, `library.b${Math.min(...units.map(bandOf))}`);
  }
  for (const s of Object.values(bySource)) s.milli = Math.round(s.milli);
  return {
    jobs,
    total: input.units.length,
    covered,
    planned: fresh.length + retake.length,
    retakes: retake.length,
    milli: jobs.reduce((n, j) => n + jobMilli(j.prompt), 0),
    bands,
    bySource,
  };
}

/** The plan as a jobs file (campaign `library`), validated like any jobs file. */
export function libraryJobsFile(jobs: readonly GenJob[]): JobsFile {
  return parseJobsFile({ v: 1, voiceKey: VOICE_KEY, campaign: LIBRARY_CAMPAIGN, jobs: [...jobs] });
}
