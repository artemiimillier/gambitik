/**
 * «Учитель»: the smart strategist of a game (contracts: `GameStrategy`, `StrategyRequest`, `ReplanRequest`,
 * `ReplanResponse`; server routes POST /coach/strategy and /coach/replan).
 *
 *  - The wizard PREFETCHES the strategy the moment colour, opponent and time control are known (the colour tap that
 *    starts the game): the request runs while the board opens and the engines wake up. Black whose first opponent
 *    move is still unknown is not prefetched — the game asks right after the bot DECIDED its first move (never a
 *    guess of it).
 *  - The game takes the prefetched answer through `GameDeps.strategist` (`createBrowserStrategist`).
 *  - Everything the server says is checked here before the game uses it: a strategy needs an id and a Russian title
 *    (an intro with Latin letters is dropped — the teacher then words its own); a re-plan must carry the request's ply
 *    and may only pick one of the request's engine candidates (anything else becomes «no preferred move»). Chess truth
 *    stays with the engine and the code.
 *
 * Light on purpose (imported by the wizard): no engines, no React, no chess logic.
 */
import type { GameStrategy, PersonaId, ReplanRequest, ReplanResponse, StrategyCard, StrategyRequest, TimeControlId } from '@gambit/shared';
import * as contentModule from '@gambit/content';
import { getStrategy, replan } from '../../api/client.ts';
import type { GameStrategist } from './gameTypes.ts';

const LATIN = /[A-Za-z]/;
const PROVIDERS: readonly GameStrategy['provider'][] = ['codex', 'openrouter', 'openai-api', 'template'];
/** Longest texts the game accepts from the server (the contract asks for ≤ 20 / ≤ 15 words — this is a hard stop). */
const MAX_INTRO_CHARS = 240;
const MAX_IDEA_CHARS = 300;
const MAX_PLAN_CHARS = 200;
const MAX_TITLE_CHARS = 80;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '' || text.length > maxChars || LATIN.test(text)) return null;
  return text;
}

function providerOf(value: unknown): GameStrategy['provider'] {
  return PROVIDERS.find((p) => p === value) ?? 'template';
}

/**
 * The strategy as the game may use it, or null: an id and a Russian title (spoken — no Latin letters). A bad intro or
 * idea (Latin letters, too long, missing) is emptied, not fatal: the teacher then says its own «В этот раз разыграем …»
 * from the title and the library card. Also reads a strategy kept in a resume snapshot.
 */
export function sanitizeStrategy(value: unknown): GameStrategy | null {
  if (!isObject(value)) return null;
  const strategyId = typeof value.strategyId === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value.strategyId) ? value.strategyId : null;
  const titleRu = cleanText(value.titleRu, MAX_TITLE_CHARS);
  if (strategyId === null || titleRu === null) return null;
  return {
    strategyId,
    titleRu,
    introRu: cleanText(value.introRu, MAX_INTRO_CHARS) ?? '',
    ideaRu: cleanText(value.ideaRu, MAX_IDEA_CHARS) ?? '',
    provider: providerOf(value.provider),
    // who chose it — «через подписку» / «платно» in the journal's «ИИ в этой партии» (never spoken)
    ...(typeof value.model === 'string' && /^[A-Za-z0-9._:/-]{1,64}$/.test(value.model) ? { model: value.model } : {}),
    ...(value.billing === 'subscription' || value.billing === 'paid' || value.billing === 'free' ? { billing: value.billing } : {}),
  };
}

/**
 * A re-plan the game may use, or null. It must answer THIS request (same ply) with a Russian plan; `preferredUci`
 * survives only when it is one of the request's candidates (the engine proved those), `whyRu` only when it is clean.
 */
export function acceptReplan(request: Pick<ReplanRequest, 'ply' | 'candidates'>, value: unknown): ReplanResponse | null {
  if (!isObject(value) || value.ply !== request.ply) return null;
  const planRu = cleanText(value.planRu, MAX_PLAN_CHARS);
  if (planRu === null) return null;
  const preferred = typeof value.preferredUci === 'string' ? value.preferredUci : null;
  const preferredUci = preferred !== null && request.candidates.some((c) => c.uci === preferred) ? preferred : null;
  return { ply: request.ply, planRu, preferredUci, whyRu: preferredUci !== null ? (cleanText(value.whyRu, MAX_PLAN_CHARS) ?? '') : '', provider: providerOf(value.provider) };
}

// ───────────────────────── the curated library (packages/content STRATEGIES) ─────────────────────────

function isStrategyCard(value: unknown): value is StrategyCard {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.titleRu === 'string' &&
    (value.side === 'w' || value.side === 'b') &&
    Array.isArray(value.lineSan) &&
    value.lineSan.every((san) => typeof san === 'string')
  );
}

/**
 * The curated card of a strategy id (its line of the child's moves — the game sees from it when the opponent left the
 * plan). Read structurally from `@gambit/content` (`STRATEGIES` as an array or a record, or a `getStrategyCard` /
 * `getStrategy` / `strategyById` function), so the game keeps working with a content package that has no library yet.
 */
export function strategyCardOf(id: string, content: Record<string, unknown> = contentModule as unknown as Record<string, unknown>): StrategyCard | undefined {
  try {
    for (const name of ['getStrategyCard', 'strategyById', 'getStrategy']) {
      const fn = content[name];
      if (typeof fn === 'function') {
        const card: unknown = (fn as (id: string) => unknown)(id);
        if (isStrategyCard(card)) return card;
      }
    }
    const library = content.STRATEGIES;
    const list: unknown[] = Array.isArray(library) ? library : isObject(library) ? Object.values(library) : [];
    const found = list.find((card) => isStrategyCard(card) && card.id === id);
    return isStrategyCard(found) ? found : undefined;
  } catch {
    return undefined;
  }
}

// ───────────────────────── wizard prefetch ─────────────────────────

/** A prefetched strategy older than this is not used (the child went away from the wizard for a while). */
export const STRATEGY_PREFETCH_MAX_AGE_MS = 120_000;
/**
 * A prefetch is handed out again within this window after it was first taken: React StrictMode mounts the game twice
 * in development, and the second controller must not start a second (paid) request. A rematch comes much later and
 * asks anew — each game its own strategy.
 */
export const STRATEGY_PREFETCH_REUSE_MS = 15_000;

export interface StrategyFetchOptions {
  signal?: AbortSignal;
}

export type StrategyFetcher = (request: StrategyRequest, opts: StrategyFetchOptions) => Promise<GameStrategy | null>;

interface PrefetchEntry {
  key: string;
  at: number;
  takenAt: number | null;
  promise: Promise<GameStrategy | null>;
}

export interface StrategyPrefetcher {
  /** Starts the request now (a repeated identical prefetch keeps the first one). */
  prefetch(request: StrategyRequest): void;
  /** The prefetched answer for this request (same colour, opponent, time control, first opponent move), or null. */
  take(request: StrategyRequest): Promise<GameStrategy | null> | null;
  clear(): void;
}

/** The part of a request that decides the strategy (the stage is the same child's — it is not part of the key). */
export function strategyRequestKey(request: Pick<StrategyRequest, 'childColor' | 'personaId' | 'timeControlId' | 'opponentFirstUci'>): string {
  return [request.childColor, request.personaId, request.timeControlId, request.opponentFirstUci ?? ''].join('|');
}

export function createStrategyPrefetcher(fetcher: StrategyFetcher, now: () => number = () => Date.now()): StrategyPrefetcher {
  let entry: PrefetchEntry | null = null;
  return {
    prefetch(request) {
      const key = strategyRequestKey(request);
      if (entry && entry.key === key && entry.takenAt === null && now() - entry.at < STRATEGY_PREFETCH_MAX_AGE_MS) return;
      let promise: Promise<GameStrategy | null>;
      try {
        promise = fetcher(request, {}).catch(() => null);
      } catch {
        promise = Promise.resolve(null);
      }
      entry = { key, at: now(), takenAt: null, promise };
    },
    take(request) {
      const current = entry;
      if (!current || current.key !== strategyRequestKey(request)) return null;
      const t = now();
      if (t - current.at >= STRATEGY_PREFETCH_MAX_AGE_MS) {
        entry = null;
        return null;
      }
      if (current.takenAt !== null && t - current.takenAt >= STRATEGY_PREFETCH_REUSE_MS) {
        entry = null;
        return null;
      }
      current.takenAt ??= t;
      return current.promise;
    },
    clear() {
      entry = null;
    },
  };
}

/** The real request: the api client, the answer checked. Never rejects on a bad answer (null), only on abort / network. */
export const fetchStrategy: StrategyFetcher = async (request, opts) => sanitizeStrategy(await getStrategy(request, opts.signal ? { signal: opts.signal } : {}));

/** The app's prefetch registry (one game at a time). */
export const strategyPrefetch: StrategyPrefetcher = createStrategyPrefetcher(fetchStrategy);

/** What the wizard knows once the colour is tapped. */
export interface WizardStrategyChoice {
  coachStyle: string;
  childColor: 'w' | 'b';
  personaId: PersonaId;
  timeControlId: TimeControlId;
  stage: number;
}

/**
 * The wizard's hook: «Учитель» as White → the strategy request starts now, before the board opens. Black waits for the
 * bot's real first move (the game asks then). Returns true when a request was started. Never throws.
 */
export function prefetchStrategyFor(choice: WizardStrategyChoice, prefetcher: StrategyPrefetcher = strategyPrefetch): boolean {
  if (choice.coachStyle !== 'teacher' || choice.childColor !== 'w') return false;
  try {
    prefetcher.prefetch({ childColor: 'w', stage: choice.stage, personaId: choice.personaId, timeControlId: choice.timeControlId });
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────── the game's strategist ─────────────────────────

/**
 * `GameDeps.strategist` of the browser: the prefetched strategy when the wizard asked already, else a new request;
 * re-plans through the api client (their answers are checked by the game with `acceptReplan`).
 */
export function createBrowserStrategist(prefetcher: StrategyPrefetcher = strategyPrefetch, fetcher: StrategyFetcher = fetchStrategy): GameStrategist {
  return {
    strategy(request, opts = {}) {
      return prefetcher.take(request) ?? fetcher(request, opts);
    },
    replan(request, opts = {}) {
      return replan(request, opts.signal ? { signal: opts.signal } : {});
    },
    card: (id) => strategyCardOf(id),
  };
}
