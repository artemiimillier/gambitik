/**
 * The smart strategist of «Учитель» (docs/TEACHER-MODE.md): every game a
 * DIFFERENT strategy announced in one short line, and a fresh plan when the opponent leaves it.
 *
 *  POST /coach/strategy → chooseStrategy: the code computes the candidates (library cards for this
 *    colour / stage / opponent's first move, minus the student's last strategies OF THIS COLOUR), a model
 *    picks one and phrases the intro; ≤ STRATEGY_TOTAL_MS (8 s) end to end.
 *  POST /coach/replan → replan: the game sends the engine's top candidates (already within tolerance,
 *    with code-computed ideas); a model picks one and phrases the plan + the why; ≤ 15 s.
 *
 * Measured on a development Mac: codex exec + gpt-5.6-sol ≈ 9.4 s per call with
 * reasoning effort 'low' and ≈ 7 s with 'none' (the CLI adds ~10 k tokens of its own prompt), OpenRouter
 * openai/gpt-5.6-sol ≈ 2.6–6 s with 'none' (once > 7 s) and 8–9.5 s with 'low'. Both calls use 'none'; the FIRST
 * provider of the strategy chain gets 'low' only when its measured speed leaves room for the reasoning pass
 * (`LOW_EFFORT_EXTRA_MS`) — with the numbers above it never does.
 *
 * The thinking goes through the owner's ChatGPT subscription with Sol. So the strategy asks codex FIRST, capped
 * at `strategyCodexMs` (7.5 s: the game's first line waits ≤ 8.5 s after the colour tap, the wizard's prefetch starts
 * the request at that tap); a codex that is missing, logged out or over its usage limit is skipped at once (the
 * gateway's breakers), a codex that failed or was too slow for the strategy is remembered for `codexSlowPauseMs` —
 * the next games ask the fast APIs first instead of making every game wait for it (`codexPause()` tells the settings).
 * A paid API is started only with ≥ `strategyApiMinMs` left; otherwise the free template answers in time.
 *
 * Provider chains (per task): strategy codex (CODEX_STRATEGY_MODEL, the owner's ChatGPT subscription) → openrouter
 * (OPENROUTER_STRATEGY_MODEL, ≈ 0.1–0.5 cent per call) → openai-api → template (STRATEGY_CODEX_FIRST=0 sets the
 * order openrouter → openai-api → codex); re-plan codex → openrouter → openai-api → template (deterministic, free).
 * Every strategy says who produced it (`provider`, `model`, `billing`: «через подписку» / «платно»). LLM_PROVIDER still restricts the chain; automated runs
 * (X-Gambit-Automation) get the template only. Chess truth stays with the engine and the code: a model
 * answer that names anything but a candidate, is too long, has Latin letters / digits, talks about the
 * clock / colours / whose turn, or names a square nobody allowed is rejected and the next provider (or
 * the template) answers. Every call is logged with its provider and latency — never a prompt or a key.
 */
import { Chess, validateFen } from 'chess.js';
import { z } from 'zod';
import { planGoalFits, planGoalRu } from '@gambit/core';
import type { Color, GameStrategy, Persona, PersonaId, ReplanRequest, ReplanResponse, StrategyBilling, StrategyCard, StrategyRequest, StudentProfile } from '@gambit/shared';
import type { LlmAttemptReport, LlmGateway } from '../llm/gateway.ts';
import type { ProviderId, ReasoningEffort, ReplanChoice, StrategyChoice } from '../llm/types.ts';
import type { StrategyHistory } from './history.ts';
import { MAX_STRATEGY_CANDIDATES, firstChildMove, varietyCandidates } from './library.ts';
import type { FirstMove, LibraryCard, StrategyLibrary } from './library.ts';
import { REPLAN_TEXT_MAX_WORDS, STRATEGY_INTRO_MAX_WORDS, buildReplanPrompt, buildStrategyPrompt, phaseOf, replanJsonSchema, strategyJsonSchema } from './prompts.ts';
import type { GamePhaseRu } from './prompts.ts';
import { lowerFirst, spokenProblem, spokenSquares, tidySentence, uciSquares, wordCount } from './text.ts';

export interface StrategistTiming {
  /** POST /coach/strategy answers within this (+ graceMs), whatever the providers do */
  strategyTotalMs: number;
  /** codex's share of the strategy budget when an API provider can still answer after it */
  strategyCodexMs: number;
  /** a paid API is started for the strategy only with at least this much of the budget left (else: the template) */
  strategyApiMinMs: number;
  /** a codex that failed / was too slow for a strategy is asked after the fast APIs for this long */
  codexSlowPauseMs: number;
  replanTotalMs: number;
  replanCodexMs: number;
  graceMs: number;
}

export const DEFAULT_STRATEGIST_TIMING: StrategistTiming = {
  // the game's first line waits ≤ 8.5 s (GameTimings.strategyWaitMs): the template answers in time when Sol cannot.
  strategyTotalMs: 8_000,
  // codex + Sol (effort 'none') ≈ 7 s on a development Mac: 7.5 s for it; a codex that fails fast (limit, login,
  // a broken install) leaves ≥ 5 s for OpenRouter (2.6–6.1 s measured)
  strategyCodexMs: 7_500,
  strategyApiMinMs: 2_500,
  // ≈ 3–4 five-minute games: a slow codex costs one game's wait, then the fast APIs lead until it is tried again
  codexSlowPauseMs: 30 * 60_000,
  // codex + Sol (effort 'none') ≈ 7 s on a development Mac: 9 s for it, then ≥ 6 s for OpenRouter (≈ 5.7 s)
  replanTotalMs: 15_000,
  replanCodexMs: 9_000,
  graceMs: 300,
};

/** Output budget per call (reasoning at effort «low» included): the answer itself is ~60 tokens. */
export const STRATEGIST_MAX_OUTPUT_TOKENS = 2_000;

/**
 * How much longer Sol takes with reasoning effort 'low' than with 'none' (measured: codex 9.4 vs 7.0 s,
 * OpenRouter 8–9.5 vs 2.6–6 s — the fast 'none' answers were the slow 'low' ones, so the APIs count the larger gap).
 * The first provider of the strategy gets 'low' only when its measured 'none' time plus this stays within
 * LOW_EFFORT_BUDGET_SHARE of its cap; a 'low' attempt that ran out of time sets its estimate to the whole budget, so
 * the next games ask with 'none' until fast answers bring the estimate down again.
 */
export const LOW_EFFORT_EXTRA_MS: Readonly<Record<'codex' | 'openrouter' | 'openai-api', number>> = { codex: 2_400, openrouter: 5_500, 'openai-api': 5_500 };
const LOW_EFFORT_BUDGET_SHARE = 0.8;
/** weight of the newest answer in the running latency estimate */
const LATENCY_EWMA = 0.5;
/**
 * An attempt granted less than its cap minus this was SHORTENED: the call waited in the one-at-a-time in-game lane
 * behind a re-plan or a superseded strategy (the deadline counts from the colour tap). Its timeout says nothing about
 * the provider's speed — a codex that got 3 s of its 7.5 s is not «too slow» for the next half hour of games.
 */
const SHORTENED_ATTEMPT_MS = 500;

const LLM_CHAIN: readonly ProviderId[] = ['codex', 'openrouter', 'openai-api', 'template'];
/** The strategy: the owner's subscription first (codex + Sol), then the fast APIs, then the free template. */
const STRATEGY_CHAIN: readonly ProviderId[] = ['codex', 'openrouter', 'openai-api', 'template'];
/** While codex is known to be too slow / failing for the strategy: the fast APIs only (codex would only burn its limit). */
const STRATEGY_CHAIN_WITHOUT_CODEX: readonly ProviderId[] = ['openrouter', 'openai-api', 'template'];
/** STRATEGY_CODEX_FIRST=0: the fast APIs first, codex with what is left. */
const STRATEGY_CHAIN_API_FIRST: readonly ProviderId[] = ['openrouter', 'openai-api', 'codex', 'template'];
const LLM_IDS: readonly ProviderId[] = ['codex', 'openrouter', 'openai-api'];
const API_IDS: readonly ProviderId[] = ['openrouter', 'openai-api'];

export interface StrategistModels {
  codex: string;
  openrouter: string;
  openaiApi: string;
}

/** Why codex is skipped right now (HealthInfo.llm.codexPaused): see `Strategist.codexPause`. */
export interface CodexPause {
  reason: 'limit' | 'login' | 'failing' | 'slow';
  /** epoch ms: when it is tried again */
  until: number;
}

/** «через подписку» / «платно» / free: who paid for an answer of this provider. */
export function billingOf(provider: ProviderId): StrategyBilling {
  if (provider === 'codex') return 'subscription';
  return provider === 'template' ? 'free' : 'paid';
}

export interface StrategistDeps {
  gateway: LlmGateway;
  /** the validated library with the content's rules (content.ts) */
  library: StrategyLibrary;
  history: StrategyHistory;
  getProfile: () => StudentProfile;
  personas: Readonly<Record<PersonaId, Persona>>;
  sanToSpokenRu: (san: string, fenBefore?: string) => string;
  models: StrategistModels;
  log?: (message: string) => void;
  now?: () => number;
  timing?: Partial<StrategistTiming>;
  /** STRATEGY_CODEX_FIRST (default true): the strategy asks the owner's subscription first */
  codexFirst?: boolean;
}

export interface CallOptions {
  /** X-Gambit-Automation: template only, nothing billed, the history is not touched */
  automation: boolean;
}

/** The request cannot be answered at all (e.g. an impossible FEN) → 400 at the route. */
export class StrategistInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrategistInputError';
  }
}

// (verb phrases: the teacher puts them inside a sentence — «Соперник свернул с нашей дороги — теперь …», «Новый план: …»)
const GENERIC_PLAN_RU: Readonly<Record<GamePhaseRu, string>> = {
  дебют: 'Выводим фигуры, держим центр и прячем короля.',
  миттельшпиль: 'Ставим фигуры активнее и ищем слабые места соперника.',
  эндшпиль: 'Король идёт вперёд, а пешки бегут в ферзи.',
};
const GENERIC_WHY_RU = 'Я проверил: это крепкий ход.';
const GENERIC_INTRO_RU = 'Играем по плану — я подскажу, что делать!';

const PIECE_INSTRUMENTAL: Readonly<Record<string, string>> = { пешка: 'пешкой', конь: 'конём', слон: 'слоном', ладья: 'ладьёй', ферзь: 'ферзём', король: 'королём' };

// ───────────── the templates never name a square (docs/TEACHING.md §0: the piece and the idea; the board shows where) ─────────────

const FILE_WORD = '(?:а|бэ|цэ|дэ|е|эф|же|жэ|аш)';
const RANK_WORD = '(?:один|два|три|четыре|пять|шесть|семь|восемь)';
const SQUARE_WORDS = `${FILE_WORD}[\\s-]+${RANK_WORD}`;
/** «цэ три», «дэ четыре, е три и цэ три» */
const SQUARE_LIST = `${SQUARE_WORDS}(?:\\s*,\\s*${SQUARE_WORDS})*(?:\\s+и\\s+${SQUARE_WORDS})?`;
const WORD_START = '(?<![а-яё])';
const WORD_END = '(?![а-яё])';
const rx = (source: string): RegExp => new RegExp(source, 'giu');

/** Without its square the phrase says nothing («держим клетку е четыре», «смотрит на эф семь»), or it names a file. */
const UNSTRIPPABLE: readonly RegExp[] = [
  rx(`${WORD_START}(?:клетк[а-яё]*|поле|поля|полю)\\s+${SQUARE_WORDS}${WORD_END}`),
  rx(`${WORD_START}(?:смотр|целит|целим|нацел)[а-яё]*\\s+(?:на|в)\\s+${SQUARE_WORDS}${WORD_END}`),
  rx(`${WORD_START}(?:лини[а-яё]*|вертикал[а-яё]*)\\s+${FILE_WORD}${WORD_END}`),
  rx(`${WORD_START}пеш[а-яё]*\\s+(?:бэ|цэ|дэ|е|эф|аш)${WORD_END}`),
];

/** What a square becomes: «ударом цэ пять» → «ударом пешки», «пешкой дэ четыре» → «пешкой», «на е один» → nothing. */
const STRIPS: readonly [RegExp, string][] = [
  [rx(`${WORD_START}ударом\\s+${SQUARE_LIST}${WORD_END}`), 'ударом пешки'],
  [rx(`${WORD_START}(пеш[а-яё]*)\\s+${SQUARE_LIST}${WORD_END}`), '$1'],
  [rx(`${WORD_START}(пеш[а-яё]*)\\s+(?:бэ|цэ|дэ|е|эф|аш)${WORD_END}`), '$1'],
  [rx(`${WORD_START}(точк[а-яё]*)\\s+${SQUARE_WORDS}${WORD_END}`), '$1'],
  [rx(`\\s*${WORD_START}(?:на|с)\\s+${SQUARE_LIST}${WORD_END}`), ''],
];

/** A piece word right before a square: «пешка же пять» (spokenSquares reads «же» / «а» as a square only after «на»). */
const PIECE_ON_SQUARE = rx(`${WORD_START}(?:пеш|кон|слон|ладь|ферз|корол)[а-яё]*\\s+${SQUARE_WORDS}${WORD_END}`);

/** No square and no file named by its letter. */
export function namesNoSquare(text: string): boolean {
  return spokenSquares(text).length === 0 && ![...UNSTRIPPABLE, PIECE_ON_SQUARE].some((re) => new RegExp(re.source, re.flags).test(text));
}

/**
 * The phrase without its squares, or null when it would not say anything then (fewer than `minWords` words, a square
 * the phrase is about): «ладья встаёт на е один и помогает центру» → «ладья встаёт и помогает центру», «готовим удар
 * пешкой дэ четыре» → «готовим удар пешкой», «держим клетку е четыре стеной из пешек» → null.
 */
export function squareFreeRu(text: string, minWords = 3): string | null {
  const plain = text.replace(/\s+/gu, ' ').trim();
  if (namesNoSquare(plain)) return wordCount(plain) >= minWords ? plain : null;
  const lower = plain.toLowerCase();
  if (UNSTRIPPABLE.slice(0, 3).some((re) => new RegExp(re.source, re.flags).test(lower))) return null;
  let out = plain;
  for (const [re, replacement] of STRIPS) out = out.replace(new RegExp(re.source, re.flags), replacement);
  out = out.replace(/\s+([,.!?…])/gu, '$1').replace(/\s+/gu, ' ').replace(/^[\s,—–-]+/u, '').trim();
  return out !== '' && namesNoSquare(out) && wordCount(out) >= minWords ? out : null;
}

/**
 * «конь на эф три» → «Начни конём.» (White) / «пешка на дэ пять» → «Ответь пешкой.» (Black — the answer to the
 * opponent's first move): the piece only, the arrow shows the square; anything else → «Первый ход — …» without a
 * square, or «Первый ход покажет стрелка.».
 */
export function startWithRu(moveRu: string, childColor: 'w' | 'b' = 'w'): string {
  const piece = /^(пешка|конь|слон|ладья|ферзь|король)(?![а-яё])/u.exec(moveRu.trim())?.[1];
  if (piece !== undefined) return `${childColor === 'b' ? 'Ответь' : 'Начни'} ${PIECE_INSTRUMENTAL[piece] ?? piece}.`;
  const plain = squareFreeRu(moveRu, 1);
  return plain !== null ? `Первый ход — ${plain}.` : 'Первый ход покажет стрелка.';
}

/**
 * The model's intro left out the first move: «Начни пешкой на е четыре.» (runtime AI only — the model path keeps its
 * square, which the model was allowed to name; the templates above never name one).
 */
function startWithSquareRu(moveRu: string, childColor: 'w' | 'b'): string {
  const match = /^(пешка|конь|слон|ладья|ферзь|король) на (.+)$/u.exec(moveRu.trim());
  const piece = match?.[1];
  const rest = match?.[2];
  if (piece !== undefined && rest !== undefined && !rest.includes(',')) return `${childColor === 'b' ? 'Ответь' : 'Начни'} ${PIECE_INSTRUMENTAL[piece] ?? piece} на ${rest}.`;
  return `Первый ход — ${moveRu}.`;
}

/** «В этот раз разыграем Итальянскую партию — быстро выводим фигуры и целимся в слабую точку. Начни пешкой.» (≤ 20 words, no square) */
export function templateIntroRu(card: LibraryCard, firstMoveRu: string | null, childColor: 'w' | 'b' = card.side): string {
  const move = firstMoveRu !== null ? ` ${startWithRu(firstMoveRu, childColor)}` : '';
  const title = card.titleAccRu ?? card.titleRu;
  const idea = squareFreeRu(lowerFirst(card.ideaRu.trim().replace(/[.!…]+$/u, '')));
  const variants = [
    ...(idea !== null ? [`В этот раз разыграем ${title} — ${idea}.${move}`] : []),
    `В этот раз разыграем ${title}.${move}`,
    firstMoveRu !== null ? startWithRu(firstMoveRu, childColor) : GENERIC_INTRO_RU,
  ];
  return variants.find((text) => spokenProblem(text, { maxWords: STRATEGY_INTRO_MAX_WORDS }) === null && namesNoSquare(text)) ?? GENERIC_INTRO_RU;
}

/**
 * The re-plan without a model — the strategy goes on after the opponent left its road («давим на цепочку пешек
 * ударом c5»): the card's GOAL that names the advised move `moveSan` with its piece first (core `planGoalRu`: «Бьём по
 * цепочке пешек ударом цэ пять.» for c5 — said «Бьём по цепочке пешек ударом пешки.», never the knight's goal for a
 * pawn on e4), then in the opening the goals, in the middlegame its middlegame ideas and the goals; the principles of
 * the phase when the card has nothing (and always in the endgame). Squares are left out (`squareFreeRu`); a line that
 * says nothing without its square is skipped. With the `board`, a line about what the board does not show («бьём по
 * цепочке» after 1.e4 e6 2.d3 — core `planGoalFits`) is not said.
 */
export function templatePlanRu(card: StrategyCard | undefined, phase: GamePhaseRu, moveSan?: string, board?: { fen: string; color: Color }): string {
  const goals = card?.planGoalsRu ?? [];
  const named = card !== undefined && moveSan !== undefined ? planGoalRu({ strategyId: card.id, titleRu: card.titleRu, ideaRu: card.ideaRu, planGoalsRu: goals }, { san: moveSan, ...(board ?? {}) }) : null;
  const fitting = named?.namesMove === true ? [named.textRu] : [];
  const pool = phase === 'эндшпиль' ? [] : phase === 'дебют' ? [...fitting, ...goals] : [...fitting, ...(card?.middlegameRu ?? []), ...goals];
  for (const [index, line] of pool.entries()) {
    if (board !== undefined && !planGoalFits(line.toLowerCase(), board.fen, board.color)) continue;
    // the goal that names the advised move may be as short as «Прыгаем конём.» (the arrow shows where)
    const plain = squareFreeRu(line, index < fitting.length ? 2 : 3);
    if (plain === null) continue;
    const text = tidySentence(plain);
    if (spokenProblem(text, { maxWords: REPLAN_TEXT_MAX_WORDS }) === null) return text;
  }
  return GENERIC_PLAN_RU[phase];
}

/** The first idea of the move the code computed, without its squares («Выводит коня и нападает на пешку.»). */
export function templateWhyRu(ideasRu: readonly string[]): string {
  for (const idea of ideasRu) {
    const plain = squareFreeRu(idea, 2);
    if (plain === null) continue;
    const text = tidySentence(plain);
    if (spokenProblem(text, { maxWords: REPLAN_TEXT_MAX_WORDS }) === null) return text;
  }
  return GENERIC_WHY_RU;
}

function cardSquares(card: StrategyCard | undefined): string[] {
  if (card === undefined) return [];
  return spokenSquares([card.titleRu, card.ideaRu, ...card.stepsRu, ...card.middlegameRu, ...(card.planGoalsRu ?? [])].join('. '));
}

function uciOf(from: string): { from: string; to: string; promotion?: string } {
  return { from: from.slice(0, 2), to: from.slice(2, 4), ...(from.length > 4 ? { promotion: from.slice(4) } : {}) };
}

/** Resolves with null when `ms` passes first (the timer never outlives the race). */
function within<T>(pending: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([pending, expired]).finally(() => clearTimeout(timer));
}

const strategyOutputSchema = z.object({ strategyId: z.string(), introRu: z.string() });
const replanOutputSchema = z.object({ planRu: z.string(), preferredUci: z.string(), whyRu: z.string() });

interface LegalCandidate {
  uci: string;
  san: string;
  cp: number;
  ideasRu: string[];
}

export class Strategist {
  private readonly deps: StrategistDeps;
  private readonly timing: StrategistTiming;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  /** «latest wins»: an answer superseded by a newer request of the same kind is not worth a paid call */
  private strategySeq = 0;
  private replanSeq = 0;
  private readonly codexFirst: boolean;
  /** codex failed / was too slow for a strategy: until then the strategy asks the fast APIs first */
  private codexSlowUntil = 0;
  /** running estimate of each provider's strategy answer time at effort 'none' (ms) */
  private readonly strategyLatency = new Map<ProviderId, number>();

  constructor(deps: StrategistDeps) {
    this.deps = deps;
    this.timing = { ...DEFAULT_STRATEGIST_TIMING, ...deps.timing };
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
    this.codexFirst = deps.codexFirst ?? true;
  }

  private modelOf(provider: ProviderId): string | null {
    if (provider === 'codex') return this.deps.models.codex;
    if (provider === 'openrouter') return this.deps.models.openrouter;
    return provider === 'openai-api' ? this.deps.models.openaiApi : null;
  }

  /**
   * Why codex is skipped right now, for the settings («через подписку Codex» must not be claimed then): its usage
   * limit, a failed login or repeated failures (the gateway's provider-wide breaker — reviews skip it too), or too slow
   * for the game's first line (only the strategy asks the APIs first). null = usable (or not configured at all).
   */
  codexPause(): CodexPause | null {
    const now = this.now();
    const wide = this.deps.gateway.breakerState('codex');
    if (wide.openUntil > now) {
      const reason = wide.lastErrorKind === 'usage_limit' ? 'limit' : wide.lastErrorKind === 'auth' ? 'login' : 'failing';
      return { reason, until: wide.openUntil };
    }
    if (this.codexSlowUntil > now) return { reason: 'slow', until: this.codexSlowUntil };
    return null;
  }

  /** The providers a strategy asks right now, in order (for the start-up line and the tests). */
  strategyChain(): ProviderId[] {
    const gateway = this.deps.gateway;
    const apiAvailable = API_IDS.some((id) => gateway.isAvailable(id, 'interactive'));
    let chain: readonly ProviderId[] = this.codexFirst ? STRATEGY_CHAIN : STRATEGY_CHAIN_API_FIRST;
    // a codex known to be slow only costs the child's wait when something faster could answer
    if (this.codexFirst && this.codexSlowUntil > this.now() && apiAvailable) chain = STRATEGY_CHAIN_WITHOUT_CODEX;
    return chain.filter((id) => id === 'template' || gateway.isAvailable(id, 'interactive'));
  }

  /** 'low' for the first provider when its measured speed leaves room for the reasoning pass within its cap. */
  private strategyEffort(provider: ProviderId, capMs: number): ReasoningEffort {
    if (provider === 'template') return 'none';
    const measured = this.strategyLatency.get(provider);
    if (measured === undefined) return 'none';
    return measured + LOW_EFFORT_EXTRA_MS[provider] <= capMs * LOW_EFFORT_BUDGET_SHARE ? 'low' : 'none';
  }

  /** Remembers how the strategy attempts went (latency; a slow / failing codex). `capMs` = what each provider may take. */
  private onStrategyAttempt(attempt: LlmAttemptReport, capMs: Partial<Record<ProviderId, number>>): void {
    if (attempt.errorKind === null) {
      const extra = attempt.effort === 'low' && attempt.provider !== 'template' ? LOW_EFFORT_EXTRA_MS[attempt.provider] : 0;
      const plain = Math.max(0, attempt.ms - extra);
      const before = this.strategyLatency.get(attempt.provider);
      this.strategyLatency.set(attempt.provider, before === undefined ? plain : Math.round(LATENCY_EWMA * plain + (1 - LATENCY_EWMA) * before));
      if (attempt.provider === 'codex') this.codexSlowUntil = 0;
      return;
    }
    const cap = capMs[attempt.provider] ?? this.timing.strategyTotalMs;
    if (attempt.errorKind === 'timeout' && attempt.timeoutMs < cap - SHORTENED_ATTEMPT_MS) {
      this.log(`[strategist] ${attempt.provider} ran out of a shortened strategy attempt (${attempt.timeoutMs} of ${cap} ms: the in-game lane was busy) — not remembered as slow`);
      return;
    }
    // any failure that ate the paid API's room (e.g. a bad answer after 7 s) cost the child Sol as much as a timeout
    const ateTheRoom = attempt.ms > this.timing.strategyTotalMs - this.timing.strategyApiMinMs;
    // the reasoning pass did not fit after all: 'none' again until fast answers bring the estimate down
    if (attempt.effort === 'low' && (attempt.errorKind === 'timeout' || ateTheRoom)) {
      this.strategyLatency.set(attempt.provider, Math.max(this.strategyLatency.get(attempt.provider) ?? 0, this.timing.strategyTotalMs));
    }
    if (attempt.provider === 'codex' && (attempt.errorKind === 'timeout' || attempt.errorKind === 'failed' || ateTheRoom)) {
      this.codexSlowUntil = this.now() + this.timing.codexSlowPauseMs;
      this.log(`[strategist] codex ${attempt.errorKind === 'timeout' ? 'was too slow' : `failed (${attempt.errorKind})`} for the strategy (${attempt.ms} ms) — the next strategies ask the fast APIs first until ${new Date(this.codexSlowUntil).toISOString()}`);
    }
  }

  private spoken(san: string, fenBefore?: string): string {
    try {
      const text = this.deps.sanToSpokenRu(san, fenBefore);
      return /[A-Za-z]/.test(text) ? 'этот ход' : text;
    } catch {
      return 'этот ход';
    }
  }

  /** codex may use the whole budget only when nothing could answer after it */
  private codexCapMs(total: number, share: number): number {
    return this.deps.gateway.isAvailable('openrouter', 'interactive') || this.deps.gateway.isAvailable('openai-api', 'interactive') ? Math.min(share, total) : total;
  }

  // ───────────────────────── POST /coach/strategy ─────────────────────────

  async chooseStrategy(request: StrategyRequest, options: CallOptions): Promise<GameStrategy> {
    const startedAt = this.now();
    const seq = (this.strategySeq += 1);
    // a new game: the last game's re-plans still waiting in the (shared, one-at-a-time) in-game lane are not worth a
    // call any more — they must not eat this strategy's budget (they answer with their template, nothing billed)
    this.replanSeq += 1;
    const library = this.deps.library;
    // variety per colour: a game as Black never pushes the White strategies out of the rule (and back)
    const history = this.deps.history.recent(request.childColor);
    const eligible = library.eligible(request);
    // variety is a hard rule: the last strategies are not even offered while there is an alternative
    const candidates = varietyCandidates(eligible, history, library.noRepeat).slice(0, MAX_STRATEGY_CANDIDATES);
    const firstMoves = new Map<string, FirstMove | null>(candidates.map((card) => [card.id, firstChildMove(card, request.childColor, request.opponentFirstUci)]));
    const firstMoveRu = (card: StrategyCard): string | null => {
      const move = firstMoves.get(card.id) ?? null;
      return move !== null ? this.spoken(move.san, move.fenBefore) : null;
    };

    const fallbackCard = library.pick(candidates, history) ?? candidates[0] ?? eligible[0];
    if (fallbackCard === undefined) throw new StrategistInputError('no strategy for this colour');
    const fallback: StrategyChoice = { strategyId: fallbackCard.id, introRu: templateIntroRu(fallbackCard, firstMoveRu(fallbackCard), request.childColor) };

    let choice = fallback;
    let provider: ProviderId = 'template';
    if (!options.automation && this.deps.gateway.hasLlm(LLM_IDS, 'interactive')) {
      const profile = this.deps.getProfile();
      const persona = this.deps.personas[request.personaId];
      const opponentFirstMoveRu = request.opponentFirstUci !== undefined ? this.opponentMoveRu(request.opponentFirstUci) : null;
      const prompt = buildStrategyPrompt({
        stage: request.stage,
        weaknesses: profile.weaknesses,
        strengths: profile.strengths,
        childColor: request.childColor,
        opponent: { name: persona.name, elo: persona.nominalElo },
        opponentFirstMoveRu,
        recentTitles: history.map((id) => library.byId(id)?.titleRu ?? '').filter((title) => title !== ''),
        candidates: candidates.map((card) => ({ card, firstMoveRu: firstMoveRu(card) })),
      });
      const opponentSquares = request.opponentFirstUci !== undefined ? uciSquares(request.opponentFirstUci) : [];
      const validate = (raw: unknown): StrategyChoice => {
        const parsed = strategyOutputSchema.parse(raw);
        const card = candidates.find((c) => c.id === parsed.strategyId);
        if (card === undefined) throw new Error('strategyId is not one of the candidates');
        const first = firstMoves.get(card.id) ?? null;
        let intro = tidySentence(parsed.introRu);
        // the first move belongs in the intro: add it when the model left it out
        const moveRu = firstMoveRu(card);
        if (first !== null && moveRu !== null && !spokenSquares(intro).includes(first.uci.slice(2, 4))) intro = `${intro} ${startWithSquareRu(moveRu, request.childColor)}`;
        const allowed = new Set([...(first !== null ? uciSquares(first.uci) : []), ...opponentSquares, ...cardSquares(card)]);
        const problem = spokenProblem(intro, { maxWords: STRATEGY_INTRO_MAX_WORDS, allowedSquares: allowed });
        if (problem !== null) throw new Error(`introRu rejected: ${problem}`);
        return { strategyId: card.id, introRu: intro };
      };
      const total = this.timing.strategyTotalMs;
      const chain = this.strategyChain();
      const first = chain[0] ?? 'template';
      const codexCap = this.codexCapMs(total, this.timing.strategyCodexMs);
      // a choice among ≤ 6 curated cards + one phrase: no reasoning pass (Sol 5.7 s instead of 8–9.5 s) — unless the
      // first provider is measured fast enough for 'low' within its cap; a fallback never gets it (it runs late already)
      const firstEffort = this.strategyEffort(first, first === 'codex' ? codexCap : total);
      const apiMin = this.timing.strategyApiMinMs;
      const answer = await within(
        this.deps.gateway
          .generateJson({ kind: 'strategy', fallback }, prompt, strategyJsonSchema(candidates.map((c) => c.id)), {
            validate,
            schemaName: 'game_strategy',
            timeoutMs: total,
            deadline: startedAt + total,
            providerTimeoutMs: { codex: codexCap },
            // a paid call that cannot finish in what is left is not made: the free template answers in time
            minAttemptMs: { codex: apiMin, openrouter: apiMin, 'openai-api': apiMin },
            providers: chain,
            models: { codex: this.deps.models.codex, openrouter: this.deps.models.openrouter, 'openai-api': this.deps.models.openaiApi },
            maxOutputTokens: STRATEGIST_MAX_OUTPUT_TOKENS,
            reasoningEffort: 'none',
            ...(firstEffort !== 'none' ? { reasoningEffortFor: { [first]: firstEffort } } : {}),
            lane: 'interactive',
            retry: false,
            label: 'strategy',
            abandonIf: () => seq !== this.strategySeq,
            onAttempt: (attempt) => this.onStrategyAttempt(attempt, { codex: codexCap }),
          })
          .catch(() => null),
        total + this.timing.graceMs,
      );
      if (answer !== null) {
        choice = answer.data;
        provider = answer.provider;
      }
    }

    const card = library.byId(choice.strategyId) ?? fallbackCard;
    if (!options.automation) this.deps.history.record(card.id, request.childColor);
    const model = this.modelOf(provider);
    const billing = billingOf(provider);
    this.log(
      `[strategist] strategy ${card.id} via ${provider}${model !== null ? ` ${model}` : ''} (${billing}) in ${Math.max(0, this.now() - startedAt)} ms (${candidates.length} candidate${candidates.length === 1 ? '' : 's'}${options.automation ? ', automation' : ''})`,
    );
    return { strategyId: card.id, titleRu: card.titleRu, introRu: choice.introRu, ideaRu: card.ideaRu, provider, ...(model !== null ? { model } : {}), billing };
  }

  private opponentMoveRu(uci: string): string | null {
    try {
      const move = new Chess().move(uciOf(uci));
      return this.spoken(move.san);
    } catch {
      return null;
    }
  }

  // ───────────────────────── POST /coach/replan ─────────────────────────

  async replan(request: ReplanRequest, options: CallOptions): Promise<ReplanResponse> {
    const startedAt = this.now();
    const seq = (this.replanSeq += 1);
    if (!validateFen(request.fen).ok) throw new StrategistInputError('invalid FEN');
    const board = new Chess(request.fen);
    const legal = new Map(board.moves({ verbose: true }).map((move) => [move.lan, move.san]));
    // only moves that exist in this position, once each (the game computed them — a mismatch is a bug, not chess)
    const candidates: LegalCandidate[] = [];
    for (const c of request.candidates) {
      const san = legal.get(c.uci);
      if (san === undefined || candidates.some((known) => known.uci === c.uci)) continue;
      candidates.push({ uci: c.uci, san, cp: c.cp, ideasRu: c.ideasRu.filter((idea) => !/[A-Za-z]/.test(idea)) });
    }

    const card = this.deps.library.byId(request.strategyId);
    const phase = phaseOf(request.fen, request.movesSan.length);
    const first = candidates[0];
    const fallback: ReplanChoice = {
      planRu: templatePlanRu(card, phase, first?.san, { fen: request.fen, color: request.childColor }),
      preferredUci: first?.uci ?? null,
      whyRu: first !== undefined ? templateWhyRu(first.ideasRu) : GENERIC_WHY_RU,
    };

    let choice = fallback;
    let provider: ProviderId = 'template';
    if (!options.automation && candidates.length > 0 && this.deps.gateway.hasLlm(LLM_IDS, 'interactive')) {
      const profile = this.deps.getProfile();
      const best = Math.max(...candidates.map((c) => c.cp));
      const lastSan = request.movesSan[request.movesSan.length - 1];
      const prompt = buildReplanPrompt({
        stage: request.stage,
        weaknesses: profile.weaknesses,
        card,
        phase,
        movesSan: request.movesSan,
        lastOpponentMoveRu: lastSan !== undefined ? this.spoken(lastSan) : null,
        candidates: candidates.map((c) => ({ uci: c.uci, moveRu: this.spoken(c.san, request.fen), behindCp: Math.max(0, best - c.cp), ideasRu: c.ideasRu })),
      });
      // the opponent's last move may be named («соперник вывел коня на эф шесть»)
      const lastSquare = lastSan !== undefined ? [...lastSan.matchAll(/[a-h][1-8]/g)].pop()?.[0] : undefined;
      const baseAllowed = [...cardSquares(card), ...(lastSquare !== undefined ? [lastSquare] : [])];
      const validate = (raw: unknown): ReplanChoice => {
        const parsed = replanOutputSchema.parse(raw);
        const chosen = candidates.find((c) => c.uci === parsed.preferredUci);
        if (chosen === undefined) throw new Error('preferredUci is not one of the candidates');
        const allowed = new Set([...baseAllowed, ...uciSquares(chosen.uci), ...spokenSquares(chosen.ideasRu.join('. '))]);
        const planRu = tidySentence(parsed.planRu);
        const whyRu = tidySentence(parsed.whyRu);
        const planProblem = spokenProblem(planRu, { maxWords: REPLAN_TEXT_MAX_WORDS, allowedSquares: allowed });
        if (planProblem !== null) throw new Error(`planRu rejected: ${planProblem}`);
        const whyProblem = spokenProblem(whyRu, { maxWords: REPLAN_TEXT_MAX_WORDS, allowedSquares: allowed });
        if (whyProblem !== null) throw new Error(`whyRu rejected: ${whyProblem}`);
        return { planRu, preferredUci: chosen.uci, whyRu };
      };
      const total = this.timing.replanTotalMs;
      const answer = await within(
        this.deps.gateway
          .generateJson({ kind: 'replan', fallback }, prompt, replanJsonSchema(candidates.map((c) => c.uci)), {
            validate,
            schemaName: 'game_replan',
            timeoutMs: total,
            deadline: startedAt + total,
            providerTimeoutMs: { codex: this.codexCapMs(total, this.timing.replanCodexMs) },
            providers: LLM_CHAIN,
            models: { codex: this.deps.models.codex, openrouter: this.deps.models.openrouter, 'openai-api': this.deps.models.openaiApi },
            maxOutputTokens: STRATEGIST_MAX_OUTPUT_TOKENS,
            // a choice among ≤ 3 engine candidates + two short phrases: no reasoning pass (codex 7 s instead of 9.4 s)
            reasoningEffort: 'none',
            lane: 'interactive',
            retry: false,
            label: `replan ply ${request.ply}`,
            abandonIf: () => seq !== this.replanSeq,
          })
          .catch(() => null),
        total + this.timing.graceMs,
      );
      if (answer !== null) {
        choice = answer.data;
        provider = answer.provider;
      }
    }

    this.log(`[strategist] replan ply ${request.ply} (${request.strategyId}) via ${provider} in ${Math.max(0, this.now() - startedAt)} ms (${candidates.length} candidate${candidates.length === 1 ? '' : 's'}${options.automation ? ', automation' : ''})`);
    return { ply: request.ply, planRu: choice.planRu, preferredUci: choice.preferredUci, whyRu: choice.whyRu, provider };
  }
}
