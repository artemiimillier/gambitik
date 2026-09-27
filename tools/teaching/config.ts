/**
 * `pnpm teach:report` — the plan of the 50-game silent report of «Учитель» (docs/TEACHING.md §7) and the record
 * format every other module of tools/teaching shares.
 *
 * 50 games = 5 simulated children (stages 1..5) × 10 consecutive games (≈ 3 a day). Each child keeps its LessonBook
 * history and its strategy history across its games; colours alternate; half the games are blitz5, the rest rapid10 /
 * training; the coach style is always 'teacher'. Everything is a pure function of the run seed, so a run can be
 * repeated move for move. Pure data + tiny helpers: no engine, no node:fs here.
 */
import type { BoardAnnotations, Color, CoachEventKind, LessonCue, LessonQuiz, LessonSay, PieceType, TimeControlId } from '../../packages/shared/src/index.ts';

// ───────────────────────── the run ─────────────────────────

export const DEFAULT_OUT = 'docs/teaching/report';
/** The sample transcripts (committed). */
export const TRANSCRIPTS_DIR = 'docs/teaching/transcripts';
export const DEFAULT_SEED = 20260924;
export const CHILDREN = 5;
export const GAMES_PER_CHILD = 10;
export const DEFAULT_GAMES = CHILDREN * GAMES_PER_CHILD;
export const MAX_WORKERS = 5;

/** Engine settings of the game (as the app's teacher turn) and of the truth audit (docs/TEACHING.md §7). */
export const ENGINE = {
  judge: { depth: 12, multipv: 3 },
  threat: { depth: 10, multipv: 1 },
  verify: { depth: 12 },
  judgeMove: { quickDepth: 11, confirmDepth: 13 },
  audit: { depth: 18, multipv: 5 },
} as const;

/**
 * The simulated child (docs/TEACHING.md §7): shares of what the child does. The move policy with
 * a visible arrow: the arrow / the engine's second line / another PV move / a random legal move.
 */
export const CHILD_POLICY = {
  move: { arrow: 0.55, second: 0.1, pv: 0.2, random: 0.15 },
  quiz: { right: 0.65, wrong: 0.3, ignore: 0.05 },
  /** of the ignored quizzes: the child moves at once (the card closes silently) / presses «Совет» / waits for the timeout */
  quizIgnore: { moveNow: 0.4, sovet: 0.2 },
  /** «Сам» / treasure / stage-5 reveal-later: the child finds the hidden move himself (else waits for the reveal) */
  findHidden: 0.5,
  /** buttons, per child turn */
  sovet: 0.1,
  why: 0.08,
  opponent: 0.06,
  /** take-back offers accepted */
  takebackAccept: 0.7,
  /** after an accepted take-back: a random legal move instead of the advice */
  retryRandom: 0.25,
} as const;

/** Time controls of a child's 10 games (half blitz; the rest rapid10 / training), rotated per child. */
export const TC_PATTERN: readonly TimeControlId[] = ['blitz5', 'rapid10', 'blitz5', 'training', 'blitz5', 'blitz5', 'rapid10', 'training', 'blitz5', 'rapid10'];

/** The five simulated children: names and the child's grammatical gender vary. */
export const CHILD_NAMES: readonly { name: string; address: 'm' | 'f' }[] = [
  { name: 'Миша', address: 'm' },
  { name: 'Маша', address: 'f' },
  { name: 'Тигр', address: 'm' },
  { name: 'Аня', address: 'f' },
  { name: '', address: 'm' },
];

/** The recommended bot personas per stage (@gambit/content CURRICULUM; a copy keeps this module engine-free). */
export const STAGE_PERSONAS: Readonly<Record<number, readonly string[]>> = {
  1: ['petya', 'sonya'],
  2: ['sonya', 'grisha'],
  3: ['grisha', 'sasha'],
  4: ['sasha', 'vika'],
  5: ['vika', 'lyova'],
};

export interface ChildPlan {
  /** 1..5 = the stage */
  child: number;
  stage: number;
  name: string;
  address: 'm' | 'f';
  /** games of this child in this run */
  games: number;
}

export interface GameConfig {
  /** 'c2g07' */
  game: string;
  child: number;
  stage: number;
  /** 1-based game number of the child */
  gameNo: number;
  childColor: Color;
  tc: TimeControlId;
  persona: string;
  name: string;
  address: 'm' | 'f';
  /** games the child played before this one (the profile) */
  gamesPlayed: number;
  /** the child policy (moves, answers, buttons, think times) */
  seed: number;
  /** the phrase book's own PRNG (seeded separately from the child) */
  bookSeed: number;
  /** the bot's sampler */
  botSeed: number;
  /** the strategy card choice (pickStrategyDeterministic) */
  stratSeed: number;
  /** the «было» words of the template teacher (never touches the other streams) */
  legacySeed: number;
}

/** mulberry32 — the same generator as apps/web/src/engine/rng.ts. */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit mix of numbers (a seed per child / game / stream). */
export function mixSeed(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h = Math.imul(h ^ (p >>> 0), 0x01000193) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d) >>> 0;
    h ^= h >>> 12;
  }
  return h >>> 0;
}

const STREAM = { policy: 1, book: 2, bot: 3, strat: 4, legacy: 5 } as const;

/** The children of a run of `games` games: 5 children, the first ones get the extra games when not a multiple of 5. */
export function childPlans(games: number): ChildPlan[] {
  const total = Math.max(1, Math.floor(games));
  const out: ChildPlan[] = [];
  for (let c = 1; c <= CHILDREN; c++) {
    const n = Math.floor(total / CHILDREN) + (c <= total % CHILDREN ? 1 : 0);
    if (n <= 0) continue;
    const who = CHILD_NAMES[c - 1] as { name: string; address: 'm' | 'f' };
    out.push({ child: c, stage: c, name: who.name, address: who.address, games: n });
  }
  return out;
}

export function gameId(child: number, gameNo: number): string {
  return `c${child}g${String(gameNo).padStart(2, '0')}`;
}

/** The games of one child, in order: colours alternate (children 1, 3, 5 start with White), time controls rotate. */
export function gameConfigs(plan: ChildPlan, runSeed: number): GameConfig[] {
  const personas = STAGE_PERSONAS[plan.stage] ?? STAGE_PERSONAS[5] ?? ['vika'];
  const out: GameConfig[] = [];
  for (let i = 0; i < plan.games; i++) {
    const gameNo = i + 1;
    const white = (i + plan.child) % 2 === 1;
    const tc = TC_PATTERN[(i + (plan.child - 1) * 3) % TC_PATTERN.length] as TimeControlId;
    const s = (stream: number): number => mixSeed(runSeed, plan.child, gameNo, stream);
    out.push({
      game: gameId(plan.child, gameNo),
      child: plan.child,
      stage: plan.stage,
      gameNo,
      childColor: white ? 'w' : 'b',
      tc,
      persona: personas[Math.floor(i / 2) % personas.length] as string,
      name: plan.name,
      address: plan.address,
      gamesPlayed: 4 * plan.stage + i,
      seed: s(STREAM.policy),
      bookSeed: s(STREAM.book),
      botSeed: s(STREAM.bot),
      stratSeed: s(STREAM.strat),
      legacySeed: s(STREAM.legacy),
    });
  }
  return out;
}

// ───────────────────────── the voice simulation («Дозапись голоса») ─────────────────────────

/**
 * `--voice lazy | k<K>[c]` — the on-demand voice simulation (free: nothing is generated, only counted). Every child keeps
 * a cache of recorded units (`lessonUnitKey`, the options sentence's `lessonQuizKey`), filled with an utterance's missing
 * units right after the child heard it (as if the server recorded the request at once). `lazy`: the book's default policy (pure
 * «generate on first use»); `k<K>`: the book's «recorded first» policy P(K) (`LessonVoicePolicy.minVoiced = K`, through
 * the book's live `voice` getter); a trailing `c` grows cheaply (`growCheap`: no piece placeholder, short first).
 */
export type VoiceSpec = { mode: 'lazy' } | { mode: 'k'; k: number; growCheap: boolean };

export function parseVoiceSpec(v: string): VoiceSpec | null {
  if (v === 'lazy') return { mode: 'lazy' };
  const m = /^k(\d{1,2})(c?)$/.exec(v);
  if (m && Number(m[1]) >= 1) return { mode: 'k', k: Number(m[1]), growCheap: m[2] === 'c' };
  return null;
}

export function voiceSpecName(v: VoiceSpec): string {
  return v.mode === 'lazy' ? 'lazy' : `k${v.k}${v.growCheap ? 'c' : ''}`;
}

/** How a recording is priced: each unit alone or the server's pack recipe (docs/voice-clips/ONDEMAND.md). */
export type VoicePricing = 'unit' | 'pack';

/** The simulated server's money rules (per child: one Mac, one overlay). */
export interface VoiceMoney {
  pricing: VoicePricing;
  /** credits per local day in milli-credits (null = no cap): once a job does not fit, nothing more is recorded that day */
  dailyCapMilli: number | null;
  /** games a child plays per day (the day of game N is ⌈N / gamesPerDay⌉) */
  gamesPerDay: number;
}

export const DEFAULT_GAMES_PER_DAY = 3;
export const DEFAULT_VOICE_MONEY: VoiceMoney = { pricing: 'pack', dailyCapMilli: null, gamesPerDay: DEFAULT_GAMES_PER_DAY };

/** The money rules from the flags `--voice-pricing`, `--daily-cap` (credits), `--games-per-day`; throws on a bad value. */
export function parseVoiceMoney(o: { pricing?: string | undefined; dailyCap?: string | undefined; gamesPerDay?: string | undefined }): VoiceMoney {
  const pricing = o.pricing ?? DEFAULT_VOICE_MONEY.pricing;
  if (pricing !== 'pack' && pricing !== 'unit') throw new Error(`--voice-pricing expects pack or unit, got "${pricing}"`);
  const cap = o.dailyCap === undefined ? null : Number(o.dailyCap);
  if (cap !== null && (!Number.isFinite(cap) || cap <= 0)) throw new Error(`--daily-cap expects credits > 0, got "${o.dailyCap}"`);
  const gamesPerDay = o.gamesPerDay === undefined ? DEFAULT_VOICE_MONEY.gamesPerDay : Number(o.gamesPerDay);
  if (!Number.isInteger(gamesPerDay) || gamesPerDay < 1) throw new Error(`--games-per-day expects an integer ≥ 1, got "${o.gamesPerDay}"`);
  return { pricing, dailyCapMilli: cap === null ? null : Math.round(cap * 1000), gamesPerDay };
}

/**
 * One recordable unit of a said utterance (voice simulation only), in spoken order: `k` the unit key, `t` what the TTS
 * is sent for it (core `ttsPartText`), `s` its sentence in the utterance, `v` it had a recording when said, `r` the
 * simulated server recorded it right after (its request fitted the day's cap).
 */
export interface VoiceUnitRecord {
  k: string;
  t: string;
  s: number;
  v?: 1;
  r?: 1;
}

/** Children spread over workers round-robin (one child = one worker: its games share the book). */
export function workerChildren(plans: readonly ChildPlan[], workers: number): ChildPlan[][] {
  const n = Math.max(1, Math.min(MAX_WORKERS, Math.floor(workers), plans.length));
  const out: ChildPlan[][] = Array.from({ length: n }, () => []);
  plans.forEach((p, i) => out[i % n]?.push(p));
  return out.filter((w) => w.length > 0);
}

// ───────────────────────── the records (games.jsonl.gz) ─────────────────────────

/** Where an utterance came from (the director call, or the quiet turn's sound word). */
export type EvSource =
  | 'start'
  | 'turn'
  | 'bark'
  | 'hurry'
  | 'answer'
  | 'reveal'
  | 'repeat'
  | 'why'
  | 'opponent'
  | 'reaction'
  | 'takebackOffer'
  | 'takebackReply'
  | 'end';

/** The moment of an utterance for the report's table. */
export type EvMoment =
  | 'theme'
  | 'recall'
  | 'advice'
  | 'quiet'
  | 'quiz'
  | 'self'
  | 'mini'
  | 'danger'
  | 'treasure'
  | 'answer'
  | 'reveal'
  | 'repeat'
  | 'why'
  | 'opponent'
  | 'hurry'
  | 'praise'
  | 'result'
  | 'mistake'
  | 'reaction'
  | 'takeback'
  | 'end';

export interface EvRecord {
  t: 'ev';
  game: string;
  /** order in the game */
  n: number;
  /** plies on the board when it was said */
  afterPly: number;
  /** the child's ply the utterance is about */
  ply: number;
  /** simulated ms since the start of the child's turn (0: said at once) */
  atMs: number;
  source: EvSource;
  moment: EvMoment;
  kind: CoachEventKind | 'bark';
  priority: number;
  text: string;
  bubble: string;
  say: LessonSay[];
  cues: LessonCue[];
  board?: BoardAnnotations;
  quiz?: LessonQuiz;
  teachMoment?: string;
  /** the advice of the turn (the audit of «лучше всего») */
  advice?: string | null;
  /** the answer event: what the child pressed */
  pressed?: { optionId: string | null; label: string | null; correct: boolean | null; how: QuizHow };
  /** the turn's advice arrow was still hidden when this was said */
  arrowHidden?: boolean;
  /** the event came back with empty words (the library had none; not spoken) */
  empty?: boolean;
  /** (per-part voice logs) per `say` part: its unit was already recorded when it was said */
  voiced?: boolean[];
  /** (voice simulation only) the utterance's recordable units: recorded when said, recorded right after */
  vu?: VoiceUnitRecord[];
}

export type QuizHow = 'right' | 'wrong' | 'timeout' | 'sovet' | 'moved';

/** How the child chose his move. */
export type MoveHow = 'arrow' | 'second' | 'pv' | 'random' | 'found' | 'guess' | 'retry';

/** The danger of a child turn as the lesson saw it (docs/TEACHING.md §2.2 «Опасность — не в каждом ходе»). */
export interface DangerRecord {
  kind: 'check' | 'mate' | 'hanging' | 'threat';
  /** the child's endangered piece (hanging) */
  piece: PieceType | null;
  square: string | null;
  /**
   * always (check, mate, a piece losing ≥ 3 pawns) / other / pawn — the class the lesson's cadence used this turn
   * (`plan.lesson.x.dangerCls` = `dangerCadenceClass`: a warning repeated about the same piece on the same square is «other»)
   */
  cls: 'always' | 'other' | 'pawn';
  /** the static `dangerClass` when the cadence class differs from it (a repeated warning: always → other) */
  baseCls?: 'always' | 'other' | 'pawn';
  /** the advice deals with it */
  saves: boolean;
  /** the mistake words right before just told of the same piece (then it is not repeated) */
  justTold: boolean;
  /** its words were said this turn (the moment is 'danger') */
  spoken: boolean;
}

export interface TurnRecord {
  ply: number;
  fen: string;
  moment: string;
  /** the child turn number of the game (1-based, the lesson's own count) */
  turnNo?: number;
  advice: { uci: string; san: string } | null;
  adviceHidden: boolean;
  revealAfterMs: number | null;
  /** stage 5: the calm advice is told now and shown later (`reveal: 'later'`) */
  revealLater?: boolean;
  /** the danger the lesson found this turn, said or not */
  danger?: DangerRecord | null;
  hints: { atMs: number; board: BoardAnnotations }[];
  /** the hints of a hidden advice stop here: it was shown (a reveal, «Совет», an answer) — none comes after */
  hintsStopMs?: number | null;
  /** a call that showed the advice (reveal, «Совет», an answer) did not stop the planned hints (`stopHints: false`) */
  hintsKept?: boolean;
  quiz: {
    id: string;
    kind: string;
    question: string;
    options: { id: string; label: string; icon?: string }[];
    correctId: string;
    how: QuizHow;
    pressed: string | null;
    atMs: number;
    /** canCapture: the capture shown; checkEscape / danger: squares (the audit) */
    captureUci?: string | null;
  } | null;
  reveal: { atMs: number; by: 'timeout' | 'button' } | null;
  buttons: ('sovet' | 'why' | 'opponent')[];
  move: { uci: string; san: string; how: MoveHow; arrowShown: boolean; thinkMs: number };
  /**
   * a take-back of this turn's first move; `again` — a later try was offered back too («и этот ход теряет…»);
   * `tries` — every move tried in this position, in order (the last one stayed on the board)
   */
  takeback?: { uci: string; san: string; accepted: boolean; again: boolean; tries?: TakebackTry[] } | null;
  /** the template teacher's words for the same plan (buildTeachTurn) — the «было» of the transcripts */
  legacy?: string | null;
  hurry?: boolean;
}

/** One move tried in a position with a take-back offer (the game store's offer → «Верну» / «Оставлю» loop). */
export interface TakebackTry {
  uci: string;
  san: string;
  /** the take-back was offered for it */
  offered: boolean;
  /** the child's answer (null: not offered) */
  accepted: boolean | null;
  /** the offer came as «и этот ход…» (a retry in the position whose move was just taken back) */
  again: boolean;
}

export interface PlyRecord {
  by: 'child' | 'bot';
  uci: string;
  san: string;
  thinkMs: number;
}

export type AuditKind = 'quiz' | 'praise' | 'best';
export type AuditVerdict = 'agree' | 'borderline' | 'disagree' | 'static' | 'error';

export interface AuditItem {
  kind: AuditKind;
  ply: number;
  fen: string;
  uci: string;
  /** what the lesson claimed: «whichPiece → n», «praise castled», «лучше всего» */
  claim: string;
  verdict: AuditVerdict;
  /** the deep engine's numbers, in words */
  detail: string;
  /** the event it is about */
  n?: number;
}

export interface GameRecord {
  t: 'game';
  game: string;
  child: number;
  stage: number;
  gameNo: number;
  seed: number;
  name: string;
  address: 'm' | 'f';
  childColor: Color;
  tc: TimeControlId;
  persona: string;
  strategyId: string | null;
  strategyTitle: string | null;
  family: string | null;
  plies: PlyRecord[];
  turns: TurnRecord[];
  result: string;
  termination: string;
  takeaway: string;
  takeawayKey: string;
  events: number;
  /** the size of the cross-game book the app would store (gambit.lessonBook, ≤ 16 KB) */
  bookBytes: number;
  /** the template teacher's first words (buildGameStart) */
  legacyStart?: string | null;
  audit?: AuditItem[];
}

export interface ErrorRecord {
  t: 'error';
  game: string;
  error: string;
}

export type RunLine = EvRecord | GameRecord | ErrorRecord;

/** Russian names of the time controls and the theme families (transcripts, report). */
export const TC_RU: Readonly<Record<string, string>> = { blitz5: 'блиц 5 минут', rapid10: '10 минут', training: 'без часов', bullet1: '1 минута' };
export const FAMILY_RU: Readonly<Record<string, string>> = {
  center: 'центр',
  counterCenter: 'контрудар по центру',
  development: 'развитие',
  castle: 'король в домике',
  f7: 'слабая пешка у короля',
  fortress: 'крепость',
  gambit: 'гамбит',
  openFile: 'открытые линии',
  kingsideAttack: 'атака на короля',
  queensideAttack: 'игра на ферзевом фланге',
};
