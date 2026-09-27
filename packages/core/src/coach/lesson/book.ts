/**
 * The phrase book of «Учитель» (docs/TEACHING.md §2.11) — the only mutable object of the lesson engine.
 *
 * Which pre-written wording of a pool to say now. A pool works like a bag: in this game a wording is not said again
 * while the pool still has a fitting wording that was not said (the hard rule). Among the fitting ones the least
 * recently said across games wins (the cross-game memory is a tie-break, never an exclusion), then the book's own
 * seeded PRNG. Two utterances in a row never open with the same word when the pool has another choice.
 *
 * It also keeps the per-child learner model the lesson needs across games (§2.5, §2.6, §2.9): mini-lesson levels,
 * praise habits, the takeaways of the last games and the concept to recall. No generative AI: every text is a wording
 * of @gambit/content LESSON_LINES.
 *
 * The game keeps one book per game: `createLessonBook({ seed, history, game })` — `history` is the cross-game state
 * (localStorage `gambit.lessonBook`, written in `finish()`), `game` the per-game state of a resumed game.
 *
 * «Дозапись голоса»: with a `voice` getter that returns a `LessonVoicePolicy` the book prefers wordings that already
 * have a recording — «recorded first», policy P(K). When the getter is absent or returns null every choice is exactly
 * the one above (same PRNG draws, same history), so the default game, the 50-game report and their tests do not change.
 */
import type { PieceType } from '@gambit/shared';
import { lessonLine, wordingFitsStage } from '@gambit/content';
import type { LessonLine, LessonWording } from '@gambit/content';
import { expandWording, usesGender, usesPiece } from '../clips/catalog.ts';
import { lineUnitKey, poolKeyOf } from '../clips/keys.ts';
import { claimsBest, isDeictic } from './lint.ts';
import { isOptionPool } from './quizWords.ts';

/** How many recently said wordings of each pool are remembered across games. */
export const RECENT_PER_POOL = 12;
/** How many past games the learner model remembers (takeaways, praise habits). */
export const LEARNER_GAMES = 12;

/** Per-child state carried between games (small: it lives in localStorage). */
export interface LessonHistory {
  v: 1;
  /** games finished with this book */
  gameSeq: number;
  /** pool id → 1-based wording numbers said, oldest first (≤ RECENT_PER_POOL) */
  recent: Record<string, number[]>;
  /**
   * mini-lesson topic → { level reached (1..3), game it was last told, demonstrations since that level was first told
   * (reset when the level rises; an older save may carry a running total — it only lets the next level come sooner) }
   */
  minis: Record<string, { level: number; lastGame: number; shown: number; retired?: boolean }>;
  /** routine praise reason → the gameSeqs where the child did it himself (≤ LEARNER_GAMES) */
  habits: Record<string, number[]>;
  /** the takeaway keys of the last games, newest last (≤ LEARNER_GAMES) */
  takeaways: { game: number; key: string }[];
  /** the gameSeq when `v3.praise.habit.*` was last said, per reason */
  habitSaid: Record<string, number>;
}

/** Per-game state (the resume snapshot keeps it). */
export interface LessonGameState {
  v: 1;
  /** pool id → wording number → plays in this game */
  plays: Record<string, Record<string, number>>;
  /** the last utterance texts of this game, newest last (≤ 6) */
  lastTexts: string[];
  /** PRNG state */
  rng: number;
}

export interface PickArgs {
  stage: number;
  /** the subject's piece, for pools with piece placeholders */
  piece?: PieceType | null;
  /** the child's gender, for {g:…} */
  g?: 'm' | 'f';
  /** the sub-case of the situation (`LessonPoolSpec.variants`) — only wordings true for it */
  variant?: string | null;
  /** false = the cue cannot be drawn / has no squares: no «вот эти клетки / сюда» wording (default true) */
  deixis?: boolean;
  /** false = no «лучше всего / сильнее всего» wording (the move is not provably the engine's best; default false) */
  allowBest?: boolean;
  /** wording numbers that must not be chosen */
  avoid?: readonly number[];
  /** only wordings of at most this many sentences (blitz: 1) */
  maxSentences?: number;
  /** only wordings of at most this many words (fitting a cap BEFORE the bag decides — never «the shortest every time») */
  maxWords?: number;
  /** only wordings not played yet in this game (null = none fits: the caller drops the sentence instead of repeating) */
  freshOnly?: boolean;
}

export interface Picked {
  pool: string;
  /** 1-based wording number */
  n: number;
  /** the expanded text */
  text: string;
  line: LessonLine;
  piece?: PieceType;
  g?: 'm' | 'f';
}

/**
 * «Recorded first» (the on-demand voice «Дозапись голоса», policy P(K)): the book prefers wordings whose unit already
 * has a recording. The existing rules stay as hard as without it: the per-game bag (fewest plays in this game),
 * `avoid`, `freshOnly`, «two in a row never open with one word» decide first; the voice preference only chooses among
 * what they leave, before the cross-game «least recently said» tie-break. An unrecorded wording is still chosen when
 *  - the pool variant (pool × the subject's piece × the child's gender, as the manifest's pool key) has fewer than
 *    `minVoiced` recorded wordings that fit this call (the set grows to K), or
 *  - every recorded one that the rules above leave is «recent»: a theme announcement said in this pool in the last
 *    `THEME_GUARD` picks, a mini-lesson in the last `MINI_GUARD` picks (the report's 7-game / 14-game windows), or
 *  - no recorded one is left at all (the bag has turned them over in this game).
 * Among equally fresh wordings (never said to this child) a recorded one wins; with `growCheap`, when none is
 * recorded, the one cheapest to record (no piece placeholder, fewest 50-character blocks).
 * Pools of `VOICE_NEUTRAL_POOL` ignore the policy (they choose as the default book).
 */
export interface LessonVoicePolicy {
  /**
   * Can the unit be played now? `unitKey` = `lessonUnitKey(...)` (`line:<pool>[@piece][/g]#n`, piece / g only when the
   * wording uses them), `text` = its expanded text (a take recorded for another text — a shifted wording number — is
   * not a recording of it; the probe may also find the take by text, see core `mergeClipIndexes`).
   */
  voiced(unitKey: string, text: string): boolean;
  /**
   * A unit that will not be recorded (its paid attempts are used up, or it was rejected: the overlay's
   * `blocked[]`). The book does not grow a pool variant with it while another wording the bag allows fits (it is
   * still said, unvoiced, when the bag leaves nothing else; a blocked unit that has a recording is simply voiced).
   * Absent = none blocked.
   */
  blocked?(unitKey: string): boolean;
  /** K — how many recorded fitting wordings a pool variant keeps before the book reuses them instead of a new one */
  minVoiced: number;
  /**
   * when a new recording is needed (only equally fresh, unrecorded wordings are left): prefer one without a piece
   * placeholder (one recording serves every piece), then the fewest started 50-character blocks (the TTS price)
   */
  growCheap: boolean;
}

/**
 * Pools the voice policy leaves alone (they choose exactly as the default book): quiz-button wordings are never
 * recorded one by one (only the composed options sentence is, as a `frag:` unit), and `v3.bark.quiet` is never said.
 */
export const VOICE_NEUTRAL_POOL = (pool: string): boolean => isOptionPool(pool) || pool === 'v3.bark.quiet';

/** A recorded theme announcement is not reused within this many picks of its pool (report: one per 7 games). */
export const THEME_GUARD = 6;
/** A recorded mini-lesson wording is not reused within this many picks of its pool (report: 14 games; the memory keeps 12). */
export const MINI_GUARD = RECENT_PER_POOL;

/** The manifest unit key of a said part (docs/voice-clips SPEC §3.2): `line:v3.lead.subject@p#4`, `line:v3.praise.x@n/m#7`. */
export function lessonUnitKey(s: { pool: string; n: number; piece?: PieceType | null; g?: 'm' | 'f' | null }): string {
  return lineUnitKey(poolKeyOf(s.pool, s.piece ?? undefined, s.g ?? undefined), s.n);
}

function voiceGuard(pool: string): number {
  if (pool.startsWith('v3.theme.')) return THEME_GUARD;
  if (pool.startsWith('v3.mini.')) return MINI_GUARD;
  return 0;
}

export interface LessonBook {
  /** A wording of the pool for this stage / subject / variant, or null when the pool has none that fits. */
  pick(pool: string, args: PickArgs): Picked | null;
  /** Can the pool say something with these arguments (does not pick)? */
  has(pool: string, args: PickArgs): boolean;
  /** The book's own PRNG in [0, 1) — for the engine's non-word choices that must not consume the game's rng. */
  random(): number;
  /** Plays of a wording in this game. */
  playsThisGame(pool: string, n: number): number;
  /** Remember what was said (the single choke point: the game's sayEvent, the report's say). */
  noteSaid(text: string): void;
  /** The last text said in this game ('' = none). */
  lastSaid(): string;
  /** A new game starts: per-game plays reset, the learner model stays. */
  newGame(): void;
  /** The game ended: `gameSeq` advances (call once, in finish()). */
  finishGame(): void;
  /** Read-only learner model (for TeachContext.lessonHistory). */
  history(): Readonly<LessonHistory>;
  /** Learner-model updates (the lesson engine calls them through the director). */
  learner: {
    miniTold(topic: string, level: number): void;
    miniShown(topic: string): void;
    habitDone(reason: string): void;
    habitPraised(reason: string): void;
    takeaway(key: string): void;
  };
  /** The cross-game state to store in localStorage (trimmed). */
  snapshotHistory(): LessonHistory;
  /** The per-game state to store in the resume snapshot. */
  snapshotGame(): LessonGameState;
}

export interface LessonBookInit {
  /** seeds the PRNG of a NEW game (a resumed game restores its own) */
  seed?: number;
  history?: unknown;
  game?: unknown;
  /**
   * «Дозапись голоса»: asked on EVERY pick (an overlay reloaded mid-game counts at once). A policy = prefer recorded
   * wordings; null (the clip layer is muted / not speaking, automation, the report) or absent = the default book,
   * byte for byte.
   */
  voice?: () => LessonVoicePolicy | null;
}

/** mulberry32 step: returns [value in [0,1), next state]. */
function nextRandom(state: number): [number, number] {
  let t = (state + 0x6d2b79f5) | 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

function firstWord(text: string): string {
  const m = text.toLowerCase().replace(/ё/g, 'е').match(/[а-я]+/u);
  return m ? m[0] : '';
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function nums(v: unknown, max: number): number[] {
  return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n > 0).slice(-max) : [];
}

export function emptyLessonHistory(): LessonHistory {
  return { v: 1, gameSeq: 0, recent: {}, minis: {}, habits: {}, takeaways: [], habitSaid: {} };
}

/** Tolerant restore of the cross-game state (anything malformed is dropped field by field). */
export function restoreLessonHistory(raw: unknown): LessonHistory {
  const h = emptyLessonHistory();
  const r = obj(raw);
  if (typeof r.gameSeq === 'number' && Number.isInteger(r.gameSeq) && r.gameSeq >= 0) h.gameSeq = r.gameSeq;
  for (const [k, v] of Object.entries(obj(r.recent))) {
    const list = nums(v, RECENT_PER_POOL);
    if (list.length > 0) h.recent[k] = list;
  }
  for (const [k, v] of Object.entries(obj(r.minis))) {
    const m = obj(v);
    const level = typeof m.level === 'number' ? Math.min(3, Math.max(0, Math.round(m.level))) : 0;
    const lastGame = typeof m.lastGame === 'number' ? m.lastGame : -1;
    const shown = typeof m.shown === 'number' ? Math.max(0, Math.round(m.shown)) : 0;
    h.minis[k] = { level, lastGame, shown, ...(m.retired === true ? { retired: true } : {}) };
  }
  for (const [k, v] of Object.entries(obj(r.habits))) h.habits[k] = (Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n >= 0) : []).slice(-LEARNER_GAMES);
  if (Array.isArray(r.takeaways)) {
    for (const t of r.takeaways) {
      const o = obj(t);
      if (typeof o.key === 'string' && typeof o.game === 'number') h.takeaways.push({ game: o.game, key: o.key });
    }
    h.takeaways = h.takeaways.slice(-LEARNER_GAMES);
  }
  for (const [k, v] of Object.entries(obj(r.habitSaid))) if (typeof v === 'number') h.habitSaid[k] = v;
  return h;
}

/** Tolerant restore of a resumed game's per-game state. */
export function restoreLessonGame(raw: unknown, seed = 1): LessonGameState {
  const r = obj(raw);
  const plays: Record<string, Record<string, number>> = {};
  for (const [k, v] of Object.entries(obj(r.plays))) {
    const counts: Record<string, number> = {};
    for (const [n, c] of Object.entries(obj(v))) if (typeof c === 'number' && c > 0) counts[n] = c;
    plays[k] = counts;
  }
  const lastTexts = Array.isArray(r.lastTexts) ? r.lastTexts.filter((t): t is string => typeof t === 'string').slice(-6) : [];
  const rng = typeof r.rng === 'number' && Number.isFinite(r.rng) ? r.rng | 0 : seed | 0;
  return { v: 1, plays, lastTexts, rng };
}

function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?…])\s+/u).filter((x) => /[а-яё]/iu.test(x)).length;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[а-яёa-z0-9]/iu.test(w)).length;
}

interface Cand {
  w: LessonWording;
  n: number;
  text: string;
}

/**
 * The variant a wording is said in: the subject's piece only when it has a piece placeholder, the child's gender only
 * when it has {g:…}. The one place that decides it — the expansion, the probed unit key and the returned `Picked`
 * all come from here, so the key the book asks about can never drift from the `say` it emits.
 */
function variantOf(t: string, args: PickArgs): { piece?: PieceType; g?: 'm' | 'f' } {
  const piece = usesPiece(t) && args.piece ? args.piece : undefined;
  const g = usesGender(t) ? (args.g ?? 'm') : undefined;
  return { ...(piece ? { piece } : {}), ...(g ? { g } : {}) };
}

function candidates(line: LessonLine, args: PickArgs): Cand[] {
  const out: Cand[] = [];
  line.wordings.forEach((w, i) => {
    if (!wordingFitsStage(line, w, args.stage)) return;
    if (args.variant && w.when && !w.when.includes(args.variant)) return;
    if (args.variant === undefined || args.variant === null) {
      // no variant known: only wordings true for every sub-case
      if (w.when && line.variants && line.variants.length > 0) return;
    }
    if (usesPiece(w.t) && !args.piece) return;
    const text = expandWording(w.t, variantOf(w.t, args));
    if (text === null) return;
    if (args.deixis === false && isDeictic(text)) return;
    if (args.allowBest !== true && line.role === 'lead' && claimsBest(text)) return;
    if (args.maxSentences !== undefined && sentenceCount(text) > args.maxSentences) return;
    if (args.maxWords !== undefined && wordCount(text) > args.maxWords) return;
    out.push({ w, n: i + 1, text });
  });
  return out;
}

/** The unit key of a candidate as `pick` would say it (piece / g only when the wording uses them). */
function unitOf(pool: string, c: Cand, args: PickArgs): string {
  return lessonUnitKey({ pool, n: c.n, ...variantOf(c.w.t, args) });
}

export function createLessonBook(init: LessonBookInit = {}): LessonBook {
  const hist = restoreLessonHistory(init.history);
  const game = restoreLessonGame(init.game, init.seed ?? 0x2545f491);
  const voiceOf = init.voice;

  const rand = (): number => {
    const [v, next] = nextRandom(game.rng);
    game.rng = next;
    return v;
  };

  const book: LessonBook = {
    pick(pool, args) {
      const line = lessonLine(pool);
      if (!line) return null;
      let cands = candidates(line, args);
      if (cands.length === 0) return null;
      const fitting = cands;
      const avoid = new Set(args.avoid ?? []);
      const notAvoided = cands.filter((c) => !avoid.has(c.n));
      if (notAvoided.length > 0) cands = notAvoided;
      // two utterances in a row never open with the same word (when there is a choice)
      const last = firstWord(game.lastTexts[game.lastTexts.length - 1] ?? '');
      if (last !== '') {
        const fresh = cands.filter((c) => firstWord(c.text) !== last);
        if (fresh.length > 0) cands = fresh;
      }
      const plays = game.plays[pool] ?? {};
      if (args.freshOnly) {
        cands = cands.filter((c) => (plays[String(c.n)] ?? 0) === 0);
        if (cands.length === 0) return null;
      }
      // 1. the bag: fewest plays in this game
      const minPlays = Math.min(...cands.map((c) => plays[String(c.n)] ?? 0));
      cands = cands.filter((c) => (plays[String(c.n)] ?? 0) === minPlays);
      const recent = hist.recent[pool] ?? [];
      const age = (n: number): number => {
        const i = recent.lastIndexOf(n);
        return i < 0 ? Number.POSITIVE_INFINITY : recent.length - i;
      };
      // 1b. (voice policy only) recorded first — among what the bag left, before the cross-game tie-break
      const voice = voiceOf && !VOICE_NEUTRAL_POOL(pool) ? voiceOf() : null;
      // (one probe per wording and pick: the probe looks the unit up in the merged clip index)
      const probed = new Map<number, boolean>();
      const isVoiced = voice
        ? (c: Cand): boolean => {
            let v = probed.get(c.n);
            if (v === undefined) {
              v = voice.voiced(unitOf(pool, c, args), c.text);
              probed.set(c.n, v);
            }
            return v;
          }
        : null;
      if (voice && isVoiced) {
        // a unit that will never be recorded does not grow the pool while the bag has another wording
        if (voice.blocked) {
          const growable = cands.filter((c) => isVoiced(c) || !voice.blocked?.(unitOf(pool, c, args)));
          if (growable.length > 0) cands = growable;
        }
        const recorded = fitting.filter(isVoiced).length;
        if (recorded >= voice.minVoiced) {
          const guard = voiceGuard(pool);
          const ok = cands.filter((c) => isVoiced(c) && age(c.n) > guard);
          if (ok.length > 0) cands = ok;
        }
      }
      // 2. least recently said across games (never said beats said)
      const best = Math.max(...cands.map((c) => age(c.n)));
      cands = cands.filter((c) => age(c.n) === best);
      // 2b. (voice policy only) among equally fresh ones, a recorded one — or, growing, the cheapest to record
      if (isVoiced) {
        const rec = cands.filter(isVoiced);
        if (rec.length > 0) cands = rec;
        else if (voice?.growCheap) {
          const plain = cands.filter((c) => !usesPiece(c.w.t));
          if (plain.length > 0) cands = plain;
          const blocks = (c: Cand): number => Math.ceil([...c.text].length / 50);
          const least = Math.min(...cands.map(blocks));
          cands = cands.filter((c) => blocks(c) === least);
        }
      }
      // 3. the book's PRNG among equals
      const c = cands[Math.min(cands.length - 1, Math.floor(rand() * cands.length))] as Cand;
      game.plays[pool] = { ...plays, [String(c.n)]: (plays[String(c.n)] ?? 0) + 1 };
      hist.recent[pool] = [...recent.filter((n) => n !== c.n), c.n].slice(-RECENT_PER_POOL);
      return { pool, n: c.n, text: c.text, line, ...variantOf(c.w.t, args) };
    },
    has(pool, args) {
      const line = lessonLine(pool);
      return !!line && candidates(line, args).length > 0;
    },
    random: rand,
    playsThisGame(pool, n) {
      return game.plays[pool]?.[String(n)] ?? 0;
    },
    noteSaid(text) {
      if (text.trim() === '') return;
      game.lastTexts = [...game.lastTexts, text].slice(-6);
    },
    lastSaid() {
      return game.lastTexts[game.lastTexts.length - 1] ?? '';
    },
    newGame() {
      game.plays = {};
      game.lastTexts = [];
    },
    finishGame() {
      hist.gameSeq += 1;
    },
    history() {
      return hist;
    },
    learner: {
      miniTold(topic, level) {
        const m = hist.minis[topic] ?? { level: 0, lastGame: -1, shown: 0 };
        const next = Math.max(m.level, Math.min(3, level));
        // a new level counts its demonstrations from zero (the ones before it were for the level below, §2.6)
        hist.minis[topic] = { ...m, level: next, lastGame: hist.gameSeq, shown: next > m.level ? 0 : m.shown };
      },
      miniShown(topic) {
        const m = hist.minis[topic] ?? { level: 0, lastGame: -1, shown: 0 };
        const shown = m.shown + 1;
        // retired after l3 and two showings since l3 was told
        hist.minis[topic] = { ...m, shown, ...(m.level >= 3 && shown >= 2 ? { retired: true } : {}) };
      },
      habitDone(reason) {
        const games = hist.habits[reason] ?? [];
        if (games[games.length - 1] !== hist.gameSeq) hist.habits[reason] = [...games, hist.gameSeq].slice(-LEARNER_GAMES);
      },
      habitPraised(reason) {
        hist.habitSaid[reason] = hist.gameSeq;
      },
      takeaway(key) {
        hist.takeaways = [...hist.takeaways, { game: hist.gameSeq, key }].slice(-LEARNER_GAMES);
      },
    },
    snapshotHistory() {
      return JSON.parse(JSON.stringify(hist)) as LessonHistory;
    },
    snapshotGame() {
      return JSON.parse(JSON.stringify(game)) as LessonGameState;
    },
  };
  return book;
}
