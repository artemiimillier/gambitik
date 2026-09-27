/**
 * «Дозапись голоса» — the voice simulation of `pnpm teach:report --voice …` and the prefetch plan (free: nothing
 * is generated, only counted). Pure functions over the records of ./config.ts.
 *
 * An utterance's recordable units (`voiceUnitsOf`): every said part (`lessonUnitKey`) and, at stages 1–2, the options
 * sentence «Ладью, коня или слона?» as ONE unit (`lessonQuizKey`; its button wordings are never recorded alone). After
 * an utterance the simulated server records its missing units at once (`recordAfter`): one request, priced by the pack
 * recipe (consecutive parts per job, ≤ 4 parts / 240 characters, the options sentence alone — or each unit alone, the
 * `unit` pricing), under the day's cap (a job that does not fit pauses recording until the next day).
 *
 * Per game number of the children: new units / jobs / characters / credits, the share of units / sentences / whole
 * utterances that were voiced, the units the cap left unrecorded, the share of sentences that name a piece (K8: cheap
 * growth prefers wordings without one), and the variety the «recorded first» book gives up (distinct sentences, the most
 * plays of one wording, adjacent repeats, «второй день» — the report's own measures). Also the prefetch plan: the units
 * to record before a child's first game for a budget, packed into jobs (`prefetchJobsFile`).
 * No engine and no files here: the CLI reads and writes, the worker plays.
 */
import type { LessonSay, PieceType } from '../../packages/shared/src/index.ts';
import { lessonLine, wordingFitsStage } from '../../packages/content/src/index.ts';
import { claimsBest, isDeictic, lessonUnitKey } from '../../packages/core/src/index.ts';
import { expandWording, usesGender, usesPiece } from '../../packages/core/src/coach/clips/catalog.ts';
import { lessonQuizKey, poolKeyOf } from '../../packages/core/src/coach/clips/keys.ts';
import { PACK_SPLIT, ttsPartText } from '../../packages/core/src/coach/clips/tts.ts';
import type { TtsPartRole } from '../../packages/core/src/coach/clips/tts.ts';
import { isOptionPool, quizOptionsText } from '../../packages/core/src/coach/lesson/quizWords.ts';
import { VOICE_KEY } from '../voice-clips/config.ts';
import { jobMilli, milliToCredits } from '../voice-clips/cost.ts';
import { parseJobsFile } from '../voice-clips/jobs.ts';
import type { GenJob, JobsFile, UnitPiece } from '../voice-clips/jobs.ts';
import { ONDEMAND_TAKE_BASE, PREFETCH_CAMPAIGN } from '../voice-clips/ondemand.ts';
import { placeholderWords } from '../voice-clips/overlay.ts';
import { FirstFitPacker, packInOrder } from '../voice-clips/pack.ts';
import type { EvRecord, GameRecord, VoiceMoney, VoicePricing, VoiceUnitRecord } from './config.ts';
import { CREDITS_PER_50, buildReport, gameStats, isUtterance, sayText, saySentences, secondDay } from './report.ts';
import type { Run } from './report.ts';

export function unitCredits(chars: number): number {
  return CREDITS_PER_50 * Math.ceil(chars / 50);
}

/** The characters of a said part as it would be sent to TTS (its expanded wording). */
export function unitChars(s: LessonSay): number {
  const t = sayText(s);
  return t ? [...t].length : 0;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;
const pct = (a: number, b: number): number => (b === 0 ? 0 : (100 * a) / b);
const chars = (t: string): number => [...t].length;

// ───────────────────────── an utterance's recordable units ─────────────────────────

/** One recordable unit of an utterance, in spoken order (./config.ts `VoiceUnitRecord` without the flags). */
export interface VoiceUnit {
  k: string;
  t: string;
  s: number;
  /** the exact expansion (the unit's manifest text; quotes kept) */
  text: string;
  role: TtsPartRole;
}

/** The TTS role of a said part: a lead right before its tail, a lead said alone, a tail, a whole wording. */
function roleOf(say: readonly LessonSay[], sent: readonly number[], i: number): TtsPartRole {
  const role = lessonLine(say[i]!.pool)?.role ?? 'whole';
  if (role !== 'lead') return role;
  const next = say[i + 1];
  return next && sent[i + 1] === sent[i] && lessonLine(next.pool)?.role === 'tail' ? 'lead' : 'leadAlone';
}

/**
 * The recordable units of a said utterance: every part (a button wording of the quiz is not one: it is never said
 * alone), and the stage 1–2 options sentence as one `frag` unit when the utterance says it — found by its composed
 * text in `text` (`quizOptionsText` of the quiz's labels), so an all-piece question (no button wording in `say`) counts
 * too. Its sentence is the one of its first button wording, else a sentence of its own after the others.
 */
export function voiceUnitsOf(e: Pick<EvRecord, 'say' | 'quiz' | 'text'>): VoiceUnit[] {
  const say = e.say;
  const sent = saySentences(say);
  const out: VoiceUnit[] = [];
  const labels = e.quiz?.options.map((o) => o.label) ?? [];
  const optionsText = labels.length === 3 ? quizOptionsText(labels as [string, string, string]) : null;
  let fragAt = -1;
  say.forEach((s, i) => {
    if (isOptionPool(s.pool)) {
      if (fragAt < 0) fragAt = sent[i] ?? 0;
      return;
    }
    const text = sayText(s);
    if (text === null) return;
    const role = roleOf(say, sent, i);
    out.push({ k: lessonUnitKey(s), t: ttsPartText(text, role), s: sent[i] ?? 0, text, role });
  });
  if (optionsText !== null && e.text.includes(optionsText)) {
    const s = fragAt >= 0 ? fragAt : Math.max(-1, ...sent) + 1;
    const frag: VoiceUnit = { k: lessonQuizKey(optionsText), t: ttsPartText(optionsText, 'frag'), s, text: optionsText, role: 'frag' };
    const at = out.findIndex((u) => u.s > s);
    if (at < 0) out.push(frag);
    else out.splice(at, 0, frag);
  }
  return out;
}

/** What one request records costs: its units packed by the server (or each alone). */
export function requestJobs(units: readonly Pick<VoiceUnit, 'k' | 't'>[], pricing: VoicePricing): { keys: string[]; milli: number; chars: number }[] {
  const parts = units.map((u) => ({ ...u, tts: u.t, frag: u.k.startsWith('frag:') }));
  const jobs = pricing === 'pack' ? packInOrder(parts) : parts.map((p) => ({ parts: [p], prompt: p.tts, milli: jobMilli(p.tts) }));
  return jobs.map((j) => ({ keys: j.parts.map((p) => p.k), milli: j.milli, chars: chars(j.prompt) }));
}

/** The simulated server's day of one child: what it spent today, and whether the cap paused it. */
export interface VoiceDay {
  day: number;
  milli: number;
  capped: boolean;
}

/**
 * After an utterance: its missing units (not in `cache`, each once) are requested at once; the server records them job
 * by job while the day's cap allows — the first job that does not fit pauses recording until the next day (the server's
 * `day-cap`). Returns the keys recorded and the day after it.
 */
export function recordAfter(units: readonly Pick<VoiceUnit, 'k' | 't'>[], cache: ReadonlySet<string>, money: VoiceMoney, today: VoiceDay): { recorded: Set<string>; day: VoiceDay } {
  const recorded = new Set<string>();
  const day = { ...today };
  const seen = new Set<string>();
  const missing = units.filter((u) => !cache.has(u.k) && !seen.has(u.k) && seen.add(u.k));
  if (missing.length === 0 || day.capped) return { recorded, day };
  for (const job of requestJobs(missing, money.pricing)) {
    if (money.dailyCapMilli !== null && day.milli + job.milli > money.dailyCapMilli) {
      day.capped = true;
      break;
    }
    day.milli += job.milli;
    for (const k of job.keys) recorded.add(k);
  }
  return { recorded, day };
}

/** The day (0-based) of a child's game N (1-based) with `gamesPerDay` games a day. */
export function dayOfGame(gameNo: number, gamesPerDay: number): number {
  return Math.floor((gameNo - 1) / Math.max(1, gamesPerDay));
}

const PIECE_WORD = /^(?:корол|ферз|ладь|ладе|слон|пешк|пешек|кон(?:ь|я|ю|ем|ей|и|ям|ями|ях)$)/;

/** Does a sentence name a piece (any case of король / ферзь / ладья / слон / конь / пешка)? */
export function namesPiece(text: string): boolean {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}]+/u)
    .some((w) => w !== '' && PIECE_WORD.test(w));
}

/** The units of a record: the worker's `vu`, or — an old log — derived from `say` with its per-part `voiced` flags. */
export function unitsOfRecord(e: EvRecord): VoiceUnitRecord[] {
  if (e.vu) return e.vu;
  const units = voiceUnitsOf(e);
  const sent = saySentences(e.say);
  return units.map((u) => {
    // a unit is voiced when every part it stands for was (the options sentence: its button wordings); a per-part
    // log carries one flag per said part
    const parts = u.role === 'frag' ? e.say.map((s, i) => (isOptionPool(s.pool) && sent[i] === u.s ? i : -1)).filter((i) => i >= 0) : [e.say.findIndex((s) => lessonUnitKey(s) === u.k)];
    const voiced = parts.length > 0 && parts.every((i) => e.voiced?.[i] === true);
    return { k: u.k, t: u.t, s: u.s, ...(voiced ? { v: 1 as const } : { r: 1 as const }) };
  });
}

// ───────────────────────── per game ─────────────────────────

export interface VoiceGame {
  game: string;
  child: number;
  gameNo: number;
  /** spoken utterances with pre-written parts */
  utterances: number;
  voicedUtterances: number;
  sentences: number;
  voicedSentences: number;
  /** recordable units said (a part, or an options sentence) and the voiced ones */
  parts: number;
  voicedParts: number;
  /** characters of all spoken units / of the voiced ones (≈ speaking time) */
  chars: number;
  voicedChars: number;
  /** units recorded after this game's utterances (distinct; not counted again if another child of a shared cache already paid) */
  newUnits: number;
  newChars: number;
  newCredits: number;
  /** paid jobs (pack pricing: one request may hold several units) */
  jobs: number;
  /** units heard without a recording that the day's cap left unrecorded */
  cappedUnits: number;
  /** sentences that name a piece (K8) */
  pieceSentences: number;
  /** the variety (report measures) */
  distinctSentences: number;
  spokenSentences: number;
  maxWording: number;
  adjacent: number;
}

/** The utterances of a game that carry pre-written parts (the voice can only ever play those). */
export function voiceUtterances(events: readonly EvRecord[]): EvRecord[] {
  return events.filter((e) => isUtterance(e) && e.say.length > 0);
}

/**
 * The voice numbers of one game. `paid` is the scope's set of units already paid for (a child's own, or the shared
 * one) — updated here, so the games must come in the order they were played.
 */
export function voiceGame(g: GameRecord, events: readonly EvRecord[], paid: Set<string>, pricing: VoicePricing = 'pack'): VoiceGame {
  const v: VoiceGame = {
    game: g.game,
    child: g.child,
    gameNo: g.gameNo,
    utterances: 0,
    voicedUtterances: 0,
    sentences: 0,
    voicedSentences: 0,
    parts: 0,
    voicedParts: 0,
    chars: 0,
    voicedChars: 0,
    newUnits: 0,
    newChars: 0,
    newCredits: 0,
    jobs: 0,
    cappedUnits: 0,
    pieceSentences: 0,
    distinctSentences: 0,
    spokenSentences: 0,
    maxWording: 0,
    adjacent: 0,
  };
  let newMilli = 0;
  for (const e of voiceUtterances(events)) {
    const units = unitsOfRecord(e);
    if (units.length === 0) continue;
    v.utterances++;
    if (units.every((u) => u.v === 1)) v.voicedUtterances++;
    const bySent = new Map<number, { voiced: boolean; text: string[] }>();
    for (const u of units) {
      const c = chars(u.t);
      v.parts++;
      v.chars += c;
      if (u.v === 1) {
        v.voicedParts++;
        v.voicedChars += c;
      } else if (u.r !== 1 && !paid.has(u.k)) v.cappedUnits++;
      const sent = bySent.get(u.s) ?? { voiced: true, text: [] };
      sent.voiced &&= u.v === 1;
      sent.text.push(u.t);
      bySent.set(u.s, sent);
    }
    v.sentences += bySent.size;
    v.voicedSentences += [...bySent.values()].filter((s) => s.voiced).length;
    v.pieceSentences += [...bySent.values()].filter((s) => namesPiece(s.text.join(' '))).length;
    // what the server recorded after this utterance, minus what this scope had already paid for
    const seen = new Set<string>();
    const fresh = units.filter((u) => u.r === 1 && !paid.has(u.k) && !seen.has(u.k) && seen.add(u.k));
    for (const job of requestJobs(fresh, pricing)) {
      v.jobs++;
      newMilli += job.milli;
    }
    for (const u of fresh) {
      paid.add(u.k);
      v.newUnits++;
      v.newChars += chars(u.t);
    }
  }
  const st = gameStats(g, events);
  v.distinctSentences = st.distinctSentences;
  v.spokenSentences = st.sentences;
  v.maxWording = st.maxWording?.n ?? 0;
  v.adjacent = st.adjacent.length;
  v.newCredits = r2(milliToCredits(newMilli));
  return v;
}

// ───────────────────────── the run ─────────────────────────

export interface VoiceRow {
  gameNo: number;
  games: number;
  newUnits: number;
  newChars: number;
  newCredits: number;
  jobs: number;
  cappedUnits: number;
  /** credits of this game number per child (mean, min, max) */
  creditsPerChild: { mean: number; min: number; max: number };
  partsPct: number;
  sentencesPct: number;
  utterancesPct: number;
  charsPct: number;
  /** sentences that name a piece (K8) */
  piecePct: number;
  distinctPct: number;
  maxWording: number;
  adjacent: number;
  /** «второй день» of this game number vs the previous one (utterances; sentences) */
  secondDayPct: number | null;
  secondDaySentPct: number | null;
}

export interface VoiceReport {
  policy: string;
  shared: boolean;
  money: VoiceMoney;
  prefetch: { budget: number; perChild: Record<string, { units: number; credits: number }> } | null;
  games: number;
  children: number;
  rows: VoiceRow[];
  totals: {
    newUnits: number;
    newCredits: number;
    jobs: number;
    cappedUnits: number;
    prefetchCredits: number;
    /** credits per child for all its games (prefetch included) */
    perChild: Record<string, number>;
    perChildMean: number;
    partsPct: number;
    sentencesPct: number;
    utterancesPct: number;
    charsPct: number;
    piecePct: number;
    distinctPct: number;
    maxWording: number;
    adjacent: number;
    secondDayWorstChildPct: number;
    secondDayAllPct: number;
    themeRepeats: number;
    miniRepeats: number;
    /** the hard gates of the report that fail (ids) */
    gatesFailed: string[];
  };
  perGame: VoiceGame[];
}

export function voiceReport(
  run: Run,
  opts: { policy: string; shared: boolean; money?: VoiceMoney; prefetch?: VoiceReport['prefetch']; seedUnits?: Record<string, readonly string[]> },
): VoiceReport {
  const money: VoiceMoney = opts.money ?? { pricing: 'pack', dailyCapMilli: null, gamesPerDay: 3 };
  // the order the games were played: a child's games in order; with a shared cache the rounds (game 1 of all children, …)
  const games = [...run.games].sort((a, b) => (opts.shared ? a.gameNo - b.gameNo || a.child - b.child : a.child - b.child || a.gameNo - b.gameNo));
  const shared = new Set<string>();
  const own = new Map<number, Set<string>>();
  const paidOf = (child: number): Set<string> => {
    if (opts.shared) return shared;
    let s = own.get(child);
    if (!s) {
      // prefetched units were paid before the first game (their credits are counted apart)
      s = new Set([...(opts.seedUnits?.['*'] ?? []), ...(opts.seedUnits?.[String(child)] ?? [])]);
      own.set(child, s);
    }
    return s;
  };
  if (opts.shared) for (const k of Object.values(opts.seedUnits ?? {}).flat()) shared.add(k);
  const perGame = games.map((g) => voiceGame(g, run.events.get(g.game) ?? [], paidOf(g.child), money.pricing));
  const sd = secondDay(run.games, run.events);
  const maxNo = Math.max(0, ...perGame.map((v) => v.gameNo));
  const rows: VoiceRow[] = [];
  const sum = (list: readonly VoiceGame[], f: (v: VoiceGame) => number): number => list.reduce((n, v) => n + f(v), 0);
  for (let no = 1; no <= maxNo; no++) {
    const list = perGame.filter((v) => v.gameNo === no);
    if (list.length === 0) continue;
    const credits = list.map((v) => v.newCredits);
    const pairs = sd.flatMap((c) => c.pairs).filter((p) => Number(p.game.slice(-2)) === no);
    const pu = pairs.reduce((n, p) => n + p.utterances, 0);
    const pr = pairs.reduce((n, p) => n + p.repeated, 0);
    const ps = pairs.reduce((n, p) => n + p.sentences, 0);
    const psr = pairs.reduce((n, p) => n + p.sentRepeated, 0);
    rows.push({
      gameNo: no,
      games: list.length,
      newUnits: sum(list, (v) => v.newUnits),
      newChars: sum(list, (v) => v.newChars),
      newCredits: r2(sum(list, (v) => v.newCredits)),
      jobs: sum(list, (v) => v.jobs),
      cappedUnits: sum(list, (v) => v.cappedUnits),
      creditsPerChild: { mean: r2(sum(list, (v) => v.newCredits) / list.length), min: Math.min(...credits), max: Math.max(...credits) },
      partsPct: pct(sum(list, (v) => v.voicedParts), sum(list, (v) => v.parts)),
      sentencesPct: pct(sum(list, (v) => v.voicedSentences), sum(list, (v) => v.sentences)),
      utterancesPct: pct(sum(list, (v) => v.voicedUtterances), sum(list, (v) => v.utterances)),
      charsPct: pct(sum(list, (v) => v.voicedChars), sum(list, (v) => v.chars)),
      piecePct: pct(sum(list, (v) => v.pieceSentences), sum(list, (v) => v.sentences)),
      distinctPct: pct(sum(list, (v) => v.distinctSentences), sum(list, (v) => v.spokenSentences)),
      maxWording: Math.max(...list.map((v) => v.maxWording)),
      adjacent: sum(list, (v) => v.adjacent),
      secondDayPct: pairs.length === 0 ? null : pct(pr, pu),
      secondDaySentPct: pairs.length === 0 ? null : pct(psr, ps),
    });
  }
  const prefetchOf = (child: number): number => opts.prefetch?.perChild[String(child)]?.credits ?? 0;
  const perChild: Record<string, number> = {};
  for (const v of perGame) perChild[String(v.child)] = r2((perChild[String(v.child)] ?? prefetchOf(v.child)) + v.newCredits);
  const report = buildReport(run);
  const all = sd.reduce((a, c) => ({ u: a.u + c.utterances, r: a.r + c.repeated }), { u: 0, r: 0 });
  const children = Object.keys(perChild).length;
  return {
    policy: opts.policy,
    shared: opts.shared,
    money,
    prefetch: opts.prefetch ?? null,
    games: perGame.length,
    children,
    rows,
    totals: {
      newUnits: sum(perGame, (v) => v.newUnits),
      newCredits: r2(sum(perGame, (v) => v.newCredits)),
      jobs: sum(perGame, (v) => v.jobs),
      cappedUnits: sum(perGame, (v) => v.cappedUnits),
      prefetchCredits: r2(Object.values(opts.prefetch?.perChild ?? {}).reduce((n, p) => n + p.credits, 0)),
      perChild,
      perChildMean: children === 0 ? 0 : r2(Object.values(perChild).reduce((n, c) => n + c, 0) / children),
      partsPct: pct(sum(perGame, (v) => v.voicedParts), sum(perGame, (v) => v.parts)),
      sentencesPct: pct(sum(perGame, (v) => v.voicedSentences), sum(perGame, (v) => v.sentences)),
      utterancesPct: pct(sum(perGame, (v) => v.voicedUtterances), sum(perGame, (v) => v.utterances)),
      charsPct: pct(sum(perGame, (v) => v.voicedChars), sum(perGame, (v) => v.chars)),
      piecePct: pct(sum(perGame, (v) => v.pieceSentences), sum(perGame, (v) => v.sentences)),
      distinctPct: pct(sum(perGame, (v) => v.distinctSentences), sum(perGame, (v) => v.spokenSentences)),
      maxWording: Math.max(0, ...perGame.map((v) => v.maxWording)),
      adjacent: sum(perGame, (v) => v.adjacent),
      secondDayWorstChildPct: sd.reduce((m, c) => Math.max(m, c.pct), 0),
      secondDayAllPct: pct(all.r, all.u),
      themeRepeats: report.themeRepeats.length,
      miniRepeats: report.miniRepeats.length,
      gatesFailed: report.gates.filter((g) => g.hard && !g.pass).map((g) => g.id),
    },
    perGame,
  };
}

const f1 = (x: number): string => (Math.round(x * 10) / 10).toFixed(1);

export function voiceMarkdown(r: VoiceReport): string {
  const t = r.totals;
  const m = r.money;
  const out: string[] = [];
  out.push(`# Голос по требованию — симуляция «${r.policy}»${r.shared ? ' (общий кэш на всех детей)' : ''}`);
  out.push('');
  out.push(
    `Бесплатно, беззвучно: ничего не генерируется, только считается. Партий ${r.games}, детей ${r.children}. После каждой реплики сервер сразу записывает её недостающие куски одним запросом; цена — 0.15 × ⌈знаков/50⌉ за задание, ${m.pricing === 'pack' ? 'куски запроса упакованы по рецепту «pack» (≤ 4 куска, ≤ 240 знаков, фраза вариантов ответа — отдельно)' : 'каждый кусок отдельным заданием'}.`,
  );
  out.push(`Дневной лимит: ${m.dailyCapMilli === null ? 'нет' : `${f1(milliToCredits(m.dailyCapMilli))} кр. на ребёнка (задание, которое не влезает, ставит запись на паузу до следующего дня)`}; партий в день: ${m.gamesPerDay}.`);
  if (r.prefetch) out.push(`Заранее записано (prefetch): бюджет ${r.prefetch.budget} кр. на ребёнка; ${Object.entries(r.prefetch.perChild).map(([c, p]) => `c${c}: ${p.units} ед. / ${f1(p.credits)} кр.`).join(', ')}.`);
  out.push('');
  out.push('| Партия № | новых ед. | заданий | знаков | кредитов (все дети) | кр. на ребёнка (ср. / мин–макс) | не записано (лимит) | кусков озвучено | предложений целиком | реплик целиком | знаков озвучено | называют фигуру | разных предл. | макс. формулировка | соседние | «второй день» реплик / предл. |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const x of r.rows) {
    out.push(
      `| ${x.gameNo} | ${x.newUnits} | ${x.jobs} | ${x.newChars} | ${f1(x.newCredits)} | ${f1(x.creditsPerChild.mean)} / ${f1(x.creditsPerChild.min)}–${f1(x.creditsPerChild.max)} | ${x.cappedUnits} | ${f1(x.partsPct)} % | ${f1(x.sentencesPct)} % | ${f1(x.utterancesPct)} % | ${f1(x.charsPct)} % | ${f1(x.piecePct)} % | ${f1(x.distinctPct)} % | ${x.maxWording} | ${x.adjacent} | ${x.secondDayPct === null ? '—' : `${f1(x.secondDayPct)} % / ${f1(x.secondDaySentPct ?? 0)} %`} |`,
    );
  }
  out.push('');
  out.push(
    `**Итого:** ${t.newUnits} новых единиц в ${t.jobs} заданиях, ${f1(t.newCredits)} кр. по требованию${t.prefetchCredits > 0 ? ` + ${f1(t.prefetchCredits)} кр. заранее` : ''}; на ребёнка за все его партии в среднем ${f1(t.perChildMean)} кр. (${Object.entries(t.perChild).map(([c, n]) => `c${c} ${f1(n)}`).join(', ')}).`,
  );
  out.push(`Озвучено: кусков ${f1(t.partsPct)} %, предложений целиком ${f1(t.sentencesPct)} %, реплик целиком ${f1(t.utterancesPct)} %, знаков ${f1(t.charsPct)} %.${m.dailyCapMilli !== null ? ` Из-за дневного лимита не записано ${t.cappedUnits} услышанных кусков (запишутся, когда прозвучат снова).` : ''}`);
  out.push(`Называют фигуру: ${f1(t.piecePct)} % предложений (K8: сравнить с «lazy» — дешёвый рост не должен снижать больше чем на 5 пунктов).`);
  out.push(
    `Разнообразие: разных предложений в партии ${f1(t.distinctPct)} %, макс. одной формулировки за партию ${t.maxWording}, соседних повторов ${t.adjacent}, «второй день» худший ребёнок ${f1(t.secondDayWorstChildPct)} % (все ${f1(t.secondDayAllPct)} %), повторов объявления темы за 7 партий ${t.themeRepeats}, мини-урока за 14 — ${t.miniRepeats}.`,
  );
  out.push(`Жёсткие пороги отчёта, которые не прошли: ${t.gatesFailed.length === 0 ? 'нет' : t.gatesFailed.join(', ')}.`);
  out.push('');
  return `${out.join('\n')}\n`;
}

// ───────────────────────── the prefetch plan ─────────────────────────

export interface PrefetchUnit {
  key: string;
  /** the content pool (`v3.…`), or '' for the options sentence */
  pool: string;
  n: number;
  piece?: PieceType;
  g?: 'm' | 'f';
  /** the exact expansion (the unit's text in the manifest) */
  text: string;
  /** what is sent to the TTS (`ttsPartText`: a lead without an end mark, quotes dropped) */
  tts: string;
  role: TtsPartRole;
  /** its price recorded alone (the greedy order); the plan's real price is packed (`prefetchCost`) */
  credits: number;
  /** the expected uses in one game it covers (the share of reference games that needed ≥ j wordings of its slot; ×2 for what a non-reader must hear) */
  value: number;
}

/** Pools a child of stages 1–2 (who cannot read yet) must hear: the question, right / wrong (and the options sentence). */
export function nonReaderPool(pool: string): boolean {
  return pool.startsWith('v3.quiz.q.') || pool === 'v3.quiz.right' || pool === 'v3.quiz.wrong';
}

/** A unit already recorded or in flight (the library, the overlay, its ledger): the plan never buys it again. */
export type Covered = (key: string, text: string) => boolean;

type Packable = PrefetchUnit & { frag: boolean };
const packable = (u: PrefetchUnit): Packable => ({ ...u, frag: u.role === 'frag' });

/**
 * The units to record before a child's first game for `budget` credits (greedy by expected uses per credit, the budget
 * spent PACKED, as the real recording run does), from a reference run (another seed, played with the «recorded first»
 * book): the games of the child's stage give, per pool (and per subject piece where every wording names the piece), how
 * many distinct wordings a game needs; the j-th recorded wording of a slot is worth the share of games that needed ≥ j.
 * Only wordings of the stage, without a sub-case (`when`), not pointing («вот эти клетки»), not «лучше всего» — the
 * shortest first; never a quiz button wording (said only inside the options sentence) nor the silent bark. At stages
 * 1–2 the options sentences the reference games said are candidates too (worth the share of games that said them), and
 * what a non-reader must hear counts double (U1). With the «recorded first» book these are the wordings game 1 says.
 */
export function prefetchPlan(ref: Run, opts: { stage: number; g: 'm' | 'f'; budget: number; covered?: Covered }): PrefetchUnit[] {
  const games = ref.games.filter((g) => g.stage === opts.stage);
  if (games.length === 0) return [];
  const nonReader = opts.stage <= 2;
  const weight = (pool: string): number => (nonReader && (pool === '' || nonReaderPool(pool)) ? 2 : 1);
  // per game: uses of each pool, and of each (pool, piece) where the piece was said; the options sentences said
  const perPool = new Map<string, number[]>();
  const perPiece = new Map<string, number[]>();
  const frags = new Map<string, { text: string; games: Set<number> }>();
  games.forEach((g, gi) => {
    for (const e of voiceUtterances(ref.events.get(g.game) ?? [])) {
      for (const s of e.say) {
        if (isOptionPool(s.pool) || s.pool === 'v3.bark.quiet') continue;
        const a = perPool.get(s.pool) ?? new Array<number>(games.length).fill(0);
        a[gi] = (a[gi] ?? 0) + 1;
        perPool.set(s.pool, a);
        if (s.piece) {
          const k = `${s.pool}@${s.piece}`;
          const b = perPiece.get(k) ?? new Array<number>(games.length).fill(0);
          b[gi] = (b[gi] ?? 0) + 1;
          perPiece.set(k, b);
        }
      }
      if (!nonReader) continue;
      for (const u of voiceUnitsOf(e)) {
        if (u.role !== 'frag') continue;
        const f = frags.get(u.k) ?? { text: u.text, games: new Set<number>() };
        f.games.add(gi);
        frags.set(u.k, f);
      }
    }
  });
  const atLeast = (counts: readonly number[], j: number): number => counts.filter((c) => c >= j).length / games.length;
  const cands: PrefetchUnit[] = [];
  for (const [pool, counts] of perPool) {
    const line = lessonLine(pool);
    if (!line) continue;
    const ok = line.wordings
      .map((w, i) => ({ w, n: i + 1 }))
      .filter(({ w }) => wordingFitsStage(line, w, opts.stage) && !w.when);
    const plain = ok.filter(({ w }) => !usesPiece(w.t));
    const slots: { counts: number[]; piece?: PieceType; list: typeof ok }[] = [];
    if (plain.length > 0) slots.push({ counts, list: plain });
    else {
      for (const [k, c] of perPiece) {
        if (!k.startsWith(`${pool}@`)) continue;
        slots.push({ counts: c, piece: k.slice(pool.length + 1) as PieceType, list: ok });
      }
    }
    // a lead is recorded as it is said before its tail (the tag makes the fall): one take serves both uses
    const role: TtsPartRole = line.role;
    for (const slot of slots) {
      const units = slot.list
        .map(({ w, n }) => {
          const g = usesGender(w.t) ? opts.g : undefined;
          const piece = usesPiece(w.t) ? slot.piece : undefined;
          const text = expandWording(w.t, { ...(piece ? { piece } : {}), ...(g ? { g } : {}) });
          return text && !isDeictic(text) && !(line.role === 'lead' && claimsBest(text)) ? { pool, n, ...(piece ? { piece } : {}), ...(g ? { g } : {}), text } : null;
        })
        .filter((u): u is NonNullable<typeof u> => u !== null)
        .sort((a, b) => [...a.text].length - [...b.text].length || a.n - b.n);
      units.forEach((u, j) => {
        const value = atLeast(slot.counts, j + 1) * weight(pool);
        if (value <= 0) return;
        const tts = ttsPartText(u.text, role);
        cands.push({ key: lessonUnitKey(u), ...u, tts, role, credits: unitCredits(chars(tts)), value });
      });
    }
  }
  for (const [key, f] of frags) {
    const tts = ttsPartText(f.text, 'frag');
    cands.push({ key, pool: '', n: 0, text: f.text, tts, role: 'frag', credits: unitCredits(chars(tts)), value: (f.games.size / games.length) * weight('') });
  }
  cands.sort((a, b) => b.value / b.credits - a.value / a.credits || b.value - a.value || a.key.localeCompare(b.key));
  const packer = new FirstFitPacker<Packable>();
  const out: PrefetchUnit[] = [];
  const seen = new Set<string>();
  const maxMilli = Math.round(opts.budget * 1000);
  for (const c of cands) {
    if (seen.has(c.key) || opts.covered?.(c.key, c.text) === true) continue;
    if (!packer.add(packable(c), maxMilli)) continue;
    seen.add(c.key);
    out.push(c);
  }
  return out;
}

/** The plan's packed price and job count (SPEC milli-credits), and what the same units would cost one job each. */
export function prefetchCost(plan: readonly PrefetchUnit[]): { milli: number; jobs: number; unpackedMilli: number } {
  const packer = new FirstFitPacker<Packable>();
  for (const u of plan) packer.add(packable(u));
  return { milli: packer.milli, jobs: packer.jobs().length, unpackedMilli: plan.reduce((n, u) => n + jobMilli(u.tts), 0) };
}

/**
 * The jobs file of a plan (tools/voice-clips/jobs.ts), campaign `prefetch`, packed by the recipe: `<#0.6#>` between the
 * parts, split at tag silences ≥ 700 ms, a question last, the options sentence alone; take 101 (the overlay's takes).
 * Each piece keeps its exact expansion (the manifest's stale-take guard), its role (a lead ending high → `ctx: 'cont'`)
 * and the words its placeholders produced (the overlay's ASR must hear them). Validated like any jobs file.
 */
export function prefetchJobsFile(plan: readonly PrefetchUnit[], opts: { stage: number; g: 'm' | 'f' }): JobsFile {
  const packer = new FirstFitPacker<Packable>();
  for (const u of plan) packer.add(packable(u));
  const batch = `prefetch-s${opts.stage}${opts.g}`;
  const jobs: GenJob[] = packer.jobs().map((j) => {
    const pieces: UnitPiece[] = j.parts.map((u) => {
      const critical = u.role === 'frag' ? [] : placeholderWordsOf(u);
      return {
        key: u.key,
        text: u.text,
        ...(u.pool !== '' ? { pool: poolKeyOf(u.pool, u.piece, u.g) } : {}),
        kind: u.role === 'frag' ? 'frag' : 'line',
        role: u.role,
        ...(critical.length > 0 ? { critical } : {}),
      };
    });
    return {
      prompt: j.prompt,
      take: ONDEMAND_TAKE_BASE,
      recipe: pieces.length > 1 ? 'pack' : 'single',
      pieces,
      ...(pieces.length > 1 ? { split: { ...PACK_SPLIT } } : {}),
      tier: 'prefetch',
      batch,
    };
  });
  return parseJobsFile({ v: 1, voiceKey: VOICE_KEY, campaign: PREFETCH_CAMPAIGN, jobs });
}

function placeholderWordsOf(u: PrefetchUnit): string[] {
  const w = lessonLine(u.pool)?.wordings[u.n - 1];
  return w ? placeholderWords(w.t, { ...(u.piece ? { piece: u.piece } : {}), ...(u.g ? { g: u.g } : {}) }) : [];
}
