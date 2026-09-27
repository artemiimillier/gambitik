/**
 * The 50-game report of «Учитель» (docs/TEACHING.md §2.11, §7): pure functions over the records of
 * ./config.ts — repetition by wording id (`say[].pool#n`) and by normalised text, openers, adjacent repeats, «второй
 * день», theme / mini-lesson repeats across games, the idea tail of advice, the hidden arrow, the hygiene of every word
 * (squares, Latin, «молодец», a feminine Гамбитик), pointing words over an undrawable cue, the truth audit verdicts and
 * the recording estimate. The rules of a turn (§2.2–§2.4) are gates too: danger in ≤ 25 %
 * of the turns of every stage and its cadence (always / once in 3 / a pawn once in 4, never at stages 1–2), the word
 * caps, blitz one sentence (two for «можно не спасать» + advice, a treasure + «найдёшь сам?», a lesson + its advice),
 * no advice arrow without words about the move, «как я и говорил» only after the advice was said, the capture quiz only
 * in agreement with the advice, the stage-5 «позже» rhythm, no treasure hint after the advice is shown. Also:
 * a quiz answer shows the arrow only with its advice words (an answer without them waits for «Совет» — a target),
 * the answer's own cap, praise ≤ 10 words (§2.5), blitz mini-lessons («как думать» or inside a danger, one sentence,
 * one a game), and the danger table shows the repeated warnings the lesson counted as «прочая».
 * No engine and no files here: the CLI reads and writes, the worker plays.
 */
import { Chess } from 'chess.js';
import type { LessonSay, PieceType } from '../../packages/shared/src/index.ts';
import { LESSON_LINES, lessonFamilyOf, lessonLine } from '../../packages/content/src/index.ts';
import type { LessonLine } from '../../packages/content/src/index.ts';
import { claimsBest, cueDrawable, expandLessonWording, expandWording, hasFeminineSelfReference, hasSpokenSquare, isDeictic, pieceNameRu } from '../../packages/core/src/index.ts';
import { countWords } from '../../packages/core/src/coach/phrase.ts';
import { ANSWER_WORDS, DANGER_MINI_WORDS, LESSON_WORDS, MINI_WORDS } from '../../packages/core/src/coach/lesson/turn.ts';
import { PRAISE_MAX_WORDS } from '../../packages/core/src/coach/lesson/praise.ts';
import { FAMILY_RU, TC_RU } from './config.ts';
import type { AuditItem, AuditVerdict, DangerRecord, ErrorRecord, EvRecord, GameRecord, RunLine, TurnRecord } from './config.ts';

// ───────────────────────── thresholds ─────────────────────────

export const GATES = {
  /** any wording (pool#n) in one game: gate / target */
  wordingPerGame: 3,
  wordingPerGameTarget: 2,
  /** any opener (first 3 words; target: first 2) in one game */
  openerPerGame: 3,
  /** «второй день»: utterances of game k heard word for word in game k−1 of the same child */
  secondDayPct: 15,
  /** the same theme announcement within this many games of a child */
  themeWindow: 7,
  /** the same mini-lesson wording within this many games */
  miniWindow: 14,
  /** advice with an idea tail */
  adviceIdeaPct: 90,
  /** child turns that start with the advice arrow hidden (quiz, «Сам», treasure, stage-5 reveal-later), stages ≥ 3 */
  hiddenMin: 15,
  hiddenMax: 35,
  /** child turns whose words speak of a danger, per stage (§2.2 «Опасность — не в каждом ходе»: goal 20–25 %) */
  dangerMaxPct: 25,
  /** §2.2 cadence: other threats / attacked pieces at most once in this many child turns; a pawn once in this many */
  dangerEveryOther: 3,
  dangerEveryPawn: 4,
  /** the cross-game book the app stores (gambit.lessonBook) */
  bookBytes: 16 * 1024,
} as const;

/** Giselle: 0.15 credits per started 50 characters of one take. */
export const CREDITS_PER_50 = 0.15;

// ───────────────────────── reading a run ─────────────────────────

export interface Run {
  games: GameRecord[];
  /** game → its utterances, in order */
  events: Map<string, EvRecord[]>;
  errors: ErrorRecord[];
}

export function parseRun(lines: readonly RunLine[]): Run {
  const games: GameRecord[] = [];
  const events = new Map<string, EvRecord[]>();
  const errors: ErrorRecord[] = [];
  for (const l of lines) {
    if (l.t === 'game') games.push(l);
    else if (l.t === 'ev') events.set(l.game, [...(events.get(l.game) ?? []), l]);
    else if (l.t === 'error') errors.push(l);
  }
  games.sort((a, b) => a.child - b.child || a.gameNo - b.gameNo);
  for (const list of events.values()) list.sort((a, b) => a.n - b.n);
  return { games, events, errors };
}

/** JSON lines → records (blank and broken lines are skipped). */
export function parseJsonLines(text: string): RunLine[] {
  const out: RunLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    try {
      const v = JSON.parse(line) as RunLine;
      if (v && typeof v === 'object' && (v.t === 'ev' || v.t === 'game' || v.t === 'error')) out.push(v);
    } catch {
      // a torn line of a killed worker
    }
  }
  return out;
}

// ───────────────────────── words ─────────────────────────

/** lower case, ё→е, no quotes or punctuation, single spaces */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”„()[\]]/g, ' ')
    .replace(/[.!?…,:;—–]+/g, ' ')
    .replace(/\s-\s/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The sentences of an utterance (as the ear splits them). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter((s) => /[а-яёА-ЯЁA-Za-z]/u.test(s));
}

const PIECE_FORMS: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const p of ['p', 'n', 'b', 'r', 'q'] as const) for (const c of ['nom', 'acc', 'gen', 'ins'] as const) s.add(pieceNameRu(p, c).replace(/ё/g, 'е'));
  for (const w of ['коне', 'коню', 'кони', 'коней', 'конями', 'коням', 'слону', 'слоне', 'слоны', 'слонов', 'слонами', 'слонам', 'ладье', 'ладьи', 'ладей', 'ладьями', 'ладьям', 'ферзю', 'ферзе', 'пешке', 'пешки', 'пешек', 'пешками', 'пешкам'])
    s.add(w);
  return s;
})();

/** The first `n` words of an utterance, piece words → {фигура} («Давай сходим конём» → «давай сходим {фигура}»). */
export function openerOf(text: string, n: number): string {
  const words = normText(text)
    .split(' ')
    .filter((w) => /[а-яa-z]/u.test(w))
    .slice(0, n)
    .map((w) => (PIECE_FORMS.has(w) ? '{фигура}' : w));
  return words.join(' ');
}

export function sayKey(s: Pick<LessonSay, 'pool' | 'n'>): string {
  return `${s.pool}#${s.n}`;
}

/** The wording template of a said part (null: unknown pool / number). */
export function wordingOf(s: Pick<LessonSay, 'pool' | 'n'>): string | null {
  return lessonLine(s.pool)?.wordings[s.n - 1]?.t ?? null;
}

/** The words of a said part as the child heard them. */
export function sayText(s: LessonSay): string | null {
  const t = wordingOf(s);
  return t === null ? null : expandWording(t, { ...(s.piece ? { piece: s.piece } : {}), ...(s.g ? { g: s.g } : {}) });
}

function isOptionPool(pool: string): boolean {
  return pool.startsWith('v3.quiz.opt.') || pool.startsWith('v3.quiz.cat.');
}

/**
 * The sentence index of every said part (render: a whole wording or a lead is a new sentence, a tail goes on; the
 * spoken quiz options are one sentence).
 */
export function saySentences(say: readonly LessonSay[]): number[] {
  const out: number[] = [];
  let idx = -1;
  let prevOption = false;
  for (const s of say) {
    if (isOptionPool(s.pool)) {
      if (!prevOption) idx++;
      prevOption = true;
      out.push(idx);
      continue;
    }
    prevOption = false;
    if (lessonLine(s.pool)?.role !== 'tail' || idx < 0) idx++;
    out.push(idx);
  }
  return out;
}

/** A spoken utterance (not the quiet turn's sound word, not an empty event). */
export function isUtterance(e: EvRecord): boolean {
  return e.source !== 'bark' && e.empty !== true && e.text.trim() !== '';
}

// ───────────────────────── hygiene ─────────────────────────

export type HygieneRule = 'square' | 'latin' | 'banned' | 'selfFeminine';

export interface HygieneIssue {
  game: string;
  n: number;
  rule: HygieneRule;
  where: 'text' | 'bubble' | 'quiz';
  text: string;
}

const PRAISE_BANNED_RE = /(?<![а-яё])(?:молод(?:ец|цы|чина)|умниц[аы]|так держать)(?![а-яё])/iu;

/** What an utterance's words break: squares, Latin, generic praise, a feminine Гамбитик — in the voice, the bubble and the quiz card. */
export function hygieneIssues(e: EvRecord): HygieneIssue[] {
  const out: HygieneIssue[] = [];
  const fields: { where: HygieneIssue['where']; text: string }[] = [
    { where: 'text', text: e.text },
    { where: 'bubble', text: e.bubble },
  ];
  if (e.quiz) {
    fields.push({ where: 'quiz', text: e.quiz.question });
    for (const o of e.quiz.options) fields.push({ where: 'quiz', text: o.label });
  }
  for (const f of fields) {
    if (!f.text) continue;
    if (hasSpokenSquare(f.text)) out.push({ game: e.game, n: e.n, rule: 'square', where: f.where, text: f.text });
    if (/[A-Za-z]/.test(f.text)) out.push({ game: e.game, n: e.n, rule: 'latin', where: f.where, text: f.text });
    if (PRAISE_BANNED_RE.test(f.text)) out.push({ game: e.game, n: e.n, rule: 'banned', where: f.where, text: f.text });
    if (hasFeminineSelfReference(f.text)) out.push({ game: e.game, n: e.n, rule: 'selfFeminine', where: f.where, text: f.text });
  }
  return out;
}

export interface DeicticIssue {
  game: string;
  n: number;
  pool: string;
  sentence: number;
  text: string;
}

/** Pointing words («вот эти клетки», «сюда») in a sentence the board cannot draw a cue for. */
export function deicticIssues(e: EvRecord): DeicticIssue[] {
  const out: DeicticIssue[] = [];
  const idx = saySentences(e.say);
  e.say.forEach((s, i) => {
    const t = sayText(s);
    if (!t || !isDeictic(t)) return;
    const k = idx[i] ?? 0;
    if (!e.cues.some((c) => c.sentence === k && cueDrawable(c))) out.push({ game: e.game, n: e.n, pool: s.pool, sentence: k, text: t });
  });
  return out;
}

// ───────────────────────── advice ─────────────────────────

const ADVICE_RE = /^v3\.(lead\.|go\.|helper$|whole\.)/;
const IDEA_RE = /^v3\.(idea\.(?!none$)|aim\.|q\.|whole\.|themeTail\.)/;

/** An utterance holding an advice sentence; `idea` — it says why (an idea tail, an aim, a question, a whole castle line). */
export function adviceOf(e: EvRecord): { advice: boolean; idea: boolean } {
  const advice = e.say.some((s) => ADVICE_RE.test(s.pool));
  return { advice, idea: advice && e.say.some((s) => IDEA_RE.test(s.pool)) };
}

/** Did an utterance use a lead that claims «лучше всего / сильнее всего»? */
export function claimsBestLead(say: readonly LessonSay[]): boolean {
  return say.some((s) => s.pool.startsWith('v3.lead.') && claimsBest(wordingOf(s) ?? ''));
}

// ───────────────────────── per game ─────────────────────────

export interface Counted {
  key: string;
  n: number;
  text?: string;
}

export interface GameStats {
  game: string;
  child: number;
  stage: number;
  gameNo: number;
  tc: string;
  childColor: string;
  persona: string;
  strategyId: string | null;
  family: string | null;
  result: string;
  termination: string;
  outcome: 'win' | 'loss' | 'draw' | 'unfinished';
  plies: number;
  utterances: number;
  sentences: number;
  distinctSentences: number;
  distinctRatio: number;
  words: number;
  barks: number;
  empty: number;
  moments: Record<string, number>;
  minis: number;
  maxWording: Counted | null;
  maxSentence: Counted | null;
  maxOpener3: Counted | null;
  maxOpener2: Counted | null;
  adjacent: { n: number; sentence: string }[];
  quizzes: { asked: number; right: number; wrong: number; timeout: number; sovet: number; moved: number };
  moves: number;
  hiddenAtStart: number;
  movedHidden: number;
  adviceUtterances: number;
  adviceWithIdea: number;
  takebacks: number;
  takeawayKey: string;
  bookBytes: number;
}

function outcomeOf(g: Pick<GameRecord, 'result' | 'childColor'>): GameStats['outcome'] {
  if (g.result === '1/2-1/2') return 'draw';
  if (g.result === '1-0') return g.childColor === 'w' ? 'win' : 'loss';
  if (g.result === '0-1') return g.childColor === 'b' ? 'win' : 'loss';
  return 'unfinished';
}

function maxOf(m: Map<string, number>, text?: (k: string) => string | undefined): Counted | null {
  let best: Counted | null = null;
  for (const [key, n] of m) if (!best || n > best.n || (n === best.n && key < best.key)) best = { key, n };
  if (best && text) {
    const t = text(best.key);
    if (t) best.text = t;
  }
  return best;
}

function bump(m: Map<string, number>, k: string, by = 1): void {
  m.set(k, (m.get(k) ?? 0) + by);
}

export function wordingSample(key: string): string {
  const i = key.lastIndexOf('#');
  return wordingOf({ pool: key.slice(0, i), n: Number(key.slice(i + 1)) }) ?? '';
}

export function gameStats(g: GameRecord, events: readonly EvRecord[]): GameStats {
  const utt = events.filter(isUtterance);
  const moments: Record<string, number> = {};
  const wording = new Map<string, number>();
  const sentence = new Map<string, number>();
  const op3 = new Map<string, number>();
  const op2 = new Map<string, number>();
  let sentences = 0;
  let words = 0;
  let minis = 0;
  let adviceU = 0;
  let adviceIdea = 0;
  const adjacent: GameStats['adjacent'] = [];
  let prev: Set<string> | null = null;
  for (const e of events) if (e.source === 'bark') moments.quiet = (moments.quiet ?? 0) + 1;
  for (const e of utt) {
    moments[e.moment] = (moments[e.moment] ?? 0) + 1;
    for (const s of e.say) bump(wording, sayKey(s));
    if (e.say.some((s) => s.pool.startsWith('v3.mini.'))) minis++;
    const sents = splitSentences(e.text).map(normText).filter((s) => s !== '');
    sentences += sents.length;
    for (const s of sents) bump(sentence, s);
    words += countWords(e.text);
    bump(op3, openerOf(e.text, 3));
    bump(op2, openerOf(e.text, 2));
    const now = new Set(sents);
    if (prev) for (const s of now) if (prev.has(s)) adjacent.push({ n: e.n, sentence: s });
    prev = now;
    const a = adviceOf(e);
    if (a.advice) {
      adviceU++;
      if (a.idea) adviceIdea++;
    }
  }
  const quizzes = { asked: 0, right: 0, wrong: 0, timeout: 0, sovet: 0, moved: 0 };
  let hiddenAtStart = 0;
  let movedHidden = 0;
  let takebacks = 0;
  for (const t of g.turns) {
    if (t.quiz) {
      quizzes.asked++;
      quizzes[t.quiz.how]++;
    }
    if (t.advice && t.adviceHidden) hiddenAtStart++;
    if (t.advice && !t.move.arrowShown) movedHidden++;
    if (t.takeback) takebacks++;
  }
  return {
    game: g.game,
    child: g.child,
    stage: g.stage,
    gameNo: g.gameNo,
    tc: g.tc,
    childColor: g.childColor,
    persona: g.persona,
    strategyId: g.strategyId,
    family: g.family,
    result: g.result,
    termination: g.termination,
    outcome: outcomeOf(g),
    plies: g.plies.length,
    utterances: utt.length,
    sentences,
    distinctSentences: sentence.size,
    distinctRatio: sentences === 0 ? 1 : sentence.size / sentences,
    words,
    barks: events.filter((e) => e.source === 'bark').length,
    empty: events.filter((e) => e.empty === true).length,
    moments,
    minis,
    maxWording: maxOf(wording, wordingSample),
    maxSentence: maxOf(sentence),
    maxOpener3: maxOf(op3),
    maxOpener2: maxOf(op2),
    adjacent,
    quizzes,
    moves: g.turns.length,
    hiddenAtStart,
    movedHidden,
    adviceUtterances: adviceU,
    adviceWithIdea: adviceIdea,
    takebacks,
    takeawayKey: g.takeawayKey,
    bookBytes: g.bookBytes,
  };
}

// ───────────────────────── across games ─────────────────────────

export interface RepeatRow {
  key: string;
  text: string;
  plays: number;
  games: number;
  maxPerGame: number;
  maxGame: string;
}

function repeatRows(perGame: Map<string, Map<string, number>>, text: (k: string) => string): RepeatRow[] {
  const acc = new Map<string, { plays: number; games: number; max: number; maxGame: string }>();
  for (const [game, m] of perGame) {
    for (const [k, n] of m) {
      const a = acc.get(k) ?? { plays: 0, games: 0, max: 0, maxGame: '' };
      a.plays += n;
      a.games += 1;
      if (n > a.max) {
        a.max = n;
        a.maxGame = game;
      }
      acc.set(k, a);
    }
  }
  return [...acc.entries()]
    .map(([key, a]) => ({ key, text: text(key), plays: a.plays, games: a.games, maxPerGame: a.max, maxGame: a.maxGame }))
    .sort((a, b) => b.plays - a.plays || b.maxPerGame - a.maxPerGame || a.key.localeCompare(b.key));
}

export interface SecondDay {
  child: number;
  pairs: { game: string; prev: string; utterances: number; repeated: number; pct: number; examples: string[]; sentences: number; sentRepeated: number }[];
  utterances: number;
  repeated: number;
  pct: number;
  /** the same by sentence (info): sentences of game k heard in game k−1 */
  sentences: number;
  sentRepeated: number;
  sentPct: number;
}

/** «Второй день»: the share of game k's utterances heard word for word in game k−1 of the same child. */
export function secondDay(games: readonly GameRecord[], events: ReadonlyMap<string, readonly EvRecord[]>): SecondDay[] {
  const byChild = new Map<number, GameRecord[]>();
  for (const g of games) byChild.set(g.child, [...(byChild.get(g.child) ?? []), g]);
  const out: SecondDay[] = [];
  for (const [child, list] of [...byChild.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...list].sort((a, b) => a.gameNo - b.gameNo);
    const pairs: SecondDay['pairs'] = [];
    for (let i = 1; i < sorted.length; i++) {
      const g = sorted[i] as GameRecord;
      const p = sorted[i - 1] as GameRecord;
      if (p.gameNo !== g.gameNo - 1) continue;
      const prevUtt = (events.get(p.game) ?? []).filter(isUtterance);
      const before = new Set(prevUtt.map((e) => normText(e.text)));
      const beforeSent = new Set(prevUtt.flatMap((e) => splitSentences(e.text).map(normText)));
      const now = (events.get(g.game) ?? []).filter(isUtterance);
      const hits = now.filter((e) => before.has(normText(e.text)));
      const sents = now.flatMap((e) => splitSentences(e.text).map(normText)).filter((x) => x !== '');
      pairs.push({
        game: g.game,
        prev: p.game,
        utterances: now.length,
        repeated: hits.length,
        pct: now.length === 0 ? 0 : (100 * hits.length) / now.length,
        examples: [...new Set(hits.map((e) => e.text))].slice(0, 5),
        sentences: sents.length,
        sentRepeated: sents.filter((x) => beforeSent.has(x)).length,
      });
    }
    const utterances = pairs.reduce((n, p) => n + p.utterances, 0);
    const repeated = pairs.reduce((n, p) => n + p.repeated, 0);
    const sentences = pairs.reduce((n, p) => n + p.sentences, 0);
    const sentRepeated = pairs.reduce((n, p) => n + p.sentRepeated, 0);
    out.push({ child, pairs, utterances, repeated, pct: utterances === 0 ? 0 : (100 * repeated) / utterances, sentences, sentRepeated, sentPct: sentences === 0 ? 0 : (100 * sentRepeated) / sentences });
  }
  return out;
}

export interface CrossRepeat {
  child: number;
  key: string;
  text: string;
  games: number[];
}

/**
 * The same wording said in two games of a child less than `window` games apart (the same game twice counts too) —
 * `pick` chooses the wordings of an utterance to watch.
 */
export function crossGameRepeats(
  games: readonly GameRecord[],
  events: ReadonlyMap<string, readonly EvRecord[]>,
  window: number,
  pick: (e: EvRecord) => readonly LessonSay[],
): CrossRepeat[] {
  const seen = new Map<string, { child: number; key: string; games: number[] }>();
  for (const g of [...games].sort((a, b) => a.child - b.child || a.gameNo - b.gameNo)) {
    for (const e of (events.get(g.game) ?? []).filter(isUtterance)) {
      for (const s of pick(e)) {
        const id = `${g.child}|${sayKey(s)}`;
        const r = seen.get(id) ?? { child: g.child, key: sayKey(s), games: [] };
        r.games.push(g.gameNo);
        seen.set(id, r);
      }
    }
  }
  const out: CrossRepeat[] = [];
  for (const r of seen.values()) {
    const gs = [...r.games].sort((a, b) => a - b);
    let bad = false;
    for (let i = 1; i < gs.length; i++) if ((gs[i] as number) - (gs[i - 1] as number) < window) bad = true;
    if (bad) out.push({ child: r.child, key: r.key, text: wordingSample(r.key), games: gs });
  }
  return out.sort((a, b) => a.child - b.child || a.key.localeCompare(b.key));
}

export function themeAnnouncementSay(e: EvRecord): readonly LessonSay[] {
  return e.source === 'start' && e.moment === 'theme' ? e.say : [];
}

export function miniSay(e: EvRecord): readonly LessonSay[] {
  return e.say.filter((s) => s.pool.startsWith('v3.mini.'));
}

// ───────────────────────── the truth audit (verdicts are pure; the worker runs the deep engine) ─────────────────────────

/** What a deep MultiPV analysis says about a position (win% of the side to move). */
export interface DeepView {
  depth: number;
  best: number;
  bestUci: string;
  lines: { uci: string; win: number }[];
  /** uci → win% of every move scored (lines + searchmoves checks) */
  known: Record<string, number>;
  /** an upper bound for unlisted moves (the MultiPV closure) */
  floor: number;
}

export interface Verdict {
  verdict: AuditVerdict;
  detail: string;
}

const f1 = (x: number): string => x.toFixed(1);

function movesOf(fen: string): { uci: string; piece: PieceType; captured: boolean }[] {
  try {
    return new Chess(fen).moves({ verbose: true }).map((m) => ({ uci: `${m.from}${m.to}${m.promotion ?? ''}`, piece: m.piece as PieceType, captured: !!m.captured }));
  } catch {
    return [];
  }
}

function winOf(d: DeepView, uci: string): number | null {
  return d.known[uci.toLowerCase()] ?? null;
}

/** A quiz answer against the deep engine (§6.1). danger / oppIdea / why are static claims (no engine). */
export function auditQuizVerdict(q: { kind: string; correctId: string; fen: string; optionIds: readonly string[]; captureUci?: string | null }, d: DeepView): Verdict {
  const moves = movesOf(q.fen);
  const typeOf = new Map(moves.map((m) => [m.uci, m.piece] as const));
  if (q.kind === 'whichPiece') {
    const bestType = typeOf.get(d.bestUci);
    if (bestType !== q.correctId) return { verdict: 'disagree', detail: `глубже лучший ход ${d.bestUci} (${bestType ?? '?'}), а ответ — ${q.correctId}` };
    for (const t of q.optionIds.filter((id) => id !== q.correctId)) {
      const near = d.lines.filter((l) => typeOf.get(l.uci) === t && l.win >= d.best - 5);
      if (near.length > 0) return { verdict: 'disagree', detail: `ход-обманка ${near[0]?.uci} (${t}) в пределах 5 % от лучшего (${f1(near[0]?.win ?? 0)} против ${f1(d.best)})` };
    }
    const second = d.lines.find((l) => typeOf.get(l.uci) !== q.correctId);
    return { verdict: 'agree', detail: `лучший ${d.bestUci} ${f1(d.best)} %${second ? `, другой фигурой ${second.uci} ${f1(second.win)} %` : ''}` };
  }
  if (q.kind === 'canCapture') {
    const uci = q.captureUci ?? '';
    const w = winOf(d, uci);
    if (w === null) return { verdict: 'error', detail: `нет оценки взятия ${uci}` };
    const gap = d.best - w;
    const detail = `взятие ${uci}: ${f1(w)} %, лучший ${d.bestUci} ${f1(d.best)} % (разница ${f1(gap)})`;
    if (q.correctId === 'capYes' || q.correctId === 'capTrade') return { verdict: gap >= 10 ? 'disagree' : gap >= 5 ? 'borderline' : 'agree', detail };
    if (q.correctId === 'capLose') return { verdict: gap < 5 ? 'disagree' : gap < 10 ? 'borderline' : 'agree', detail };
    return { verdict: 'error', detail: `неизвестный ответ ${q.correctId}` };
  }
  if (q.kind === 'checkEscape') {
    const way = (u: string): string | null => {
      const m = moves.find((x) => x.uci === u);
      if (!m) return null;
      return m.piece === 'k' ? 'escKing' : m.captured ? 'escCapture' : 'escBlock';
    };
    const bestWay = way(d.bestUci);
    if (bestWay === q.correctId) return { verdict: 'agree', detail: `лучший ${d.bestUci} — ${bestWay}` };
    const claimed = moves.filter((m) => way(m.uci) === q.correctId).map((m) => winOf(d, m.uci) ?? d.floor);
    const top = claimed.length > 0 ? Math.max(...claimed) : -1;
    return { verdict: top >= d.best - 5 ? 'borderline' : 'disagree', detail: `глубже лучший ${d.bestUci} — ${bestWay ?? '?'}; способ ${q.correctId} не лучше ${f1(top)} % против ${f1(d.best)} %` };
  }
  return { verdict: 'static', detail: 'доказательство по позиции, без движка' };
}

/** Praise tiers: a real find («always») may be a little under the best; a routine deed must be a sound move. */
export function praiseTier(reason: string): 'always' | 'routine' {
  return /^(tactic\.|treasureFound|mate$|stoppedMate|promotion)/.test(reason) ? 'always' : 'routine';
}

/** The praised move against the deep engine. */
export function auditPraiseVerdict(reason: string, san: string, moveWin: number | null, d: DeepView): Verdict {
  if (reason === 'mate') return san.includes('#') ? { verdict: 'agree', detail: 'мат на доске' } : { verdict: 'disagree', detail: `похвала «мат», а ход ${san}` };
  if (moveWin === null) return { verdict: 'error', detail: 'нет оценки хода' };
  const gap = d.best - moveWin;
  const detail = `ход ${f1(moveWin)} %, лучший ${d.bestUci} ${f1(d.best)} % (потеря ${f1(gap)})`;
  if (praiseTier(reason) === 'always') return { verdict: gap >= 10 ? 'disagree' : gap >= 5 ? 'borderline' : 'agree', detail };
  return { verdict: gap >= 5 ? 'disagree' : gap >= 2 ? 'borderline' : 'agree', detail };
}

/** «Лучше всего / сильнее всего»: the advice is the deep engine's first move and the second is ≥ 3 % worse. */
export function auditBestVerdict(uci: string, d: DeepView): Verdict {
  const u = uci.toLowerCase();
  const second = d.lines.find((l) => l.uci !== d.bestUci);
  if (d.bestUci === u) {
    const gap = second ? d.best - second.win : 100;
    return { verdict: gap >= 3 ? 'agree' : 'borderline', detail: `первый ход и глубже; второй ${second ? `${second.uci} ${f1(second.win)} %` : 'нет'} (разрыв ${f1(gap)})` };
  }
  const w = winOf(d, u);
  if (w !== null && w >= d.best - 3) return { verdict: 'borderline', detail: `глубже первый ${d.bestUci} ${f1(d.best)} %, совет ${f1(w)} % — почти так же` };
  return { verdict: 'disagree', detail: `глубже первый ${d.bestUci} ${f1(d.best)} %, совет ${w === null ? '≤ ' + f1(d.floor) : f1(w)} %` };
}

// ───────────────────────── the recording estimate ─────────────────────────

export interface RecordingPart {
  wordings: number;
  units: number;
  chars: number;
  credits: number;
}

export interface Recording {
  library: RecordingPart;
  used: RecordingPart;
  heard: RecordingPart;
  byFamily: { family: string; library: RecordingPart; used: RecordingPart }[];
}

function credits(chars: number): number {
  return CREDITS_PER_50 * Math.ceil(chars / 50);
}

function emptyPart(): RecordingPart {
  return { wordings: 0, units: 0, chars: 0, credits: 0 };
}

function addWording(p: RecordingPart, line: LessonLine, n: number): void {
  const w = line.wordings[n - 1];
  if (!w) return;
  p.wordings++;
  for (const x of expandLessonWording(line, w)) {
    if (!x.text) continue;
    const c = [...x.text].length;
    p.units++;
    p.chars += c;
    p.credits += credits(c);
  }
}

/**
 * What recording the lesson would cost with Giselle (0.15 credits per started 50 characters of a take): the whole
 * library (every wording × its piece / gender expansions), the wordings the run used (with all their expansions) and the
 * expansions actually heard.
 */
export function recordingEstimate(used: Iterable<LessonSay>, lines: readonly LessonLine[] = LESSON_LINES): Recording {
  const library = emptyPart();
  const usedPart = emptyPart();
  const heard = emptyPart();
  const fam = new Map<string, { library: RecordingPart; used: RecordingPart }>();
  const famOf = (pool: string): { library: RecordingPart; used: RecordingPart } => {
    const f = lessonFamilyOf(pool);
    const got = fam.get(f) ?? { library: emptyPart(), used: emptyPart() };
    fam.set(f, got);
    return got;
  };
  for (const line of lines) line.wordings.forEach((_, i) => {
    addWording(library, line, i + 1);
    addWording(famOf(line.id).library, line, i + 1);
  });
  const usedKeys = new Set<string>();
  const heardKeys = new Set<string>();
  const byId = new Map(lines.map((l) => [l.id, l] as const));
  for (const s of used) {
    const line = byId.get(s.pool);
    if (!line) continue;
    const k = sayKey(s);
    if (!usedKeys.has(k)) {
      usedKeys.add(k);
      addWording(usedPart, line, s.n);
      addWording(famOf(line.id).used, line, s.n);
    }
    const hk = `${k}|${s.piece ?? ''}|${s.g ?? ''}`;
    if (!heardKeys.has(hk)) {
      heardKeys.add(hk);
      const w = line.wordings[s.n - 1];
      const t = w ? expandWording(w.t, { ...(s.piece ? { piece: s.piece } : {}), ...(s.g ? { g: s.g } : {}) }) : null;
      if (t) {
        const c = [...t].length;
        heard.units++;
        heard.chars += c;
        heard.credits += credits(c);
      }
    }
  }
  heard.wordings = usedKeys.size;
  const round = (p: RecordingPart): void => {
    p.credits = Math.round(p.credits * 100) / 100;
  };
  for (const p of [library, usedPart, heard, ...[...fam.values()].flatMap((f) => [f.library, f.used])]) round(p);
  return {
    library,
    used: usedPart,
    heard,
    byFamily: [...fam.entries()].map(([family, v]) => ({ family, ...v })).sort((a, b) => b.library.credits - a.library.credits),
  };
}

// ───────────────────────── observations (rhythm, length, words without a move) ─────────────────────────

export interface Examples {
  count: number;
  of?: number;
  byMoment?: Record<string, number>;
  examples: string[];
}

export type DangerClassId = DangerRecord['cls'];

export interface DangerStage {
  stage: number;
  /** child turns */
  turns: number;
  /** turns whose moment is danger (its words were said: the sentence, «можно не спасать», its quiz) */
  danger: number;
  pct: number;
  /** turns where the lesson found a danger (said or not) */
  found: number;
  byClass: Record<DangerClassId, { found: number; spoken: number }>;
  /** said about the same square as the danger said on the child turn just before (the child left it) */
  sameAgain: number;
  /** a warning repeated about the same piece on the same square: statically «всегда», counted by the lesson as «прочая» — found / said */
  repeatWarn: { found: number; spoken: number };
}

export interface Observations {
  /** turns whose moment is danger, per stage, and the dangers found (§2.2 «Опасность — не в каждом ходе») */
  dangerShare: DangerStage[];
  /** §2.2 cadence broken: a pawn at stages 1–2, a pawn / other danger said too soon, a sure danger left unsaid, a danger repeated right after the mistake words, «Соперник напал» over an unsaid danger, «предупреждали» after an unsaid one */
  dangerCadence: Examples;
  /** the moments of the child turns per stage (TurnRecord.moment) */
  momentsByStage: { stage: number; turns: number; moments: Record<string, number> }[];
  /** turn utterances over their word cap (§2.2: 16 / 22; the engine's caps for a mini-lesson 40 and a danger with its lesson 32) */
  overCap: Examples;
  /** blitz turn utterances with more sentences than §2.2 allows (one; two for «можно не спасать» + advice, a treasure + «найдёшь сам?», a lesson + its advice; quizzes exempt) */
  blitzMulti: Examples;
  /** a turn or a quiz answer that shows the advice arrow with no words about the move (§2.2 «Стрелка совета никогда не показывается без слов о самом ходе»; the quiet turn is its own form) */
  arrowWithoutWords: Examples;
  /** a quiz answer whose advice words did not fit: no arrow, it waits for «Совет» (§2.4 wants «пояснение + совет, стрелка»; a target) — `of`: answers with an advice */
  answerNoAdvice: Examples;
  /** praise over PRAISE_MAX_WORDS words (§2.5 «короткой репликой (≤ 10 слов)») */
  praiseLong: Examples;
  /** blitz mini-lessons against §2.2 / §2.6: a topic other than «как думать» outside a danger, more than one sentence of the lesson, more than one a game */
  blitzMini: Examples;
  /** «Совет» answered with «как я и говорил / не передумал» although the advice was never said in words this turn */
  repeatWithoutAdvice: Examples;
  /** canCapture quizzes against §2.4: «да» / «размен» only when that capture is the advice, «нет» only when the advice is another move, never without advice */
  captureNotAdvice: Examples;
  /** stage 5 «позже» (§2.2): right after another hidden-arrow turn, or two calm advices in a row told with the arrow later */
  laterCadence: Examples;
  /** stage-5 turns told with the arrow later / all stage-5 turns */
  later: { turns: number; later: number; pct: number };
  /** stages 3–5: «да» to a take-back without the concept said after it */
  takebackNoConcept: Examples;
  /** a reveal / «Совет» / an answer that did not stop the treasure's hints (`stopHints: false`; they must stop there) */
  hintsAfterShown: Examples;
  quizKinds: Record<string, number>;
  /** caps of §2.4, §2.5, §2.7 exceeded (target: none) */
  rhythm: string[];
}

const ADVICE_POOL_RE = /^v3\.(lead\.|go\.|helper$|whole\.)/;

function wordCount(t: string): number {
  return countWords(t);
}

const TURN_MOMENTS = ['advice', 'quiet', 'quiz', 'self', 'mini', 'danger', 'treasure'] as const;

/** The word cap of a turn utterance or a quiz answer (the engine's own `ANSWER_WORDS`); null: not capped — a quiz question with its buttons. */
export function wordCapOf(stage: number, e: Pick<EvRecord, 'moment' | 'say' | 'quiz' | 'source'>): number | null {
  if (e.source === 'answer') return stage <= 2 ? ANSWER_WORDS.young : ANSWER_WORDS.old;
  if (e.source !== 'turn' || e.quiz) return null;
  const mini = e.say.some((x) => x.pool.startsWith('v3.mini.'));
  if (e.moment === 'mini') return MINI_WORDS;
  if (e.moment === 'danger' && mini) return DANGER_MINI_WORDS;
  if (e.moment === 'advice' || e.moment === 'danger' || e.moment === 'self' || e.moment === 'treasure') return stage <= 2 ? LESSON_WORDS.young : LESSON_WORDS.old;
  return null;
}

/**
 * Sentences a blitz turn utterance may have (§2.2 «Блиц: одно предложение, кроме…»): «можно не спасать» + the advice,
 * a treasure + «найдёшь сам?», a mini-lesson (one sentence of the lesson) + its advice — two; the rest one.
 */
export function blitzSentencesAllowed(e: Pick<EvRecord, 'moment' | 'say'>): number {
  const pools = e.say.map((x) => x.pool);
  if (e.moment === 'treasure' || e.moment === 'mini') return 2;
  if (e.moment === 'danger') return 1 + (pools.some((p) => p.startsWith('v3.danger.letGo.')) ? 1 : 0) + (pools.some((p) => p.startsWith('v3.mini.')) ? 1 : 0);
  return 1;
}

/** §2.4: a capture question is asked only when its answer agrees with the advice (null = fine). */
export function captureRuleBroken(t: Pick<TurnRecord, 'quiz' | 'advice'>): string | null {
  const q = t.quiz;
  if (!q || q.kind !== 'canCapture') return null;
  const cap = q.captureUci ?? null;
  const adv = t.advice?.uci ?? null;
  if (!adv) return 'совета нет';
  if (!cap) return 'взятие неизвестно';
  if ((q.correctId === 'capYes' || q.correctId === 'capTrade') && cap !== adv) return `ответ «${q.correctId === 'capYes' ? 'да' : 'размен'}», а совет — другой ход`;
  if (q.correctId === 'capLose' && cap === adv) return 'ответ «нет», а это взятие и есть совет';
  return null;
}

/** The advice arrow is on this board (a quiz answer shows it only with words about the move, §2.2). */
export function boardShowsAdvice(board: { arrows: readonly { from: string; to: string }[] } | null | undefined, uci: string | null | undefined): boolean {
  if (!board || !uci) return false;
  return board.arrows.some((a) => a.from === uci.slice(0, 2) && a.to === uci.slice(2, 4));
}

/** The topic of a mini-lesson pool (`v3.mini.<topic>.l<n>`). */
export function miniTopicOf(pool: string): string | null {
  const m = /^v3\.mini\.([^.]+)\.l\d$/.exec(pool);
  return m ? (m[1] as string) : null;
}

function isRevealLater(t: TurnRecord): boolean {
  return t.revealLater ?? (t.moment === 'advice' && t.adviceHidden && !t.quiz);
}

const CLASS_RU: Readonly<Record<DangerClassId, string>> = { always: 'всегда', other: 'прочая', pawn: 'пешка' };

export function observations(run: Run): Observations {
  const push = (x: Examples, line: string, moment?: string): void => {
    x.count++;
    if (moment) x.byMoment = { ...(x.byMoment ?? {}), [moment]: (x.byMoment?.[moment] ?? 0) + 1 };
    if (x.examples.length < 6) x.examples.push(line);
  };
  const o: Observations = {
    dangerShare: [],
    dangerCadence: { count: 0, examples: [] },
    momentsByStage: [],
    overCap: { count: 0, examples: [] },
    blitzMulti: { count: 0, examples: [] },
    arrowWithoutWords: { count: 0, examples: [] },
    answerNoAdvice: { count: 0, of: 0, examples: [] },
    praiseLong: { count: 0, examples: [] },
    blitzMini: { count: 0, examples: [] },
    repeatWithoutAdvice: { count: 0, examples: [] },
    captureNotAdvice: { count: 0, of: 0, examples: [] },
    laterCadence: { count: 0, examples: [] },
    later: { turns: 0, later: 0, pct: 0 },
    takebackNoConcept: { count: 0, of: 0, examples: [] },
    hintsAfterShown: { count: 0, examples: [] },
    quizKinds: {},
    rhythm: [],
  };
  const emptyClasses = (): DangerStage['byClass'] => ({ always: { found: 0, spoken: 0 }, other: { found: 0, spoken: 0 }, pawn: { found: 0, spoken: 0 } });
  const byStage = new Map<number, Omit<DangerStage, 'stage' | 'pct'>>();
  const momentsBy = new Map<number, { turns: number; moments: Record<string, number> }>();
  for (const g of run.games) {
    const ev = run.events.get(g.game) ?? [];
    const blitz = g.tc === 'blitz5' || g.tc === 'bullet1';
    const st = byStage.get(g.stage) ?? { turns: 0, danger: 0, found: 0, byClass: emptyClasses(), sameAgain: 0, repeatWarn: { found: 0, spoken: 0 } };
    const mo = momentsBy.get(g.stage) ?? { turns: 0, moments: {} };
    const turnEv = new Map<number, EvRecord>();
    for (const e of ev) if (e.source === 'turn' && isUtterance(e) && !turnEv.has(e.ply)) turnEv.set(e.ply, e);
    // the §2.2 danger cadence, counted as the lesson counts it (the child turn number of the last spoken danger)
    let lastSpoken: number | null = null;
    let lastSpokenSquare: string | null = null;
    let prevHidden = false;
    let lastCalmLater = false;
    g.turns.forEach((t, i) => {
      st.turns++;
      mo.turns++;
      mo.moments[t.moment] = (mo.moments[t.moment] ?? 0) + 1;
      if (t.moment === 'danger') st.danger++;
      const turnNo = t.turnNo ?? i + 1;
      const where = `${g.game}, полуход ${t.ply}`;
      const d = t.danger;
      if (d) {
        st.found++;
        st.byClass[d.cls].found++;
        if (d.spoken) st.byClass[d.cls].spoken++;
        if (d.baseCls === 'always' && d.cls === 'other') {
          st.repeatWarn.found++;
          if (d.spoken) st.repeatWarn.spoken++;
        }
        const gap = lastSpoken === null ? Infinity : turnNo - lastSpoken;
        const what = `${CLASS_RU[d.cls]}${d.piece ? `, ${pieceNameRu(d.piece, 'nom')}` : ''} (${d.kind})`;
        if (d.spoken) {
          if (d.justTold) push(o.dangerCadence, `${where}: опасность (${what}) сказана сразу после слов об ошибке про ту же фигуру`, 'justTold');
          else if (d.cls === 'pawn' && g.stage <= 2) push(o.dangerCadence, `${where}: пешка под ударом на ступени ${g.stage}`, 'pawnYoung');
          else if (d.cls === 'pawn' && !d.saves) push(o.dangerCadence, `${where}: пешка под ударом, а совет её не спасает`, 'pawnLetGo');
          else if (d.cls === 'pawn' && gap < GATES.dangerEveryPawn) push(o.dangerCadence, `${where}: пешка под ударом через ${gap} хода после прошлой опасности`, 'pawnSoon');
          else if (d.cls === 'other' && gap < GATES.dangerEveryOther) push(o.dangerCadence, `${where}: ${what} через ${gap} хода после прошлой опасности`, 'otherSoon');
        } else {
          if (d.cls === 'always' && !d.justTold) push(o.dangerCadence, `${where}: ${what} не сказана`, 'alwaysUnsaid');
          const te = turnEv.get(t.ply);
          if (te && te.say.some((x) => x.pool === 'v3.opp.attack' || x.pool === 'v3.opp.threatMate')) push(o.dangerCadence, `${where}: опасность не сказана, а «${te.text}» говорит о нападении`, 'oppOverUnsaid');
        }
      }
      if (t.moment === 'danger') {
        if (d?.square && lastSpoken === turnNo - 1 && lastSpokenSquare === d.square) st.sameAgain++;
        lastSpoken = turnNo;
        lastSpokenSquare = d?.square ?? null;
      }
      if (t.quiz) {
        o.quizKinds[t.quiz.kind] = (o.quizKinds[t.quiz.kind] ?? 0) + 1;
        if (t.quiz.kind === 'canCapture') {
          o.captureNotAdvice.of = (o.captureNotAdvice.of ?? 0) + 1;
          const why = captureRuleBroken(t);
          if (why) push(o.captureNotAdvice, `${where}: ${why} — взятие ${t.quiz.captureUci ?? '?'}, совет ${t.advice?.uci ?? '—'} (ответ «${t.quiz.options.find((x) => x.id === t.quiz?.correctId)?.label ?? t.quiz.correctId}»)`);
        }
      }
      // the arrow of a shown advice needs words about the move (a quiet turn is its own form: a sound and a nod)
      if (t.advice && !t.adviceHidden && t.moment !== 'quiet') {
        const te = turnEv.get(t.ply);
        if (!te) push(o.arrowWithoutWords, `${where} (ступень ${g.stage}, ${TC_RU[g.tc] ?? g.tc}, ${t.moment}): ни слова — стрелка ${t.advice.uci}`, t.moment);
        else if (!te.say.some((x) => ADVICE_POOL_RE.test(x.pool))) push(o.arrowWithoutWords, `${where} (ступень ${g.stage}, ${TC_RU[g.tc] ?? g.tc}, ${t.moment}): «${te.text}» — стрелка ${t.advice.uci}`, t.moment);
      }
      // stage 5 «позже»: every second calm advice at most, never right after another hidden-arrow turn
      if (g.stage >= 5) {
        o.later.turns++;
        const later = isRevealLater(t);
        if (later) {
          o.later.later++;
          if (prevHidden) push(o.laterCadence, `${where}: «позже» сразу после хода со скрытой стрелкой`);
          else if (lastCalmLater) push(o.laterCadence, `${where}: два спокойных совета подряд со стрелкой «позже»`);
        }
        if (t.moment === 'advice' && !t.quiz) lastCalmLater = later;
      }
      prevHidden = !!t.advice && t.adviceHidden;
      // the hints of a hidden advice stop once it is shown: the director says so (`stopHints`), the store cancels them
      if (t.hintsKept === true) push(o.hintsAfterShown, `${where} (${t.moment}): совет показан (${t.reveal ? `${t.reveal.by === 'button' ? '«Совет»' : 'по времени'} на ${Math.round(t.reveal.atMs / 1000)} с` : 'ответ'}), а подсказки не остановлены`);
    });
    byStage.set(g.stage, st);
    momentsBy.set(g.stage, mo);
    const utt = ev.filter(isUtterance);
    for (const e of utt) {
      const pools = e.say.map((x) => x.pool);
      const cap = wordCapOf(g.stage, e);
      if (cap !== null) {
        const w = wordCount(e.text);
        if (w > cap) push(o.overCap, `${g.game} (ступень ${g.stage}, ${e.moment}, ${w} слов > ${cap}): «${e.text}»`, e.moment);
      }
      if (blitz && e.source === 'turn' && !e.quiz) {
        const n = splitSentences(e.text).length;
        const allowed = blitzSentencesAllowed(e);
        if (n > allowed) push(o.blitzMulti, `${g.game} (${e.moment}, ${n} предл. > ${allowed}): «${e.text}»`, e.moment);
      }
      // the answer of a quiz puts the advice arrow on the board: its words must speak of the move too (the advice
      // sentence, or the capture explanation when that capture IS the advice)
      // (an answer whose advice words did not fit shows no arrow — it waits for «Совет»: a target of its own)
      if (e.source === 'answer') {
        const t = g.turns.find((x) => x.ply === e.ply);
        const aboutCapture = t?.quiz?.kind === 'canCapture' && !!t.advice && t.quiz.captureUci === t.advice.uci;
        // («Зачем мы так сходили?»: its «вот зачем» explains the PAST move — not words about the advice)
        const saysAdvice = pools.some((x) => ADVICE_POOL_RE.test(x) && !(t?.quiz?.kind === 'why' && x === 'v3.lead.why'));
        const arrow = boardShowsAdvice(e.board, t?.advice?.uci);
        if (t?.advice && arrow && !aboutCapture && !saysAdvice) {
          push(o.arrowWithoutWords, `${g.game}, полуход ${e.ply} (ступень ${g.stage}, ответ на ${t.quiz?.kind ?? 'вопрос'}, ${e.pressed?.how ?? '—'}): «${e.text}» — стрелка ${t.advice.uci}`, 'answer');
        }
        if (t?.advice) {
          o.answerNoAdvice.of = (o.answerNoAdvice.of ?? 0) + 1;
          if (!arrow && !saysAdvice) {
            const later = ev.find((x) => x.ply === e.ply && x.n > e.n && x.source === 'repeat');
            push(o.answerNoAdvice, `${g.game}, полуход ${e.ply} (ступень ${g.stage}, ${wordCount(e.text)} слов, ответ на ${t.quiz?.kind ?? 'вопрос'}): «${e.text}» — стрелки нет${later ? ', ребёнок нажал «Совет»' : `, ребёнок сходил ${t.move.san || '—'}`}`, t.quiz?.kind ?? 'answer');
          }
        }
      }
      if (e.kind === 'praise' && wordCount(e.text) > PRAISE_MAX_WORDS) push(o.praiseLong, `${g.game}, полуход ${e.ply} (${wordCount(e.text)} слов, \`${e.say[0]?.pool ?? '?'}\`): «${e.text}»`);
      // «предупреждали и не спасли» only after a danger that was said (an unsaid one leaves no warning behind)
      if (pools.includes('v3.mistake.ignoredDanger')) {
        const t = g.turns.find((x) => x.ply === e.ply);
        if (t && t.moment !== 'danger') push(o.dangerCadence, `${g.game}, полуход ${e.ply}: «предупреждали», а опасность этого хода не была сказана — «${e.text}»`, 'warnedUnsaid');
      }
      if (e.source === 'repeat' && pools.includes('v3.lead.repeat')) {
        const before = ev.filter((x) => x.ply === e.ply && x.n < e.n && ['turn', 'bark', 'answer', 'repeat', 'reveal'].includes(x.source));
        if (!before.some((x) => x.say.some((y) => ADVICE_POOL_RE.test(y.pool)))) push(o.repeatWithoutAdvice, `${g.game}, полуход ${e.ply}: до этого «${before.map((x) => x.text).join(' / ') || '—'}» → «${e.text}»`);
      }
      if (e.source === 'takebackReply' && g.stage >= 3 && pools[0] === 'v3.takeback.yes') {
        o.takebackNoConcept.of = (o.takebackNoConcept.of ?? 0) + 1;
        if (!pools.some((x) => x.startsWith('v3.mistake.'))) push(o.takebackNoConcept, `${g.game}, полуход ${e.ply}: «${e.text}»`);
      }
    }
    if (blitz) {
      // §2.2 / §2.6: a blitz mini-lesson is «как думать» or a lesson inside a danger, one sentence of it, one a game
      const minis = utt.filter((e) => ['turn', 'reveal', 'repeat'].includes(e.source) && e.say.some((x) => x.pool.startsWith('v3.mini.')));
      minis.forEach((e, k) => {
        const parts = e.say.filter((x) => x.pool.startsWith('v3.mini.'));
        const topics = parts.map((x) => miniTopicOf(x.pool) ?? x.pool);
        const where = `${g.game}, полуход ${e.ply} (${MOMENT_RU[e.source === 'turn' ? e.moment : e.source] ?? e.moment}, ${topics.join(', ')})`;
        const bad = topics.filter((tp) => tp !== 'thinking' && e.moment !== 'danger');
        if (bad.length > 0) push(o.blitzMini, `${where}: в блице урок только «как думать» или внутри опасности — «${e.text}»`, 'topic');
        else if (parts.some((x) => splitSentences(sayText(x) ?? '').length > 1)) push(o.blitzMini, `${where}: урок в блице — одно предложение — «${e.text}»`, 'sentences');
        else if (k >= 1) push(o.blitzMini, `${where}: второй мини-урок за партию — «${e.text}»`, 'second');
      });
    }
    const praises = utt.filter((e) => e.kind === 'praise' && !(e.say[0]?.pool ?? '').endsWith('.mate')).length;
    const praiseCap = g.stage <= 2 ? 6 : 4;
    if (praises > praiseCap) o.rhythm.push(`${g.game}: похвал ${praises} > ${praiseCap}`);
    const quizzes = g.turns.filter((t) => t.quiz).length;
    const budget = g.tc === 'blitz5' || g.tc === 'bullet1' ? 3 : g.tc === 'rapid10' ? 4 : g.stage <= 2 ? 4 : 5;
    if (quizzes > budget) o.rhythm.push(`${g.game}: вопросов ${quizzes} > ${budget}`);
    const treasures = g.turns.filter((t) => t.moment === 'treasure').length;
    const treasureCap = g.stage <= 1 ? 3 : 4;
    if (treasures > treasureCap) o.rhythm.push(`${g.game}: подарков-загадок ${treasures} > ${treasureCap}`);
    const firstQuiz = g.turns.findIndex((t) => t.quiz);
    if (firstQuiz >= 0 && firstQuiz < 2) o.rhythm.push(`${g.game}: первый вопрос на ${firstQuiz + 1}-м ходу`);
  }
  o.dangerShare = [...byStage.entries()].sort((a, b) => a[0] - b[0]).map(([stage, v]) => ({ stage, ...v, pct: v.turns === 0 ? 0 : (100 * v.danger) / v.turns }));
  o.momentsByStage = [...momentsBy.entries()].sort((a, b) => a[0] - b[0]).map(([stage, v]) => ({ stage, ...v }));
  o.later.pct = o.later.turns === 0 ? 0 : (100 * o.later.later) / o.later.turns;
  return o;
}

// ───────────────────────── the whole report ─────────────────────────

export interface Gate {
  id: string;
  title: string;
  value: string;
  limit: string;
  pass: boolean;
  /** a hard gate fails the run (exit 1); a target only warns */
  hard: boolean;
}

export interface Report {
  games: number;
  errors: ErrorRecord[];
  perGame: GameStats[];
  totals: {
    utterances: number;
    sentences: number;
    words: number;
    wordsPerGame: number;
    utterancesPerGame: number;
    distinctRatio: number;
    results: Record<string, number>;
    moments: Record<string, number>;
    quizzes: GameStats['quizzes'];
    adviceUtterances: number;
    adviceWithIdea: number;
    adviceIdeaPct: number;
    takebacks: number;
    maxBookBytes: number;
  };
  topWordings: RepeatRow[];
  topSentences: RepeatRow[];
  overWording: { game: string; key: string; n: number; text: string }[];
  openers: { game: string; opener3: Counted | null; opener2: Counted | null }[];
  adjacent: { game: string; n: number; sentence: string }[];
  secondDay: SecondDay[];
  themeRepeats: CrossRepeat[];
  miniRepeats: CrossRepeat[];
  hidden: { stage: number; moves: number; movedHidden: number; movedHiddenPct: number; turns: number; hiddenAtStart: number; hiddenAtStartPct: number }[];
  hygiene: HygieneIssue[];
  deictic: DeicticIssue[];
  audit: { counts: Record<string, Record<string, number>>; items: (AuditItem & { game: string })[] } | null;
  recording: Recording;
  takeaways: Record<string, number>;
  themes: Record<string, number>;
  observations: Observations;
  gates: Gate[];
}

const pct = (a: number, b: number): number => (b === 0 ? 0 : (100 * a) / b);

export function buildReport(run: Run): Report {
  const perGame = run.games.map((g) => gameStats(g, run.events.get(g.game) ?? []));
  const wordingPerGame = new Map<string, Map<string, number>>();
  const sentencePerGame = new Map<string, Map<string, number>>();
  const hygiene: HygieneIssue[] = [];
  const deictic: DeicticIssue[] = [];
  const said: LessonSay[] = [];
  for (const g of run.games) {
    const w = new Map<string, number>();
    const s = new Map<string, number>();
    for (const e of run.events.get(g.game) ?? []) {
      hygiene.push(...hygieneIssues(e));
      if (!isUtterance(e)) continue;
      deictic.push(...deicticIssues(e));
      for (const x of e.say) {
        bump(w, sayKey(x));
        said.push(x);
      }
      for (const t of splitSentences(e.text).map(normText)) if (t) bump(s, t);
    }
    wordingPerGame.set(g.game, w);
    sentencePerGame.set(g.game, s);
  }
  const topWordings = repeatRows(wordingPerGame, wordingSample);
  const topSentences = repeatRows(sentencePerGame, (k) => k);
  const overWording: Report['overWording'] = [];
  for (const [game, m] of wordingPerGame) for (const [key, n] of m) if (n > GATES.wordingPerGameTarget) overWording.push({ game, key, n, text: wordingSample(key) });
  overWording.sort((a, b) => b.n - a.n || a.game.localeCompare(b.game) || a.key.localeCompare(b.key));

  const moments: Record<string, number> = {};
  const results: Record<string, number> = {};
  const quizzes = { asked: 0, right: 0, wrong: 0, timeout: 0, sovet: 0, moved: 0 };
  for (const s of perGame) {
    for (const [k, n] of Object.entries(s.moments)) moments[k] = (moments[k] ?? 0) + n;
    results[s.outcome] = (results[s.outcome] ?? 0) + 1;
    for (const k of Object.keys(quizzes) as (keyof typeof quizzes)[]) quizzes[k] += s.quizzes[k];
  }
  const utterances = perGame.reduce((n, s) => n + s.utterances, 0);
  const sentences = perGame.reduce((n, s) => n + s.sentences, 0);
  const words = perGame.reduce((n, s) => n + s.words, 0);
  const adviceUtterances = perGame.reduce((n, s) => n + s.adviceUtterances, 0);
  const adviceWithIdea = perGame.reduce((n, s) => n + s.adviceWithIdea, 0);
  const distinctAll = perGame.reduce((n, s) => n + s.distinctSentences, 0);

  const hidden: Report['hidden'] = [];
  for (const stage of [...new Set(perGame.map((s) => s.stage))].sort()) {
    const list = perGame.filter((s) => s.stage === stage);
    const moves = list.reduce((n, s) => n + s.moves, 0);
    const movedHidden = list.reduce((n, s) => n + s.movedHidden, 0);
    const hiddenAtStart = list.reduce((n, s) => n + s.hiddenAtStart, 0);
    hidden.push({ stage, moves, movedHidden, movedHiddenPct: pct(movedHidden, moves), turns: moves, hiddenAtStart, hiddenAtStartPct: pct(hiddenAtStart, moves) });
  }

  const sd = secondDay(run.games, run.events);
  const themeRepeats = crossGameRepeats(run.games, run.events, GATES.themeWindow, themeAnnouncementSay);
  const miniRepeats = crossGameRepeats(run.games, run.events, GATES.miniWindow, miniSay);
  const adjacent = perGame.flatMap((s) => s.adjacent.map((a) => ({ game: s.game, ...a })));

  let audit: Report['audit'] = null;
  if (run.games.some((g) => g.audit !== undefined)) {
    const counts: Record<string, Record<string, number>> = {};
    const items: (AuditItem & { game: string })[] = [];
    for (const g of run.games) {
      for (const a of g.audit ?? []) {
        const c = counts[a.kind] ?? {};
        c[a.verdict] = (c[a.verdict] ?? 0) + 1;
        counts[a.kind] = c;
        items.push({ ...a, game: g.game });
      }
    }
    audit = { counts, items };
  }

  const takeaways: Record<string, number> = {};
  const themes: Record<string, number> = {};
  for (const g of run.games) {
    if (g.takeawayKey) takeaways[g.takeawayKey] = (takeaways[g.takeawayKey] ?? 0) + 1;
    if (g.strategyId) themes[g.strategyId] = (themes[g.strategyId] ?? 0) + 1;
  }

  const maxWording = Math.max(0, ...perGame.map((s) => s.maxWording?.n ?? 0));
  const maxOp3 = Math.max(0, ...perGame.map((s) => s.maxOpener3?.n ?? 0));
  const maxOp2 = Math.max(0, ...perGame.map((s) => s.maxOpener2?.n ?? 0));
  const worstSecond = sd.reduce((m, c) => Math.max(m, c.pct), 0);
  const ideaPct = pct(adviceWithIdea, adviceUtterances);
  const maxBookBytes = Math.max(0, ...run.games.map((g) => g.bookBytes));
  const hyg = (rule: HygieneRule): number => hygiene.filter((h) => h.rule === rule).length;
  const disagree = audit ? audit.items.filter((a) => a.verdict === 'disagree').length : 0;
  const gates: Gate[] = [
    { id: 'errors', title: 'партии без ошибок движка / кода', value: String(run.errors.length), limit: '0', pass: run.errors.length === 0, hard: true },
    { id: 'squares', title: 'клетки в словах (hasSpokenSquare)', value: String(hyg('square')), limit: '0', pass: hyg('square') === 0, hard: true },
    { id: 'latin', title: 'латиница в тексте / облачке / кнопках', value: String(hyg('latin')), limit: '0', pass: hyg('latin') === 0, hard: true },
    { id: 'banned', title: '«молодец / умница / так держать»', value: String(hyg('banned')), limit: '0', pass: hyg('banned') === 0, hard: true },
    { id: 'selfFeminine', title: 'Гамбитик о себе в женском роде', value: String(hyg('selfFeminine')), limit: '0', pass: hyg('selfFeminine') === 0, hard: true },
    { id: 'adjacent', title: 'одинаковое предложение в соседних репликах', value: String(adjacent.length), limit: '0', pass: adjacent.length === 0, hard: true },
    { id: 'wordingPerGame', title: 'макс. повторов одной формулировки за партию', value: String(maxWording), limit: `≤ ${GATES.wordingPerGame}`, pass: maxWording <= GATES.wordingPerGame, hard: true },
    { id: 'wordingPerGameTarget', title: 'то же, цель', value: String(maxWording), limit: `≤ ${GATES.wordingPerGameTarget}`, pass: maxWording <= GATES.wordingPerGameTarget, hard: false },
    { id: 'opener3', title: 'макс. одного начала (3 слова) за партию', value: String(maxOp3), limit: `≤ ${GATES.openerPerGame}`, pass: maxOp3 <= GATES.openerPerGame, hard: true },
    { id: 'opener2', title: 'макс. одного начала (2 слова) за партию', value: String(maxOp2), limit: `≤ ${GATES.openerPerGame}`, pass: maxOp2 <= GATES.openerPerGame, hard: false },
    { id: 'secondDay', title: '«второй день»: дословно как в прошлой партии (худший ученик)', value: `${f1(worstSecond)} %`, limit: `≤ ${GATES.secondDayPct} %`, pass: worstSecond <= GATES.secondDayPct, hard: true },
    { id: 'themeRepeat', title: `одно объявление темы за ${GATES.themeWindow} партий`, value: String(themeRepeats.length), limit: '0', pass: themeRepeats.length === 0, hard: true },
    { id: 'miniRepeat', title: `одна формулировка мини-урока за ${GATES.miniWindow} партий`, value: String(miniRepeats.length), limit: '0', pass: miniRepeats.length === 0, hard: true },
    { id: 'adviceIdea', title: 'советы с «зачем» (хвост идеи)', value: `${f1(ideaPct)} % (${adviceWithIdea}/${adviceUtterances})`, limit: `≥ ${GATES.adviceIdeaPct} %`, pass: adviceUtterances === 0 || ideaPct >= GATES.adviceIdeaPct, hard: true },
  ];
  for (const h of hidden.filter((x) => x.stage >= 3)) {
    gates.push({
      id: `hidden${h.stage}`,
      title: `ступень ${h.stage}: ходы со скрытой стрелкой (вопрос, «Сам», подарок, показ позже)`,
      value: `${f1(h.hiddenAtStartPct)} % (${h.hiddenAtStart}/${h.moves}; сходил, так и не увидев стрелку, — ${f1(h.movedHiddenPct)} %)`,
      limit: `${GATES.hiddenMin}–${GATES.hiddenMax} %`,
      pass: h.hiddenAtStartPct >= GATES.hiddenMin && h.hiddenAtStartPct <= GATES.hiddenMax,
      hard: true,
    });
  }
  const ob = observations(run);
  for (const d of ob.dangerShare) {
    gates.push({
      id: `danger${d.stage}`,
      title: `ступень ${d.stage}: ходы с опасностью (сказана вслух, §2.2)`,
      value: `${f1(d.pct)} % (${d.danger}/${d.turns}; найдена в ${d.found})`,
      limit: `≤ ${GATES.dangerMaxPct} %`,
      pass: d.pct <= GATES.dangerMaxPct,
      hard: true,
    });
  }
  const zero = (id: string, title: string, x: Examples, hard = true): Gate => ({ id, title, value: x.of !== undefined ? `${x.count} из ${x.of}` : String(x.count), limit: hard ? '0' : '0 (цель)', pass: x.count === 0, hard });
  gates.push(
    zero('dangerCadence', `ритм опасности (§2.2): пешка на ступенях 1–2, чаще раза в ${GATES.dangerEveryOther} / ${GATES.dangerEveryPawn} хода, «всегда» не сказана, повтор за ошибкой`, ob.dangerCadence),
    zero('wordCap', `реплика хода длиннее ${LESSON_WORDS.young} / ${LESSON_WORDS.old} слов (мини-урок ${MINI_WORDS}, опасность с уроком ${DANGER_MINI_WORDS}, ответ на вопрос ${ANSWER_WORDS.young} / ${ANSWER_WORDS.old})`, ob.overCap),
    zero('praiseWords', `похвала длиннее ${PRAISE_MAX_WORDS} слов (§2.5)`, ob.praiseLong),
    zero('blitzOne', 'блиц: больше предложений, чем разрешает §2.2 (одно; два — «можно не спасать» + совет, подарок + «найдёшь сам?», урок + совет)', ob.blitzMulti),
    zero('blitzMini', 'блиц: мини-урок не «как думать» вне опасности, длиннее предложения или второй за партию (§2.2, §2.6)', ob.blitzMini),
    zero('arrowWords', 'стрелка совета без слов о ходе (ход или ответ на вопрос)', ob.arrowWithoutWords),
    zero('answerAdvice', 'ответ на вопрос без совета: стрелка ждёт «Совет» (§2.4: «пояснение + совет, стрелка»)', ob.answerNoAdvice, false),
    zero('repeatLead', '«Совет»: «как я и говорил» без сказанного совета', ob.repeatWithoutAdvice),
    zero('canCapture', '«Выгодно ли съесть?» против правила §2.4 («да» / «размен» — только про совет, «нет» — только при другом совете)', ob.captureNotAdvice),
    zero('later5', 'ступень 5: «показ позже» сразу после скрытой стрелки или два спокойных совета подряд', ob.laterCadence),
    zero('hintsStop', 'показ совета не остановил подсказки подарка (stopHints)', ob.hintsAfterShown),
    zero('takebackConcept', 'ступени 3–5: «да» на возврат хода без понятия после него', ob.takebackNoConcept, false),
  );
  gates.push(
    { id: 'bookBytes', title: 'книга фраз в localStorage', value: `${maxBookBytes} Б`, limit: `≤ ${GATES.bookBytes} Б`, pass: maxBookBytes <= GATES.bookBytes, hard: true },
    { id: 'deictic', title: '«вот эти клетки / сюда» без подсветки', value: String(deictic.length), limit: '0 (цель)', pass: deictic.length === 0, hard: false },
  );
  if (audit) gates.push({ id: 'truth', title: 'сверка правды глубоким Stockfish: расхождения', value: String(disagree), limit: '0 (цель)', pass: disagree === 0, hard: false });

  return {
    games: run.games.length,
    errors: run.errors,
    perGame,
    totals: {
      utterances,
      sentences,
      words,
      wordsPerGame: perGame.length === 0 ? 0 : words / perGame.length,
      utterancesPerGame: perGame.length === 0 ? 0 : utterances / perGame.length,
      distinctRatio: sentences === 0 ? 1 : distinctAll / sentences,
      results,
      moments,
      quizzes,
      adviceUtterances,
      adviceWithIdea,
      adviceIdeaPct: ideaPct,
      takebacks: perGame.reduce((n, s) => n + s.takebacks, 0),
      maxBookBytes,
    },
    topWordings: topWordings.slice(0, 30),
    topSentences: topSentences.slice(0, 30),
    overWording,
    openers: perGame.map((s) => ({ game: s.game, opener3: s.maxOpener3, opener2: s.maxOpener2 })),
    adjacent,
    secondDay: sd,
    themeRepeats,
    miniRepeats,
    hidden,
    hygiene,
    deictic,
    audit,
    recording: recordingEstimate(said),
    takeaways,
    themes,
    observations: ob,
    gates,
  };
}

export function gatesFailed(r: Pick<Report, 'gates'>): Gate[] {
  return r.gates.filter((g) => g.hard && !g.pass);
}

// ───────────────────────── markdown ─────────────────────────

const MOMENT_COLS = ['theme', 'advice', 'quiet', 'quiz', 'answer', 'self', 'mini', 'danger', 'treasure', 'praise', 'result', 'mistake', 'takeback', 'end'] as const;
const MOMENT_RU: Readonly<Record<string, string>> = {
  theme: 'тема',
  recall: 'вспомни',
  advice: 'совет',
  quiet: 'тихо',
  quiz: 'вопрос',
  answer: 'ответ',
  self: 'сам',
  mini: 'мини',
  danger: 'опасн.',
  treasure: 'подарок',
  praise: 'похвала',
  result: 'итог хода',
  mistake: 'ошибка',
  takeback: 'возврат',
  end: 'конец',
  reveal: 'показ',
  repeat: '«Совет»',
  why: '«Почему»',
  opponent: '«Соперник»',
  hurry: 'торопись',
  reaction: 'реакция',
};

const CADENCE_RU: Readonly<Record<string, string>> = {
  topic: 'не та тема',
  sentences: 'больше предложения',
  second: 'второй за партию',
  justTold: 'повтор за ошибкой',
  pawnYoung: 'пешка на ступенях 1–2',
  pawnLetGo: 'пешка, которую совет не спасает',
  pawnSoon: 'пешка слишком часто',
  otherSoon: 'прочая слишком часто',
  alwaysUnsaid: '«всегда» не сказана',
  oppOverUnsaid: '«соперник напал» вместо опасности',
  warnedUnsaid: '«предупреждали» без предупреждения',
};

const OUTCOME_RU: Readonly<Record<string, string>> = { win: 'победа', loss: 'поражение', draw: 'ничья', unfinished: 'не доиграна' };

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function reportMarkdown(r: Report, meta: { seed: number; args: string }): string {
  const out: string[] = [];
  const failed = gatesFailed(r);
  out.push('# «Учитель» — отчёт по партиям');
  out.push('');
  out.push(`Бесплатно, беззвучно, локальный Stockfish 19. Партий: ${r.games}. Сид: ${meta.seed}. Запуск: \`${meta.args}\`.`);
  out.push('');
  out.push(failed.length === 0 ? '**Все пороги пройдены.**' : `**Не пройдено порогов: ${failed.length}** — ${failed.map((g) => g.title).join('; ')}.`);
  out.push('');
  out.push('## Пороги');
  out.push('');
  out.push('| | Проверка | Значение | Порог |');
  out.push('|---|---|---|---|');
  for (const g of r.gates) out.push(`| ${g.pass ? 'ок' : g.hard ? '**НЕТ**' : 'цель: нет'} | ${esc(g.title)} | ${esc(g.value)} | ${esc(g.limit)} |`);
  out.push('');
  const t = r.totals;
  out.push('## Главные числа');
  out.push('');
  out.push(`- Итоги: ${Object.entries(t.results).map(([k, n]) => `${OUTCOME_RU[k] ?? k} ${n}`).join(', ')}.`);
  out.push(`- Реплик: ${t.utterances} (${f1(t.utterancesPerGame)} на партию), предложений ${t.sentences}, слов ${t.words} (${f1(t.wordsPerGame)} на партию); разных предложений в партии в среднем ${f1(100 * t.distinctRatio)} %.`);
  out.push(`- Вопросов: ${t.quizzes.asked}; верно ${t.quizzes.right}, неверно ${t.quizzes.wrong}, по времени ${t.quizzes.timeout}, закрыт «Советом» ${t.quizzes.sovet}, сходил не отвечая ${t.quizzes.moved}.`);
  out.push(`- Советов с «зачем»: ${f1(t.adviceIdeaPct)} % (${t.adviceWithIdea} из ${t.adviceUtterances}). Возвратов хода: ${t.takebacks}. Книга фраз: до ${t.maxBookBytes} байт.`);
  out.push(`- Моменты за все партии: ${Object.entries(t.moments).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${MOMENT_RU[k] ?? k} ${n}`).join(', ')}.`);
  out.push(`- Выводы партии: ${Object.entries(r.takeaways).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || '—'}.`);
  out.push(`- Темы (карточки): ${Object.entries(r.themes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || '—'}.`);
  out.push('');
  out.push('## Партии');
  out.push('');
  out.push('Столбцы моментов считают реплики по моменту хода; «вопросов» — все вопросы с кнопками (и вопрос об опасности), «мини» — реплики с мини-уроком.');
  out.push('');
  out.push(`| Партия | Ст. | Контроль | Цвет | Итог | Полух. | Реплик | Предл. | Разных | Доля | Слов | ${MOMENT_COLS.map((m) => MOMENT_RU[m]).join(' | ')} | Вопросов (верно) | Мини | Макс. формул. | Макс. начало |`);
  out.push(`|${'---|'.repeat(11 + MOMENT_COLS.length + 4)}`);
  for (const s of r.perGame) {
    const m = MOMENT_COLS.map((k) => String(s.moments[k] ?? 0));
    out.push(
      `| ${s.game} | ${s.stage} | ${TC_RU[s.tc] ?? s.tc} | ${s.childColor === 'w' ? 'белые' : 'чёрные'} | ${OUTCOME_RU[s.outcome]} | ${s.plies} | ${s.utterances} | ${s.sentences} | ${s.distinctSentences} | ${f1(100 * s.distinctRatio)} % | ${s.words} | ${m.join(' | ')} | ${s.quizzes.asked} (${s.quizzes.right}) | ${s.minis} | ${s.maxWording ? `${s.maxWording.n}× \`${s.maxWording.key}\`` : '—'} | ${s.maxOpener3 ? `${s.maxOpener3.n}× «${esc(s.maxOpener3.key)}»` : '—'} |`,
    );
  }
  out.push('');
  out.push('## Частые формулировки (по номеру `pool#n`)');
  out.push('');
  out.push('| Формулировка | Текст | Раз | Партий | Макс. за партию |');
  out.push('|---|---|---|---|---|');
  for (const w of r.topWordings) out.push(`| \`${w.key}\` | ${esc(w.text)} | ${w.plays} | ${w.games} | ${w.maxPerGame} (${w.maxGame}) |`);
  out.push('');
  out.push('## Частые предложения (по нормализованному тексту)');
  out.push('');
  out.push('| Предложение | Раз | Партий | Макс. за партию |');
  out.push('|---|---|---|---|');
  for (const w of r.topSentences) out.push(`| ${esc(w.key)} | ${w.plays} | ${w.games} | ${w.maxPerGame} (${w.maxGame}) |`);
  out.push('');
  out.push(`## Формулировки чаще ${GATES.wordingPerGameTarget} раз за партию`);
  out.push('');
  if (r.overWording.length === 0) out.push('Нет.');
  else {
    out.push('| Партия | Формулировка | Раз | Текст |');
    out.push('|---|---|---|---|');
    for (const o of r.overWording.slice(0, 60)) out.push(`| ${o.game} | \`${o.key}\` | ${o.n} | ${esc(o.text)} |`);
    if (r.overWording.length > 60) out.push(`| … | ещё ${r.overWording.length - 60} | | |`);
  }
  out.push('');
  out.push('## Начала реплик (первые 3 / 2 слова, фигура → {фигура}), максимум за партию');
  out.push('');
  const worstOpen = [...r.openers].sort((a, b) => (b.opener2?.n ?? 0) - (a.opener2?.n ?? 0)).slice(0, 12);
  out.push('| Партия | 3 слова | 2 слова |');
  out.push('|---|---|---|');
  for (const o of worstOpen) out.push(`| ${o.game} | ${o.opener3 ? `${o.opener3.n}× «${esc(o.opener3.key)}»` : '—'} | ${o.opener2 ? `${o.opener2.n}× «${esc(o.opener2.key)}»` : '—'} |`);
  out.push('');
  out.push('## Одинаковое предложение в соседних репликах');
  out.push('');
  out.push(r.adjacent.length === 0 ? 'Нет.' : r.adjacent.slice(0, 30).map((a) => `- ${a.game} №${a.n}: «${a.sentence}»`).join('\n'));
  out.push('');
  out.push('## «Второй день»');
  out.push('');
  out.push('Порог — по репликам целиком (дословно та же реплика, что в прошлой партии). Справа для сведения — по отдельным предложениям.');
  out.push('');
  out.push('| Ученик | Реплик | Дословно как вчера | Доля | Худшая пара | Предложений | Как вчера | Доля |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const c of r.secondDay) {
    const worst = [...c.pairs].sort((a, b) => b.pct - a.pct)[0];
    const worstText = worst && worst.repeated > 0 ? `${worst.game}: ${f1(worst.pct)} % (${worst.examples.slice(0, 2).map((x) => `«${esc(x)}»`).join(', ')})` : '—';
    out.push(`| ${c.child} | ${c.utterances} | ${c.repeated} | ${f1(c.pct)} % | ${worstText} | ${c.sentences} | ${c.sentRepeated} | ${f1(c.sentPct)} % |`);
  }
  out.push('');
  out.push(`## Объявление темы повторилось быстрее ${GATES.themeWindow} партий`);
  out.push('');
  out.push(r.themeRepeats.length === 0 ? 'Нет.' : r.themeRepeats.map((x) => `- ученик ${x.child}: \`${x.key}\` в партиях ${x.games.join(', ')} — «${x.text}»`).join('\n'));
  out.push('');
  out.push(`## Мини-урок той же формулировкой быстрее ${GATES.miniWindow} партий`);
  out.push('');
  out.push(r.miniRepeats.length === 0 ? 'Нет.' : r.miniRepeats.map((x) => `- ученик ${x.child}: \`${x.key}\` в партиях ${x.games.join(', ')} — «${x.text}»`).join('\n'));
  out.push('');
  out.push('## Скрытая стрелка');
  out.push('');
  out.push('Порог считается по ходам, в начале которых урок спрятал стрелку (вопрос, «Сам», подарок, показ позже на ступени 5): это решение урока, а не ребёнка-модели. Рядом — ходы, сделанные так и не увидев стрелку (зависит от ребёнка-модели: половину спрятанных ходов он находит сам, остальные ждёт показа).');
  out.push('');
  out.push('| Ступень | Ходов | Сходил при скрытой стрелке | Стрелка скрыта в начале хода |');
  out.push('|---|---|---|---|');
  for (const h of r.hidden) out.push(`| ${h.stage} | ${h.moves} | ${h.movedHidden} (${f1(h.movedHiddenPct)} %) | ${h.hiddenAtStart} (${f1(h.hiddenAtStartPct)} %) |`);
  out.push('');
  out.push('## Чистота слов');
  out.push('');
  out.push(r.hygiene.length === 0 ? 'Нет клеток, латиницы, «молодец» и женского рода Гамбитика ни в голосе, ни в облачке, ни на кнопках.' : r.hygiene.slice(0, 40).map((h) => `- ${h.game} №${h.n} [${h.rule}, ${h.where}]: «${esc(h.text)}»`).join('\n'));
  out.push('');
  out.push('## Указание на доску без подсветки');
  out.push('');
  out.push(r.deictic.length === 0 ? 'Нет.' : r.deictic.slice(0, 40).map((d) => `- ${d.game} №${d.n}, предложение ${d.sentence + 1}, \`${d.pool}\`: «${esc(d.text)}»`).join('\n'));
  out.push('');
  const ob = r.observations;
  const exBlock = (title: string, x: Examples): void => {
    out.push('');
    out.push(`**${title}: ${x.count}${x.of !== undefined ? ` из ${x.of}` : ''}**${x.byMoment ? ` (${Object.entries(x.byMoment).map(([k, v]) => `${MOMENT_RU[k] ?? CADENCE_RU[k] ?? k} ${v}`).join(', ')})` : ''}`);
    for (const line of x.examples) out.push(`- ${esc(line)}`);
  };
  out.push('## Моменты хода по ступеням');
  out.push('');
  out.push('Один момент на ход ребёнка (§2.2): число ходов и доля от всех ходов ступени. «Скрыта» — стрелка скрыта в начале хода (вопрос, «Сам», подарок, показ позже).');
  out.push('');
  out.push(`| Ступень | Ходов | ${TURN_MOMENTS.map((m) => MOMENT_RU[m] ?? m).join(' | ')} | скрыта |`);
  out.push(`|${'---|'.repeat(3 + TURN_MOMENTS.length)}`);
  for (const m of ob.momentsByStage) {
    const h = r.hidden.find((x) => x.stage === m.stage);
    const cell = (n: number): string => `${n} (${f1(pct(n, m.turns))} %)`;
    out.push(`| ${m.stage} | ${m.turns} | ${TURN_MOMENTS.map((k) => cell(m.moments[k] ?? 0)).join(' | ')} | ${h ? cell(h.hiddenAtStart) : '—'} |`);
  }
  out.push('');
  out.push('## Опасность: не в каждом ходе (§2.2)');
  out.push('');
  out.push(`«Найдена» — урок видел опасность (шах, угроза мата, фигура под ударом); «сказана» — ход с моментом «опасность» (фраза, «можно не спасать», вопрос). Порог: сказана не больше чем в ${GATES.dangerMaxPct} % ходов на каждой ступени. Классы: «всегда» — шах, угроза мата, фигура (не пешка) с потерей ≥ 3; «прочая» — не чаще раза в ${GATES.dangerEveryOther} хода; «пешка» — на ступенях 1–2 никогда, на 3–5 не чаще раза в ${GATES.dangerEveryPawn} хода и только если совет её спасает.`);
  out.push('');
  out.push('Классы — как их посчитал урок в этом ходе: повтор предупреждения о той же фигуре на той же клетке — «прочая» (столбец «повтор → прочая», найден / сказан; он входит в «прочую»).');
  out.push('');
  out.push('| Ступень | Ходов | Найдена | Сказана | Доля ходов | «всегда»: найдена / сказана | «прочая» | «пешка» | Повтор → прочая | Та же фигура, что ходом раньше |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const d of ob.dangerShare) {
    const c = (k: DangerClassId): string => `${d.byClass[k].found} / ${d.byClass[k].spoken}`;
    const rw = d.repeatWarn ?? { found: 0, spoken: 0 };
    out.push(`| ${d.stage} | ${d.turns} | ${d.found} | ${d.danger} | ${f1(d.pct)} % | ${c('always')} | ${c('other')} | ${c('pawn')} | ${rw.found} / ${rw.spoken} | ${d.sameAgain} |`);
  }
  exBlock('Ритм опасности нарушен', ob.dangerCadence);
  out.push('');
  out.push('## Наблюдения: ритм, длина, стрелка без слов');
  out.push('');
  out.push(`- Вопросы по видам: ${Object.entries(ob.quizKinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}.`);
  out.push(`- Ступень 5, «показ позже»: ${ob.later.later} из ${ob.later.turns} ходов (${f1(ob.later.pct)} %).`);
  out.push(`- Лимиты похвал, вопросов, подарков, первый вопрос не раньше 3-го хода: ${ob.rhythm.length === 0 ? 'соблюдены' : ob.rhythm.join('; ')}.`);
  exBlock(`Реплики хода длиннее ${LESSON_WORDS.young} / ${LESSON_WORDS.old} слов (§2.2; мини-урок — ${MINI_WORDS}, опасность с уроком — ${DANGER_MINI_WORDS}, ответ на вопрос — ${ANSWER_WORDS.young} / ${ANSWER_WORDS.old}; вопросы не считаются)`, ob.overCap);
  exBlock(`Похвала длиннее ${PRAISE_MAX_WORDS} слов (§2.5)`, ob.praiseLong);
  exBlock('Блиц: больше предложений, чем разрешено (одно; два — «можно не спасать» + совет, подарок + «найдёшь сам?», урок + совет)', ob.blitzMulti);
  exBlock('Блиц: мини-урок не «как думать» вне опасности, длиннее одного предложения или второй за партию', ob.blitzMini);
  exBlock('Стрелка совета без слов о ходе — в ходе или после ответа на вопрос (тихий ход не считается; ответ про взятие, которое и есть совет, — о ходе)', ob.arrowWithoutWords);
  exBlock('Ответ на вопрос без совета — стрелки нет, она ждёт «Совет» (цель; из ответов, у хода которых есть совет)', ob.answerNoAdvice);
  exBlock('«Совет» отвечает «как я и говорил», хотя совета словами не было', ob.repeatWithoutAdvice);
  exBlock('«Выгодно ли съесть?» против правила §2.4', ob.captureNotAdvice);
  exBlock('Ступень 5: «показ позже» сразу после скрытой стрелки или два раза подряд', ob.laterCadence);
  exBlock('Показ совета не остановил подсказки подарка (stopHints)', ob.hintsAfterShown);
  exBlock('Ступени 3–5: «да» на возврат хода без понятия после него', ob.takebackNoConcept);
  out.push('');
  out.push('## Сверка правды (Stockfish, глубина 18, MultiPV 5)');
  out.push('');
  if (!r.audit) out.push('Не запускалась (флаг `--audit`).');
  else {
    const kinds: Record<string, string> = { quiz: 'ответы на вопросы', praise: 'похвалы', best: '«лучше всего»' };
    for (const [k, c] of Object.entries(r.audit.counts)) out.push(`- ${kinds[k] ?? k}: ${Object.entries(c).map(([v, n]) => `${v} ${n}`).join(', ')}`);
    const bad = r.audit.items.filter((a) => a.verdict === 'disagree' || a.verdict === 'error');
    const border = r.audit.items.filter((a) => a.verdict === 'borderline');
    out.push('');
    out.push(bad.length === 0 ? 'Расхождений нет.' : '**Расхождения:**');
    for (const a of bad) out.push(`- ${a.game}, полуход ${a.ply}, ${a.claim} (${a.uci}): ${a.verdict} — ${esc(a.detail)}. FEN \`${a.fen}\``);
    if (border.length > 0) {
      out.push('');
      out.push('На грани:');
      for (const a of border.slice(0, 30)) out.push(`- ${a.game}, полуход ${a.ply}, ${a.claim} (${a.uci}): ${esc(a.detail)}`);
    }
  }
  out.push('');
  out.push('## Оценка записи голосом (Giselle: 0,15 кредита за начатые 50 знаков)');
  out.push('');
  const rec = r.recording;
  const row = (name: string, p: RecordingPart): string => `| ${name} | ${p.wordings} | ${p.units} | ${p.chars} | ${f1(p.credits)} |`;
  out.push('| Что | Формулировок | Дублей (фигура × род) | Знаков | Кредитов |');
  out.push('|---|---|---|---|---|');
  out.push(row('вся библиотека', rec.library));
  out.push(row('что прозвучало в партиях (все варианты)', rec.used));
  out.push(row('что прозвучало (только услышанные варианты)', rec.heard));
  out.push('');
  out.push('| Семья | Библиотека: дублей / кредитов | Прозвучало: дублей / кредитов |');
  out.push('|---|---|---|');
  for (const f of rec.byFamily) out.push(`| ${f.family} | ${f.library.units} / ${f1(f.library.credits)} | ${f.used.units} / ${f1(f.used.credits)} |`);
  out.push('');
  if (r.errors.length > 0) {
    out.push('## Ошибки');
    out.push('');
    for (const e of r.errors) out.push(`- ${e.game}: ${esc(e.error.split('\n')[0] ?? '')}`);
    out.push('');
  }
  out.push(`Семьи тем: ${Object.entries(FAMILY_RU).map(([k, v]) => `${k} — ${v}`).join('; ')}.`);
  out.push('');
  return out.join('\n');
}
